import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ── Log file aliases ────────────────────────────────────────────────
// Resolve project root from this file's location: tools/ -> src/ -> mcp-server/ -> api/ -> apps/ -> khef/
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../../../..");
const LOG_ROOT = path.join(PROJECT_ROOT, "logs");

const LOG_ALIASES: Record<string, string> = {
  trace:      "ui/trace.log",
  errors:     "ui/api-errors.log",
  "api-errors": "ui/api-errors.log",
  api:        "api/khef.1.log",
  workers:    "api/khef-workers.1.log",
  ui:         "ui/khef-ui.log",
  debug:      "api/debug.log",
};

// ── Formatting ──────────────────────────────────────────────────────

function formatTraceLine(obj: Record<string, unknown>): string {
  const label = obj.label || "?";
  const data = obj.data;
  const summary = typeof data === "object" && data !== null
    ? Object.entries(data as Record<string, unknown>)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ")
    : JSON.stringify(data);
  return `[${label}] ${summary}`;
}

function formatApiErrorLine(obj: Record<string, unknown>): string {
  const ts = obj.at ? new Date(obj.at as string).toLocaleTimeString() : "?";
  const method = obj.method || "?";
  const url = obj.url || "?";
  const status = obj.status ?? obj.error ?? "?";

  let detail = "";
  if (obj.response) {
    try {
      const parsed = typeof obj.response === "string" ? JSON.parse(obj.response) : obj.response;
      detail = (parsed as Record<string, unknown>).error
        ? ` — ${(parsed as Record<string, unknown>).error}`
        : (parsed as Record<string, unknown>).message
          ? ` — ${(parsed as Record<string, unknown>).message}`
          : "";
    } catch {
      const resp = String(obj.response);
      if (resp.length > 0 && resp.length <= 120) detail = ` — ${resp}`;
    }
  }
  if (!detail && obj.error) detail = ` — ${obj.error}`;

  return `${ts}  ${status}  ${method} ${url}${detail}`;
}

const PINO_LEVELS: Record<number, string> = {
  10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL",
};

function formatPinoLine(obj: Record<string, unknown>): string {
  const ts = obj.time ? new Date(obj.time as number).toLocaleTimeString() : "?";
  const level = PINO_LEVELS[(obj.level as number)] || String(obj.level);
  const msg = obj.msg || "";

  // Request completed lines
  if (obj.res && typeof obj.res === "object") {
    const res = obj.res as Record<string, unknown>;
    const req = obj.req as Record<string, unknown> | undefined;
    const rt = typeof obj.responseTime === "number" ? `${Math.round(obj.responseTime)}ms` : "";
    const method = req?.method || "";
    const url = req?.url || "";
    return `${ts}  ${level}  ${res.statusCode} ${method} ${url} ${rt}`.trim();
  }

  // Request incoming lines
  if (obj.req && typeof obj.req === "object") {
    const req = obj.req as Record<string, unknown>;
    return `${ts}  ${level}  → ${req.method} ${req.url}`;
  }

  return `${ts}  ${level}  ${msg}`;
}

function detectAndFormat(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";

  // Bracketed text log: [timestamp] [LEVEL] message
  if (trimmed.startsWith("[")) return trimmed;

  // Try JSON
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;

    // Trace log: has label + data
    if ("label" in obj && "data" in obj) return formatTraceLine(obj);

    // API errors log: has at + method + url
    if ("at" in obj && "method" in obj) return formatApiErrorLine(obj);

    // Pino log: has level + time
    if ("level" in obj && "time" in obj) return formatPinoLine(obj);

    // Unknown JSON — compact single-line
    return JSON.stringify(obj);
  } catch {
    // Plain text
    return trimmed;
  }
}

function resolveLogPath(file: string): string {
  // Check alias first
  const alias = LOG_ALIASES[file.toLowerCase()];
  if (alias) return path.join(LOG_ROOT, alias);

  // Absolute path
  if (path.isAbsolute(file)) return file;

  // Relative to LOG_ROOT
  return path.join(LOG_ROOT, file);
}

// ── Tool definition ─────────────────────────────────────────────────

export const tools: Tool[] = [
  {
    name: "read_trace_log",
    description:
      "Read and format khef log files with auto-detected formatting. Supports all log types: trace (UI state), api-errors (proxy failures), api (Pino request logs), workers (background jobs), ui (Vite HMR), debug. Use aliases or relative paths under logs/.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            "Log file alias or path. Aliases: trace, errors (api-errors), api, workers, ui, debug. Or a relative path under logs/ (e.g., 'ui/trace.log') or absolute path.",
        },
        limit: {
          type: "number",
          description: "Number of most recent lines to return (default: 50, max: 500)",
        },
        filter: {
          type: "string",
          description: "Case-insensitive text filter — only show lines containing this string (applied after formatting)",
        },
        label: {
          type: "string",
          description: "For trace logs: filter by label value (e.g., 'TeamBoard')",
        },
        errors_only: {
          type: "boolean",
          description: "For api-errors and Pino logs: only show 4xx/5xx status codes",
        },
        raw: {
          type: "boolean",
          description: "Return raw lines without formatting (default: false)",
        },
      },
      required: [],
    },
  },
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  _client: KhefClient,
  _dbClient: DbClient
): Promise<ToolResult | null> {
  if (name !== "read_trace_log") return null;

  const file = (args.file as string) || "trace";
  const limit = Math.min(Math.max((args.limit as number) || 50, 1), 500);
  const textFilter = args.filter as string | undefined;
  const labelFilter = args.label as string | undefined;
  const errorsOnly = args.errors_only as boolean | undefined;
  const raw = args.raw as boolean | undefined;

  const logPath = resolveLogPath(file);

  if (!fs.existsSync(logPath)) {
    return {
      content: [{ type: "text", text: `Log file not found: ${logPath}\n\nAvailable aliases: ${Object.keys(LOG_ALIASES).join(", ")}` }],
    };
  }

  const content = fs.readFileSync(logPath, "utf-8");
  let lines = content.split("\n").filter((l) => l.trim().length > 0);

  // Pre-filter by label (before formatting, on raw JSON)
  if (labelFilter) {
    const lower = labelFilter.toLowerCase();
    lines = lines.filter((l) => {
      try {
        const obj = JSON.parse(l) as Record<string, unknown>;
        return String(obj.label || "").toLowerCase() === lower;
      } catch {
        return false;
      }
    });
  }

  // Pre-filter errors_only (on raw JSON)
  if (errorsOnly) {
    lines = lines.filter((l) => {
      try {
        const obj = JSON.parse(l) as Record<string, unknown>;
        const res = obj.res as Record<string, unknown> | undefined;
        const status = (obj.status as number | undefined) || (res?.statusCode as number | undefined);
        return status !== undefined && status >= 400;
      } catch {
        return false;
      }
    });
  }

  // Take last N lines
  lines = lines.slice(-limit);

  // Format
  const formatted = raw ? lines : lines.map(detectAndFormat).filter(Boolean);

  // Post-filter by text
  const output = textFilter
    ? formatted.filter((l) => l.toLowerCase().includes(textFilter.toLowerCase()))
    : formatted;

  if (output.length === 0) {
    return {
      content: [{ type: "text", text: `No matching entries in ${path.basename(logPath)}` }],
    };
  }

  const header = `# ${path.basename(logPath)} (${output.length} entries)\n`;
  return {
    content: [{ type: "text", text: header + output.join("\n") }],
  };
}
