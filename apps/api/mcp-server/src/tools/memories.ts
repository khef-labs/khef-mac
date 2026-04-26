import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatSearchResults, formatMemory, formatMemorySnapshots, formatSnapshotDiff, formatMutationResult } from "../formatters/memories.js";
import { sanitizeTags } from "../lib/sanitize-tags.js";
import { getTypeNames } from "../type-registry.js";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync, existsSync } from "node:fs";

// Resolve API root: build/tools/ -> build/ -> mcp-server/ -> apps/api/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, "..", "..", "..");

const FILE_UUID_RE = /\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

function extractFileUuids(content: string): string[] {
  const matches = [...content.matchAll(FILE_UUID_RE)];
  return [...new Set(matches.map((m) => m[1]))];
}

function resolveFilePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(API_ROOT, filePath);
}

/** Build a type property definition using the current registry values. */
function typeEnum(description: string) {
  return { type: "string" as const, enum: getTypeNames(), description };
}

function parseGoogleDocIdFromUrl(url: string): string | null {
  const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function readContentFromFile(filePath: string): string {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const content = readFileSync(resolved, 'utf-8');
  if (!content.trim()) {
    throw new Error(`File is empty: ${resolved}`);
  }
  return content;
}

function normalizeCreateMemoryMetadata(metadata?: Record<string, string>): Record<string, string> | undefined {
  if (!metadata || typeof metadata !== "object") return metadata;

  const normalized = { ...metadata };
  const sourceType = normalized["external-source-type"];
  const sourceUrl = normalized["external-source-url"];
  const sourceId = normalized["external-source-id"];

  if (!sourceId && sourceType === "google-doc" && typeof sourceUrl === "string") {
    const parsedId = parseGoogleDocIdFromUrl(sourceUrl.trim());
    if (parsedId) {
      normalized["external-source-id"] = parsedId;
    }
  }

  return normalized;
}

// Tools that don't reference memory type enums — defined once at module load
const staticTools: Tool[] = [
  {
  name: "create_memory_snapshot",
  description:
    "Create a manual snapshot for a memory by ID. Uses the memory update endpoint with snapshot=true and no content changes.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description:
          "Project handle (e.g., 'khef'), name, or UUID. Optional — auto-resolved from the memory if omitted.",
      },
      memory_id: {
        type: "string",
        description: "Memory ID (UUID)",
      },
    },
    required: ["memory_id"],
  },
},

  {
  name: "sync_external_snapshot",
  description:
    "Re-fetch content from a memory's external source (e.g., Google Doc) and save the current content as a pre-sync snapshot before updating. Only works on memories with external-source metadata. Returns sync result with snapshot number.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID)",
      },
      include_comments: {
        type: "boolean",
        description: "Sync comments from the external source (default: true)",
      },
    },
    required: ["memory_id"],
  },
},

  {
  name: "append_memory",
  description:
    "Append content to an existing memory without replacing it. Useful for accumulating notes, adding findings, or building up documentation incrementally. Content is automatically re-chunked if it exceeds 2000 chars.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description:
          "Project handle (e.g., 'khef'), name, or UUID. Optional — auto-resolved from the memory if omitted.",
      },
      memory_id: {
        type: "string",
        description: "Memory ID (UUID)",
      },
      content: {
        type: "string",
        description: "Content to append to the existing memory",
      },
      separator: {
        type: "string",
        description: "Separator between existing and new content (default: '\\n\\n')",
      },
    },
    required: ["memory_id", "content"],
  },
},

  {
  name: "delete_memory",
  description:
    "Delete a memory by ID. This permanently removes the memory and all its chunks. Relations involving this memory are also deleted.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description:
          "Project handle (e.g., 'khef'), name, or UUID. Optional — auto-resolved from the memory if omitted.",
      },
      memory_id: {
        type: "string",
        description: "Memory ID (UUID) to delete",
      },
    },
    required: ["memory_id"],
  },
},

  {
  name: "resolve_memory_id",
  description:
    "Find memories by partial UUID prefix. Returns matching memories with title, handle, project, and type. Useful when you have a truncated UUID and need to identify the full ID.",
  inputSchema: {
    type: "object",
    properties: {
      partial_id: {
        type: "string",
        description: "Partial UUID prefix (at least 4 hex characters, with or without dashes)",
      },
      limit: {
        type: "number",
        description: "Max results (default: 10)",
      },
    },
    required: ["partial_id"],
  },
},

  {
  name: "get_memory_by_id",
  description:
    "Fetch a memory globally by UUID. Uses UUID-only path: GET /api/memories/:id. By default excludes resolved comments. Always use full UUIDs — partial prefixes resolve only when unambiguous.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (full UUID preferred; partial prefix accepted if unambiguous)",
      },
      include_resolved: {
        type: "boolean",
        description: "Include resolved comments (default: false)",
      },
    },
    required: ["memory_id"],
  },
},

  {
  name: "get_memory_by_handle",
  description:
    "Fetch a memory by its handle within a project. Resolves handle → UUID, then returns the full memory. By default excludes resolved comments.",
  inputSchema: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description: "Memory handle (kebab-case identifier unique within project)",
      },
      project_id: {
        type: "string",
        description: "Project handle, name, or UUID",
      },
      include_resolved: {
        type: "boolean",
        description: "Include resolved comments (default: false)",
      },
    },
    required: ["handle", "project_id"],
  },
},

  {
  name: "compare_memory_snapshots",
  description:
    "Compare two snapshots of a memory, returning a line-level diff with context. 'from' and 'to' accept snapshot numbers or 'current' for the live content.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID)",
      },
      from: {
        type: "string",
        description: "Starting snapshot: number (e.g., '1') or 'current'",
      },
      to: {
        type: "string",
        description: "Ending snapshot: number (e.g., '3') or 'current'",
      },
      context: {
        type: "number",
        description: "Lines of context around changes (default: 3)",
      },
      limit: {
        type: "number",
        description: "Max change blocks to return (default: 20, 0 for all)",
      },
      offset: {
        type: "number",
        description: "Skip this many change blocks (default: 0)",
      },
    },
    required: ["memory_id", "from", "to"],
  },
},

  {
  name: "list_memory_snapshots",
  description:
    "List all snapshots for a memory, showing snapshot numbers, sources, timestamps, and which is current.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID)",
      },
    },
    required: ["memory_id"],
  },
},

  {
  name: "delete_memory_snapshot",
  description:
    "Delete one or more memory snapshots. For single delete: can delete the current snapshot (previous becomes current). For bulk delete: cannot include the current snapshot. Cannot delete the only snapshot.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID)",
      },
      snapshot_number: {
        type: "number",
        description: "Single snapshot number to delete",
      },
      snapshot_numbers: {
        type: "array",
        items: { type: "number" },
        description: "Array of snapshot numbers to bulk delete (cannot include current snapshot)",
      },
    },
    required: ["memory_id"],
  },
},

  {
  name: "restore_memory_snapshot",
  description:
    "Restore a memory to a previous snapshot. Automatically saves the current state as a safety snapshot before restoring. Replaces the memory content with the snapshot content and regenerates chunks.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID)",
      },
      snapshot_number: {
        type: "number",
        description: "Snapshot number to restore from",
      },
    },
    required: ["memory_id", "snapshot_number"],
  },
},

  {
  name: "update_memory_from_file",
  description:
    "Update an existing memory by reading content from a file on disk. Useful for large content that is awkward to pass inline as a tool parameter. The agent writes content to a file first, then passes the file path here.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID)",
      },
      file_path: {
        type: "string",
        description: "Absolute path to the file whose content will replace the memory content",
      },
      project_id: {
        type: "string",
        description:
          "Project handle (e.g., 'khef'), name, or UUID. Optional — auto-resolved from the memory if omitted.",
      },
      title: {
        type: "string",
        description: "New title (max 200 chars, must be unique within project)",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Replace all tags (empty array removes all)",
      },
    },
    required: ["memory_id", "file_path"],
  },
},

  {
  name: "create_memory_from_file",
  description:
    "Create a new memory by reading content from a file on disk. Useful for large content that is awkward to pass inline as a tool parameter. The agent writes content to a file first, then passes the file path here.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project handle (e.g., 'khef'), name, or UUID",
      },
      handle: {
        type: "string",
        description: "Memory handle - a kebab-case identifier (e.g., 'auth-flow-decision'). Must be unique within the project.",
      },
      title: {
        type: "string",
        description: "Memory title (max 200 chars, must be unique within project)",
      },
      file_path: {
        type: "string",
        description: "Absolute path to the file whose content will become the memory content",
      },
      type: {
        type: "string",
        description: "Type of memory (e.g., 'context', 'decision', 'assistant-todo')",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for organization",
      },
      metadata: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Optional key-value metadata",
      },
    },
    required: ["project_id", "handle", "title", "file_path", "type"],
  },
},
];

/**
 * Build the full tool list. Tools with type enum properties are built
 * dynamically so they reflect the current type registry (including custom types).
 */
export function getTools(): Tool[] {
  const dynamicTools: Tool[] = [
    {
    name: "search_memories",
    description:
      "Search and filter memories. Supports full-text search (mode=keyword, default) or semantic/vector search (mode=semantic). Filtering by type/tag/status and pagination. If project_id is omitted, searches across all projects.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project UUID (UUID-only). If omitted, searches across all projects.",
        },
        q: {
          type: "string",
          description: "Search query (full-text for keyword mode, natural language for semantic mode)",
        },
        mode: {
          type: "string",
          enum: ["keyword", "semantic"],
          description: "Search mode: 'keyword' (default, PostgreSQL full-text) or 'semantic' (vector similarity)",
        },
        project_handle: {
          type: "string",
          description: "Global search only: filter by exact project handle (ignored if project_id provided)",
        },
        project_name: {
          type: "string",
          description: "Global search only: filter by exact project name",
        },
        handle: {
          type: "string",
          description: "Filter by memory handle (exact match)",
        },
        name: {
          type: "string",
          description: "Filter by memory title (exact match)",
        },
        type: typeEnum("Filter by memory type"),
        tag: {
          type: "string",
          description: "Filter by tag name",
        },
        status: {
          type: "string",
          description: "Filter by status value (e.g., 'in_progress', 'done', 'active')",
        },
        limit: {
          type: "number",
          description: "Number of results per page (default: 20)",
        },
        offset: {
          type: "number",
          description: "Number of results to skip (default: 0)",
        },
        compact: {
          type: "boolean",
          description: "Return compact format with content_excerpt instead of full content (default: true)",
        },
        pinned: {
          type: "boolean",
          description: "Filter by pinned status: true returns only pinned memories, false returns only unpinned",
        },
      },
      required: [],
    },
  },

    {
    name: "search_content",
    description:
      "Search memories by content only (excludes tag matching). Use this when you want to search only within memory content/text, not tag names.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project UUID (UUID-only). If omitted, searches across all projects.",
        },
        q: {
          type: "string",
          description: "Full-text search query across memory content only",
        },
        project_handle: {
          type: "string",
          description: "Global search only: filter by exact project handle (ignored if project_id provided)",
        },
        project_name: {
          type: "string",
          description: "Global search only: filter by exact project name",
        },
        type: typeEnum("Filter by memory type"),
        tag: {
          type: "string",
          description: "Filter by tag name",
        },
        status: {
          type: "string",
          description: "Filter by status value (e.g., 'in_progress', 'done', 'active')",
        },
        limit: {
          type: "number",
          description: "Number of results per page (default: 20)",
        },
        offset: {
          type: "number",
          description: "Number of results to skip (default: 0)",
        },
        compact: {
          type: "boolean",
          description: "Return compact format with content_excerpt instead of full content (default: true)",
        },
      },
      required: ["q"],
    },
  },

    {
    name: "search_tags",
    description:
      "Search memories by tag names only. Use this when you want to find memories that have tags matching a search term.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project UUID (UUID-only). If omitted, searches across all projects.",
        },
        q: {
          type: "string",
          description: "Search query to match against tag names (case-insensitive partial match)",
        },
        project_handle: {
          type: "string",
          description: "Global search only: filter by exact project handle (ignored if project_id provided)",
        },
        project_name: {
          type: "string",
          description: "Global search only: filter by exact project name",
        },
        type: typeEnum("Filter by memory type"),
        status: {
          type: "string",
          description: "Filter by status value (e.g., 'in_progress', 'done', 'active')",
        },
        limit: {
          type: "number",
          description: "Number of results per page (default: 20)",
        },
        offset: {
          type: "number",
          description: "Number of results to skip (default: 0)",
        },
        compact: {
          type: "boolean",
          description: "Return compact format with content_excerpt instead of full content (default: true)",
        },
      },
      required: ["q"],
    },
  },

    {
    name: "create_memory",
    description:
      "Create a new memory in a project. Requires: project_id, handle, title, content, type. The 'handle' is a kebab-case identifier for the memory (e.g., 'auth-decision', 'db-pattern'). Use project_id='user' for general/user memories not tied to a specific project. Content over 2000 chars is automatically chunked.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project handle (e.g., 'khef'), name, or UUID",
        },
        handle: {
          type: "string",
          description: "Memory handle - a kebab-case identifier for this memory (e.g., 'auth-flow-decision', 'api-pattern'). Must be unique within the project. Required.",
        },
        title: {
          type: "string",
          description: "Memory title (max 200 chars, must be unique within project)",
        },
        content: {
          type: "string",
          description: "Memory content (auto-chunked if >2000 chars). For type='video': first line must be a video URL. Use external URLs directly (e.g. 'https://youtube.com/...'). For local files, use a stub URL (e.g. 'pending-upload') and tell the user to upload via the upload button on the memory page. Remaining lines are markdown notes below the player. Example: 'https://example.com/talk.mp4\\n\\n## Notes\\n- Key point at 2:30'. For type='diagram': Mermaid/D2/PlantUML source. For type='csv': raw CSV data.",
        },
        type: typeEnum("Type of memory. 'video' renders an inline player (content = URL on first line)."),
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for organization",
        },
        metadata: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional key-value metadata (e.g., { 'external-source-type': 'google-doc', 'external-source-url': 'https://...' }). Keys must match registered metadata fields.",
        },
      },
      required: ["project_id", "handle", "title", "content", "type"],
    },
  },

    {
    name: "update_memory",
    description:
      "Update an existing memory. Can modify title, content, type, tags, metadata, or move to a different project. Use update_memory_status to change status.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description:
            "Project handle (e.g., 'khef'), name, or UUID. Identifies the memory's current project. Optional — auto-resolved from the memory if omitted.",
        },
        new_project_id: {
          type: "string",
          description:
            "Move memory to a different project. Accepts project handle, name, or UUID. Title and handle must be unique in the target project.",
        },
        memory_id: {
          type: "string",
          description: "Memory ID (UUID)",
        },
        title: {
          type: "string",
          description: "New title (max 200 chars, must be unique within project)",
        },
        content: {
          type: "string",
          description: "New content",
        },
        type: typeEnum("New type"),
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Replace all tags (empty array removes all)",
        },
        metadata: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Key-value metadata to set or update (e.g., { 'external-source-type': 'jira', 'external-source-url': 'https://...' }). Keys must match registered metadata fields.",
        },
      },
      required: ["memory_id"],
    },
  },
  ];

  return [...dynamicTools, ...staticTools];
}

// Backward-compat: modules that only check `m.tools` still work via getTools()
export const tools: Tool[] = [];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "search_memories": {
      const fmt = (args.format as string) || "text";
      const mode = (args.mode as string) || 'keyword';

      let result;
      if (mode === 'semantic') {
        // Semantic search via vector embeddings
        if (!args.q) {
          throw new Error('q (query) is required for semantic search');
        }
        result = await client.semanticSearch({
          q: args.q as string,
          project_id: args.project_id as string | undefined,
          type: args.type as string | undefined,
          limit: args.limit as number | undefined,
          compact: args.compact !== undefined ? args.compact as boolean : true,
        });
      } else {
        // Keyword search via PostgreSQL full-text
        result = await client.searchMemories(args.project_id as string | undefined, {
          q: args.q as string | undefined,
          search_mode: 'all',
          type: args.type as string | undefined,
          tag: args.tag as string | undefined,
          status: args.status as string | undefined,
          project_handle: args.project_handle as string | undefined,
          project_name: args.project_name as string | undefined,
          handle: args.handle as string | undefined,
          name: args.name as string | undefined,
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
          compact: args.compact !== undefined ? args.compact as boolean : true,
          pinned: args.pinned as boolean | undefined,
        });
      }

      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? formatSearchResults(result, args.q as string | undefined) : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "search_content": {
      const fmt = (args.format as string) || "text";
      const result = await client.searchMemories(args.project_id as string | undefined, {
        q: args.q as string | undefined,
        search_mode: 'content',
        type: args.type as string | undefined,
        tag: args.tag as string | undefined,
        status: args.status as string | undefined,
        project_handle: args.project_handle as string | undefined,
        project_name: args.project_name as string | undefined,
        handle: args.handle as string | undefined,
        name: args.name as string | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
        compact: args.compact !== undefined ? args.compact as boolean : true,
      });
      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? formatSearchResults(result, args.q as string | undefined) : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "search_tags": {
      const fmt = (args.format as string) || "text";
      const result = await client.searchMemories(args.project_id as string | undefined, {
        q: args.q as string | undefined,
        search_mode: 'tags',
        type: args.type as string | undefined,
        status: args.status as string | undefined,
        project_handle: args.project_handle as string | undefined,
        project_name: args.project_name as string | undefined,
        handle: args.handle as string | undefined,
        name: args.name as string | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
        compact: args.compact !== undefined ? args.compact as boolean : true,
      });
      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? formatSearchResults(result, args.q as string | undefined) : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "create_memory": {
      const projectId = args.project_id as string;
      const handle = args.handle as string;
      const title = args.title as string;
      const content = args.content as string;
      const type = args.type as string;
      const rawTags = sanitizeTags(args.tags);
      const tags = rawTags.length > 0 ? rawTags : undefined;

      if (!handle) {
        return {
          content: [
            {
              type: "text",
              text: "Missing required 'handle'. Provide a kebab-case handle unique within the project.",
            },
          ],
          isError: true,
        };
      }

      const metadata = normalizeCreateMemoryMetadata(args.metadata as Record<string, string> | undefined);
      const result = await client.createMemory(projectId, handle, title, content, type, tags, metadata);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "update_memory": {
      const sanitizedTags = args.tags !== undefined ? sanitizeTags(args.tags) : undefined;
      const metadata = normalizeCreateMemoryMetadata(args.metadata as Record<string, string> | undefined);
      const result = await client.updateMemory(
        args.project_id as string | undefined,
        args.memory_id as string,
        {
          title: args.title as string | undefined,
          content: args.content as string | undefined,
          type: args.type as string | undefined,
          tags: sanitizedTags,
          metadata,
        },
        args.new_project_id as string | undefined
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

    case "create_memory_snapshot": {
      const result = await client.createMemorySnapshot(
        args.project_id as string | undefined,
        args.memory_id as string
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

    case "sync_external_snapshot": {
      const result = await client.syncExternalSnapshot(
        args.memory_id as string,
        args.include_comments !== false
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

    case "append_memory": {
      const result = await client.appendMemory(
        args.project_id as string | undefined,
        args.memory_id as string,
        args.content as string,
        args.separator as string | undefined
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

    case "delete_memory": {
      const result = await client.deleteMemory(
        args.project_id as string | undefined,
        args.memory_id as string
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

    case "resolve_memory_id": {
      const partialId = (args.partial_id as string).toLowerCase();
      const limit = (args.limit as number) || 10;

      if (partialId.replace(/-/g, '').length < 4) {
        return {
          content: [{ type: "text", text: "Partial UUID must be at least 4 hex characters." }],
          isError: true,
        };
      }

      const rows = (await dbClient.queryKhef(
        `SELECT m.id::text, m.title, m.handle, p.handle AS project_handle,
                mt.name AS type, mts.status_value AS status
         FROM memories m
         JOIN projects p ON p.id = m.project_id
         JOIN memory_types mt ON mt.id = m.memory_type_id
         LEFT JOIN memory_type_statuses mts ON mts.id = m.status_id
         WHERE m.id::text LIKE $1
         ORDER BY m.updated_at DESC
         LIMIT $2`,
        [partialId + '%', limit]
      )) as { rows: Array<{ id: string; title: string; handle: string; project_handle: string; type: string; status: string }> };

      if (rows.rows.length === 0) {
        return {
          content: [{ type: "text", text: `No memories found matching prefix "${partialId}"` }],
        };
      }

      const lines = rows.rows.map((r, i) =>
        `${i + 1}. ${r.id}\n   ${r.title} (${r.type}, ${r.status})\n   Project: ${r.project_handle} | Handle: ${r.handle}`
      );
      return {
        content: [{
          type: "text",
          text: `Found ${rows.rows.length} memor${rows.rows.length === 1 ? 'y' : 'ies'} matching "${partialId}":\n\n${lines.join('\n\n')}`,
        }],
      };
    }

    case "get_memory_by_id": {
      const fmt = (args.format as string) || "text";
      const result = await client.getGlobalMemory(
        args.memory_id as string,
        args.include_resolved as boolean | undefined ?? false
      );

      let files: any[] | undefined;
      if (fmt === "text") {
        const content = result.memory?.content || "";
        const fileUuids = extractFileUuids(content);
        if (fileUuids.length > 0) {
          try {
            const fileResult = (await dbClient.queryKhef(
              `SELECT id, original_filename, mime_type, size, path FROM files WHERE id = ANY($1::uuid[])`,
              [fileUuids]
            )) as { rows: any[] };
            files = fileResult.rows.map((f: any) => ({
              ...f,
              disk_path: resolveFilePath(f.path),
            }));
          } catch {
            // DB unavailable — skip file resolution
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? formatMemory(result, files) : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "get_memory_by_handle": {
      const fmt = (args.format as string) || "text";
      const memoryId = await client.resolveMemoryId(
        args.handle as string,
        args.project_id as string
      );
      const result = await client.getGlobalMemory(
        memoryId,
        args.include_resolved as boolean | undefined ?? false
      );

      let files: any[] | undefined;
      if (fmt === "text") {
        const content = result.memory?.content || "";
        const fileUuids = extractFileUuids(content);
        if (fileUuids.length > 0) {
          try {
            const fileResult = (await dbClient.queryKhef(
              `SELECT id, original_filename, mime_type, size, path FROM files WHERE id = ANY($1::uuid[])`,
              [fileUuids]
            )) as { rows: any[] };
            files = fileResult.rows.map((f: any) => ({
              ...f,
              disk_path: resolveFilePath(f.path),
            }));
          } catch {
            // DB unavailable — skip file resolution
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? formatMemory(result, files) : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "compare_memory_snapshots": {
      const fmt = (args.format as string) || "text";
      const result = await client.compareMemorySnapshots(
        args.memory_id as string,
        args.from as string,
        args.to as string,
        args.context as number | undefined,
        args.limit as number | undefined,
        args.offset as number | undefined
      );
      return {
        content: [
          {
            type: "text",
            text: fmt === "text" ? formatSnapshotDiff(result) : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "list_memory_snapshots": {
      const result = await client.listMemorySnapshots(
        args.memory_id as string
      );
      return {
        content: [
          {
            type: "text",
            text: formatMemorySnapshots(result),
          },
        ],
      };
    }

    case "delete_memory_snapshot": {
      const memId = args.memory_id as string;
      const nums = args.snapshot_numbers as number[] | undefined;
      const num = args.snapshot_number as number | undefined;

      let result;
      if (nums && nums.length > 0) {
        result = await client.bulkDeleteMemorySnapshots(memId, nums);
      } else if (num != null) {
        result = await client.deleteMemorySnapshot(memId, num);
      } else {
        return {
          content: [{ type: "text", text: "Error: provide snapshot_number or snapshot_numbers" }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "restore_memory_snapshot": {
      const result = await client.restoreMemorySnapshot(
        args.memory_id as string,
        args.snapshot_number as number
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

    case "update_memory_from_file": {
      const filePath = args.file_path as string;
      const content = readContentFromFile(filePath);
      const sanitizedTags = args.tags !== undefined ? sanitizeTags(args.tags) : undefined;
      const result = await client.updateMemory(
        args.project_id as string | undefined,
        args.memory_id as string,
        {
          content,
          title: args.title as string | undefined,
          tags: sanitizedTags,
        }
      );
      return {
        content: [
          {
            type: "text",
            text: formatMutationResult(result, { action: "Updated", source: filePath }),
          },
        ],
      };
    }

    case "create_memory_from_file": {
      const filePath = args.file_path as string;
      const content = readContentFromFile(filePath);
      const handle = args.handle as string;
      if (!handle) {
        return {
          content: [
            {
              type: "text",
              text: "Missing required 'handle'. Provide a kebab-case handle unique within the project.",
            },
          ],
          isError: true,
        };
      }
      const rawTags = sanitizeTags(args.tags);
      const tags = rawTags.length > 0 ? rawTags : undefined;
      const metadata = normalizeCreateMemoryMetadata(args.metadata as Record<string, string> | undefined);
      const result = await client.createMemory(
        args.project_id as string,
        handle,
        args.title as string,
        content,
        args.type as string,
        tags,
        metadata
      );
      return {
        content: [
          {
            type: "text",
            text: formatMutationResult(result, { action: "Created", source: filePath }),
          },
        ],
      };
    }

    default:
      return null;
  }
}
