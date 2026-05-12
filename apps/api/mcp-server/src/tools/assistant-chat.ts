import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatChatResponse, formatChatList, formatChat } from "../formatters/assistant-chat.js";

export const tools: Tool[] = [
  {
  name: "assistant_chat",
  description:
    "Send a chat message to an assistant backend (claude-code, codex-cli, gemini). Auto-creates a persistent chat if no chat_id is provided. Include previous messages for multi-turn context. Returns the assistant's response and persisted message.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Backend to chat with: 'claude-code', 'codex-cli', or 'gemini'",
      },
      prompt_text: {
        type: "string",
        description: "The current message/question to send",
      },
      messages: {
        type: "array",
        description: "Previous conversation turns for context (optional). Each item has role ('user'|'assistant') and content.",
        items: {
          type: "object",
          properties: {
            role: { type: "string", description: "'user' or 'assistant'" },
            content: { type: "string" },
          },
          required: ["role", "content"],
        },
      },
      model: {
        type: "string",
        description: "Optional model override (e.g., 'gemini-2.5-pro', 'claude-opus-4-7')",
      },
      chat_id: {
        type: "string",
        description: "Existing chat UUID to continue. If omitted, a new chat is created.",
      },
      parent_turn_id: {
        type: "string",
        description: "Parent turn UUID. Set when delegating to another backend so the child chat is linked to the exact turn that triggered the delegation.",
      },
      project_id: {
        type: "string",
        description: "Project handle, name, or UUID to associate with a new chat (ignored if chat_id is provided)",
      },
      title: {
        type: "string",
        description: "Title for a new chat (ignored if chat_id is provided)",
      },
      caller_handle: {
        type: "string",
        description: "Handle of the assistant making this MCP call (e.g., 'claude-code', 'codex-cli'). Stored on new chats to identify who initiated the conversation.",
      },
      use_google_search: {
        type: "boolean",
        description: "Enable Google Search grounding (Gemini only)",
      },
      use_url_context: {
        type: "boolean",
        description: "Enable URL context fetching (Gemini only). Gemini fetches the URLs referenced in the prompt and grounds its response on their actual content. The response includes a url_context.fetched array listing each URL and its retrieval status — use this to verify claims about web pages, YouTube videos, or other URL-addressable resources instead of trusting the model's prior.",
      },
      use_thinking: {
        type: "boolean",
        description: "Enable thinking mode (Gemini only)",
      },
      thinking_budget: {
        type: "number",
        description: "Token budget for thinking (Gemini only, requires use_thinking)",
      },
    },
    required: ["assistant_handle", "prompt_text"],
  },
},

  {
  name: "list_assistant_chats",
  description:
    "List persistent chats for an assistant backend. Returns chats with message counts, paginated.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code', 'gemini')",
      },
      project_id: {
        type: "string",
        description: "Filter by project (handle, name, or UUID)",
      },
      limit: { type: "number", description: "Max results (default 20, max 100)" },
      offset: { type: "number", description: "Pagination offset" },
    },
    required: ["assistant_handle"],
  },
},

  {
  name: "get_assistant_chat",
  description:
    "Get a specific chat with optional messages included. Chat ID is globally unique so assistant_handle is optional.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code', 'gemini'). Optional — chat_id is globally unique.",
      },
      chat_id: {
        type: "string",
        description: "Chat UUID",
      },
      include_messages: {
        type: "boolean",
        description: "Include all messages in response (default false)",
      },
    },
    required: ["chat_id"],
  },
},

  {
  name: "delete_assistant_chat",
  description:
    "Delete a chat and all its messages. Chat ID is globally unique so assistant_handle is optional.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code', 'gemini'). Optional — chat_id is globally unique.",
      },
      chat_id: {
        type: "string",
        description: "Chat UUID to delete",
      },
    },
    required: ["chat_id"],
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "assistant_chat": {
      const fmt = (args.format as string) || "text";
      const result = await client.assistantChat(
        args.assistant_handle as string,
        args.prompt_text as string,
        args.messages as Array<{ role: string; content: string }> | undefined,
        args.model as string | undefined,
        args.chat_id as string | undefined,
        args.parent_turn_id as string | undefined,
        args.project_id as string | undefined,
        args.title as string | undefined,
        args.caller_handle as string | undefined,
        args.use_google_search as boolean | undefined,
        args.use_thinking as boolean | undefined,
        args.thinking_budget as number | undefined,
        args.use_url_context as boolean | undefined,
      );
      return {
        content: [{ type: "text", text: fmt === "text" ? formatChatResponse(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "list_assistant_chats": {
      const fmt = (args.format as string) || "text";
      const result = await client.listAssistantChats(
        args.assistant_handle as string,
        args.project_id as string | undefined,
        args.limit as number | undefined,
        args.offset as number | undefined,
      );
      return {
        content: [{ type: "text", text: fmt === "text" ? formatChatList(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "get_assistant_chat": {
      const fmt = (args.format as string) || "text";
      const result = await client.getAssistantChat(
        args.assistant_handle as string | undefined,
        args.chat_id as string,
        args.include_messages as boolean | undefined,
      );
      return {
        content: [{ type: "text", text: fmt === "text" ? formatChat(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "delete_assistant_chat": {
      const result = await client.deleteAssistantChat(
        args.assistant_handle as string | undefined,
        args.chat_id as string,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      return null;
  }
}
