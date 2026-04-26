import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";

export const tools: Tool[] = [
  {
    name: "bulk_delete_kvec_files",
    description:
      "Delete multiple tracked files from a kvec collection in one request. Removes selected files and their chunks.",
    inputSchema: {
      type: "object",
      properties: {
        collection_name: {
          type: "string",
          description: "Collection name (e.g., 'kvec-source', 'slack-messages')",
        },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of tracked file UUIDs to delete",
        },
      },
      required: ["collection_name", "ids"],
    },
  },
  {
    name: "delete_kvec_collection_files",
    description:
      "Delete all tracked files from a kvec collection by collection name. Removes all files and their chunks in that collection.",
    inputSchema: {
      type: "object",
      properties: {
        collection_name: {
          type: "string",
          description: "Collection name (e.g., 'kvec-source', 'slack-messages')",
        },
      },
      required: ["collection_name"],
    },
  },
  {
    name: "delete_kvec_channel_files",
    description:
      "Delete tracked files from a kvec collection where metadata.channel matches the provided channel name.",
    inputSchema: {
      type: "object",
      properties: {
        collection_name: {
          type: "string",
          description: "Collection name (e.g., 'slack-messages')",
        },
        channel: {
          type: "string",
          description: "Channel name stored in metadata.channel (e.g., 'general')",
        },
      },
      required: ["collection_name", "channel"],
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
    case "bulk_delete_kvec_files": {
      const result = await client.bulkDeleteKvecFiles(
        args.collection_name as string,
        args.ids as string[]
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "delete_kvec_collection_files": {
      const result = await client.deleteAllKvecFilesByCollection(
        args.collection_name as string
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "delete_kvec_channel_files": {
      const result = await client.deleteKvecFilesByChannel(
        args.collection_name as string,
        args.channel as string
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      return null;
  }
}
