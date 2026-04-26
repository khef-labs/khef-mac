import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatMemoryTypeStatuses, formatProjectMemoryTypes } from "../formatters/memory-types.js";
import { getTypeNames } from "../type-registry.js";

/** Build a memory_type property definition using the current registry values. */
function typeEnum(description: string) {
  return { type: "string" as const, enum: getTypeNames(), description };
}

// Static tools that don't reference memory type enums
const staticTools: Tool[] = [
  {
  name: "get_project_memory_types",
  description:
    "List memory types for a project with usage counts. Returns memory types, statuses, and usage_count per type for the specified project.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project handle (e.g., 'khef'), name, or UUID",
      },
    },
    required: ["project_id"],
  },
},

  {
  name: "get_memory_status",
  description:
    "Get the current status of a memory. All memories have a status (auto-assigned on creation).",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project handle (e.g., 'khef'), name, or UUID. Optional — auto-resolved from memory_id if omitted.",
      },
      memory_id: {
        type: "string",
        description: "Memory ID (UUID)",
      },
    },
    required: ["memory_id"],
  },
},

  {
  name: "update_memory_status",
  description:
    "Set or update the status of a memory. Status values are type-specific (e.g., user-todo: open/in_progress/done, decision: proposed/accepted/rejected). Use get_memory_type_statuses to discover valid statuses.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project handle (e.g., 'khef'), name, or UUID. Optional — auto-resolved from memory_id if omitted.",
      },
      memory_id: {
        type: "string",
        description: "Memory ID (UUID)",
      },
      status: {
        type: "string",
        description: "Status value (type-specific)",
      },
    },
    required: ["memory_id", "status"],
  },
},
];

/**
 * Build the full tool list. Tools with memory_type enum properties are built
 * dynamically so they reflect the current type registry (including custom types).
 */
export function getTools(): Tool[] {
  const dynamicTools: Tool[] = [
    {
    name: "get_memory_type_statuses",
    description:
      "Get available status values for a memory type. Call this to discover which status values are valid for each memory type (e.g., user-todo has open/in_progress/done, decision has proposed/accepted/rejected).",
    inputSchema: {
      type: "object",
      properties: {
        memory_type: typeEnum("Memory type to get status values for"),
      },
      required: ["memory_type"],
    },
  },

    {
    name: "get_project_memory_type_statuses",
    description:
      "List status usage for a project memory type. Returns statuses and usage_count per status for the specified type.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project handle (e.g., 'khef'), name, or UUID",
        },
        memory_type: typeEnum("Memory type to get status usage for"),
      },
      required: ["project_id", "memory_type"],
    },
  },
  ];

  return [...dynamicTools, ...staticTools];
}

// Backward-compat: modules that only check `m.tools` still work via getTools()
export const tools: Tool[] = [];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "get_memory_type_statuses": {
      const fmt = (args.format as string) || "text";
      const result = await client.getMemoryTypeStatuses(args.memory_type as string);
      return {
        content: [{ type: "text", text: fmt === "text" ? formatMemoryTypeStatuses(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "get_project_memory_types": {
      const fmt = (args.format as string) || "text";
      const result = await client.getProjectMemoryTypes(args.project_id as string);
      return {
        content: [{ type: "text", text: fmt === "text" ? formatProjectMemoryTypes(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "get_project_memory_type_statuses": {
      const fmt = (args.format as string) || "text";
      const result = await client.getProjectMemoryTypeStatuses(
        args.project_id as string,
        args.memory_type as string
      );
      return {
        content: [{ type: "text", text: fmt === "text" ? formatMemoryTypeStatuses(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "get_memory_status": {
      const result = await client.getMemoryStatus(
        args.project_id as string | undefined,
        args.memory_id as string
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

    case "update_memory_status": {
      const result = await client.updateMemoryStatus(
        args.project_id as string | undefined,
        args.memory_id as string,
        args.status as string
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

    default:
      return null;
  }
}
