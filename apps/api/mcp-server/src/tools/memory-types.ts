import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatMemoryTypes, formatMemoryType } from "../formatters/memory-types.js";
import { refresh as refreshTypeRegistry } from "../type-registry.js";

export const tools: Tool[] = [
  {
  name: "list_memory_types",
  description:
    "List all memory types with their statuses, built_in flag, and memory counts. Use this to discover available types when creating memories or to manage custom types.",
  inputSchema: {
    type: "object",
    properties: {
    },
    required: [],
  },
},

  {
  name: "get_memory_type",
  description:
    "Get a single memory type by name or UUID. Returns full details including statuses, parent/children, and memory count.",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        description: "Type name (e.g., 'decision') or UUID",
      },
    },
    required: ["type"],
  },
},

  {
  name: "create_memory_type",
  description:
    "Create a custom memory type with optional statuses. Use kebab-case for names (e.g., 'pr-review', 'meeting-notes'). If no statuses provided, defaults to a single 'active' status.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Type name in kebab-case (2-50 chars, e.g., 'pr-review')",
      },
      description: {
        type: "string",
        description: "Description of what this type is for",
      },
      statuses: {
        type: "array",
        description: "Custom statuses for this type. Each status needs a value (kebab-case or snake_case)",
        items: {
          type: "object",
          properties: {
            value: {
              type: "string",
              description: "Status value (kebab-case or snake_case)",
            },
            display_name: {
              type: "string",
              description: "Human-readable display name",
            },
            description: {
              type: "string",
              description: "Description of this status",
            },
            sort_order: {
              type: "number",
              description: "Display order (lower = first)",
            },
          },
          required: ["value"],
        },
      },
    },
    required: ["name"],
  },
},

  {
  name: "update_memory_type",
  description:
    "Update a memory type's name or description. Built-in types can only update description, not name.",
  inputSchema: {
    type: "object",
    properties: {
      type_name: {
        type: "string",
        description: "Current type name or UUID",
      },
      name: {
        type: "string",
        description: "New name (only for custom types)",
      },
      description: {
        type: "string",
        description: "New description",
      },
    },
    required: ["type_name"],
  },
},

  {
  name: "delete_memory_type",
  description:
    "Delete a custom memory type. Cannot delete built-in types or types that have existing memories.",
  inputSchema: {
    type: "object",
    properties: {
      type_name: {
        type: "string",
        description: "Type name or UUID to delete",
      },
    },
    required: ["type_name"],
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "list_memory_types": {
      const fmt = (args.format as string) || "text";
      const result = await client.listMemoryTypes();
      return {
        content: [{ type: "text", text: fmt === "text" ? formatMemoryTypes(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "get_memory_type": {
      const fmt = (args.format as string) || "text";
      const result = await client.getMemoryType(args.type as string);
      return {
        content: [{ type: "text", text: fmt === "text" ? formatMemoryType(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "create_memory_type": {
      const result = await client.createMemoryType(
        args.name as string,
        args.description as string | undefined,
        args.statuses as Array<{
          value: string;
          display_name?: string;
          description?: string;
          sort_order?: number;
        }> | undefined
      );
      await refreshTypeRegistry();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "update_memory_type": {
      const result = await client.updateMemoryType(
        args.type_name as string,
        {
          name: args.name as string | undefined,
          description: args.description as string | undefined,
        }
      );
      // Refresh if the name was changed (affects enum values)
      if (args.name) await refreshTypeRegistry();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "delete_memory_type": {
      const result = await client.deleteMemoryType(args.type_name as string);
      await refreshTypeRegistry();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      return null;
  }
}
