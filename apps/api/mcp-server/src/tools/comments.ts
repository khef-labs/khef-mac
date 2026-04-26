import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatCommentList, formatComment } from "../formatters/comments.js";

export const tools: Tool[] = [
  {
  name: "list_comments",
  description:
    "List comments for a memory or plan. Provide either memory_id OR plan_id (not both). Returns paginated comments with optional status filtering and ordering. Comments can be anchored to specific text in the content.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID) - provide this OR plan_id",
      },
      plan_id: {
        type: "string",
        description: "Plan ID (UUID) - provide this OR memory_id",
      },
      limit: {
        type: "number",
        description: "Number of results per page (default: 20, max: 100)",
      },
      offset: {
        type: "number",
        description: "Number of results to skip (default: 0)",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort order by created_at (default: asc)",
      },
      status: {
        type: "string",
        enum: ["active", "orphaned", "resolved"],
        description: "Filter by comment status",
      },
    },
    required: [],
  },
},

  {
  name: "create_comment",
  description:
    "Create a comment on a memory or plan. Content is required. Provide either memory_id OR plan_id (not both). Optionally anchor the comment to specific text using anchor_text with prefix/suffix for disambiguation. Use parent_comment_id to create a reply (1 level nesting only).",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID) - provide this OR plan_id",
      },
      plan_id: {
        type: "string",
        description: "Plan ID (UUID) - provide this OR memory_id",
      },
      content: {
        type: "string",
        description: "Comment content (max 5000 characters)",
      },
      author: {
        type: "string",
        enum: ["user", "claude-code", "codex-cli"],
        description: "Comment author: 'user' (human) or assistant handle (default: 'user')",
      },
      parent_comment_id: {
        type: "string",
        description: "Parent comment ID for replies (UUID, optional). Replies cannot have replies (1 level nesting only).",
      },
      anchor_text: {
        type: "string",
        description: "Text excerpt from content to anchor the comment to (max 500 chars, optional)",
      },
      anchor_prefix: {
        type: "string",
        description: "Text immediately before anchor_text for disambiguation (max 128 chars, optional)",
      },
      anchor_suffix: {
        type: "string",
        description: "Text immediately after anchor_text for disambiguation (max 128 chars, optional)",
      },
    },
    required: ["content"],
  },
},

  {
  name: "update_comment",
  description:
    "Update a comment on a memory or plan. Provide either memory_id OR plan_id (not both). Can modify content, anchor fields, or status. At least one field is required.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID) - provide this OR plan_id",
      },
      plan_id: {
        type: "string",
        description: "Plan ID (UUID) - provide this OR memory_id",
      },
      comment_id: {
        type: "string",
        description: "Comment ID (UUID)",
      },
      content: {
        type: "string",
        description: "New comment content (max 5000 characters)",
      },
      anchor_text: {
        type: "string",
        description: "Updated anchor text excerpt",
      },
      anchor_prefix: {
        type: "string",
        description: "Updated anchor prefix",
      },
      anchor_suffix: {
        type: "string",
        description: "Updated anchor suffix",
      },
      status: {
        type: "string",
        enum: ["active", "orphaned", "resolved"],
        description: "New comment status",
      },
    },
    required: ["comment_id"],
  },
},

  {
  name: "delete_comment",
  description:
    "Delete a comment from a memory or plan. Provide either memory_id OR plan_id (not both). This permanently removes the comment.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID) - provide this OR plan_id",
      },
      plan_id: {
        type: "string",
        description: "Plan ID (UUID) - provide this OR memory_id",
      },
      comment_id: {
        type: "string",
        description: "Comment ID (UUID) to delete",
      },
    },
    required: ["comment_id"],
  },
},

  {
  name: "delete_comments",
  description:
    "Delete comments for a memory. Provide status to delete a subset, or confirm=true to delete all.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID) the comments belong to",
      },
      status: {
        type: "string",
        description: "Comment status to delete (active, orphaned, resolved)",
      },
      confirm: {
        type: "boolean",
        description: "Set true to delete all comments when status is omitted",
      },
    },
    required: ["memory_id"],
  },
},

  {
  name: "get_comment_by_id",
  description:
    "Fetch a comment by its ID without knowing the parent entity. Returns the comment with entity_type and entity_id to identify the parent.",
  inputSchema: {
    type: "object",
    properties: {
      comment_id: {
        type: "string",
        description: "Comment ID (UUID)",
      },
    },
    required: ["comment_id"],
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "list_comments": {
      const memoryId = args.memory_id as string | undefined;
      const planId = args.plan_id as string | undefined;
      const fmt = (args.format as string) || "text";

      if (!memoryId && !planId) {
        throw new Error("Either memory_id or plan_id is required");
      }
      if (memoryId && planId) {
        throw new Error("Provide either memory_id or plan_id, not both");
      }

      const options = {
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
        order: args.order as string | undefined,
        status: args.status as string | undefined,
      };

      const result = memoryId
        ? await client.listComments(memoryId, options)
        : await client.listPlanComments(planId!, options);

      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? formatCommentList(result) : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "create_comment": {
      const memoryId = args.memory_id as string | undefined;
      const planId = args.plan_id as string | undefined;

      if (!memoryId && !planId) {
        throw new Error("Either memory_id or plan_id is required");
      }
      if (memoryId && planId) {
        throw new Error("Provide either memory_id or plan_id, not both");
      }

      const result = memoryId
        ? await client.createComment(
            memoryId,
            args.content as string,
            args.author as string | undefined,
            args.parent_comment_id as string | undefined,
            args.anchor_text as string | undefined,
            args.anchor_prefix as string | undefined,
            args.anchor_suffix as string | undefined
          )
        : await client.createPlanComment(
            planId!,
            args.content as string,
            args.author as string | undefined,
            args.parent_comment_id as string | undefined,
            args.anchor_text as string | undefined,
            args.anchor_prefix as string | undefined,
            args.anchor_suffix as string | undefined
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

    case "update_comment": {
      const memoryId = args.memory_id as string | undefined;
      const planId = args.plan_id as string | undefined;

      if (!memoryId && !planId) {
        throw new Error("Either memory_id or plan_id is required");
      }
      if (memoryId && planId) {
        throw new Error("Provide either memory_id or plan_id, not both");
      }

      const updates: Record<string, string | undefined> = {};
      if (args.content !== undefined) updates.content = args.content as string;
      if (args.anchor_text !== undefined) updates.anchor_text = args.anchor_text as string;
      if (args.anchor_prefix !== undefined) updates.anchor_prefix = args.anchor_prefix as string;
      if (args.anchor_suffix !== undefined) updates.anchor_suffix = args.anchor_suffix as string;
      if (args.status !== undefined) updates.status = args.status as string;

      const result = memoryId
        ? await client.updateComment(memoryId, args.comment_id as string, updates)
        : await client.updatePlanComment(planId!, args.comment_id as string, updates);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "delete_comment": {
      const memoryId = args.memory_id as string | undefined;
      const planId = args.plan_id as string | undefined;

      if (!memoryId && !planId) {
        throw new Error("Either memory_id or plan_id is required");
      }
      if (memoryId && planId) {
        throw new Error("Provide either memory_id or plan_id, not both");
      }

      const result = memoryId
        ? await client.deleteComment(memoryId, args.comment_id as string)
        : await client.deletePlanComment(planId!, args.comment_id as string);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "delete_comments": {
      const result = await client.deleteComments(
        args.memory_id as string,
        {
          status: args.status as string | undefined,
          confirm: args.confirm as boolean | undefined,
        }
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

    case "get_comment_by_id": {
      const fmt = (args.format as string) || "text";
      const result = await client.getCommentById(args.comment_id as string);
      return {
        content: [{ type: "text", text: fmt === "text" ? formatComment(result) : JSON.stringify(result, null, 2) }],
      };
    }

    default:
      return null;
  }
}
