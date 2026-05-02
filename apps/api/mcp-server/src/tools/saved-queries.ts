import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import {
  formatSavedQueryList,
  formatSavedQuery,
  formatSavedQueryRunResult,
  formatSavedQuerySnapshotList,
} from "../formatters/saved-queries.js";

const PARAM_ITEM_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Parameter name without colon (e.g. 'external_url'). Must match `:name` tokens in the SQL.",
    },
    value_type: {
      type: "string",
      enum: ["text", "number", "bool", "enum"],
      description: "Value type. Defaults to 'text'.",
    },
    required: {
      type: "boolean",
      description: "If true, the param must be provided at run time.",
    },
    default_value: {
      type: "string",
      description: "Default value used when the param is not provided.",
    },
    options: {
      type: "array",
      items: { type: "string" },
      description: "For value_type='enum', the allowed values.",
    },
    sort_order: {
      type: "number",
      description: "Stable ordering hint for the UI (defaults to insertion order).",
    },
  },
  required: ["name"],
};

export const tools: Tool[] = [
  {
    name: "list_saved_queries",
    description:
      "List saved queries from the dbx schema. Use filters to narrow by connection, favorites, shared status, or fuzzy match on name/handle/description. Returns compact summaries; use get_saved_query for full SQL + params.",
    inputSchema: {
      type: "object",
      properties: {
        connection_id: {
          type: "string",
          description: "Filter to queries bound to this dbx connection UUID. Omit to include connection-agnostic queries too.",
        },
        session_id: {
          type: "string",
          description: "Session ID for resolving favorite status (e.g. 'khef-ui'). When omitted, is_favorite is always false.",
        },
        favorite: {
          type: "boolean",
          description: "If true, only return queries favorited by session_id. Requires session_id.",
        },
        shared: {
          type: "boolean",
          description: "If true, only return shared queries.",
        },
        q: {
          type: "string",
          description: "Fuzzy search on name, handle, or description (ILIKE).",
        },
        limit: {
          type: "number",
          description: "Max rows (default 50, max 200).",
        },
        offset: {
          type: "number",
          description: "Pagination offset (default 0).",
        },
      },
    },
  },

  {
    name: "get_saved_query",
    description:
      "Fetch a single saved query by UUID. Returns full SQL, declared parameters, version number, and shared/readonly flags.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Saved query UUID.",
        },
        session_id: {
          type: "string",
          description: "Optional session ID to resolve is_favorite for the response.",
        },
      },
      required: ["id"],
    },
  },

  {
    name: "create_saved_query",
    description:
      "Create a new saved query in the dbx schema. Use parameter tokens like `:external_url` in SQL and declare each one in `params` so the run endpoint can validate and bind them safely. handle must be kebab-case and unique per connection (or globally for connection_id=null).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Display name (max 200 chars).",
        },
        handle: {
          type: "string",
          description: "Kebab-case identifier, unique per connection (e.g. 'find-memory-by-external-url').",
        },
        sql: {
          type: "string",
          description: "SQL body. Use `:param_name` tokens for parameters, declared in `params`.",
        },
        connection_id: {
          type: "string",
          description: "Bind to a specific dbx connection UUID. Omit or pass null for any-connection.",
        },
        description: {
          type: "string",
          description: "What the query does, when to use it, gotchas.",
        },
        schema_scope: {
          type: "string",
          description: "Informational hint: 'public', 'kdag', 'kvec', etc.",
        },
        is_shared: {
          type: "boolean",
          description: "Visible to all sessions when true (default false).",
        },
        is_readonly: {
          type: "boolean",
          description: "Wrap runs in BEGIN READ ONLY (default true).",
        },
        owner_session_id: {
          type: "string",
          description: "Session that owns this query (for private/shared scoping). Optional.",
        },
        params: {
          type: "array",
          description: "Declared parameters that map to `:name` tokens in the SQL.",
          items: PARAM_ITEM_SCHEMA,
        },
      },
      required: ["name", "handle"],
    },
  },

  {
    name: "update_saved_query",
    description:
      "Update fields on a saved query. Changing `sql` or `params` bumps the version and writes a snapshot. Passing `params` replaces all existing params; omit it to leave them alone.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Saved query UUID.",
        },
        name: { type: "string" },
        handle: { type: "string" },
        sql: { type: "string" },
        connection_id: {
          type: "string",
          description: "Pass null to unbind from any connection.",
        },
        description: { type: "string" },
        schema_scope: { type: "string" },
        is_shared: { type: "boolean" },
        is_readonly: { type: "boolean" },
        params: {
          type: "array",
          description: "Replaces all existing params if provided.",
          items: PARAM_ITEM_SCHEMA,
        },
        edited_by: {
          type: "string",
          description: "Session ID recorded on the version snapshot.",
        },
      },
      required: ["id"],
    },
  },

  {
    name: "delete_saved_query",
    description:
      "Permanently delete a saved query, its parameters, favorites, and version history. Run-history rows have their query_id nulled but remain.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Saved query UUID to delete." },
      },
      required: ["id"],
    },
  },

  {
    name: "list_saved_query_snapshots",
    description:
      "List point-in-time snapshots of a saved query (sql + params at the moment of capture). Returned newest-first. Snapshots are user-managed: editing a saved query no longer auto-creates one — use create_saved_query_snapshot to capture the current state explicitly.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Saved query UUID." },
      },
      required: ["id"],
    },
  },

  {
    name: "create_saved_query_snapshot",
    description:
      "Capture a manual snapshot of the saved query's current SQL + params. Returns the assigned snapshot_number. Useful before risky edits, to preserve a known-good version.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Saved query UUID." },
        edited_by: {
          type: "string",
          description: "Session ID recorded on the snapshot (e.g. 'codex-cli', 'khef-ui').",
        },
      },
      required: ["id"],
    },
  },

  {
    name: "restore_saved_query_snapshot",
    description:
      "Restore a snapshot's SQL + params onto the live saved query. The current state is automatically captured as a `pre-restore` safety snapshot first, so the restore is reversible. Returns the restored saved query.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Saved query UUID." },
        snapshot_number: {
          type: "number",
          description: "Which snapshot to restore (from list_saved_query_snapshots).",
        },
        edited_by: {
          type: "string",
          description: "Session ID recorded on the pre-restore safety snapshot.",
        },
      },
      required: ["id", "snapshot_number"],
    },
  },

  {
    name: "delete_saved_query_snapshot",
    description:
      "Permanently delete a single snapshot of a saved query. The live query and other snapshots are unaffected.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Saved query UUID." },
        snapshot_number: {
          type: "number",
          description: "Snapshot to delete.",
        },
      },
      required: ["id", "snapshot_number"],
    },
  },

  {
    name: "run_saved_query",
    description:
      "Execute a saved query against its bound connection (or the builtin khef connection when connection_id is null). Binds `:name` parameters from the `params` object, validates them against the saved declarations, and runs in a read-only transaction by default. Logs the run to dbx.query_history. Returns columns, rows, rowCount, and duration. Use get_saved_query first to see declared params and the SQL.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Saved query UUID to run.",
        },
        params: {
          type: "object",
          description: "Object mapping declared parameter names to runtime values (e.g. { external_url: 'docs.google', project_handle: null }). Required params must be present and non-empty.",
          additionalProperties: true,
        },
        session_id: {
          type: "string",
          description: "Session ID recorded on the query_history row (e.g. 'codex-cli', 'khef-ui'). Optional but recommended for traceability.",
        },
        timeout: {
          type: "number",
          description: "Override per-statement timeout in milliseconds (default 10000 for read-only saved queries).",
        },
        maxRows: {
          type: "number",
          description: "Override max rows returned (default 1000).",
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
  _dbClient: DbClient,
): Promise<ToolResult | null> {
  switch (name) {
    case "list_saved_queries": {
      const result = await client.listSavedQueries({
        connection_id: args.connection_id as string | undefined,
        session_id: args.session_id as string | undefined,
        favorite: args.favorite as boolean | undefined,
        shared: args.shared as boolean | undefined,
        q: args.q as string | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
      });
      return {
        content: [{ type: "text", text: formatSavedQueryList(result) }],
      };
    }

    case "get_saved_query": {
      const result = await client.getSavedQuery(
        args.id as string,
        args.session_id as string | undefined,
      );
      return {
        content: [{ type: "text", text: formatSavedQuery(result) }],
      };
    }

    case "create_saved_query": {
      const result = await client.createSavedQuery({
        name: args.name as string,
        handle: args.handle as string,
        sql: args.sql as string | undefined,
        connection_id: args.connection_id as string | null | undefined,
        description: args.description as string | undefined,
        schema_scope: args.schema_scope as string | undefined,
        is_shared: args.is_shared as boolean | undefined,
        is_readonly: args.is_readonly as boolean | undefined,
        owner_session_id: args.owner_session_id as string | undefined,
        params: args.params as any,
      });
      return {
        content: [{ type: "text", text: formatSavedQuery(result) }],
      };
    }

    case "update_saved_query": {
      const result = await client.updateSavedQuery(args.id as string, {
        name: args.name as string | undefined,
        handle: args.handle as string | undefined,
        sql: args.sql as string | undefined,
        connection_id: args.connection_id as string | null | undefined,
        description: args.description as string | undefined,
        schema_scope: args.schema_scope as string | undefined,
        is_shared: args.is_shared as boolean | undefined,
        is_readonly: args.is_readonly as boolean | undefined,
        params: args.params as any,
        edited_by: args.edited_by as string | undefined,
      });
      return {
        content: [{ type: "text", text: formatSavedQuery(result) }],
      };
    }

    case "delete_saved_query": {
      const result = await client.deleteSavedQuery(args.id as string);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "run_saved_query": {
      const result = await client.runSavedQuery(args.id as string, {
        params: args.params as Record<string, unknown> | undefined,
        session_id: args.session_id as string | undefined,
        timeout: args.timeout as number | undefined,
        maxRows: args.maxRows as number | undefined,
      });
      return {
        content: [{ type: "text", text: formatSavedQueryRunResult(result) }],
      };
    }

    case "list_saved_query_snapshots": {
      const result = await client.listSavedQuerySnapshots(args.id as string);
      return {
        content: [{ type: "text", text: formatSavedQuerySnapshotList(result) }],
      };
    }

    case "create_saved_query_snapshot": {
      const result = await client.createSavedQuerySnapshot(
        args.id as string,
        args.edited_by as string | undefined,
      );
      return {
        content: [{ type: "text", text: `Captured snapshot v${result.snapshot_number}.` }],
      };
    }

    case "restore_saved_query_snapshot": {
      const result = await client.restoreSavedQuerySnapshot(
        args.id as string,
        args.snapshot_number as number,
        args.edited_by as string | undefined,
      );
      return {
        content: [{ type: "text", text: formatSavedQuery(result) }],
      };
    }

    case "delete_saved_query_snapshot": {
      const result = await client.deleteSavedQuerySnapshot(
        args.id as string,
        args.snapshot_number as number,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      return null;
  }
}
