import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatMemory } from "../formatters/memories.js";

export const tools: Tool[] = [
  {
    name: "import_google_doc",
    description:
      "Import a Google Doc as a khef memory with full external source metadata (enables sync). Requires gcloud auth with Drive scope. Accepts a Google Doc URL or document ID. Optionally imports Google Doc comments as anchored khef comments.",
    inputSchema: {
      type: "object",
      properties: {
        doc_url: {
          type: "string",
          description:
            "Google Doc URL (e.g., 'https://docs.google.com/document/d/abc123/edit') or raw document ID",
        },
        project_id: {
          type: "string",
          description: "Project handle (e.g., 'khef'), name, or UUID",
        },
        handle: {
          type: "string",
          description:
            "Memory handle (kebab-case). Auto-generated from doc title if omitted.",
        },
        type: {
          type: "string",
          description:
            "Memory type (default: 'google-doc'). Use 'google-doc' for the base type.",
        },
        subtype: {
          type: "string",
          description:
            "Child type under the parent type (e.g., 'design-doc' under 'google-doc'). Resolved as child of type.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to apply to the imported memory",
        },
        include_comments: {
          type: "boolean",
          description:
            "Import Google Doc comments as anchored khef comments (default: true)",
        },
      },
      required: ["doc_url", "project_id"],
    },
  },
  {
    name: "push_to_google_doc",
    description:
      "Push khef memory content back to its linked Google Doc (reverse sync). Replaces the Google Doc body with the memory's current content. The memory must have external-source-id metadata linking it to a Google Doc. Updates the last-synced timestamp on success.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: {
          type: "string",
          description: "Memory ID (UUID) to push to Google Docs",
        },
        mode: {
          type: "string",
          enum: ["html", "workspace"],
          description:
            "Push mode: 'html' (Drive API media upload, works everywhere) or 'workspace' (Docs API batchUpdate with native formatting). Defaults to google.workspace setting.",
        },
      },
      required: ["memory_id"],
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
    case "import_google_doc": {
      const docUrl = args.doc_url as string;
      const projectId = args.project_id as string;

      // Check Google availability first
      const status = (await client.getGoogleStatus()) as {
        available: boolean;
        reason?: string;
      };
      if (!status.available) {
        return {
          content: [
            {
              type: "text",
              text: `Google integration unavailable: ${status.reason || "gcloud not authenticated"}. Run: gcloud auth login --enable-gdrive-access`,
            },
          ],
          isError: true,
        };
      }

      const result = (await client.importGoogleDoc(docUrl, projectId, {
        handle: args.handle as string | undefined,
        type: args.type as string | undefined,
        subtype: args.subtype as string | undefined,
        tags: args.tags as string[] | undefined,
        includeComments: args.include_comments as boolean | undefined,
      })) as { memory: Record<string, unknown> };

      return {
        content: [
          {
            type: "text",
            text: formatMemory(result.memory),
          },
        ],
      };
    }

    case "push_to_google_doc": {
      const memoryId = args.memory_id as string;

      // Check Google availability first
      const status = (await client.getGoogleStatus()) as {
        available: boolean;
        reason?: string;
      };
      if (!status.available) {
        return {
          content: [
            {
              type: "text",
              text: `Google integration unavailable: ${status.reason || "gcloud not authenticated"}. Run: gcloud auth login --enable-gdrive-access`,
            },
          ],
          isError: true,
        };
      }

      // Get the memory to find its linked Google Doc ID
      const memory = (await client.getGlobalMemory(memoryId)) as {
        memory: { id: string; title: string; metadata?: Record<string, string> };
      };

      const docId =
        memory.memory.metadata?.["external-source-id"];

      if (!docId) {
        return {
          content: [
            {
              type: "text",
              text: "This memory has no linked Google Doc (missing external-source-id metadata). Import it via import_google_doc first.",
            },
          ],
          isError: true,
        };
      }

      const result = (await client.pushToGoogleDoc(docId, memoryId, args.mode as string | undefined)) as {
        success: boolean;
        doc: { docId: string; title: string; url: string };
        synced_at: string;
      };

      return {
        content: [
          {
            type: "text",
            text: `Pushed to Google Doc: ${result.doc.title}\nURL: ${result.doc.url}\nSynced at: ${result.synced_at}`,
          },
        ],
      };
    }

    default:
      return null;
  }
}
