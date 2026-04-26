import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatDocSearchResults, formatDocContent } from "../formatters/docs.js";

export const tools: Tool[] = [
  {
    name: "search_docs",
    description:
      "Semantic search across indexed documents (markdown, PDF, text files) using vector embeddings. Returns matching document chunks with file paths, scores, and metadata. Requires the kvec-docs collection to be populated via doc embed jobs.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Natural language search query",
        },
        project: {
          type: "string",
          description: "Filter by project handle",
        },
        tag: {
          type: "string",
          description: "Filter by tag name",
        },
        file_type: {
          type: "string",
          description: "Filter by file type (e.g., 'md', 'pdf', 'txt')",
        },
        limit: {
          type: "number",
          description: "Max results (default: 10)",
        },
        min_score: {
          type: "number",
          description: "Minimum similarity score 0-1 (default: 0)",
        },
      },
      required: ["q"],
    },
  },
  {
    name: "get_doc_content",
    description:
      "Retrieve the content of an indexed document from the kvec-docs collection. Returns paginated chunks ordered by position. Use the document_id (file_path) from search_docs results. Useful for reading full document content including extracted PDF text.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: {
          type: "string",
          description: "The document file path (from search_docs results file_path field)",
        },
        limit: {
          type: "number",
          description: "Max chunks to return per page (default: 10)",
        },
        offset: {
          type: "number",
          description: "Number of chunks to skip (default: 0)",
        },
      },
      required: ["document_id"],
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
    case "search_docs": {
      const result = await client.searchDocs({
        q: args.q as string,
        project: args.project as string | undefined,
        tag: args.tag as string | undefined,
        file_type: args.file_type as string | undefined,
        limit: args.limit as number | undefined,
        min_score: args.min_score as number | undefined,
      });
      return {
        content: [{ type: "text", text: formatDocSearchResults(result, args) }],
      };
    }

    case "get_doc_content": {
      const result = await client.getDocContent({
        document_id: args.document_id as string,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
      });
      return {
        content: [{ type: "text", text: formatDocContent(result) }],
      };
    }

    default:
      return null;
  }
}
