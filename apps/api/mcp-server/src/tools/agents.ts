import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatAgentList, formatAgent } from "../formatters/agents.js";

export const tools: Tool[] = [
  {
  name: "get_user_agents",
  description:
    "List user-level agents for a coding assistant. Returns agents from ~/.claude/agents/ (for claude-code). These are personal agents available across all projects.",
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
  name: "get_project_agents",
  description:
    "List project-level agents for a coding assistant. Returns agents from .claude/agents/ in the project directory. projectId accepts khef project handle, name, or UUID. Returns empty if project has no path configured.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
      project_id: {
        type: "string",
        description: "Khef project handle, name, or UUID",
      },
    },
    required: ["assistant_handle", "project_id"],
  },
},

  {
  name: "get_user_agent",
  description:
    "Get a single user-level agent by name.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
      agent_name: {
        type: "string",
        description: "Agent name",
      },
    },
    required: ["assistant_handle", "agent_name"],
  },
},

  {
  name: "get_project_agent",
  description:
    "Get a single project-level agent by name.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
      agent_name: {
        type: "string",
        description: "Agent name",
      },
      project_id: {
        type: "string",
        description: "Khef project handle, name, or UUID",
      },
    },
    required: ["assistant_handle", "agent_name", "project_id"],
  },
},

  {
  name: "create_user_agent",
  description:
    "Create a new user-level agent. Writes a markdown file with YAML frontmatter to ~/.claude/agents/.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
      name: {
        type: "string",
        description: "Agent name (used as filename)",
      },
      description: {
        type: "string",
        description: "Agent description shown in agent selection",
      },
      prompt: {
        type: "string",
        description: "Agent system prompt (markdown body)",
      },
      model: {
        type: "string",
        enum: ["sonnet", "opus", "haiku", "inherit"],
        description: "Model to use (optional, defaults to inherit)",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: "Tools to allow (optional)",
      },
      disallowedTools: {
        type: "array",
        items: { type: "string" },
        description: "Tools to disallow (optional)",
      },
      permissionMode: {
        type: "string",
        enum: ["default", "acceptEdits", "dontAsk", "bypassPermissions", "plan"],
        description: "Permission mode (optional)",
      },
      skills: {
        type: "array",
        items: { type: "string" },
        description: "Skills to enable (optional)",
      },
    },
    required: ["assistant_handle", "name", "description", "prompt"],
  },
},

  {
  name: "create_project_agent",
  description:
    "Create a new project-level agent. Writes a markdown file with YAML frontmatter to .claude/agents/ in the project directory.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
      project_id: {
        type: "string",
        description: "Khef project handle, name, or UUID",
      },
      name: {
        type: "string",
        description: "Agent name (used as filename)",
      },
      description: {
        type: "string",
        description: "Agent description shown in agent selection",
      },
      prompt: {
        type: "string",
        description: "Agent system prompt (markdown body)",
      },
      model: {
        type: "string",
        enum: ["sonnet", "opus", "haiku", "inherit"],
        description: "Model to use (optional, defaults to inherit)",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: "Tools to allow (optional)",
      },
      disallowedTools: {
        type: "array",
        items: { type: "string" },
        description: "Tools to disallow (optional)",
      },
      permissionMode: {
        type: "string",
        enum: ["default", "acceptEdits", "dontAsk", "bypassPermissions", "plan"],
        description: "Permission mode (optional)",
      },
      skills: {
        type: "array",
        items: { type: "string" },
        description: "Skills to enable (optional)",
      },
    },
    required: ["assistant_handle", "project_id", "name", "description", "prompt"],
  },
},

  {
  name: "update_user_agent",
  description:
    "Update an existing user-level agent. Can modify any field including name (which renames the file).",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
      agent_name: {
        type: "string",
        description: "Current agent name",
      },
      name: {
        type: "string",
        description: "New agent name (optional, renames file if different)",
      },
      description: {
        type: "string",
        description: "New description (optional)",
      },
      prompt: {
        type: "string",
        description: "New system prompt (optional)",
      },
      model: {
        type: "string",
        enum: ["sonnet", "opus", "haiku", "inherit"],
        description: "New model (optional)",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: "New tools list (optional)",
      },
      disallowedTools: {
        type: "array",
        items: { type: "string" },
        description: "New disallowed tools list (optional)",
      },
      permissionMode: {
        type: "string",
        enum: ["default", "acceptEdits", "dontAsk", "bypassPermissions", "plan"],
        description: "New permission mode (optional)",
      },
      skills: {
        type: "array",
        items: { type: "string" },
        description: "New skills list (optional)",
      },
    },
    required: ["assistant_handle", "agent_name"],
  },
},

  {
  name: "update_project_agent",
  description:
    "Update an existing project-level agent. Can modify any field including name (which renames the file).",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
      agent_name: {
        type: "string",
        description: "Current agent name",
      },
      project_id: {
        type: "string",
        description: "Khef project handle, name, or UUID",
      },
      name: {
        type: "string",
        description: "New agent name (optional, renames file if different)",
      },
      description: {
        type: "string",
        description: "New description (optional)",
      },
      prompt: {
        type: "string",
        description: "New system prompt (optional)",
      },
      model: {
        type: "string",
        enum: ["sonnet", "opus", "haiku", "inherit"],
        description: "New model (optional)",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: "New tools list (optional)",
      },
      disallowedTools: {
        type: "array",
        items: { type: "string" },
        description: "New disallowed tools list (optional)",
      },
      permissionMode: {
        type: "string",
        enum: ["default", "acceptEdits", "dontAsk", "bypassPermissions", "plan"],
        description: "New permission mode (optional)",
      },
      skills: {
        type: "array",
        items: { type: "string" },
        description: "New skills list (optional)",
      },
    },
    required: ["assistant_handle", "agent_name", "project_id"],
  },
},

  {
  name: "delete_user_agent",
  description:
    "Delete a user-level agent by name. Removes the markdown file from ~/.claude/agents/.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
      agent_name: {
        type: "string",
        description: "Agent name to delete",
      },
    },
    required: ["assistant_handle", "agent_name"],
  },
},

  {
  name: "delete_project_agent",
  description:
    "Delete a project-level agent by name. Removes the markdown file from .claude/agents/ in the project directory.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
      agent_name: {
        type: "string",
        description: "Agent name to delete",
      },
      project_id: {
        type: "string",
        description: "Khef project handle, name, or UUID",
      },
    },
    required: ["assistant_handle", "agent_name", "project_id"],
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "get_user_agents": {
      const result = await client.getUserAgents(args.assistant_handle as string);
      return {
        content: [{ type: "text", text: formatAgentList(result, args) }],
      };
    }

    case "get_project_agents": {
      const result = await client.getProjectAgents(
        args.assistant_handle as string,
        args.project_id as string
      );
      return {
        content: [{ type: "text", text: formatAgentList(result, args) }],
      };
    }

    case "get_user_agent": {
      const result = await client.getUserAgent(
        args.assistant_handle as string,
        args.agent_name as string
      );
      return {
        content: [{ type: "text", text: formatAgent(result) }],
      };
    }

    case "get_project_agent": {
      const result = await client.getProjectAgent(
        args.assistant_handle as string,
        args.agent_name as string,
        args.project_id as string
      );
      return {
        content: [{ type: "text", text: formatAgent(result) }],
      };
    }

    case "create_user_agent": {
      const result = await client.createUserAgent(
        args.assistant_handle as string,
        {
          name: args.name as string,
          description: args.description as string,
          prompt: args.prompt as string,
          model: args.model as string | undefined,
          tools: args.tools as string[] | undefined,
          disallowedTools: args.disallowedTools as string[] | undefined,
          permissionMode: args.permissionMode as string | undefined,
          skills: args.skills as string[] | undefined,
        }
      );
      return {
        content: [{ type: "text", text: formatAgent(result) }],
      };
    }

    case "create_project_agent": {
      const result = await client.createProjectAgent(
        args.assistant_handle as string,
        args.project_id as string,
        {
          name: args.name as string,
          description: args.description as string,
          prompt: args.prompt as string,
          model: args.model as string | undefined,
          tools: args.tools as string[] | undefined,
          disallowedTools: args.disallowedTools as string[] | undefined,
          permissionMode: args.permissionMode as string | undefined,
          skills: args.skills as string[] | undefined,
        }
      );
      return {
        content: [{ type: "text", text: formatAgent(result) }],
      };
    }

    case "update_user_agent": {
      const result = await client.updateUserAgent(
        args.assistant_handle as string,
        args.agent_name as string,
        {
          name: args.name as string | undefined,
          description: args.description as string | undefined,
          prompt: args.prompt as string | undefined,
          model: args.model as string | undefined,
          tools: args.tools as string[] | undefined,
          disallowedTools: args.disallowedTools as string[] | undefined,
          permissionMode: args.permissionMode as string | undefined,
          skills: args.skills as string[] | undefined,
        }
      );
      return {
        content: [{ type: "text", text: formatAgent(result) }],
      };
    }

    case "update_project_agent": {
      const result = await client.updateProjectAgent(
        args.assistant_handle as string,
        args.agent_name as string,
        args.project_id as string,
        {
          name: args.name as string | undefined,
          description: args.description as string | undefined,
          prompt: args.prompt as string | undefined,
          model: args.model as string | undefined,
          tools: args.tools as string[] | undefined,
          disallowedTools: args.disallowedTools as string[] | undefined,
          permissionMode: args.permissionMode as string | undefined,
          skills: args.skills as string[] | undefined,
        }
      );
      return {
        content: [{ type: "text", text: formatAgent(result) }],
      };
    }

    case "delete_user_agent": {
      const result = await client.deleteUserAgent(
        args.assistant_handle as string,
        args.agent_name as string
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "delete_project_agent": {
      const result = await client.deleteProjectAgent(
        args.assistant_handle as string,
        args.agent_name as string,
        args.project_id as string
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      return null;
  }
}
