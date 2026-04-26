import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatSessionContext } from "../formatters/session.js";
import { formatProjectList, formatProjectDetail } from "../formatters/projects.js";

export const tools: Tool[] = [
  {
  name: "list_projects",
  description:
    "List projects. Optionally filter by exact name, handle, or favorite status. Returns projects sorted with favorites first.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Filter by exact project name (optional)",
      },
      handle: {
        type: "string",
        description: "Filter by exact project handle (optional)",
      },
      favorite: {
        type: "boolean",
        description: "Filter by favorite status: true for favorites only, false for non-favorites only (optional)",
      },
    },
    required: [],
  },
},

  {
  name: "create_project",
  description:
    "Create a new project. Returns the created project with its ID. Use this before creating memories. Always set the path to the project's root directory on disk.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Project name (required)",
      },
      description: {
        type: "string",
        description: "Project description (optional)",
      },
      path: {
        type: "string",
        description: "Absolute path to the project's root directory on disk (optional but strongly recommended)",
      },
    },
    required: ["name"],
  },
},

  {
  name: "update_project",
  description:
    "Update a project's properties including name, description, path, or favorite status.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project handle, name, or UUID",
      },
      name: {
        type: "string",
        description: "New project name (optional)",
      },
      display_name: {
        type: "string",
        description: "New display name (optional)",
      },
      description: {
        type: "string",
        description: "New project description (optional)",
      },
      path: {
        type: "string",
        description: "New project path on disk (optional)",
      },
      is_favorite: {
        type: "boolean",
        description: "Mark project as favorite (optional)",
      },
    },
    required: ["project_id"],
  },
},

  {
  name: "get_project",
  description:
    "Get a project by handle, name, or UUID. Returns the project details if found. Use this to get the project_id for other operations. Handles are human-readable slugs (e.g., 'khef') that are easier to remember than UUIDs.",
  inputSchema: {
    type: "object",
    properties: {
      identifier: {
        type: "string",
        description: "Project handle (e.g., 'khef'), name, or UUID",
      },
    },
    required: ["identifier"],
  },
},

  {
  name: "initialize_session",
  description:
    "Initialize a new session by retrieving all relevant project context in one call. Returns project info, agent rules, active todos, recent decisions, patterns, and context. This is the recommended first call when starting work on a project.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project UUID (optional)",
      },
      project_handle: {
        type: "string",
        description: "Project handle/slug (optional)",
      },
      project_name: {
        type: "string",
        description: "Project name (optional)",
      },
      session_id: {
        type: "string",
        description: "Current session UUID (from hook-injected context). Used to pre-populate active session tracking.",
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
    case "list_projects": {
      const fmt = (args.format as string) || "text";
      const result = await client.getProjects(
        (args.name as string | undefined) || undefined,
        (args.handle as string | undefined) || undefined,
        args.favorite as boolean | undefined
      );
      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? formatProjectList(result) : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "create_project": {
      const result = await client.createProject(
        args.name as string,
        args.description as string | undefined,
        args.path as string | undefined
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

    case "update_project": {
      const updates: {
        name?: string;
        display_name?: string;
        description?: string;
        path?: string;
        is_favorite?: boolean;
      } = {};
      if (args.name !== undefined) updates.name = args.name as string;
      if (args.display_name !== undefined) updates.display_name = args.display_name as string;
      if (args.description !== undefined) updates.description = args.description as string;
      if (args.path !== undefined) updates.path = args.path as string;
      if (args.is_favorite !== undefined) updates.is_favorite = args.is_favorite as boolean;

      const result = await client.updateProject(args.project_id as string, updates);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "get_project": {
      // Accept project_id as alias for identifier (common LLM mistake)
      const identifier = (args.identifier ?? args.project_id) as string | undefined;
      const fmt = (args.format as string) || "text";

      if (!identifier) {
        return {
          content: [
            {
              type: "text",
              text: "Error: identifier is required. Pass a project handle, name, or UUID.",
            },
          ],
        };
      }

      // Try to get project by handle/UUID first
      try {
        const result = await client.getProject(identifier);
        if (result.project) {
          return {
            content: [
              {
                type: "text",
                text: fmt === "text" ? formatProjectDetail(result.project) : JSON.stringify(result.project, null, 2),
              },
            ],
          };
        }
      } catch (error: any) {
        // If not found by handle/UUID, fall back to name search
        if (error?.message?.includes("404") || error?.message?.includes("not found")) {
          const result = await client.getProjects(identifier);
          const project = result.projects?.[0];
          if (!project) {
            return {
              content: [
                {
                  type: "text",
                  text: `No project found with identifier: ${identifier}`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: fmt === "text" ? formatProjectDetail(project) : JSON.stringify(project, null, 2),
              },
            ],
          };
        }
        // If error is not a 404, re-throw it
        throw error;
      }
      // Shouldn't reach here but just in case
      return {
        content: [
          {
            type: "text",
            text: `No project found with identifier: ${identifier}`,
          },
        ],
      };
    }

    case "initialize_session": {
      const fmt = (args.format as string) || "text";
      const result = await client.getSessionContext(
        (args.project_handle as string | undefined) || undefined,
        (args.project_id as string | undefined) || undefined,
        (args.project_name as string | undefined) || undefined,
      );
      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? formatSessionContext(result) : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    default:
      return null;
  }
}
