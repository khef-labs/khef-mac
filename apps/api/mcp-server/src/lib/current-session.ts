import { execFileSync } from "node:child_process";
import type { KhefClient } from "../clients/khef-client.js";

export interface CurrentSessionResolution {
  session: any;
  source: string;
}

/** Cap on how many ancestor PIDs we walk before giving up. */
const ANCESTOR_PID_DEPTH = 6;

function normalizeTerminalSessionId(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.includes(":") ? trimmed.split(":").pop() || null : trimmed;
}

function getEnvSessionId(): string | null {
  const sessionId = process.env.KHEF_SESSION_ID?.trim();
  return sessionId || null;
}

function getEnvTerminalSessionId(): string | null {
  return normalizeTerminalSessionId(
    process.env.KHEF_TERMINAL_SESSION_ID || process.env.ITERM_SESSION_ID
  );
}

function getSessionFromResponse(result: any): any {
  return result?.session || result;
}

/**
 * Get the parent PID of a process via `ps -o ppid= -p <pid>`. Returns null on
 * any failure (process gone, ps missing, non-numeric output). macOS and Linux
 * both ship a compatible `ps` for this invocation.
 */
function getParentPid(pid: number): number | null {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    const ppid = Number.parseInt(out, 10);
    return Number.isFinite(ppid) && ppid > 1 ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * Try to resolve the active session by walking up the MCP server's process
 * tree and asking the API for a session row tied to each ancestor PID.
 *
 * The MCP server runs as a child of the assistant CLI (claude-code, codex-cli,
 * or others). The assistant's heartbeat registers its own PID in the sessions
 * table, so the first ancestor that matches is the calling assistant's session.
 *
 * We walk a few extra ancestors so we still resolve when there are wrappers
 * between the MCP server and the assistant (npx, shell-based launchers like
 * `codeks`, etc.).
 *
 * Returns `{ session, depth }` on hit (depth=0 means direct parent), or null.
 */
async function resolveByAncestorPid(
  client: KhefClient
): Promise<{ session: any; depth: number } | null> {
  let pid: number | null = typeof process.ppid === "number" ? process.ppid : null;
  for (let depth = 0; depth < ANCESTOR_PID_DEPTH && pid && pid > 1; depth++) {
    try {
      const result = await client.getActiveSessionByPid(pid);
      const session = getSessionFromResponse(result);
      if (session?.session_id) {
        return { session, depth };
      }
    } catch {
      // Network or 500 — bail on the walk rather than hammer the API.
      return null;
    }
    pid = getParentPid(pid);
  }
  return null;
}

/**
 * Resolve the current Khef session for self-oriented MCP tools.
 *
 * Resolution tiers (each falls through to the next on miss):
 *   1. Explicit `session_id` argument.
 *   2. `KHEF_SESSION_ID` env var.
 *   3. `KHEF_TERMINAL_SESSION_ID` / `ITERM_SESSION_ID` matched against
 *      sessions.terminal_session_id.
 *   4. Walk up MCP server's ancestor PIDs (process.ppid → parent's parent →
 *      ...) and match against sessions.pid. This covers cases where the env
 *      vars and terminal GUID are missing — common for Codex sessions whose
 *      JSONL UUID is only known after the codex process starts (so codeks.sh
 *      cannot export KHEF_SESSION_ID into the running process env).
 *
 * Throws a descriptive error if all four tiers fail.
 */
export async function resolveCurrentSession(
  client: KhefClient,
  explicitSessionId?: string | null
): Promise<CurrentSessionResolution> {
  const sessionId = explicitSessionId?.trim() || getEnvSessionId();
  if (sessionId) {
    const result = await client.getActiveSessionBySessionId(sessionId);
    return { session: getSessionFromResponse(result), source: explicitSessionId ? "argument" : "KHEF_SESSION_ID" };
  }

  const terminalSessionId = getEnvTerminalSessionId();
  if (terminalSessionId) {
    const result = await client.scanActiveSessions();
    const sessions = result?.sessions || [];
    const matches = sessions.filter(
      (session: any) => normalizeTerminalSessionId(session.terminal_session_id) === terminalSessionId
    );

    if (matches.length > 0) {
      return { session: matches[0], source: "ITERM_SESSION_ID" };
    }
  }

  // Final fallback — walk MCP server's process tree. Works without any env
  // var plumbing as long as the heartbeat stored a PID for the active session.
  const byPid = await resolveByAncestorPid(client);
  if (byPid) {
    return {
      session: byPid.session,
      source: byPid.depth === 0 ? "ancestor_pid" : `ancestor_pid+${byPid.depth}`,
    };
  }

  throw new Error(
    "Could not resolve the current Khef session. Tried: KHEF_SESSION_ID env var, " +
    "KHEF_TERMINAL_SESSION_ID / ITERM_SESSION_ID, and walking ancestor PIDs up to " +
    `depth ${ANCESTOR_PID_DEPTH}. Pass session_id explicitly, set KHEF_SESSION_ID, ` +
    "or confirm the calling assistant has heartbeated with its PID."
  );
}
