import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "child_process";
import { promisify } from "util";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatLiveMessageSent, formatLiveInbox, formatLiveCount, formatLiveMessageDeleted } from "../formatters/live-messages.js";

const execFileAsync = promisify(execFile);

export const tools: Tool[] = [
  {
    name: "send_live_message",
    description:
      "Send an ephemeral live message to another session via Redis. Messages expire after 24 hours. Use for inter-session communication — task delegation, sharing findings, asking questions. If a nickname is shared by multiple active sessions, the message is broadcast to all of them. Use list_active_sessions to find target session nicknames. Always use full UUIDs or nicknames — do not truncate session IDs.",
    inputSchema: {
      type: "object",
      properties: {
        to_session_id: {
          type: "string",
          description: "Target session's nickname or full file UUID (from list_active_sessions). Never truncate UUIDs.",
        },
        from_session_id: {
          type: "string",
          description: "Your session ID (from the hook-injected Session ID in system prompt)",
        },
        content: {
          type: "string",
          description: "Message content to send",
        },
        from_nickname: {
          type: "string",
          description: "Your session nickname (from SessionStart hook). Used in the iTerm2 nudge message.",
        },
      },
      required: ["to_session_id", "from_session_id", "content"],
    },
  },
  {
    name: "check_live_messages",
    description:
      "Check ephemeral live messages for your session. By default, reading clears the messages (destructive read). Use peek=true to read without clearing. Messages expire after 24 hours.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Your session ID (from the hook-injected Session ID in system prompt)",
        },
        limit: {
          type: "number",
          description: "Max messages to return (default: 50, max: 100)",
        },
        peek: {
          type: "boolean",
          description: "If true, read without clearing messages (default: false)",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "delete_live_message",
    description:
      "Delete a sent live message from a recipient's inbox before they read it. Only the original sender can delete. Requires the message ID returned from send_live_message.",
    inputSchema: {
      type: "object",
      properties: {
        to_session_id: {
          type: "string",
          description: "Recipient session's nickname or full UUID (the session you sent the message to)",
        },
        message_id: {
          type: "string",
          description: "Message ID returned by send_live_message",
        },
        from_session_id: {
          type: "string",
          description: "Your session ID (must match the original sender)",
        },
      },
      required: ["to_session_id", "message_id", "from_session_id"],
    },
  },
  {
    name: "wake_session",
    description:
      "Wake an inactive Claude Code session by resuming it in its iTerm2 tab. Finds the target tab by scanning iTerm2 user variables, then types a claude --resume command to bring the session back to life. Use this when send_live_message returns a 404 saying the session is inactive.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Target session's full UUID (from the 404 error's inactive_session_id field)",
        },
        message: {
          type: "string",
          description: "Optional message to include in the wake prompt (e.g. why you're waking them)",
        },
        from_nickname: {
          type: "string",
          description: "Your session nickname (from SessionStart hook)",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "count_live_messages",
    description:
      "Count pending ephemeral live messages without reading them.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Your session ID",
        },
      },
      required: ["session_id"],
    },
  },
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: KhefClient,
  _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "send_live_message": {
      const missing = ["to_session_id", "from_session_id", "content"].filter(k => !args[k]);
      if (missing.length > 0) {
        const got = Object.keys(args).join(", ") || "(none)";
        return {
          content: [{ type: "text", text: `Missing required params: ${missing.join(", ")}. Got: ${got}` }],
          isError: true,
        };
      }
      const result = await client.sendLiveMessage(
        args.to_session_id as string,
        args.from_session_id as string,
        args.content as string,
        args.from_nickname as string | undefined
      );
      return {
        content: [{ type: "text", text: formatLiveMessageSent(result) }],
      };
    }

    case "check_live_messages": {
      const limit = Math.min((args.limit as number) || 50, 100);
      const peek = (args.peek as boolean) || false;
      const result = await client.checkLiveMessages(
        args.session_id as string,
        { limit, peek }
      );
      return {
        content: [{ type: "text", text: formatLiveInbox(result) }],
      };
    }

    case "delete_live_message": {
      const result = await client.deleteLiveMessage(
        args.to_session_id as string,
        args.message_id as string,
        args.from_session_id as string
      );
      return {
        content: [{ type: "text", text: formatLiveMessageDeleted(result) }],
      };
    }

    case "wake_session": {
      if (!args.session_id) {
        return {
          content: [{ type: "text", text: "Missing required param: session_id" }],
          isError: true,
        };
      }
      const wakeResult = await wakeViaIterm(
        args.session_id as string,
        args.message as string | undefined,
        args.from_nickname as string | undefined
      );
      return {
        content: [{ type: "text", text: wakeResult }],
      };
    }

    case "count_live_messages": {
      const result = await client.countLiveMessages(args.session_id as string);
      return {
        content: [{ type: "text", text: formatLiveCount(result) }],
      };
    }

    default:
      return null;
  }
}

/**
 * Wake an inactive session by finding its iTerm2 tab and typing a
 * claude --resume command into it.
 *
 * Tab discovery scans all iTerm2 sessions for the user.claude_session
 * variable matching the target session UUID (set by the UserPromptSubmit hook).
 */
async function wakeViaIterm(
  sessionId: string,
  message?: string,
  fromNickname?: string
): Promise<string> {
  try {
    const senderLabel = fromNickname || "another session";
    const prompt = message
      ? `${senderLabel} woke you up: ${message}. Check live messages with check_live_messages.`
      : `${senderLabel} woke you up. Check live messages with check_live_messages.`;
    const promptEscaped = prompt.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const resumeCmd = `claude --resume ${sessionId} -p \\"${promptEscaped}\\"`;

    const script = `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        try
          tell s to set sessVar to (variable named "user.claude_session")
          if sessVar is "${sessionId}" then
            tell s to write text "${resumeCmd}"
            return "ok"
          end if
        end try
      end repeat
    end repeat
  end repeat
end tell
return "not_found"`;

    const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 5000 });
    const result = stdout.trim();
    if (result === "ok") {
      return `Session ${sessionId} woken — claude --resume typed into its iTerm2 tab.`;
    }
    return `Could not find an iTerm2 tab for session ${sessionId}. The tab may have been closed.`;
  } catch (err: any) {
    return `Wake failed: ${err.message || err}`;
  }
}
