import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatCommitList, formatDiffComments, formatDiff, formatCommitComments } from "../formatters/diffs.js";

export const tools: Tool[] = [
  {
  name: "get_commits",
  description:
    "Get commit history for a project. Returns recent commits with SHA, message, author, and date.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project handle, name, or UUID",
      },
      branch: {
        type: "string",
        description: "Branch name (default: current branch)",
      },
      limit: {
        type: "number",
        description: "Max commits to return (default: 20)",
      },
      path: {
        type: "string",
        description: "Filter commits to specific file/directory path",
      },
    },
    required: ["project_id"],
  },
},

  {
  name: "get_diff",
  description:
    "Get diff content for a specific commit or working tree. Returns unified diff format with stats.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project handle, name, or UUID",
      },
      commit_sha: {
        type: "string",
        description: "Commit SHA to get diff for (omit for working tree changes)",
      },
      path: {
        type: "string",
        description: "Filter diff to specific file/directory path",
      },
    },
    required: ["project_id"],
  },
},

  {
  name: "annotate_commit",
  description:
    "Add a review comment to a specific commit's diff. Creates a diff record if needed and attaches the comment. Use anchor_path and anchor_line for file/line anchoring, or anchor_text for text-based anchoring.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project handle, name, or UUID",
      },
      commit_sha: {
        type: "string",
        description: "Commit SHA to annotate",
      },
      content: {
        type: "string",
        description: "Comment content",
      },
      anchor_path: {
        type: "string",
        description: "File path in the diff to anchor comment to (e.g., 'src/routes/git.ts')",
      },
      anchor_line: {
        type: "number",
        description: "Line index in the diff to anchor comment to",
      },
      anchor_text: {
        type: "string",
        description: "Exact text in the diff to anchor the comment to (alternative to path/line)",
      },
      anchor_prefix: {
        type: "string",
        description: "Context before anchor_text for disambiguation",
      },
      anchor_suffix: {
        type: "string",
        description: "Context after anchor_text for disambiguation",
      },
      path: {
        type: "string",
        description: "Filter diff to specific file path",
      },
    },
    required: ["project_id", "commit_sha", "content"],
  },
},

  {
  name: "comment_working_diff",
  description:
    "Add a review comment to the current working diff (uncommitted changes). Creates a working diff record if needed. Use anchor_path and anchor_line for file/line anchoring, or anchor_text for text-based anchoring.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project handle, name, or UUID",
      },
      content: {
        type: "string",
        description: "Comment content",
      },
      anchor_path: {
        type: "string",
        description: "File path in the diff to anchor comment to (e.g., 'src/routes/git.ts')",
      },
      anchor_line: {
        type: "number",
        description: "Line index in the diff to anchor comment to",
      },
      anchor_text: {
        type: "string",
        description: "Exact text in the diff to anchor the comment to (alternative to path/line)",
      },
      anchor_prefix: {
        type: "string",
        description: "Context before anchor_text for disambiguation",
      },
      anchor_suffix: {
        type: "string",
        description: "Context after anchor_text for disambiguation",
      },
      path: {
        type: "string",
        description: "Filter diff to specific file path",
      },
    },
    required: ["project_id", "content"],
  },
},

  {
  name: "get_commit_comments",
  description:
    "Get all review comments for a specific commit. Returns empty array if no comments exist.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project handle, name, or UUID",
      },
      commit_sha: {
        type: "string",
        description: "Commit SHA to get comments for",
      },
      path: {
        type: "string",
        description: "Filter to specific file path",
      },
    },
    required: ["project_id", "commit_sha"],
  },
},

  {
  name: "get_diff_comments",
  description:
    "Get diff record and comments by ref. Use 'working' for uncommitted changes, or a commit SHA (short 7+ chars or full 40 chars).",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project handle, name, or UUID",
      },
      ref: {
        type: "string",
        description: "Git ref: 'working' for uncommitted changes, or commit SHA (short or full)",
      },
      path: {
        type: "string",
        description: "Filter to specific file path",
      },
    },
    required: ["project_id", "ref"],
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "get_commits": {
      const fmt = (args.format as string) || "text";
      const result = await client.getCommits(args.project_id as string, {
        branch: args.branch as string | undefined,
        limit: args.limit as number | undefined,
        path: args.path as string | undefined,
      });
      return {
        content: [{ type: "text", text: fmt === "text" ? formatCommitList(result, args) : JSON.stringify(result, null, 2) }],
      };
    }

    case "get_diff": {
      const fmt = (args.format as string) || "text";
      const result = await client.getDiff(
        args.project_id as string,
        args.commit_sha as string | undefined,
        args.path as string | undefined
      );
      return {
        content: [{ type: "text", text: fmt === "text" ? formatDiff(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "annotate_commit": {
      const result = await client.annotateDiff(
        args.project_id as string,
        args.commit_sha as string,
        {
          content: args.content as string,
          author: 'claude-code',
          anchor_path: args.anchor_path as string | undefined,
          anchor_line: args.anchor_line as number | undefined,
          anchor_text: args.anchor_text as string | undefined,
          anchor_prefix: args.anchor_prefix as string | undefined,
          anchor_suffix: args.anchor_suffix as string | undefined,
        },
        args.path as string | undefined
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "comment_working_diff": {
      const result = await client.annotateDiff(
        args.project_id as string,
        "working",
        {
          content: args.content as string,
          author: 'claude-code',
          anchor_path: args.anchor_path as string | undefined,
          anchor_line: args.anchor_line as number | undefined,
          anchor_text: args.anchor_text as string | undefined,
          anchor_prefix: args.anchor_prefix as string | undefined,
          anchor_suffix: args.anchor_suffix as string | undefined,
        },
        args.path as string | undefined
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "get_commit_comments": {
      const fmt = (args.format as string) || "text";
      const result = await client.getCommitComments(
        args.project_id as string,
        args.commit_sha as string,
        args.path as string | undefined
      );
      return {
        content: [{ type: "text", text: fmt === "text" ? formatCommitComments(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "get_diff_comments": {
      const fmt = (args.format as string) || "text";
      const result = await client.getDiffByRef(
        args.project_id as string,
        args.ref as string,
        args.path as string | undefined
      );
      return {
        content: [{ type: "text", text: fmt === "text" ? formatDiffComments(result) : JSON.stringify(result, null, 2) }],
      };
    }

    default:
      return null;
  }
}
