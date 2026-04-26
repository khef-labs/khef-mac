import fs from "node:fs";
import path from "node:path";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatSessionSearchResults, formatSessionProjects, formatSessionList, formatSyncedSessionList, formatSyncedSession, formatSessionLineage, formatSessionLineageExport, formatSessionLineageTokenCount, formatReadSession } from "../formatters/sessions.js";

export const tools: Tool[] = [
  {
  name: "list_session_projects",
  description:
    "List session project directories for an assistant with stats (session count, total size, last modified). Matches directories to khef projects when possible.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
    },
    required: ["assistant_handle"],
  },
},

  {
  name: "list_sessions",
  description:
    "List session files in a project directory with metadata (size, summary, companion info). The project_dir parameter accepts a khef project handle, name, or raw directory name.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
      project_dir: {
        type: "string",
        description:
          "Project identifier: a khef project handle (e.g., 'khef'), project name, or raw directory name (e.g., '-Users-roger-projects-khef')",
      },
      sort: {
        type: "string",
        description: "Sort field: 'date' (default) or 'size'",
      },
      order: {
        type: "string",
        description: "Sort order: 'asc' or 'desc' (default)",
      },
      limit: {
        type: "number",
        description: "Number of results per page (default: 50)",
      },
      offset: {
        type: "number",
        description: "Number of results to skip (default: 0)",
      },
    },
    required: ["assistant_handle", "project_dir"],
  },
},

  {
  name: "read_session",
  description:
    "Read the raw JSONL transcript from disk with paginated entries. Returns parsed entries (summary, user, assistant, file-history-snapshot types). Only session_id is required — assistant_handle and project_dir are auto-resolved from the sessions database when omitted. Prefer get_session_by_id for metadata/summary; use this only when you need the full raw transcript.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Session UUID or agent-hex identifier",
      },
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code'). Auto-resolved from sessions DB if omitted.",
      },
      project_dir: {
        type: "string",
        description:
          "Project identifier: a khef project handle, name, or raw directory name. Auto-resolved from sessions DB if omitted.",
      },
      limit: {
        type: "number",
        description: "Number of entries per page (default: 100)",
      },
      offset: {
        type: "number",
        description: "Number of entries to skip (default: 0)",
      },
      include_thinking: {
        type: "boolean",
        description: "Include thinking blocks in assistant responses (default: false)",
      },
      include_tool_calls: {
        type: "boolean",
        description: "Include tool_use and tool_result entries (default: false)",
      },
      export_path: {
        type: "string",
        description: "Write formatted transcript to this file path instead of returning inline. Useful for large sessions.",
      },
    },
    required: ["session_id"],
  },
},

  {
  name: "delete_session",
  description:
    "Delete a session JSONL file and its companion directory (subagents, tool results). Returns success confirmation.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
      project_dir: {
        type: "string",
        description:
          "Project identifier: a khef project handle, name, or raw directory name",
      },
      session_id: {
        type: "string",
        description: "Session UUID or agent-hex identifier",
      },
    },
    required: ["assistant_handle", "project_dir", "session_id"],
  },
},

  {
  name: "bulk_delete_sessions",
  description:
    "Bulk delete sessions matching filter criteria. At least one filter (projectDir, before, sessionIds) is required. Returns count of deleted sessions and freed bytes.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
      projectDir: {
        type: "string",
        description: "Delete sessions in this project directory (handle, name, or raw dir name)",
      },
      before: {
        type: "string",
        description: "Delete sessions modified before this ISO date",
      },
      sessionIds: {
        type: "array",
        items: { type: "string" },
        description: "Specific session IDs to delete",
      },
    },
    required: ["assistant_handle"],
  },
},

  {
  name: "sync_session_embeddings",
  description:
    "Sync session transcripts to vector database for semantic search. Extracts clean conversation content (prompts, responses, thinking, tool calls) and creates embeddings. Uses file size to detect changes - only re-embeds if session file grew.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
      project_dir: {
        type: "string",
        description: "Optional: sync only sessions in this project directory (handle, name, or raw dir name). Omit to sync all projects.",
      },
      session_id: {
        type: "string",
        description: "Optional: sync a single session by its UUID. Implies force=true.",
      },
      force: {
        type: "boolean",
        description: "Force re-embedding even if file size unchanged (default: false)",
      },
    },
    required: ["assistant_handle"],
  },
},

  {
  name: "get_session_embedding_status",
  description:
    "Get status of session embedding sync. Returns count of embedded sessions, total chunks, and last sync time.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
      project_dir: {
        type: "string",
        description: "Optional: get status for specific project directory only",
      },
    },
    required: ["assistant_handle"],
  },
},

  {
  name: "search_sessions",
  description:
    "Search session transcripts using keyword, semantic, or fulltext search. Returns matching chunks with session context (session_id, project, summary). Use this to find relevant past conversations. To get full session details from a result, call get_session_by_id with the session_id.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description: "Search query (natural language for semantic, exact text for keyword/fulltext)",
      },
      mode: {
        type: "string",
        enum: ["keyword", "semantic", "fulltext"],
        description: "Search mode: 'keyword' for text contains in vector DB, 'semantic' for vector similarity (default), 'fulltext' for PostgreSQL full-text search",
      },
      assistant_handle: {
        type: "string",
        description: "Optional: filter by assistant handle (e.g., 'claude-code')",
      },
      project_dir: {
        type: "string",
        description: "Optional: filter by project directory (handle, name, or raw dir name)",
      },
      session_id: {
        type: "string",
        description: "Optional: filter by session UUID to search within a specific session",
      },
      exclude_session_id: {
        type: "string",
        description: "Optional: exclude results from this session UUID (e.g., exclude your own current session)",
      },
      limit: {
        type: "number",
        description: "Maximum number of results (default: 10)",
      },
      include_thinking: {
        type: "boolean",
        description: "Include thinking blocks in results (default: true). Set to false for cleaner output.",
      },
      include_tool_calls: {
        type: "boolean",
        description: "Include tool call blocks in results (default: false). Set to true to see what tools/commands were used.",
      },
    },
    required: ["q"],
  },
},

  {
  name: "grep_sessions",
  description:
    "Raw ripgrep across session JSONL files on disk. Searches the full transcript content (including tool_result blocks that search_sessions strips at index time) — use this to find exact strings like Jira account IDs, error messages, or UUIDs that don't surface through the indexed search. Requires at least one scope: session_id, nickname, or project_dir. Returns matches enriched with role, tool name, timestamp, and a focused excerpt around each hit.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Literal text to search for (or a regex if is_regex=true). Required.",
      },
      is_regex: {
        type: "boolean",
        description: "Treat pattern as a regex (default: false = literal). Literal is safer for IDs and tokens.",
      },
      case_sensitive: {
        type: "boolean",
        description: "Case-sensitive match (default: false)",
      },
      session_id: {
        type: "string",
        description: "Scope to one session (original file UUID from the JSONL filename)",
      },
      nickname: {
        type: "string",
        description: "Scope to all sessions in a lineage (e.g., 'ridge')",
      },
      project_dir: {
        type: "string",
        description: "Scope to all sessions under a project (khef project handle, name, or raw dir name)",
      },
      assistant_handle: {
        type: "string",
        description: "Used with project_dir (default: 'claude-code')",
      },
      limit: {
        type: "number",
        description: "Max matches returned (default: 20, max: 200)",
      },
      context_lines: {
        type: "number",
        description: "Lines of surrounding context per match (default: 2, max: 10)",
      },
      format: {
        type: "string",
        enum: ["text", "json"],
        description: "Output format (default: text). JSON returns the full structured result.",
      },
    },
    required: ["pattern"],
  },
},

  {
  name: "list_synced_sessions",
  description:
    "List sessions stored in the database. Returns session metadata (summary, message count, timestamps). Sessions are populated by the background sync worker and heartbeat hooks.",
  inputSchema: {
    type: "object",
    properties: {
      assistant: {
        type: "string",
        description: "Optional: filter by assistant handle (e.g., 'claude-code', 'codex-cli')",
      },
      project: {
        type: "string",
        description: "Optional: filter by khef project handle or name",
      },
      limit: {
        type: "number",
        description: "Maximum number of results (default: 50)",
      },
      offset: {
        type: "number",
        description: "Number of results to skip for pagination (default: 0)",
      },
    },
  },
},

  {
  name: "get_synced_session",
  description:
    "Get a session by its database ID or original session file UUID. Provide either `id` (DB row ID) or `session_uuid` (the original file UUID from the JSONL filename). Returns full session metadata and optionally the parsed content chunks.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Session database row ID (UUID)",
      },
      session_uuid: {
        type: "string",
        description: "Original session file UUID (from the JSONL filename, stored as session_id in the DB)",
      },
      include_chunks: {
        type: "boolean",
        description: "Include parsed content chunks (default: false)",
      },
    },
  },
},

  {
  name: "trigger_session_sync",
  description:
    "Trigger an immediate session sync. Normally sessions are synced automatically every 60 seconds. Use this to force a sync after creating new sessions.",
  inputSchema: {
    type: "object",
    properties: {
      force: {
        type: "boolean",
        description: "Force re-sync all sessions, even if file size unchanged (default: false)",
      },
    },
  },
},

  {
  name: "get_session_lineage",
  description:
    "Get all sessions sharing a nickname (session lineage). Returns chronological list with summary snapshot IDs and compaction summary chunk IDs. Use this to understand the history of a session thread before continuing work. Call export_session_lineage to write full content to disk for reading.",
  inputSchema: {
    type: "object",
    properties: {
      nickname: {
        type: "string",
        description: "Session nickname to look up (e.g., 'dulci', 'ridge')",
      },
    },
    required: ["nickname"],
  },
},

  {
  name: "export_session_lineage",
  description:
    "Export all summaries and compaction summaries for a session lineage to disk. Writes markdown files organized by session, chronologically. Use this when you need to read full summary content — avoids multiple round-trip MCP calls for large content.",
  inputSchema: {
    type: "object",
    properties: {
      nickname: {
        type: "string",
        description: "Session nickname to export (e.g., 'dulci', 'ridge')",
      },
      path: {
        type: "string",
        description: "Output directory (default: tmp/lineage/<nickname>)",
      },
    },
    required: ["nickname"],
  },
},

  {
  name: "get_session_lineage_token_count",
  description:
    "Estimate the token cost of rehydrating a session lineage. Returns byte totals and a bytes/4 token estimate across all summary snapshots and compaction chunks for the nickname — no file writes. Use this to decide whether a /rehydrate is worth the context spend before invoking export_session_lineage.",
  inputSchema: {
    type: "object",
    properties: {
      nickname: {
        type: "string",
        description: "Session nickname to estimate (e.g., 'dulci', 'ridge')",
      },
    },
    required: ["nickname"],
  },
},

  {
  name: "update_session",
  description:
    "Update a session's metadata — currently supports setting the short summary label and name. Use this to populate session summaries after generating them from session content.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Session UUID — either the database row ID or the original file UUID (both work)",
      },
      summary: {
        type: "string",
        description: "Short summary label for the session (5-15 words describing what was worked on)",
      },
      name: {
        type: "string",
        description: "Session name/title",
      },
    },
    required: ["session_id"],
  },
},

  {
  name: "get_session_by_id",
  description:
    "Lookup a session by any UUID — accepts either the database row ID or the original file UUID. Returns full session metadata (project, assistant, message count, timestamps, summary). Use this after search_sessions to get details about a specific session.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Session UUID — either the database row ID or the original file UUID (both work)",
      },
      include_chunks: {
        type: "boolean",
        description: "Include parsed content chunks (default: false)",
      },
    },
    required: ["session_id"],
  },
},

  {
  name: "find_session_for_area",
  description:
    "Find sessions that have prior context for a topic or feature area. Combines session transcript search (what was discussed), commit-attribution memories (what was built), and active-session liveness. Returns ranked candidates so you can decide whether to (a) live-message an active session, (b) claude --resume an inactive one to leverage its warm context, or (c) just search/read yourself. Pair with get_session_loaded_context to confirm a candidate has touched the relevant files before resuming.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description: "Search query — concept, feature area, file path, or commit subject. 2-4 core terms work best.",
      },
      limit: {
        type: "number",
        description: "Max candidates to return (default: 10)",
      },
      active_only: {
        type: "boolean",
        description: "If true, only return sessions that are currently active (default: false).",
      },
      exclude_session_id: {
        type: "string",
        description: "Optional UUID to exclude (e.g., your own session_id, so you do not propose resuming yourself).",
      },
    },
    required: ["q"],
  },
},

  {
  name: "get_session_loaded_context",
  description:
    "Summarize the working context a session has touched: file paths it has read/edited/written, search patterns, top bash commands, and MCP tool usage. Built by streaming the JSONL tool_use blocks. Useful when deciding whether to resume a prior session (high relevant file count = high cache value) versus re-deriving context from scratch. Pair with find_session_for_area to discover candidates.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Session UUID (file UUID, not the DB row ID).",
      },
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code'). Auto-resolved from sessions DB if omitted.",
      },
      project_dir: {
        type: "string",
        description: "Project identifier: khef project handle, name, or raw directory name. Auto-resolved from sessions DB if omitted.",
      },
    },
    required: ["session_id"],
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "list_session_projects": {
      const fmt = (args.format as string) || "text";
      const result = await client.listSessionProjects(
        args.assistant_handle as string
      );
      return {
        content: [{ type: "text", text: fmt === "text" ? formatSessionProjects(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "list_sessions": {
      const fmt = (args.format as string) || "text";
      const result = await client.listSessions(
        args.assistant_handle as string,
        args.project_dir as string,
        {
          sort: args.sort as string | undefined,
          order: args.order as string | undefined,
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
        }
      );
      return {
        content: [{ type: "text", text: fmt === "text" ? formatSessionList(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "read_session": {
      let assistantHandle = args.assistant_handle as string | undefined;
      let projectDir = args.project_dir as string | undefined;
      const sessionId = args.session_id as string;

      // Auto-resolve assistant_handle and project_dir from sessions DB
      if (!assistantHandle || !projectDir) {
        try {
          const synced = await client.getSyncedSessionByUuid(sessionId);
          const session = (synced as any).session;
          if (session) {
            if (!assistantHandle && session.assistant?.handle) {
              assistantHandle = session.assistant.handle;
            }
            if (!projectDir && session.file_path) {
              // Extract project dir from file_path: /Users/.../.claude/projects/<project_dir>/<uuid>.jsonl
              const parts = (session.file_path as string).split("/");
              const jsonlIndex = parts.findIndex((p: string) => p.endsWith(".jsonl"));
              if (jsonlIndex > 0) {
                projectDir = parts[jsonlIndex - 1];
              }
            }
          }
        } catch {
          // Session not in DB — fall back to defaults
        }
      }

      if (!assistantHandle || !projectDir) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: "Could not resolve assistant_handle and project_dir. Session may not be in the database yet. Provide them explicitly or run trigger_session_sync first."
          }) }],
          isError: true,
        };
      }

      const exportPath = args.export_path as string | undefined;
      const result = await client.readSession(
        assistantHandle,
        projectDir,
        sessionId,
        {
          limit: exportPath ? 10000 : (args.limit as number | undefined),
          offset: args.offset as number | undefined,
        }
      );
      const formatted = formatReadSession(result, {
        includeThinking: args.include_thinking as boolean | undefined,
        includeToolCalls: args.include_tool_calls as boolean | undefined,
      });

      if (exportPath) {
        const dir = path.dirname(exportPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(exportPath, formatted, "utf-8");
        const bytes = Buffer.byteLength(formatted, "utf-8");
        const tokens = Math.round(bytes / 4);
        return {
          content: [{ type: "text", text: `Exported to ${exportPath} (${bytes} bytes, ~${tokens.toLocaleString()} tokens)` }],
        };
      }

      return {
        content: [{ type: "text", text: formatted }],
      };
    }

    case "delete_session": {
      const result = await client.deleteSessionFile(
        args.assistant_handle as string,
        args.project_dir as string,
        args.session_id as string
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "bulk_delete_sessions": {
      const result = await client.bulkDeleteSessions(
        args.assistant_handle as string,
        {
          projectDir: args.projectDir as string | undefined,
          before: args.before as string | undefined,
          sessionIds: args.sessionIds as string[] | undefined,
        }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "sync_session_embeddings": {
      const sessionId = args.session_id as string | undefined;
      const result = await client.syncSessionEmbeddings(
        args.assistant_handle as string,
        {
          projectDir: args.project_dir as string | undefined,
          sessionId,
          force: sessionId ? true : (args.force as boolean | undefined),
        }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "get_session_embedding_status": {
      const result = await client.getSessionEmbeddingStatus(
        args.assistant_handle as string,
        args.project_dir as string | undefined
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "search_sessions": {
      const fmt = (args.format as string) || "text";
      const result = await client.searchSessions(args.q as string, {
        assistantHandle: args.assistant_handle as string | undefined,
        projectDir: args.project_dir as string | undefined,
        sessionId: args.session_id as string | undefined,
        excludeSessionId: args.exclude_session_id as string | undefined,
        limit: args.limit as number | undefined,
        includeThinking: args.include_thinking as boolean | undefined,
        includeToolCalls: args.include_tool_calls as boolean | undefined,
        mode: args.mode as 'keyword' | 'semantic' | 'fulltext' | undefined,
      });
      return {
        content: [{ type: "text", text: fmt === "text" ? formatSessionSearchResults(result, args) : JSON.stringify(result, null, 2) }],
      };
    }

    case "grep_sessions": {
      const fmt = (args.format as string) || "text";
      const result = await client.grepSessions({
        pattern: args.pattern as string,
        is_regex: args.is_regex as boolean | undefined,
        case_sensitive: args.case_sensitive as boolean | undefined,
        session_id: args.session_id as string | undefined,
        nickname: args.nickname as string | undefined,
        project_dir: args.project_dir as string | undefined,
        assistant_handle: args.assistant_handle as string | undefined,
        limit: args.limit as number | undefined,
        context_lines: args.context_lines as number | undefined,
      });
      const text = (result as any)?.text ?? JSON.stringify(result, null, 2);
      return {
        content: [{ type: "text", text: fmt === "text" ? text : JSON.stringify(result, null, 2) }],
      };
    }

    case "list_synced_sessions": {
      const fmt = (args.format as string) || "text";
      const result = await client.listSyncedSessions({
        assistant: args.assistant as string | undefined,
        project: args.project as string | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
      });
      return {
        content: [{ type: "text", text: fmt === "text" ? formatSyncedSessionList(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "get_synced_session": {
      const fmt = (args.format as string) || "text";
      const sessionUuid = args.session_uuid as string | undefined;
      const sessionId = args.id as string | undefined;
      if (!sessionUuid && !sessionId) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Either 'id' or 'session_uuid' must be provided" }) }],
          isError: true,
        };
      }
      const includeChunks = args.include_chunks as boolean | undefined;
      const result = sessionUuid
        ? await client.getSyncedSessionByUuid(sessionUuid, includeChunks)
        : await client.getSyncedSession(sessionId!, includeChunks);
      return {
        content: [{ type: "text", text: fmt === "text" ? formatSyncedSession(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "trigger_session_sync": {
      const result = await client.triggerSessionSync(args.force as boolean | undefined);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "get_session_lineage": {
      const result = await client.getSessionLineage(args.nickname as string);
      return {
        content: [{ type: "text", text: formatSessionLineage(result) }],
      };
    }

    case "export_session_lineage": {
      const result = await client.exportSessionLineage(
        args.nickname as string,
        args.path as string | undefined
      );
      return {
        content: [{ type: "text", text: formatSessionLineageExport(result) }],
      };
    }

    case "get_session_lineage_token_count": {
      const result = await client.getSessionLineageTokenCount(args.nickname as string);
      return {
        content: [{ type: "text", text: formatSessionLineageTokenCount(result) }],
      };
    }

    case "update_session": {
      const sessionId = args.session_id as string;
      const data: { summary?: string; name?: string } = {};
      if (args.summary !== undefined) data.summary = args.summary as string;
      if (args.name !== undefined) data.name = args.name as string;
      const result = await client.updateSession(sessionId, data);
      const session = (result as any)?.session;
      const text = session
        ? `Updated session ${sessionId}:\n  summary: ${session.summary || '(none)'}\n  name: ${session.name || '(none)'}`
        : `Updated session ${sessionId}`;
      return {
        content: [{ type: "text", text }],
      };
    }

    case "get_session_by_id": {
      const fmt = (args.format as string) || "text";
      const includeChunks = args.include_chunks as boolean | undefined;
      const result = await client.getSyncedSession(args.session_id as string, includeChunks);
      return {
        content: [{ type: "text", text: fmt === "text" ? formatSyncedSession(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "find_session_for_area": {
      const q = args.q as string;
      const limit = (args.limit as number | undefined) ?? 10;
      const activeOnly = (args.active_only as boolean | undefined) ?? false;
      const excludeSessionId = args.exclude_session_id as string | undefined;

      const [sessionRes, attribRes, activeRes] = await Promise.all([
        client.searchSessions(q, { mode: 'semantic', limit: limit * 3 }).catch(() => ({ results: [] })),
        client.searchMemories(undefined, { q, type: 'reference', tag: 'session-attribution', limit: 10 }).catch(() => ({ memories: [] })),
        client.scanActiveSessions().catch(() => ({ sessions: [] })),
      ]);

      type Candidate = {
        session_id: string;
        nickname: string | null;
        assistant_handle: string | null;
        project_handle: string | null;
        summary: string | null;
        active: boolean;
        last_seen_at: string | null;
        signals: string[];
        score: number;
        excerpts: string[];
        attribution_memory_ids: string[];
      };

      const byId = new Map<string, Candidate>();

      // 1. Transcript search hits.
      // Search response fields differ between modes: fulltext returns
      // {rank, excerpt, project_handle}; semantic returns {score, content,
      // project_dir}. Normalize both.
      const sessionResults = (sessionRes as any)?.results ?? [];
      for (const r of sessionResults) {
        const sid = r.session_id as string | undefined;
        if (!sid) continue;
        if (excludeSessionId && sid === excludeSessionId) continue;
        const relevance = (r.rank ?? r.score ?? 0) as number;
        const snippet = (r.excerpt ?? r.content ?? '') as string;
        const existing = byId.get(sid);
        if (existing) {
          // Take the max chunk score per session rather than summing — many
          // chunks shouldn't out-weight a strong cross-signal match.
          if (relevance > existing.score) existing.score = relevance;
          if (snippet && existing.excerpts.length < 3) existing.excerpts.push(snippet);
        } else {
          byId.set(sid, {
            session_id: sid,
            nickname: r.nickname ?? null,
            assistant_handle: r.assistant_handle ?? null,
            project_handle: r.project_handle ?? r.project_dir ?? null,
            summary: r.summary ?? null,
            active: false,
            last_seen_at: null,
            signals: ['transcript-match'],
            score: relevance,
            excerpts: snippet ? [snippet] : [],
            attribution_memory_ids: [],
          });
        }
      }

      // 2. Commit-attribution memory hits — extract nickname from handle and
      // attach to candidates with a matching nickname. Boost score for the
      // bridge signal.
      const attribMemories = (attribRes as any)?.memories ?? [];
      const attribByNickname = new Map<string, string[]>();
      for (const m of attribMemories) {
        const handle = String(m.handle ?? '');
        const match = handle.match(/^commit-attribution-(.+)$/);
        if (!match) continue;
        const nick = match[1].toLowerCase();
        const list = attribByNickname.get(nick) ?? [];
        list.push(m.id as string);
        attribByNickname.set(nick, list);
      }
      for (const cand of byId.values()) {
        const nick = cand.nickname?.toLowerCase();
        if (!nick) continue;
        const ids = attribByNickname.get(nick);
        if (ids && ids.length > 0) {
          cand.attribution_memory_ids = ids;
          cand.signals.push('commit-attribution');
          cand.score += 0.25 * ids.length;
        }
      }

      // 3. Active session enrichment
      const activeSessions = (activeRes as any)?.sessions ?? [];
      const activeMap = new Map<string, any>();
      for (const s of activeSessions) {
        if (s.session_id) activeMap.set(s.session_id, s);
      }
      for (const cand of byId.values()) {
        const a = activeMap.get(cand.session_id);
        if (a) {
          cand.active = true;
          cand.last_seen_at = a.last_seen_at ?? null;
          if (!cand.nickname && a.nickname) cand.nickname = a.nickname;
          cand.signals.push('active');
          cand.score += 0.15;
        }
      }

      let candidates = [...byId.values()];
      if (activeOnly) candidates = candidates.filter((c) => c.active);
      candidates.sort((a, b) => b.score - a.score);
      candidates = candidates.slice(0, limit);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            query: q,
            total: candidates.length,
            candidates: candidates.map((c) => ({
              session_id: c.session_id,
              nickname: c.nickname,
              active: c.active,
              project_handle: c.project_handle,
              assistant_handle: c.assistant_handle,
              summary: c.summary,
              last_seen_at: c.last_seen_at,
              signals: c.signals,
              score: Math.round(c.score * 1000) / 1000,
              attribution_memory_ids: c.attribution_memory_ids,
              excerpts: c.excerpts,
            })),
          }, null, 2),
        }],
      };
    }

    case "get_session_loaded_context": {
      let assistantHandle = args.assistant_handle as string | undefined;
      let projectDir = args.project_dir as string | undefined;
      const sessionId = args.session_id as string;

      if (!assistantHandle || !projectDir) {
        try {
          const synced = await client.getSyncedSessionByUuid(sessionId);
          const session = (synced as any).session;
          if (session) {
            if (!assistantHandle && session.assistant?.handle) {
              assistantHandle = session.assistant.handle;
            }
            if (!projectDir && session.file_path) {
              const parts = (session.file_path as string).split("/");
              const jsonlIndex = parts.findIndex((p: string) => p.endsWith(".jsonl"));
              if (jsonlIndex > 0) projectDir = parts[jsonlIndex - 1];
            }
          }
        } catch {
          // Session not in DB — caller can pass explicit handle/projectDir
        }
      }

      if (!assistantHandle || !projectDir) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: "Could not resolve assistant_handle and project_dir. Session may not be in the database yet. Provide them explicitly or run trigger_session_sync first."
          }) }],
          isError: true,
        };
      }

      const result = await client.getSessionLoadedContext(assistantHandle, projectDir, sessionId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      return null;
  }
}
