import type { KhefClient } from "../clients/khef-client.js";

export interface CurrentSessionResolution {
  session: any;
  source: string;
}

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

  throw new Error(
    "Could not resolve the current Khef session. Pass session_id explicitly, set KHEF_SESSION_ID, or run inside a registered iTerm2 session."
  );
}

