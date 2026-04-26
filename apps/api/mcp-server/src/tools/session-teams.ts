import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";

export const tools: Tool[] = [
  {
    name: "list_session_teams",
    description:
      "List session teams. Optionally filter by project handle. Teams group multiple Claude Code sessions for coordination and monitoring.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Filter by project handle (optional)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_session_team",
    description:
      "Get a session team by ID with its members. Returns team details, member sessions with status, nicknames, and message counts.",
    inputSchema: {
      type: "object",
      properties: {
        team_id: {
          type: "string",
          description: "Team UUID",
        },
      },
      required: ["team_id"],
    },
  },
  {
    name: "create_session_team",
    description:
      "Create a new session team for grouping and coordinating multiple Claude Code sessions.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Team name",
        },
        description: {
          type: "string",
          description: "Team description (optional)",
        },
        project: {
          type: "string",
          description: "Project handle to associate with (optional)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "update_session_team",
    description: "Update a session team's name or description.",
    inputSchema: {
      type: "object",
      properties: {
        team_id: {
          type: "string",
          description: "Team UUID",
        },
        name: {
          type: "string",
          description: "New team name (optional)",
        },
        description: {
          type: "string",
          description: "New description (optional)",
        },
      },
      required: ["team_id"],
    },
  },
  {
    name: "delete_session_team",
    description:
      "Delete a session team. Sessions themselves are not affected.",
    inputSchema: {
      type: "object",
      properties: {
        team_id: {
          type: "string",
          description: "Team UUID",
        },
      },
      required: ["team_id"],
    },
  },
  {
    name: "add_team_members",
    description:
      "Add one or more sessions to a team by their session file UUIDs.",
    inputSchema: {
      type: "object",
      properties: {
        team_id: {
          type: "string",
          description: "Team UUID",
        },
        session_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of session file UUIDs to add",
        },
      },
      required: ["team_id", "session_ids"],
    },
  },
  {
    name: "remove_team_member",
    description: "Remove a session from a team.",
    inputSchema: {
      type: "object",
      properties: {
        team_id: {
          type: "string",
          description: "Team UUID",
        },
        session_id: {
          type: "string",
          description: "Session file UUID to remove",
        },
      },
      required: ["team_id", "session_id"],
    },
  },
  {
    name: "broadcast_to_team",
    description:
      "Send a live message to all active sessions in a team. Delivers via Redis and iTerm2 for instant notification.",
    inputSchema: {
      type: "object",
      properties: {
        team_id: {
          type: "string",
          description: "Team UUID",
        },
        content: {
          type: "string",
          description: "Message content to broadcast",
        },
        from_session_id: {
          type: "string",
          description: "Sender session ID (defaults to 'mcp')",
        },
      },
      required: ["team_id", "content"],
    },
  },
];

function formatTeamList(data: any): string {
  const teams = data?.teams || [];
  if (teams.length === 0) return "No session teams found.";

  const lines = ["# Session Teams", ""];
  for (const t of teams) {
    lines.push(`## ${t.name}${t.project_handle ? ` (${t.project_handle})` : ""}`);
    lines.push(`ID: ${t.id}`);
    if (t.description) lines.push(t.description);
    lines.push(`Members: ${t.member_count || 0} | Created: ${t.created_at?.slice(0, 10) || "?"}`);
    lines.push("");
  }
  return lines.join("\n");
}

function formatTeamDetail(data: any): string {
  const team = data?.team;
  const members = data?.members || [];
  if (!team) return "Team not found.";

  const lines = [
    `# ${team.name}`,
    `ID: ${team.id}`,
  ];
  if (team.project_handle) lines.push(`Project: ${team.project_handle}`);
  if (team.description) lines.push(team.description);
  lines.push("");

  if (members.length === 0) {
    lines.push("No members.");
  } else {
    lines.push(`## Members (${members.length})`);
    lines.push("");
    for (const m of members) {
      const status = m.status === "active" ? "🟢" : "⚪";
      const nick = m.nickname || m.session_id.slice(0, 8);
      const msgs = m.message_count ? ` | ${m.message_count} msgs` : "";
      const ctx = m.context_window_tokens ? ` | ${Math.round(m.context_window_tokens / 1000)}k ctx` : "";
      lines.push(`- ${status} **${nick}** (${m.session_id.slice(0, 8)}) — ${m.status || "unknown"}${msgs}${ctx}`);
    }
  }
  return lines.join("\n");
}

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: KhefClient,
  _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "list_session_teams": {
      const result = await client.listSessionTeams(args.project as string | undefined);
      return { content: [{ type: "text", text: formatTeamList(result) }] };
    }

    case "get_session_team": {
      const result = await client.getSessionTeam(args.team_id as string);
      return { content: [{ type: "text", text: formatTeamDetail(result) }] };
    }

    case "create_session_team": {
      const result = await client.createSessionTeam({
        name: args.name as string,
        description: args.description as string | undefined,
        project: args.project as string | undefined,
      });
      return {
        content: [{ type: "text", text: `Team created: **${result.team.name}** (${result.team.id})` }],
      };
    }

    case "update_session_team": {
      const result = await client.updateSessionTeam(args.team_id as string, {
        name: args.name as string | undefined,
        description: args.description as string | undefined,
      });
      return {
        content: [{ type: "text", text: `Team updated: **${result.team.name}**` }],
      };
    }

    case "delete_session_team": {
      await client.deleteSessionTeam(args.team_id as string);
      return { content: [{ type: "text", text: "Team deleted." }] };
    }

    case "add_team_members": {
      const result = await client.addTeamMembers(
        args.team_id as string,
        args.session_ids as string[]
      );
      const count = result?.added || (args.session_ids as string[]).length;
      return {
        content: [{ type: "text", text: `Added ${count} session${count !== 1 ? "s" : ""} to team.` }],
      };
    }

    case "remove_team_member": {
      await client.removeTeamMember(args.team_id as string, args.session_id as string);
      return { content: [{ type: "text", text: "Member removed from team." }] };
    }

    case "broadcast_to_team": {
      const result = await client.broadcastToTeam(
        args.team_id as string,
        args.content as string,
        args.from_session_id as string | undefined
      );
      return {
        content: [{ type: "text", text: `Broadcast sent to ${result.recipients} session${result.recipients !== 1 ? "s" : ""}.` }],
      };
    }

    default:
      return null;
  }
}
