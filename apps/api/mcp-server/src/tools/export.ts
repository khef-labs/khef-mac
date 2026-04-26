import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatStats } from "../formatters/stats.js";

export const tools: Tool[] = [
  {
  name: "export_memory",
  description:
    "Export a memory in a specified format. Returns markdown (with YAML frontmatter), Slack mrkdwn (plain text optimized for Slack), DOCX (base64-encoded binary), CSV (raw tabular data), or XLSX (base64-encoded Excel). Use csv/xlsx for csv-type memories.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID)",
      },
      format: {
        type: "string",
        enum: ["markdown", "docx", "slack", "csv", "xlsx", "html"],
        description:
          "Export format: 'markdown' (with YAML frontmatter), 'slack' (Slack mrkdwn), 'docx' (base64-encoded Word document), 'csv' (raw CSV data), 'xlsx' (base64-encoded Excel spreadsheet), 'html' (raw HTML content from canvas-type memories)",
      },
    },
    required: ["memory_id", "format"],
  },
},

  {
  name: "bulk_export_memories",
  description:
    "Export multiple memories from a project as a zip archive (base64-encoded). Supports filtering by type, tag, and status. Returns a base64-encoded zip containing files in the requested format (seed markdown with frontmatter, plain markdown, or docx).",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description:
          "Project handle (e.g., 'khef'), name, or UUID",
      },
      type: {
        type: "string",
        description:
          "Comma-separated memory types to include (e.g., 'commands,context,pattern'). Omit for all types.",
      },
      tag: {
        type: "string",
        description: "Filter by tag name",
      },
      status: {
        type: "string",
        description: "Filter by status value (e.g., 'active', 'open')",
      },
      format: {
        type: "string",
        enum: ["seed", "markdown", "docx"],
        description:
          "File format in the zip: 'seed' (markdown with YAML frontmatter, default), 'markdown' (plain content), 'docx' (Word documents)",
      },
    },
    required: ["project_id"],
  },
},

  {
  name: "sync_builtin_commands",
  description:
    "Sync built-in kf- prefixed commands from the khef repo to the user's command directory (e.g., ~/.claude/commands). Only syncs files with kf- prefix.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
    },
    required: ["assistant_handle"],
  },
},

  {
  name: "get_embed_health",
  description:
    "Check if the embedding server (sentence-transformers sidecar) is available. Returns availability status, model name, and embedding dimensions.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
},

  {
  name: "get_stats",
  description:
    "Get system-wide statistics. Returns memory counts (total, by type, by project), project/tag/relation/file counts, database size, and timestamp bounds. No parameters required.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
},

  {
  name: "get_system_health",
  description:
    "Check health and connectivity of all khef infrastructure services. Returns status, port, and URL for each service: API, PostgreSQL, Kroki (diagrams), and Embed server (sentence-transformers). Shows 'healthy' when all services are up, 'degraded' when any are down.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "export_memory": {
      const result = await client.exportMemory(
        args.memory_id as string,
        args.format as "markdown" | "docx" | "slack" | "csv" | "xlsx" | "html"
      );
      const descriptions: Record<string, string> = {
        docx: "Base64-encoded DOCX binary. Decode with Buffer.from(text, 'base64') to get the .docx file.",
        slack: "Slack mrkdwn formatted text, ready to paste into Slack.",
        csv: "Raw CSV data. Save directly as a .csv file.",
        xlsx: "Base64-encoded XLSX binary. Decode with Buffer.from(text, 'base64') to get the .xlsx file.",
        html: "Raw HTML content from a canvas-type memory. Save directly as a .html file.",
        markdown: "Markdown with YAML frontmatter.",
      };
      const description = descriptions[args.format as string] || descriptions.markdown;
      return {
        content: [
          {
            type: "text",
            text: `Format: ${args.format}\n${description}\n\n${result}`,
          },
        ],
      };
    }

    case "bulk_export_memories": {
      const result = await client.bulkExportMemories(
        args.project_id as string,
        {
          type: args.type as string | undefined,
          tag: args.tag as string | undefined,
          status: args.status as string | undefined,
          format: args.format as string | undefined,
        }
      );
      const format = (args.format as string) || "seed";
      return {
        content: [
          {
            type: "text",
            text: `Base64-encoded zip archive (format: ${format}). Decode with Buffer.from(text, 'base64') to get the .zip file.\n\n${result}`,
          },
        ],
      };
    }

    case "sync_builtin_commands": {
      const result = await client.syncBuiltinCommands(
        args.assistant_handle as string
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "get_embed_health": {
      const result = await client.getEmbedHealth();
      const r = result as { available: boolean; model?: string; dimensions?: number; error?: string };
      const text = r.available
        ? `Embed server: available\nModel: ${r.model}\nDimensions: ${r.dimensions}`
        : `Embed server: unavailable\nError: ${r.error || 'unknown'}`;
      return {
        content: [{ type: "text", text }],
      };
    }

    case "get_stats": {
      const fmt = (args.format as string) || "text";
      const result = await client.getStats();
      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? formatStats(result) : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "get_system_health": {
      const result = await client.getSystemHealth() as {
        status: string;
        services: Record<string, { status: string; port?: number; url?: string; error?: string; details?: Record<string, unknown> }>;
      };
      const lines: string[] = [`# System Health: ${result.status.toUpperCase()}`, ''];
      for (const [name, svc] of Object.entries(result.services)) {
        const icon = svc.status === 'ok' ? '+' : '-';
        const portStr = svc.port ? `:${svc.port}` : '';
        const detail = svc.details ? ` (${Object.entries(svc.details).map(([k, v]) => `${k}: ${v}`).join(', ')})` : '';
        const err = svc.status !== 'ok' && svc.error ? ` — ${svc.error}` : '';
        lines.push(`[${icon}] ${name}${portStr} ${svc.status}${detail}${err}`);
      }
      return {
        content: [{ type: "text", text: lines.join('\n') }],
      };
    }

    default:
      return null;
  }
}
