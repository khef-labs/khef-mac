import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatCollectionList, formatCollectionDetail } from "../formatters/collections.js";

export const tools: Tool[] = [
  {
    name: "list_collections",
    description:
      "List collections for a project. By default returns only root collections (no sub-collections). Use parent_id filter for children of a specific parent.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project handle (e.g., 'khef'), name, or UUID",
        },
        parent_id: {
          type: "string",
          description: "Filter by parent: UUID for children of that parent, 'null' for root collections only (default), omit for all",
        },
        limit: {
          type: "number",
          description: "Number of results per page (default: 20)",
        },
        offset: {
          type: "number",
          description: "Number of results to skip (default: 0)",
        },
      },
      required: ["project_id"],
    },
  },
  {
    name: "create_collection",
    description:
      "Create a new collection in a project. Collections group related memories with manual ordering. Can be a sub-collection of another (single-level nesting only).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project handle (e.g., 'khef'), name, or UUID",
        },
        handle: {
          type: "string",
          description: "Collection handle — kebab-case identifier (e.g., 'auth-overhaul')",
        },
        name: {
          type: "string",
          description: "Display name for the collection",
        },
        description: {
          type: "string",
          description: "Optional description of the collection's purpose",
        },
        parent_id: {
          type: "string",
          description: "Optional parent collection ID (UUID) to create as a sub-collection. Parent must be a root collection.",
        },
        view_mode: {
          type: "string",
          enum: ["list", "board", "grid"],
          description: "View mode for the collection (default: 'list'). 'board' renders as a kanban board grouped by status.",
        },
      },
      required: ["project_id", "handle", "name"],
    },
  },
  {
    name: "get_collection",
    description:
      "Get a collection with its ordered list of memories and sub-collections. Returns collection metadata, children (if parent), and all memories sorted by position.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project handle (e.g., 'khef'), name, or UUID",
        },
        collection_id: {
          type: "string",
          description: "Collection ID (UUID)",
        },
      },
      required: ["project_id", "collection_id"],
    },
  },
  {
    name: "update_collection",
    description:
      "Update a collection's name, description, view mode, board config, or parent. Set parent_id to move into a parent (sub-collection) or null to make root.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project handle (e.g., 'khef'), name, or UUID",
        },
        collection_id: {
          type: "string",
          description: "Collection ID (UUID)",
        },
        name: {
          type: "string",
          description: "New display name",
        },
        description: {
          type: "string",
          description: "New description (pass null to clear)",
        },
        view_mode: {
          type: "string",
          enum: ["list", "board", "grid"],
          description: "View mode (list, board, grid)",
        },
        parent_id: {
          type: ["string", "null"],
          description: "Move to parent collection (UUID) or null to make root. Collections with children cannot be moved.",
        },
        board_config: {
          type: "object",
          description: "Board view config (e.g., { hiddenColumns: ['canceled', 'on_hold'] })",
          properties: {
            hiddenColumns: {
              type: "array",
              items: { type: "string" },
              description: "Status values to hide as board columns",
            },
          },
        },
      },
      required: ["project_id", "collection_id"],
    },
  },
  {
    name: "delete_collection",
    description:
      "Delete a collection. This only removes the grouping — the memories themselves are not deleted.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project handle (e.g., 'khef'), name, or UUID",
        },
        collection_id: {
          type: "string",
          description: "Collection ID (UUID)",
        },
      },
      required: ["project_id", "collection_id"],
    },
  },
  {
    name: "add_to_collection",
    description:
      "Add a memory to a collection. The memory must belong to the same project. If no position is specified, it is appended at the end.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project handle (e.g., 'khef'), name, or UUID",
        },
        collection_id: {
          type: "string",
          description: "Collection ID (UUID)",
        },
        memory_id: {
          type: "string",
          description: "Memory ID (UUID) to add",
        },
        position: {
          type: "number",
          description: "Optional position in the collection (0-based)",
        },
      },
      required: ["project_id", "collection_id", "memory_id"],
    },
  },
  {
    name: "remove_from_collection",
    description:
      "Remove a memory from a collection. The memory itself is not deleted.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project handle (e.g., 'khef'), name, or UUID",
        },
        collection_id: {
          type: "string",
          description: "Collection ID (UUID)",
        },
        memory_id: {
          type: "string",
          description: "Memory ID (UUID) to remove",
        },
      },
      required: ["project_id", "collection_id", "memory_id"],
    },
  },
  {
    name: "reorder_collection",
    description:
      "Reorder memories in a collection by setting new positions. Accepts an array of { memory_id, position } items. Positions are 0-based integers. Only items included in the array are moved — others keep their current positions.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project handle (e.g., 'khef'), name, or UUID",
        },
        collection_id: {
          type: "string",
          description: "Collection ID (UUID)",
        },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              memory_id: {
                type: "string",
                description: "Memory ID (UUID)",
              },
              position: {
                type: "number",
                description: "New 0-based position",
              },
            },
            required: ["memory_id", "position"],
          },
          description: "Array of memory IDs with their new positions",
        },
      },
      required: ["project_id", "collection_id", "items"],
    },
  },
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "list_collections": {
      const result = await client.getCollections(
        args.project_id as string,
        args.limit as number | undefined,
        args.offset as number | undefined,
        args.parent_id as string | undefined,
      );
      return {
        content: [{ type: "text", text: formatCollectionList(result) }],
      };
    }

    case "create_collection": {
      const result = await client.createCollection(
        args.project_id as string,
        args.handle as string,
        args.name as string,
        args.description as string | undefined,
        args.parent_id as string | undefined,
        args.view_mode as string | undefined,
      );
      return {
        content: [{ type: "text", text: formatCollectionDetail(result) }],
      };
    }

    case "get_collection": {
      const result = await client.getCollection(
        args.project_id as string,
        args.collection_id as string,
      );
      return {
        content: [{ type: "text", text: formatCollectionDetail(result) }],
      };
    }

    case "update_collection": {
      const data: Record<string, unknown> = {};
      if (args.name !== undefined) data.name = args.name;
      if (args.description !== undefined) data.description = args.description;
      if (args.view_mode !== undefined) data.view_mode = args.view_mode;
      if (args.parent_id !== undefined) data.parent_id = args.parent_id;
      if (args.board_config !== undefined) data.board_config = args.board_config;
      const result = await client.updateCollection(
        args.project_id as string,
        args.collection_id as string,
        data,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "delete_collection": {
      const result = await client.deleteCollection(
        args.project_id as string,
        args.collection_id as string,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "add_to_collection": {
      const result = await client.addToCollection(
        args.project_id as string,
        args.collection_id as string,
        args.memory_id as string,
        args.position as number | undefined,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "remove_from_collection": {
      const result = await client.removeFromCollection(
        args.project_id as string,
        args.collection_id as string,
        args.memory_id as string,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "reorder_collection": {
      const result = await client.reorderCollection(
        args.project_id as string,
        args.collection_id as string,
        args.items as { memory_id: string; position: number }[],
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      return null;
  }
}
