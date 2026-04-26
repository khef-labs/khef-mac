import type { KhefClient } from "./clients/khef-client.js";
import type { DbClient } from "./clients/db-client.js";

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export type ToolArgs = Record<string, unknown>;

export type ToolHandler = (
  name: string,
  args: ToolArgs,
  client: KhefClient,
  dbClient: DbClient
) => Promise<ToolResult | null>;
