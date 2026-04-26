import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatGraphHealth } from "../formatters/stats.js";
import { formatSuggestedRelations } from "../formatters/relations.js";

export const tools: Tool[] = [
  {
  name: "create_relation",
  description:
    "Create a typed relation between two memories. Relations can be within the same project, or cross-project if one memory is in the 'user' project. Relation types: relates_to, contradicts, supports, depends_on, follows_from, references, supersedes, implements, blocks, extends, duplicates.",
  inputSchema: {
    type: "object",
    properties: {
      source_memory_id: {
        type: "string",
        description: "Source memory ID (UUID)",
      },
      target_memory_id: {
        type: "string",
        description: "Target memory ID (UUID)",
      },
      relation_type: {
        type: "string",
        enum: [
          "relates_to",
          "contradicts",
          "supports",
          "depends_on",
          "follows_from",
          "references",
          "supersedes",
          "implements",
          "blocks",
          "extends",
          "duplicates",
        ],
        description: "Type of relation",
      },
    },
    required: ["source_memory_id", "target_memory_id", "relation_type"],
  },
},

  {
  name: "suggest_relations",
  description:
    "Suggest related memories for linking. Returns candidate memories and a suggested relation type when possible.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project handle (e.g., 'khef'), name, or UUID",
      },
      memory_id: {
        type: "string",
        description: "Memory ID (UUID) to suggest relations for",
      },
      limit: {
        type: "integer",
        description: "Maximum number of suggestions to return (default 10)",
        minimum: 1,
        maximum: 50,
      },
    },
    required: ["project_id", "memory_id"],
  },
},

  {
  name: "get_memory_graph",
  description:
    "Get a memory and its relation graph. Traverses relations bidirectionally to the specified depth. Use format='text' (default) for an agent-friendly summary showing connections by depth with directional arrows, or format='json' for raw nodes/edges.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID) to start from",
      },
      depth: {
        type: "number",
        description: "Depth of graph traversal (default: 2)",
      },
    },
    required: ["memory_id"],
  },
},

  {
  name: "get_project_graph",
  description:
    "Get a project-wide view of all memories and their connections. Use format='text' (default) for an agent-friendly summary listing each memory with its outgoing/incoming relations and type/relation stats, or format='json' for raw nodes/edges. Supports filtering by memory type and tag.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project handle (e.g., 'khef'), name, or UUID",
      },
      max_nodes: {
        type: "number",
        description: "Maximum number of memories to include (default: 100)",
      },
      max_edges: {
        type: "number",
        description: "Maximum number of relations to include (default: 200)",
      },
      type: {
        type: "string",
        description: "Filter by memory type (e.g., 'decision', 'pattern', 'context')",
      },
      tag: {
        type: "string",
        description: "Filter by tag name",
      },
    },
    required: ["project_id"],
  },
},

  {
  name: "get_graph_health",
  description:
    "Analyze the knowledge graph health for a project. Returns orphan memories (no relations), connected component analysis (total components, isolated count, largest size), relation type distribution, and per-type stats. Use this to identify memories that should be linked and assess graph connectivity.",
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
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "create_relation": {
      const result = await client.createRelation(
        args.source_memory_id as string,
        args.target_memory_id as string,
        args.relation_type as string
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

    case "suggest_relations": {
      const fmt = (args.format as string) || "text";
      const result = await client.suggestRelations(
        args.project_id as string,
        args.memory_id as string,
        args.limit as number | undefined
      );
      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? formatSuggestedRelations(result) : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "get_memory_graph": {
      const fmt = (args.format as string) || "text";
      const result = await client.getMemoryGraph(
        args.memory_id as string,
        (args.depth as number) || 2,
        fmt
      );
      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? (result as string) : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "get_project_graph": {
      const fmt = (args.format as string) || "text";
      const result = await client.getProjectGraph(
        args.project_id as string,
        {
          max_nodes: args.max_nodes as number | undefined,
          max_edges: args.max_edges as number | undefined,
          format: fmt,
          type: args.type as string | undefined,
          tag: args.tag as string | undefined,
        }
      );
      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? (result as string) : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "get_graph_health": {
      const fmt = (args.format as string) || "text";
      const result = await client.getGraphHealth(args.project_id as string);
      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? formatGraphHealth(result) : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    default:
      return null;
  }
}
