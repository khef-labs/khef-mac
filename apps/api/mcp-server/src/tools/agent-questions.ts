import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import {
  formatQuestionCreated,
  formatAnswer,
  formatPendingList,
  formatCanceled,
} from "../formatters/agent-questions.js";

const FIELDS_SCHEMA_DESCRIPTION =
  "Array of fields. Each field: { key, type, label, required?, hint?, placeholder?, default?, min?, max?, options?[] }. Types: 'single-choice', 'multi-choice', 'text', 'textarea', 'number', 'toggle'. For choice types, options must be a non-empty array of { value, label, hint? }.";

export const tools: Tool[] = [
  {
    name: "ask_user_question",
    description:
      "Post a structured question to the user via the khef UI panel and return immediately. The answer is delivered to your session as a live message when the user submits — check check_live_messages or wait for the next user prompt. Pass `nickname` (or `session_id`) so the answer can be routed back to you. Use this instead of dumping multi-part questions into chat: keeps the conversation clean and gives you structured answers without blocking. Set `wait=true` only if you must block right now (e.g., you cannot make any progress without the answer).",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short question title shown at the top of the panel (max 200 chars).",
        },
        description: {
          type: "string",
          description: "Optional context paragraph rendered above the form (markdown allowed).",
        },
        fields: {
          type: "array",
          description: FIELDS_SCHEMA_DESCRIPTION,
        },
        nickname: {
          type: "string",
          description: "Your session nickname. REQUIRED for live-message delivery of the answer — without this (or session_id) the answer cannot be routed back to your session.",
        },
        session_id: {
          type: "string",
          description: "Your session UUID. Alternative to nickname for live-message delivery.",
        },
        assistant_handle: {
          type: "string",
          description: "Assistant identifier, e.g. 'claude-code' or 'codex-cli'.",
        },
        ttl_seconds: {
          type: "number",
          description: "Time-to-live in seconds before the question auto-expires (default 600, max 86400).",
        },
        wait: {
          type: "boolean",
          description: "If true, block until the user answers, cancels, or the timeout fires. Default false — returns immediately and the answer arrives as a live message. Only use wait=true when you genuinely cannot continue without the answer.",
        },
        timeout_ms: {
          type: "number",
          description: "When wait=true, max ms to wait for resolution (default 600000 = 10 min, max 3600000 = 1 hour).",
        },
      },
      required: ["title", "fields"],
    },
  },
  {
    name: "get_user_answer",
    description:
      "Fetch the answer for a previously posted question by id. Use after ask_user_question with wait=false. Long-polls until the answer arrives, the question is canceled, or the timeout fires.",
    inputSchema: {
      type: "object",
      properties: {
        question_id: {
          type: "string",
          description: "The id returned by ask_user_question.",
        },
        wait: {
          type: "boolean",
          description: "If true (default), block until the user responds or the timeout fires. If false, return immediately.",
        },
        timeout_ms: {
          type: "number",
          description: "When wait=true, max ms to wait (default 60000 = 1 min, max 3600000 = 1 hour).",
        },
      },
      required: ["question_id"],
    },
  },
  {
    name: "cancel_user_question",
    description:
      "Cancel a pending question that the agent no longer needs answered (e.g., it figured out the answer another way).",
    inputSchema: {
      type: "object",
      properties: {
        question_id: {
          type: "string",
          description: "The id returned by ask_user_question.",
        },
      },
      required: ["question_id"],
    },
  },
  {
    name: "list_pending_user_questions",
    description:
      "List currently pending agent questions. Useful for debugging and observability.",
    inputSchema: {
      type: "object",
      properties: {
        nickname: {
          type: "string",
          description: "Filter to questions posted by a specific session nickname.",
        },
        limit: {
          type: "number",
          description: "Max questions to return (default 50, max 200).",
        },
      },
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
    case "ask_user_question": {
      const title = typeof args.title === "string" ? args.title : "";
      const fields = args.fields;
      if (!title || !Array.isArray(fields)) {
        return {
          content: [
            { type: "text", text: "Missing required params: title (string) and fields (array)." },
          ],
          isError: true,
        };
      }

      const agent: Record<string, string> = {};
      if (typeof args.nickname === "string" && args.nickname) agent.nickname = args.nickname;
      if (typeof args.session_id === "string" && args.session_id) agent.session_id = args.session_id;
      if (typeof args.assistant_handle === "string" && args.assistant_handle) {
        agent.assistant_handle = args.assistant_handle;
      }

      const created = await client.createAgentQuestion({
        title,
        description: typeof args.description === "string" ? args.description : undefined,
        fields,
        agent: Object.keys(agent).length > 0 ? agent : undefined,
        ttl_seconds: typeof args.ttl_seconds === "number" ? args.ttl_seconds : undefined,
      });

      // Default to async — the answer arrives as a live message.
      const wait = Boolean(args.wait);
      if (!wait) {
        return {
          content: [{ type: "text", text: formatQuestionCreated(created) }],
        };
      }

      const timeoutMs = Math.min(
        Math.max(typeof args.timeout_ms === "number" ? args.timeout_ms : 600_000, 1000),
        3_600_000,
      );

      const waited = await client.waitForAgentAnswer(created.question.id, timeoutMs);
      const header = formatQuestionCreated(created);
      const body = formatAnswer(waited, created.question.id);
      return {
        content: [{ type: "text", text: `${header}\n\n${body}` }],
      };
    }

    case "get_user_answer": {
      const id = typeof args.question_id === "string" ? args.question_id : "";
      if (!id) {
        return {
          content: [{ type: "text", text: "Missing required param: question_id" }],
          isError: true,
        };
      }
      const wait = args.wait === undefined ? true : Boolean(args.wait);
      const timeoutMs = Math.min(
        Math.max(typeof args.timeout_ms === "number" ? args.timeout_ms : 60_000, 100),
        3_600_000,
      );

      if (!wait) {
        const result = await client.getAgentQuestion(id);
        return {
          content: [{ type: "text", text: formatAnswer(result, id) }],
        };
      }

      const waited = await client.waitForAgentAnswer(id, timeoutMs);
      return {
        content: [{ type: "text", text: formatAnswer(waited, id) }],
      };
    }

    case "cancel_user_question": {
      const id = typeof args.question_id === "string" ? args.question_id : "";
      if (!id) {
        return {
          content: [{ type: "text", text: "Missing required param: question_id" }],
          isError: true,
        };
      }
      try {
        const result = await client.cancelAgentQuestion(id);
        return {
          content: [{ type: "text", text: formatCanceled(id, Boolean(result?.canceled)) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Cancel failed: ${err.message || err}` }],
          isError: true,
        };
      }
    }

    case "list_pending_user_questions": {
      const nickname = typeof args.nickname === "string" ? args.nickname : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const result = await client.listAgentQuestions({ nickname, limit });
      return {
        content: [{ type: "text", text: formatPendingList(result) }],
      };
    }

    default:
      return null;
  }
}
