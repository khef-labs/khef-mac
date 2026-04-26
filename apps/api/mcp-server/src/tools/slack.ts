import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatSlackSearchResults, formatSlackDocumentList, formatSlackChannelList } from "../formatters/slack.js";

export const tools: Tool[] = [
  {
    name: "ingest_slack",
    description:
      "Ingest Slack markdown content into the slack-messages kvec collection for semantic search. Uses heading-aware markdown chunking with ### message headers. Returns the number of chunks created (0 if content unchanged).",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Markdown content to ingest (### [timestamp] USERID headings per message). Use 'path' instead for large files.",
        },
        path: {
          type: "string",
          description: "Absolute file path to a markdown file to ingest. Preferred over 'content' for large files (avoids JSON body size limits). Provide either content or path, not both.",
        },
        document_id: {
          type: "string",
          description:
            "Stable identifier for this document (e.g., 'general-2024-05', 'backend-incident-123'). Used for deduplication and deletion.",
        },
        channel: {
          type: "string",
          description: "Slack channel name (required, e.g., 'general', 'dev-tools')",
        },
        workspace: {
          type: "string",
          description: "Slack workspace name (e.g., 'idme')",
        },
        team: {
          type: "string",
          description: "Team or group name",
        },
        topic: {
          type: "string",
          description: "Topic or thread subject",
        },
        date_range: {
          type: "string",
          description: "Date range covered (e.g., '2024-05-01 to 2024-05-31')",
        },
      },
      required: ["document_id", "channel"],
    },
  },
  {
    name: "search_slack",
    description:
      "Search across all ingested Slack content. Supports semantic and keyword modes. Returns matching message chunks with content, scores, and metadata.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Search query (natural language for semantic mode, terms for keyword mode)",
        },
        mode: {
          type: "string",
          enum: ["semantic", "keyword"],
          description: "Search mode (default: semantic)",
        },
        channel: {
          type: "string",
          description: "Filter by channel name",
        },
        workspace: {
          type: "string",
          description: "Filter by workspace name",
        },
        limit: {
          type: "number",
          description: "Max results (default: 10, max: 50)",
        },
        since: {
          type: "string",
          description: "Only include messages from documents updated after this date (ISO 8601, e.g., '2025-01-01')",
        },
        until: {
          type: "string",
          description: "Only include messages from documents updated before this date (ISO 8601, e.g., '2025-03-31')",
        },
      },
      required: ["q"],
    },
  },
  {
    name: "list_slack_documents",
    description:
      "List ingested Slack documents with metadata, chunk counts, and timestamps. Supports filtering by channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Filter by exact channel name (e.g., 'eng-platform')",
        },
        limit: {
          type: "number",
          description: "Results per page (default: 50)",
        },
        offset: {
          type: "number",
          description: "Results to skip (default: 0)",
        },
      },
    },
  },
  {
    name: "list_slack_channels",
    description:
      "List Slack channels that have ingested documents, with document and chunk counts per channel. Supports prefix filtering for typeahead.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Filter by substring match (case-insensitive, e.g., 'plat' matches 'eng-platform')",
        },
      },
    },
  },
  {
    name: "ingest_slack_dir",
    description:
      "Ingest all .md files in a directory into the slack-messages collection. Derives document_id from each filename (sans .md) and channel from filename (strips -messages suffix and -YYYY-MM date suffix). Returns per-file results with chunk counts.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to a directory containing .md files to ingest.",
        },
        channel: {
          type: "string",
          description: "Override channel name for all files. If omitted, derived from each filename.",
        },
        workspace: {
          type: "string",
          description: "Slack workspace name (e.g., 'idme')",
        },
        team: {
          type: "string",
          description: "Team or group name",
        },
        topic: {
          type: "string",
          description: "Topic or thread subject",
        },
        date_range: {
          type: "string",
          description: "Date range covered (e.g., '2024-05-01 to 2024-05-31')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "delete_slack_document",
    description:
      "Delete an ingested Slack document and all its chunks by document_id.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: {
          type: "string",
          description: "The document_id used during ingestion",
        },
      },
      required: ["document_id"],
    },
  },
  {
    name: "register_slack_channel",
    description:
      "Register a Slack channel for tracked export/sync. Upserts by workspace_id + channel_id.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Slack channel ID (e.g., 'D03FA9ZJ9GC', 'C01234ABCDE')",
        },
        workspace_id: {
          type: "string",
          description: "Slack workspace ID (e.g., 'T03C0ENJ6UE')",
        },
        workspace_name: {
          type: "string",
          description: "Human-readable workspace name (e.g., 'railsconf2022')",
        },
        channel_name: {
          type: "string",
          description: "Friendly channel name for file paths and display (e.g., 'roger-garza', 'general')",
        },
        channel_type: {
          type: "string",
          enum: ["dm", "public", "private", "mpim"],
          description: "Channel type (default: 'dm')",
        },
        export_path: {
          type: "string",
          description: "Override export path relative to project root (default: chats/<channel_name>)",
        },
      },
      required: ["channel_id", "workspace_id", "channel_name"],
    },
  },
  {
    name: "list_registered_slack_channels",
    description:
      "List Slack channels registered for tracked export/sync, with their export state (last_message_ts, last_exported_at, message_count).",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Filter by workspace ID or name",
        },
      },
    },
  },
  {
    name: "get_slack_channel",
    description:
      "Look up a registered Slack channel by name or channel ID. Returns channel details including IDs, workspace, type, and export state.",
    inputSchema: {
      type: "object",
      properties: {
        channel_name: {
          type: "string",
          description: "Channel display name (e.g., 'roger-garza', 'general'). Case-insensitive.",
        },
        channel_id: {
          type: "string",
          description: "Slack channel ID (e.g., 'D03FA9ZJ9GC')",
        },
      },
    },
  },
  {
    name: "sync_slack_channel",
    description:
      "Trigger a full export→split→ingest pipeline for a registered Slack channel via kdag. Creates and queues a slack-channel-sync job. Uses last_message_ts for incremental export. Provide any one of: channel_name, channel_id, or id to identify the channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel_name: {
          type: "string",
          description: "Channel display name (e.g., 'roger-garza'). Looks up channel_id and workspace_id from the registered channels table.",
        },
        channel_id: {
          type: "string",
          description: "Slack channel ID (e.g., D03FA9ZJ9GC)",
        },
        id: {
          type: "string",
          description: "Database UUID of the registered channel",
        },
      },
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
    case "ingest_slack": {
      const metadata: Record<string, unknown> = {};
      if (args.workspace) metadata.workspace = args.workspace;
      if (args.team) metadata.team = args.team;
      if (args.topic) metadata.topic = args.topic;
      if (args.date_range) metadata.date_range = args.date_range;

      const body: Record<string, unknown> = {
        document_id: args.document_id as string,
        channel: args.channel as string,
      };
      if (args.path) {
        body.path = args.path as string;
      } else {
        body.content = args.content as string;
      }
      if (Object.keys(metadata).length > 0) {
        body.metadata = metadata;
      }

      const result = await client.ingestSlack(body as any);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "search_slack": {
      const fmt = (args.format as string) || "text";
      const result = await client.searchSlack(args.q as string, {
        mode: args.mode as 'keyword' | 'semantic' | undefined,
        channel: args.channel as string | undefined,
        workspace: args.workspace as string | undefined,
        limit: args.limit as number | undefined,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
      });
      return {
        content: [{ type: "text", text: fmt === "text" ? formatSlackSearchResults(result, args) : JSON.stringify(result, null, 2) }],
      };
    }

    case "list_slack_documents": {
      const fmt = (args.format as string) || "text";
      const result = await client.listSlackDocuments({
        channel: args.channel as string | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
      });
      return {
        content: [{ type: "text", text: fmt === "text" ? formatSlackDocumentList(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "list_slack_channels": {
      const result = await client.listSlackChannels(args.channel as string | undefined);
      return {
        content: [{ type: "text", text: formatSlackChannelList(result) }],
      };
    }

    case "ingest_slack_dir": {
      const body: Record<string, unknown> = {
        path: args.path as string,
      };
      if (args.channel) body.channel = args.channel;
      if (args.workspace) body.workspace = args.workspace;
      if (args.team) body.team = args.team;
      if (args.topic) body.topic = args.topic;
      if (args.date_range) body.date_range = args.date_range;

      const result = await client.ingestSlackDir(body as any);
      const r = result as any;
      const lines = [
        `Status: ${r.status}`,
        `Path: ${r.path}`,
        `Files queued: ${r.files}`,
      ];
      return {
        content: [{ type: "text", text: lines.join('\n') }],
      };
    }

    case "delete_slack_document": {
      const result = await client.deleteSlackDocument(
        args.document_id as string
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "register_slack_channel": {
      const result = await client.registerSlackChannel({
        channel_id: args.channel_id as string,
        workspace_id: args.workspace_id as string,
        workspace_name: args.workspace_name as string | undefined,
        channel_name: args.channel_name as string,
        channel_type: args.channel_type as string | undefined,
        export_path: args.export_path as string | undefined,
      });
      const ch = (result as any).channel;
      const lines = [
        `Registered: ${ch.channel_name} (${ch.channel_id})`,
        `Workspace: ${ch.workspace_name || ch.workspace_id}`,
        `Type: ${ch.channel_type}`,
        `ID: ${ch.id}`,
      ];
      if (ch.last_exported_at) {
        lines.push(`Last exported: ${ch.last_exported_at}`);
      }
      return {
        content: [{ type: "text", text: lines.join('\n') }],
      };
    }

    case "list_registered_slack_channels": {
      const result = await client.listRegisteredSlackChannels(
        args.workspace as string | undefined
      );
      const r = result as any;
      if (!r.channels || r.channels.length === 0) {
        return {
          content: [{ type: "text", text: "No registered channels found." }],
        };
      }
      const lines = [`# Registered Slack Channels (${r.total_count})`, ''];
      for (const ch of r.channels) {
        const exported = ch.last_exported_at
          ? `last exported ${new Date(ch.last_exported_at).toLocaleDateString()}, ${ch.message_count} msgs`
          : 'never exported';
        lines.push(`- **${ch.channel_name}** (${ch.channel_id}) — ${ch.workspace_name || ch.workspace_id} — ${ch.channel_type} — ${exported}`);
        lines.push(`  ID: ${ch.id}`);
      }
      return {
        content: [{ type: "text", text: lines.join('\n') }],
      };
    }

    case "get_slack_channel": {
      const listResult = await client.listRegisteredSlackChannels() as any;
      const channels = listResult.channels || [];
      const nameQuery = (args.channel_name as string || '').toLowerCase();
      const idQuery = args.channel_id as string || '';

      if (!nameQuery && !idQuery) {
        return {
          content: [{ type: "text", text: "Provide channel_name or channel_id to look up a channel." }],
          isError: true,
        };
      }

      const match = channels.find((ch: any) =>
        (nameQuery && ch.channel_name.toLowerCase() === nameQuery) ||
        (idQuery && ch.channel_id === idQuery)
      );

      if (!match) {
        const identifier = idQuery ? `channel_id: ${idQuery}` : `channel_name: ${nameQuery}`;
        return {
          content: [{ type: "text", text: `No registered channel found with ${identifier}.` }],
        };
      }

      const exported = match.last_exported_at
        ? `${new Date(match.last_exported_at).toLocaleDateString()}, ${match.message_count} msgs`
        : 'never exported';
      const lines = [
        `# ${match.channel_name}`,
        '',
        `| Field | Value |`,
        `|-------|-------|`,
        `| Channel ID | ${match.channel_id} |`,
        `| Workspace | ${match.workspace_name || match.workspace_id} |`,
        `| Workspace ID | ${match.workspace_id} |`,
        `| Type | ${match.channel_type} |`,
        `| DB ID | ${match.id} |`,
        `| Last Exported | ${exported} |`,
      ];
      if (match.export_path) {
        lines.push(`| Export Path | ${match.export_path} |`);
      }
      return {
        content: [{ type: "text", text: lines.join('\n') }],
      };
    }

    case "sync_slack_channel": {
      // Look up the channel by channel_name, channel_id, or database UUID
      let channelDbId = args.id as string | undefined;
      if (!channelDbId && (args.channel_id || args.channel_name)) {
        const listResult = await client.listRegisteredSlackChannels() as any;
        const channels = listResult.channels || [];
        let match: any;
        if (args.channel_id) {
          match = channels.find((ch: any) => ch.channel_id === args.channel_id);
        } else if (args.channel_name) {
          match = channels.find((ch: any) => ch.channel_name === args.channel_name);
        }
        if (!match) {
          const identifier = args.channel_id ? `channel_id: ${args.channel_id}` : `channel_name: ${args.channel_name}`;
          return {
            content: [{ type: "text", text: `No registered channel found with ${identifier}. Register it first with register_slack_channel.` }],
            isError: true,
          };
        }
        channelDbId = match.id;
      }
      if (!channelDbId) {
        return {
          content: [{ type: "text", text: "Provide channel_name, channel_id, or id to identify the channel." }],
          isError: true,
        };
      }

      const result = await client.syncSlackChannel(channelDbId);
      const r = result as any;
      const lines = [
        `Sync job queued for: ${r.channel}`,
        `Job ID: ${r.job_id}`,
        `Run ID: ${r.run_id}`,
        `Status: ${r.status}`,
      ];
      return {
        content: [{ type: "text", text: lines.join('\n') }],
      };
    }

    default:
      return null;
  }
}
