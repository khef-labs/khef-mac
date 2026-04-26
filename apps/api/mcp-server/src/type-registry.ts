import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { KhefClient } from "./clients/khef-client.js";

/**
 * Dynamic memory type registry.
 *
 * Fetches type names from the API at startup and exposes them for use
 * in tool schemas. When types are created or deleted, call refresh()
 * to re-fetch and notify the client that tool schemas have changed.
 */

// Hardcoded fallback used when the API is unreachable at startup
const BUILTIN_TYPES = [
  "user-note",
  "assistant-note",
  "project-note",
  "user-todo",
  "assistant-todo",
  "decision",
  "command",
  "context",
  "api",
  "pattern",
  "reference",
  "assistant-rule",
  "diagram",
  "csv",
  "video",
  "canvas",
  "widget",
  "animation",
  "prototype",
  "quiz",
  "knowledge",
  "commands",
];

let typeNames: string[] = [...BUILTIN_TYPES];
let client: KhefClient | null = null;
let server: Server | null = null;

async function fetchTypeNames(): Promise<string[]> {
  if (!client) return BUILTIN_TYPES;
  try {
    const result = await client.listMemoryTypes();
    const types: string[] = (result.memory_types ?? []).map(
      (t: { type: string }) => t.type
    );
    return types.length > 0 ? types.sort() : BUILTIN_TYPES;
  } catch {
    console.error("[khef MCP] Failed to fetch memory types, using fallback");
    return BUILTIN_TYPES;
  }
}

/** Initialize the registry. Call once at startup before connecting the transport. */
export async function init(khefClient: KhefClient, mcpServer: Server): Promise<void> {
  client = khefClient;
  server = mcpServer;
  typeNames = await fetchTypeNames();
}

/** Re-fetch types from the API and notify the client that tools changed. */
export async function refresh(): Promise<void> {
  typeNames = await fetchTypeNames();
  if (server) {
    try {
      await server.notification({
        method: "notifications/tools/list_changed",
      });
    } catch {
      // Client may not support list_changed — not fatal
    }
  }
}

/** Current type names for use in tool schema enum arrays. */
export function getTypeNames(): string[] {
  return typeNames;
}
