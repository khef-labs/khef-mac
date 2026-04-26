import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatOutline } from "../formatters/sections.js";

export const tools: Tool[] = [
  {
  name: "get_memory_outline",
  description:
    "Get the section structure of a memory. Returns markdown headings with character positions and direct content for each section by default. Set include_content=false for structure only.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (full UUID preferred; partial prefix accepted if unambiguous)",
      },
      include_content: {
        type: "boolean",
        description: "Include direct text content for each section (default: true). Set false for structure only.",
      },
    },
    required: ["memory_id"],
  },
},

  {
  name: "get_memory_section",
  description:
    "Fetch a specific section of a memory by heading name. Returns just that section's content, reducing token usage for large documents. Use get_memory_outline first to discover available sections.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (full UUID preferred; partial prefix accepted if unambiguous)",
      },
      heading: {
        type: "string",
        description: "Exact heading text (without # prefix)",
      },
      include_subsections: {
        type: "boolean",
        description: "Include nested subsections (default: true)",
      },
      index: {
        type: "number",
        description: "Which occurrence to target if heading appears multiple times (0-based, default: 0)",
      },
    },
    required: ["memory_id", "heading"],
  },
},

  {
  name: "search_within_memory",
  description:
    "Search within a single memory's content and return markdown results grouped by matching outline sections with contextual excerpts.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (full UUID preferred; partial prefix accepted if unambiguous)",
      },
      q: {
        type: "string",
        description: "Search query to find within the memory",
      },
    },
    required: ["memory_id", "q"],
  },
},

  {
  name: "update_memory_section",
  description:
    "Update a specific section of a memory without affecting other sections. Optionally rename the heading. Returns compact memory format.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (full UUID preferred; partial prefix accepted if unambiguous)",
      },
      heading: {
        type: "string",
        description: "Exact heading text to find (without # prefix)",
      },
      content: {
        type: "string",
        description: "New content for the section (without heading)",
      },
      new_heading: {
        type: "string",
        description: "Optional new heading text to replace the existing heading",
      },
      index: {
        type: "number",
        description: "Which occurrence to target if heading appears multiple times (0-based, default: 0)",
      },
      replace_subsections: {
        type: "boolean",
        description: "If true, replace the entire section including all child subsections. Default false (preserves subsections).",
      },
    },
    required: ["memory_id", "heading", "content"],
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "get_memory_outline": {
      const result = await client.getMemoryOutline(
        args.memory_id as string,
        args.include_content as boolean | undefined
      );
      const format = (args.format as string) || "text";
      if (format === "text") {
        return {
          content: [{ type: "text", text: formatOutline(result) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "get_memory_section": {
      const result = await client.getMemorySection(
        args.memory_id as string,
        args.heading as string,
        args.include_subsections as boolean | undefined,
        args.index as number | undefined
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "search_within_memory": {
      const result = await client.searchWithinMemory(
        args.memory_id as string,
        args.q as string
      );
      return {
        content: [{ type: "text", text: result.markdown ?? JSON.stringify(result, null, 2) }],
      };
    }

    case "update_memory_section": {
      const result = await client.updateMemorySection(
        args.memory_id as string,
        args.heading as string,
        args.content as string,
        args.new_heading as string | undefined,
        args.index as number | undefined,
        args.replace_subsections as boolean | undefined
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      return null;
  }
}
