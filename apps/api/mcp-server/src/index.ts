#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { KhefClient } from "./clients/khef-client.js";
import { DbClient } from "./clients/db-client.js";
import { init as initTypeRegistry } from "./type-registry.js";

// Import all tool modules
import * as projectTools from "./tools/projects.js";
import * as memoryTools from "./tools/memories.js";
import * as relationTools from "./tools/relations.js";
import * as tagTools from "./tools/tags.js";
import * as statusTools from "./tools/status.js";
import * as knowledgeTools from "./tools/knowledge.js";
import * as agentTools from "./tools/agents.js";
import * as commentTools from "./tools/comments.js";
import * as sessionTools from "./tools/sessions.js";
import * as planTools from "./tools/plans.js";
import * as sectionTools from "./tools/sections.js";
import * as diffTools from "./tools/diffs.js";
import * as memoryTypeTools from "./tools/memory-types.js";
import * as kdagTools from "./tools/kdag.js";
import * as kapiTools from "./tools/kapi.js";
import * as promptTools from "./tools/prompts.js";
import * as savedQueryTools from "./tools/saved-queries.js";
import * as assistantChatTools from "./tools/assistant-chat.js";
import * as exportTools from "./tools/export.js";
import * as dbTools from "./tools/db.js";
import * as activeSessionTools from "./tools/active-sessions.js";
import * as sourceCodeTools from "./tools/source-code.js";
import * as kvecTools from "./tools/kvec.js";
import * as slackTools from "./tools/slack.js";
import * as collectionTools from "./tools/collections.js";
import * as liveMessageTools from "./tools/live-messages.js";
import * as agentQuestionTools from "./tools/agent-questions.js";
import * as jobErrorTools from "./tools/job-errors.js";
import * as docsTools from "./tools/docs.js";
import * as unifiedSearchTools from "./tools/unified-search.js";
import * as googleTools from "./tools/google.js";
import * as logTools from "./tools/logs.js";
import * as sessionTeamTools from "./tools/session-teams.js";
import * as notificationTools from "./tools/notifications.js";

// Environment configuration
const API_URL = process.env.KHEF_API_URL || "http://localhost:3201";

const client = new KhefClient(API_URL);
const dbClient = new DbClient();

// Warn if the build appears stale compared to source (best-effort)
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // Running from build; compare build file mtime to src file mtime
  const buildFile = path.join(__dirname, "index.js");
  const srcFile = path.join(__dirname, "../src/index.ts");
  if (fs.existsSync(buildFile) && fs.existsSync(srcFile)) {
    const b = fs.statSync(buildFile).mtimeMs;
    const s = fs.statSync(srcFile).mtimeMs;
    if (s > b) {
      console.error(
        "[khef MCP] Warning: build is older than source. Run 'npm --prefix mcp-server run build'."
      );
    }
  }
} catch {
  // ignore any fs/url errors; this is a non-fatal hint
}

// Create server instance
const server = new Server(
  {
    name: "khef",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: { listChanged: true },
    },
  }
);

// Collect all tool modules.
// Modules may export a static `tools` array, a dynamic `getTools()` function, or both.
// Dynamic modules use getTools() so their schemas reflect the current type registry.
const toolModules = [
  projectTools,
  memoryTools,
  relationTools,
  tagTools,
  statusTools,
  knowledgeTools,
  agentTools,
  commentTools,
  sessionTools,
  planTools,
  sectionTools,
  diffTools,
  memoryTypeTools,
  kdagTools,
  kapiTools,
  promptTools,
  savedQueryTools,
  assistantChatTools,
  exportTools,
  dbTools,
  activeSessionTools,
  sourceCodeTools,
  kvecTools,
  slackTools,
  collectionTools,
  liveMessageTools,
  agentQuestionTools,
  jobErrorTools,
  docsTools,
  unifiedSearchTools,
  googleTools,
  logTools,
  sessionTeamTools,
  notificationTools,
];

function collectAllTools() {
  return toolModules.flatMap((m) => {
    const mod = m as { tools: Tool[]; getTools?: () => Tool[] };
    return mod.getTools ? mod.getTools() : mod.tools;
  });
}

// Tool handlers — re-collects on each request so dynamic schemas stay current
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: collectAllTools() };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    return {
      content: [
        {
          type: "text",
          text: "Error: No arguments provided",
        },
      ],
      isError: true,
    };
  }

  try {
    // debug_raw_json: re-dispatch with format=json injected
    if (name === "debug_raw_json") {
      const toolName = (args as Record<string, unknown>).tool_name as string;
      const toolArgs = { ...((args as Record<string, unknown>).tool_args as Record<string, unknown>), format: "json" };
      for (const mod of toolModules) {
        const result = await mod.handleTool(toolName, toolArgs, client, dbClient);
        if (result) return result;
      }
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }

    for (const mod of toolModules) {
      const result = await mod.handleTool(name, args as Record<string, unknown>, client, dbClient);
      if (result) return result;
    }

    return {
      content: [
        {
          type: "text",
          text: `Unknown tool: ${name}`,
        },
      ],
      isError: true,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  // Populate the type registry from the API before accepting requests.
  // Falls back to built-in types if the API is unreachable.
  await initTypeRegistry(client, server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("khef MCP server running on stdio");
  console.error(`API URL: ${API_URL}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
