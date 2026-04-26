import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatPromptList, formatPrompt } from "../formatters/prompts.js";

export const tools: Tool[] = [
  {
  name: "list_prompts",
  description:
    "List prompts with optional filtering. Returns compact summaries (title, handle, description excerpt). Use get_prompt to fetch full content for a specific prompt.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description: "Search by title, handle, or description (case-insensitive partial match)",
      },
      assistant: {
        type: "string",
        description: "Filter by assistant handle (e.g., 'claude-code')",
      },
      type: {
        type: "string",
        description: "Filter by prompt type (e.g., 'agent', 'command', 'prompt')",
      },
      limit: {
        type: "number",
        description: "Results per page (default: 50)",
      },
      offset: {
        type: "number",
        description: "Results to skip (default: 0)",
      },
    },
  },
},

  {
  name: "get_prompt",
  description:
    "Get a prompt by UUID. Returns full content, assistant associations, and current snapshot number.",
  inputSchema: {
    type: "object",
    properties: {
      prompt_id: {
        type: "string",
        description: "Prompt UUID",
      },
    },
    required: ["prompt_id"],
  },
},

  {
  name: "create_prompt",
  description:
    "Create a new prompt with a unique handle. Optionally associate with assistants.",
  inputSchema: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description: "Unique kebab-case handle for the prompt",
      },
      title: {
        type: "string",
        description: "Display title",
      },
      content: {
        type: "string",
        description: "Prompt content (markdown)",
      },
      description: {
        type: "string",
        description: "Short description of the prompt's purpose",
      },
      assistants: {
        type: "array",
        description: "Assistant associations to create",
        items: {
          type: "object",
          properties: {
            assistant_handle: {
              type: "string",
              description: "Assistant handle (e.g., 'claude-code')",
            },
            prompt_type: {
              type: "string",
              description: "Prompt type: 'agent', 'command', or 'prompt'",
            },
            source_path: {
              type: "string",
              description: "Optional file path on disk for sync",
            },
          },
          required: ["assistant_handle", "prompt_type"],
        },
      },
    },
    required: ["handle", "title", "content"],
  },
},

  {
  name: "update_prompt",
  description:
    "Update a prompt's title, content, or description. Auto-creates a snapshot when content changes (disable with snapshot=false).",
  inputSchema: {
    type: "object",
    properties: {
      prompt_id: {
        type: "string",
        description: "Prompt UUID",
      },
      title: {
        type: "string",
        description: "New title",
      },
      content: {
        type: "string",
        description: "New content",
      },
      description: {
        type: "string",
        description: "New description",
      },
      snapshot: {
        type: "boolean",
        description: "Auto-snapshot on content change (default: true)",
      },
    },
    required: ["prompt_id"],
  },
},

  {
  name: "delete_prompt",
  description:
    "Delete a prompt and all its associations and snapshots.",
  inputSchema: {
    type: "object",
    properties: {
      prompt_id: {
        type: "string",
        description: "Prompt UUID to delete",
      },
    },
    required: ["prompt_id"],
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "list_prompts": {
      const result = await client.listPrompts({
        q: args.q as string | undefined,
        assistant: args.assistant as string | undefined,
        type: args.type as string | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
      });
      return {
        content: [{ type: "text", text: formatPromptList(result) }],
      };
    }

    case "get_prompt": {
      const fmt = (args.format as string) || "text";
      const result = await client.getPrompt(args.prompt_id as string);
      return {
        content: [{ type: "text", text: fmt === "text" ? formatPrompt(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "create_prompt": {
      const result = await client.createPrompt(
        args.handle as string,
        args.title as string,
        args.content as string,
        args.description as string | undefined,
        args.assistants as Array<{
          assistant_handle: string;
          prompt_type: string;
          source_path?: string;
        }> | undefined,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "update_prompt": {
      const result = await client.updatePrompt(
        args.prompt_id as string,
        {
          title: args.title as string | undefined,
          content: args.content as string | undefined,
          description: args.description as string | undefined,
          snapshot: args.snapshot as boolean | undefined,
        },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "delete_prompt": {
      const result = await client.deletePrompt(args.prompt_id as string);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      return null;
  }
}
