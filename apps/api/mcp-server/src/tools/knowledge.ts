import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatProjectKnowledge, formatAgentRules } from "../formatters/knowledge.js";

export const tools: Tool[] = [
  {
  name: "get_project_knowledge",
  description:
    "Get all operational knowledge for a project in one call. Returns commands, context memories, and pattern memories. Use this at session start to load project knowledge quickly.",
  inputSchema: {
    type: "object",
    properties: {
      project_handle: {
        type: "string",
        description: "Project handle (e.g., 'khef'), name, or UUID",
      },
    },
    required: ["project_handle"],
  },
},

  {
  name: "set_project_commands",
  description:
    "Set or update the project commands memory. Upserts a single memory containing all common commands for the project (dev, test, db, deploy, etc.). Content should be markdown with commands grouped by category.",
  inputSchema: {
    type: "object",
    properties: {
      project_handle: {
        type: "string",
        description: "Project handle (e.g., 'khef'), name, or UUID",
      },
      content: {
        type: "string",
        description: "Markdown content with commands grouped by category (e.g., ## Development, ## Testing)",
      },
    },
    required: ["project_handle", "content"],
  },
},

  {
  name: "set_project_context",
  description:
    "Set or update a project context memory. Use for storing architecture info, DB schemas, log locations, env setup, etc. Each context has a unique handle (e.g., 'db-schema', 'log-locations').",
  inputSchema: {
    type: "object",
    properties: {
      project_handle: {
        type: "string",
        description: "Project handle (e.g., 'khef'), name, or UUID",
      },
      handle: {
        type: "string",
        description: "Context handle (lowercase, hyphens allowed). E.g., 'db-schema', 'log-locations', 'env-setup'",
      },
      title: {
        type: "string",
        description: "Human-readable title for this context",
      },
      content: {
        type: "string",
        description: "Context content (markdown)",
      },
    },
    required: ["project_handle", "handle", "title", "content"],
  },
},

  {
  name: "set_project_pattern",
  description:
    "Set or update a project pattern memory. Use for documenting workflows like 'how to run tests', 'how to deploy', 'how to debug'. Each pattern has a unique handle.",
  inputSchema: {
    type: "object",
    properties: {
      project_handle: {
        type: "string",
        description: "Project handle (e.g., 'khef'), name, or UUID",
      },
      handle: {
        type: "string",
        description: "Pattern handle (lowercase, hyphens allowed). E.g., 'testing-workflow', 'deployment', 'local-setup'",
      },
      title: {
        type: "string",
        description: "Human-readable title for this pattern",
      },
      content: {
        type: "string",
        description: "Pattern content - step-by-step workflow (markdown)",
      },
    },
    required: ["project_handle", "handle", "title", "content"],
  },
},

  {
  name: "delete_project_context",
  description:
    "Delete a project context memory by handle.",
  inputSchema: {
    type: "object",
    properties: {
      project_handle: {
        type: "string",
        description: "Project handle (e.g., 'khef'), name, or UUID",
      },
      handle: {
        type: "string",
        description: "Context handle to delete (e.g., 'db-schema')",
      },
    },
    required: ["project_handle", "handle"],
  },
},

  {
  name: "delete_project_pattern",
  description:
    "Delete a project pattern memory by handle.",
  inputSchema: {
    type: "object",
    properties: {
      project_handle: {
        type: "string",
        description: "Project handle (e.g., 'khef'), name, or UUID",
      },
      handle: {
        type: "string",
        description: "Pattern handle to delete (e.g., 'testing-workflow')",
      },
    },
    required: ["project_handle", "handle"],
  },
},

  {
  name: "sync_project_knowledge",
  description:
    "Sync project knowledge (commands, context, patterns) to a KF-PROJECT-KNOWLEDGE.md file in the project directory. Ensures CLAUDE.local.md imports the file. Returns sync results (created/updated/unchanged).",
  inputSchema: {
    type: "object",
    properties: {
      project_handle: {
        type: "string",
        description:
          "Project handle (e.g., 'khef'), name, or UUID",
      },
      location: {
        type: "string",
        description:
          "Target directory path. If omitted, uses the project's configured path.",
      },
    },
    required: ["project_handle"],
  },
},

  {
  name: "get_agent_rules",
  description:
    "Get assistant-rule memories. By default returns active rules across all projects (user-level + project-level); pass project_id to scope to a single project, or q to filter by a substring against handle/title/content. Use this whenever the user references 'the X rule' to locate the right memory before reading or editing it.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Optional. Project handle (e.g., 'khef'), name, or UUID. Omit to search across all projects.",
      },
      q: {
        type: "string",
        description: "Optional. Case-insensitive substring filter applied to rule handle, title, and content. Use 2-3 core terms (e.g., 'git', 'feature branch', 'never push').",
      },
    },
  },
},

  {
  name: "sync_project_rules",
  description:
    "Sync assistant-rule memories to KF-RULES.md files on disk. For the 'user' project, syncs to ~/.claude/KF-RULES.md and ~/.codex/AGENTS.md. For other projects, syncs to the project's configured path (or a provided location). Returns which files were created/updated/unchanged.",
  inputSchema: {
    type: "object",
    properties: {
      project_handle: {
        type: "string",
        description: "Project handle (e.g., 'khef', 'user')",
      },
      location: {
        type: "string",
        description: "Target directory path override. If omitted, uses the project's configured path.",
      },
    },
    required: ["project_handle"],
  },
},

  {
  name: "seed_and_sync",
  description:
    "Run the full seed-and-sync cycle: seeds the database from seed files, then syncs rules and knowledge to disk. Equivalent to 'npm run db:seed:sync'. Optionally scoped to a single project. Without a project, seeds all projects and syncs all that have paths configured.",
  inputSchema: {
    type: "object",
    properties: {
      project_handle: {
        type: "string",
        description: "Optional project handle to scope seeding and syncing to a single project. Omit to seed all projects.",
      },
    },
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "get_project_knowledge": {
      const fmt = (args.format as string) || "text";
      const result = await client.getProjectKnowledge(args.project_handle as string);
      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? formatProjectKnowledge(result) : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "set_project_commands": {
      const result = await client.setProjectCommands(
        args.project_handle as string,
        args.content as string
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

    case "set_project_context": {
      const result = await client.setProjectContext(
        args.project_handle as string,
        args.handle as string,
        args.title as string,
        args.content as string
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

    case "set_project_pattern": {
      const result = await client.setProjectPattern(
        args.project_handle as string,
        args.handle as string,
        args.title as string,
        args.content as string
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

    case "delete_project_context": {
      const result = await client.deleteProjectContext(
        args.project_handle as string,
        args.handle as string
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

    case "delete_project_pattern": {
      const result = await client.deleteProjectPattern(
        args.project_handle as string,
        args.handle as string
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

    case "sync_project_knowledge": {
      const result = await client.syncProjectKnowledge(
        args.project_handle as string,
        args.location as string | undefined
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

    case "get_agent_rules": {
      const fmt = (args.format as string) || "text";
      const projectId = args.project_id as string | undefined;
      const q = args.q as string | undefined;
      const result = await client.searchMemories(projectId, {
        type: "assistant-rule",
        status: "active",
        ...(q ? { q } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? formatAgentRules(result, projectId ?? "all projects") : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "sync_project_rules": {
      const result = await client.syncProjectRules(
        args.project_handle as string,
        args.location as string | undefined
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

    case "seed_and_sync": {
      const projectHandle = args.project_handle as string | undefined;
      const results: Record<string, unknown> = {};

      // Step 1: Run seeds
      const seedResult = await client.runSeed(projectHandle);
      results.seed = seedResult;

      // Step 2: Determine which projects to sync
      let projectHandles: string[];
      if (projectHandle) {
        projectHandles = [projectHandle];
      } else {
        // Get all projects and sync those with paths + always include "user"
        const projectsResult = await client.getProjects();
        const projects = projectsResult.projects || [];
        projectHandles = ['user'];
        for (const p of projects) {
          if (p.path && p.handle !== 'user') {
            projectHandles.push(p.handle);
          }
        }
      }

      // Step 3: Sync rules, knowledge, and glossary for each project
      const syncResults: Array<{ project: string; rules?: unknown; knowledge?: unknown; glossary?: unknown; error?: string }> = [];
      for (const handle of projectHandles) {
        const entry: { project: string; rules?: unknown; knowledge?: unknown; glossary?: unknown; error?: string } = { project: handle };
        try {
          entry.rules = await client.syncProjectRules(handle);
        } catch (err: any) {
          entry.rules = { error: err?.message || 'Failed to sync rules' };
        }
        try {
          entry.knowledge = await client.syncProjectKnowledge(handle);
        } catch (err: any) {
          entry.knowledge = { error: err?.message || 'Failed to sync knowledge' };
        }
        try {
          entry.glossary = await client.syncGlossary(handle);
        } catch (err: any) {
          entry.glossary = { error: err?.message || 'Failed to sync glossary' };
        }
        syncResults.push(entry);
      }
      results.sync = syncResults;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }

    default:
      return null;
  }
}
