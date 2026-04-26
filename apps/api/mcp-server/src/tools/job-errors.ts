import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatJobErrors, formatJobErrorsCleared } from "../formatters/job-errors.js";

export const tools: Tool[] = [
  {
    name: "get_job_errors",
    description:
      "List recent kdag job errors cached in Redis (3-day TTL). Returns job ID, step, error message, model, and backend for each failure. Use this to quickly diagnose why a job failed without searching logs.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max errors to return (default: 20, max: 100)",
        },
        job_id: {
          type: "string",
          description: "Filter errors by job UUID",
        },
        definition_key: {
          type: "string",
          description: "Filter errors by pipeline definition key (e.g., 'custom', 'session-summary')",
        },
      },
      required: [],
    },
  },
  {
    name: "clear_job_errors",
    description:
      "Clear all cached kdag job errors from Redis.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: KhefClient,
  _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "get_job_errors": {
      const limit = Math.min((args.limit as number) || 20, 100);
      const result = await client.getJobErrors({
        limit,
        jobId: args.job_id as string | undefined,
        definitionKey: args.definition_key as string | undefined,
      });
      return {
        content: [{ type: "text", text: formatJobErrors(result) }],
      };
    }

    case "clear_job_errors": {
      const result = await client.clearJobErrors();
      return {
        content: [{ type: "text", text: formatJobErrorsCleared(result) }],
      };
    }

    default:
      return null;
  }
}
