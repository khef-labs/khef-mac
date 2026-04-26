import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatTagList, formatTagMemories } from "../formatters/tags.js";

export const tools: Tool[] = [
  {
  name: "list_tags",
  description:
    "Get all tags used across all projects. Returns tag names sorted alphabetically.",
  inputSchema: {
    type: "object",
    properties: {},
  },
},

  {
  name: "get_tag_memories",
  description:
    "Get all memories associated with a specific tag. Returns memories across all projects that have this tag.",
  inputSchema: {
    type: "object",
    properties: {
      tag_name: {
        type: "string",
        description: "Name of the tag to search for",
      },
    },
    required: ["tag_name"],
  },
},

  {
  name: "create_tag",
  description:
    "Create a new tag. Tags can then be associated with memories for organization. Returns the created tag with its ID.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Tag name (will be trimmed, must be unique)",
      },
    },
    required: ["name"],
  },
},

  {
  name: "rename_tag",
  description:
    "Rename an existing tag. Updates the tag name across all memories that use it. The new name must be unique.",
  inputSchema: {
    type: "object",
    properties: {
      tag_id: {
        type: "string",
        description: "Tag ID (UUID)",
      },
      name: {
        type: "string",
        description: "New tag name (will be trimmed, must be unique)",
      },
    },
    required: ["tag_id", "name"],
  },
},

  {
  name: "delete_tag",
  description:
    "Delete a tag. Can only delete tags that are not in use by any memories. Returns 409 error if tag is in use.",
  inputSchema: {
    type: "object",
    properties: {
      tag_id: {
        type: "string",
        description: "Tag ID (UUID)",
      },
    },
    required: ["tag_id"],
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "list_tags": {
      const fmt = (args.format as string) || "text";
      const result = await client.getTags();
      return {
        content: [{ type: "text", text: fmt === "text" ? formatTagList(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "get_tag_memories": {
      const fmt = (args.format as string) || "text";
      const result = await client.getTagMemories(args.tag_name as string);
      return {
        content: [{ type: "text", text: fmt === "text" ? formatTagMemories(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "create_tag": {
      const result = await client.createTag(args.name as string);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "rename_tag": {
      const result = await client.renameTag(
        args.tag_id as string,
        args.name as string
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

    case "delete_tag": {
      const result = await client.deleteTag(args.tag_id as string);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    default:
      return null;
  }
}
