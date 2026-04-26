import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";

export const tools: Tool[] = [
  {
  name: "query_khef",
  description:
    "Run a read-only SQL query against the khef database (public schema). Tables: memories, projects, tags, memory_types, memory_type_statuses, memory_relations, memory_chunks, memory_tags, memory_metadata, configs, settings, sessions, etc. Only SELECT/WITH/EXPLAIN allowed. Results limited to 1000 rows max.",
  inputSchema: {
    type: "object",
    properties: {
      sql: {
        type: "string",
        description: "SQL query to execute (SELECT only)",
      },
      params: {
        type: "array",
        items: {},
        description:
          "Parameterized query values (use $1, $2, etc. in SQL)",
      },
      limit: {
        type: "number",
        description: "Max rows to return (default: 100, max: 1000)",
      },
    },
    required: ["sql"],
  },
},

  {
  name: "query_kvec",
  description:
    "Run a read-only SQL query against the kvec schema (vector database). Tables: collections, repos, snapshots, tracked_files, chunks, upload_events, collection_stats (view), tracked_files_stats (view). search_path is set to kvec,public so you can reference tables without schema prefix. Only SELECT/WITH/EXPLAIN allowed.",
  inputSchema: {
    type: "object",
    properties: {
      sql: {
        type: "string",
        description: "SQL query to execute (SELECT only)",
      },
      params: {
        type: "array",
        items: {},
        description:
          "Parameterized query values (use $1, $2, etc. in SQL)",
      },
      limit: {
        type: "number",
        description: "Max rows to return (default: 100, max: 1000)",
      },
    },
    required: ["sql"],
  },
},

  {
  name: "query_kdag",
  description:
    "Run a read-only SQL query against the kdag schema (pipeline orchestration). Tables: job_definitions, job_definition_steps, job_definition_inputs, input_types, jobs, job_runs, job_steps, job_inputs, job_outputs, job_types, assistants. search_path is set to kdag,public so you can reference tables without schema prefix. Only SELECT/WITH/EXPLAIN allowed.",
  inputSchema: {
    type: "object",
    properties: {
      sql: {
        type: "string",
        description: "SQL query to execute (SELECT only)",
      },
      params: {
        type: "array",
        items: {},
        description:
          "Parameterized query values (use $1, $2, etc. in SQL)",
      },
      limit: {
        type: "number",
        description: "Max rows to return (default: 100, max: 1000)",
      },
    },
    required: ["sql"],
  },
},

  {
  name: "list_tables",
  description:
    "List all tables and views in the khef database with estimated row counts. By default shows tables from public, kvec, and kdag schemas.",
  inputSchema: {
    type: "object",
    properties: {
      schema: {
        type: "string",
        enum: ["public", "kvec", "kdag"],
        description:
          "Filter to a specific schema (default: show all three)",
      },
    },
  },
},

  {
  name: "describe_table",
  description:
    "Get detailed schema information for a database table: columns (name, type, nullability, defaults), constraints (PK, FK, UNIQUE), and indexes.",
  inputSchema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Table name to describe",
      },
      schema: {
        type: "string",
        enum: ["public", "kvec", "kdag"],
        description: "Schema the table belongs to (default: public)",
      },
    },
    required: ["table"],
  },
},

  {
  name: "debug_raw_json",
  description:
    "Debug tool: re-runs any khef MCP tool and returns raw JSON instead of formatted text. Gated by PreToolUse hook — requires user approval. Never use for routine queries.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: {
        type: "string",
        description: "Name of the khef tool to call (e.g., 'search_memories', 'list_tags')",
      },
      tool_args: {
        type: "object",
        description: "Arguments to pass to the tool",
      },
    },
    required: ["tool_name", "tool_args"],
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "query_khef": {
      const result = await dbClient.queryKhef(
        args.sql as string,
        args.params as unknown[] | undefined,
        args.limit as number | undefined,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "query_kvec": {
      const result = await dbClient.queryKvec(
        args.sql as string,
        args.params as unknown[] | undefined,
        args.limit as number | undefined,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "query_kdag": {
      const result = await dbClient.queryKdag(
        args.sql as string,
        args.params as unknown[] | undefined,
        args.limit as number | undefined,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "list_tables": {
      const result = await dbClient.listTables(
        args.schema as string | undefined,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "describe_table": {
      const result = await dbClient.describeTable(
        args.table as string,
        args.schema as string | undefined,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      return null;
  }
}
