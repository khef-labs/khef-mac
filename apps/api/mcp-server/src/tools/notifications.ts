import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";

export const tools: Tool[] = [
  {
    name: "debug_raise_notification",
    description:
      "Dev-only: raise a fake notification to smoke-test the SSE-push pipeline that drives the NotificationsBanner UI. Publishes a notifications.changed delta on the SSE bus so every open khef tab refreshes within milliseconds. Returns the created notification. Returns 404 in production builds (NODE_ENV=production).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Notification ID. Optional — defaults to debug-<timestamp>. Reuse an id to update an existing notification rather than create a new one.",
        },
        kind: {
          type: "string",
          description: "Notification kind, free-form. Optional — defaults to 'debug'. Real producers use kinds like 'session.context' and 'memory.high'.",
        },
        severity: {
          type: "string",
          enum: ["info", "warning", "error"],
          description: "Severity level. Optional — defaults to 'info'.",
        },
        title: {
          type: "string",
          description: "Banner title. Optional — defaults to 'Test notification'.",
        },
        body: {
          type: "string",
          description: "Banner body text. Optional — defaults to 'Manually raised for SSE smoke test.'.",
        },
      },
    },
  },

  {
    name: "debug_clear_notification",
    description:
      "Dev-only: clear a notification by id. Removes it from the in-memory store and emits a notifications.changed delta so banners drop it immediately. Returns 404 if the id is unknown or in production builds (NODE_ENV=production).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Notification ID to clear.",
        },
      },
      required: ["id"],
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
    case "debug_raise_notification": {
      const result = await client.debugRaiseNotification({
        id: args.id as string | undefined,
        kind: args.kind as string | undefined,
        severity: args.severity as 'info' | 'warning' | 'error' | undefined,
        title: args.title as string | undefined,
        body: args.body as string | undefined,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "debug_clear_notification": {
      const result = await client.debugClearNotification(args.id as string);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      return null;
  }
}
