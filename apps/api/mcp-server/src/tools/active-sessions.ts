import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatActiveSessionsList, formatCurrentSession } from "../formatters/active-sessions.js";
import { resolveCurrentSession } from "../lib/current-session.js";

export const tools: Tool[] = [
  {
  name: "list_active_sessions",
  description:
    "List active Claude Code sessions detected by the background scanner. Uses three-tier detection: PID liveness from heartbeat hook, fuser on task dirs, and JSONL mtime heuristic. Returns active sessions with project and transcript metadata.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
},

  {
  name: "get_current_session",
  description:
    "Look up the current session, or a specific session by file UUID. If session_id is omitted, resolves from KHEF_SESSION_ID or the iTerm2 terminal session ID.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Optional session file UUID. Omit to resolve the current session automatically.",
      },
    },
    required: [],
  },
},

  {
  name: "list_nicknames",
  description:
    "List nicknames of all active sessions with their project and session ID. Quick way to see who's online without full session details.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
},

  {
  name: "claim_nickname",
  description:
    "Claim a specific nickname for this session. Used for session continuity — when starting a fresh session that continues a previous line of work, claim the same nickname to link them. Multiple active sessions can share a nickname (for handoff). Use the /continue-as skill for the full handoff workflow.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Optional current session ID. Omit to resolve from KHEF_SESSION_ID or the iTerm2 terminal session ID.",
      },
      nickname: {
        type: "string",
        description: "The nickname to claim (e.g., 'dulci', 'ridge')",
      },
    },
    required: ["nickname"],
  },
},

  {
  name: "get_nickname",
  description:
    "Get the nickname assigned to the current session, or a specific session. Returns the short human-friendly name (e.g., 'jasper', 'lark').",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Optional session file UUID. Omit to resolve the current session automatically.",
      },
    },
    required: [],
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "list_active_sessions": {
      const result = await client.scanActiveSessions();
      const sessions = result?.sessions || [];
      // Enrich with live message counts from Redis
      const counts = await Promise.all(
        sessions.map((s: any) =>
          client.countLiveMessages(s.session_id).then((r: any) => r.count ?? 0).catch(() => 0)
        )
      );
      for (let i = 0; i < sessions.length; i++) {
        sessions[i].live_message_count = counts[i];
      }
      return {
        content: [{ type: "text", text: formatActiveSessionsList(result) }],
      };
    }

    case "get_current_session": {
      const result = args.session_id
        ? await client.getActiveSessionBySessionId(args.session_id as string)
        : { session: (await resolveCurrentSession(client)).session };
      return {
        content: [{ type: "text", text: formatCurrentSession(result) }],
      };
    }

    case "list_nicknames": {
      const result = await client.scanActiveSessions();
      const sessions = result?.sessions || [];
      if (sessions.length === 0) {
        return { content: [{ type: "text", text: "No active sessions." }] };
      }
      // Group by nickname to show shared names
      const byNickname = new Map<string, any[]>();
      for (const s of sessions) {
        const name = s.nickname || '(none)';
        if (!byNickname.has(name)) byNickname.set(name, []);
        byNickname.get(name)!.push(s);
      }
      const lines: string[] = [];
      for (const [name, group] of byNickname) {
        if (group.length > 1) {
          lines.push(`- **${name}** (${group.length} sessions)`);
          for (const s of group) {
            const project = s.project?.handle || 'no project';
            lines.push(`  - [${project}] ${s.session_id}`);
          }
        } else {
          const s = group[0];
          const project = s.project?.handle || 'no project';
          lines.push(`- **${name}** [${project}] ${s.session_id}`);
        }
      }
      return {
        content: [{ type: "text", text: `# Active Nicknames (${sessions.length})\n\n${lines.join('\n')}` }],
      };
    }

    case "claim_nickname": {
      const sessionId = args.session_id
        ? args.session_id as string
        : (await resolveCurrentSession(client)).session?.session_id;
      const result = await client.claimNickname(
        sessionId,
        args.nickname as string
      );
      const nickname = result?.nickname;
      return {
        content: [{ type: "text", text: nickname ? `Nickname claimed: **${nickname}**` : 'Failed to claim nickname — session may not be registered yet.' }],
      };
    }

    case "get_nickname": {
      const session = args.session_id
        ? (await client.getActiveSessionBySessionId(args.session_id as string))?.session
        : (await resolveCurrentSession(client)).session;
      const nickname = session?.nickname || null;
      return {
        content: [{ type: "text", text: nickname ? `Your nickname is **${nickname}**` : 'No nickname assigned to this session.' }],
      };
    }

    default:
      return null;
  }
}
