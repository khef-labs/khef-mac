import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatSourceResults, formatCommitSearchResults, formatSessionSummary, formatSourceFileView } from "../formatters/source-code.js";

export const tools: Tool[] = [
  {
  name: "search_source_code",
  description:
    "Semantic search across indexed source code files using vector embeddings. Returns matching code chunks with file paths, language, and similarity scores. Requires the kvec-source collection to be populated via the ingest script.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description: "Natural language search query",
      },
      language: {
        type: "string",
        description: "Filter by programming language (e.g., 'typescript', 'python')",
      },
      repo: {
        type: "string",
        description: "Filter by repository name",
      },
      branch: {
        type: "string",
        description: "Filter by git branch name",
      },
      commit: {
        type: "string",
        description: "Filter by git commit hash",
      },
      limit: {
        type: "number",
        description: "Max results (default: 10)",
      },
      min_score: {
        type: "number",
        description: "Minimum similarity score 0-1 (default: 0)",
      },
      view: {
        type: "string",
        enum: ["grouped", "all"],
        description: "Text output presentation mode. 'grouped' (default) shows top matches per file; 'all' shows all chunks.",
      },
      group_by_file: {
        type: "boolean",
        description: "Group results by file in text output (default: true). Does not affect JSON output.",
      },
      max_per_file: {
        type: "number",
        description: "Max matches to show per file in text output when grouping (default: 1).",
      },
      context: {
        type: "number",
        description: "Number of neighboring chunks to include before/after each match for surrounding context (0-3, default: 1). Use 0 to disable, 2-3 for broader context.",
      },
    },
    required: ["q"],
  },
},

  {
  name: "view_source_code_file",
  description:
    "View a source file, either by kvec-indexed `repo` + repo-relative `path`, or by absolute `abs_path` (must resolve inside $HOME; leading `~` is expanded). Supports optional 1-based start/end line slice and an optional git ref; with `ref`, reads via `git show <ref>:<path>` without touching the working tree. Use `abs_path` for files in un-indexed repos or outside any repo.",
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: "Repo name as indexed in kvec-source (e.g., 'khef'). Required with `path`; mutually exclusive with `abs_path`.",
      },
      path: {
        type: "string",
        description: "Repo-relative file path (e.g., 'apps/api/src/routes/vector-search.ts'). Required with `repo`; mutually exclusive with `abs_path`.",
      },
      abs_path: {
        type: "string",
        description: "Absolute file path (e.g., '/Users/me/projects/foo/src/bar.ts'). Leading `~` is expanded to $HOME. Must resolve inside $HOME. Mutually exclusive with `repo`+`path`.",
      },
      start: {
        type: "number",
        description: "1-based start line (inclusive). Defaults to 1.",
      },
      end: {
        type: "number",
        description: "1-based end line (inclusive). Defaults to end of file.",
      },
      ref: {
        type: "string",
        description: "Optional git ref (branch, tag, or commit). When set, reads the file at that ref via `git show` without checking out. Works with both `repo`+`path` and `abs_path` (git root is auto-detected in abs_path mode).",
      },
    },
  },
},

  {
  name: "search_commits",
  description:
    "Semantic search across indexed git commit messages using vector embeddings. Returns matching commits with SHA, message, author, date, repo, and similarity scores. Requires the kvec-commits collection to be populated via an embed job.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description: "Natural language search query (e.g., 'retry logic', 'auth refactor')",
      },
      repo: {
        type: "string",
        description: "Filter by repository name",
      },
      author: {
        type: "string",
        description: "Filter by author name (case-insensitive partial match)",
      },
      since: {
        type: "string",
        description: "Filter commits after this date (ISO 8601, e.g., '2026-01-01')",
      },
      until: {
        type: "string",
        description: "Filter commits before this date (ISO 8601)",
      },
      branch: {
        type: "string",
        description: "Filter by git branch name",
      },
      limit: {
        type: "number",
        description: "Max results (default: 20, max: 100)",
      },
      offset: {
        type: "number",
        description: "Pagination offset (default: 0)",
      },
      min_score: {
        type: "number",
        description: "Minimum similarity score 0-1 (default: 0)",
      },
    },
    required: ["q"],
  },
},

  {
  name: "get_session_summary",
  description:
    "Get the AI-generated summary for a session. Accepts a session database row ID, original session file UUID, or snapshot UUID. Returns summary content, snapshot metadata, and latest job run status.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Session database row ID, or snapshot UUID — the endpoint resolves all three",
      },
      session_uuid: {
        type: "string",
        description: "Original session file UUID (from the JSONL filename)",
      },
    },
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "search_source_code": {
      const fmt = (args.format as string) || "text";
      const result = await client.searchSourceCode({
        q: args.q as string,
        language: args.language as string | undefined,
        repo: args.repo as string | undefined,
        branch: args.branch as string | undefined,
        commit: args.commit as string | undefined,
        limit: args.limit as number | undefined,
        min_score: args.min_score as number | undefined,
        context: args.context as number | undefined,
      });
      return {
        content: [{ type: "text", text: fmt === "text" ? formatSourceResults(result, args) : JSON.stringify(result, null, 2) }],
      };
    }

    case "view_source_code_file": {
      const fmt = (args.format as string) || "text";
      const result = await client.viewSourceCodeFile({
        repo: args.repo as string | undefined,
        path: args.path as string | undefined,
        abs_path: args.abs_path as string | undefined,
        start: args.start as number | undefined,
        end: args.end as number | undefined,
        ref: args.ref as string | undefined,
      });
      return {
        content: [{ type: "text", text: fmt === "text" ? formatSourceFileView(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "search_commits": {
      const fmt = (args.format as string) || "text";
      const result = await client.searchCommits({
        q: args.q as string,
        repo: args.repo as string | undefined,
        author: args.author as string | undefined,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        branch: args.branch as string | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
        min_score: args.min_score as number | undefined,
      });
      return {
        content: [{ type: "text", text: fmt === "text" ? formatCommitSearchResults(result, args) : JSON.stringify(result, null, 2) }],
      };
    }

    case "get_session_summary": {
      const sessionUuid = args.session_uuid as string | undefined;
      const sessionId = args.id as string | undefined;
      if (!sessionUuid && !sessionId) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Either 'id' or 'session_uuid' must be provided" }) }],
          isError: true,
        };
      }
      // Resolve session_uuid to DB id if needed
      let dbId = sessionId;
      if (sessionUuid && !sessionId) {
        const session = await client.getSyncedSessionByUuid(sessionUuid);
        if (session?.session?.id) {
          dbId = session.session.id;
        } else {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: `Session not found for UUID: ${sessionUuid}` }) }],
            isError: true,
          };
        }
      }
      const fmt = (args.format as string) || "text";
      try {
        const result = await client.getSessionSummary(dbId!);
        return {
          content: [{ type: "text", text: fmt === "text" ? formatSessionSummary(result) : JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        if (err.message?.includes('404')) {
          return {
            content: [{ type: "text", text: JSON.stringify({ summary: null, job: null, message: "No summary found for this session" }) }],
          };
        }
        throw err;
      }
    }

    default:
      return null;
  }
}
