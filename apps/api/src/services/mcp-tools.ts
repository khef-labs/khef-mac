import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { logger } from '../lib/logger';

const log = logger.child({ component: 'mcp-tools' });

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

const TOOL_MODULES = [
  'projects', 'memories', 'relations', 'tags', 'status', 'knowledge',
  'agents', 'comments', 'sessions', 'plans', 'sections', 'diffs',
  'memory-types', 'kdag', 'kapi', 'prompts', 'assistant-chat', 'export',
  'db', 'active-sessions', 'source-code', 'kvec', 'slack', 'collections',
  'live-messages', 'job-errors', 'docs', 'unified-search', 'google',
  'logs', 'session-teams',
];

interface ToolModule {
  tools?: McpToolInfo[];
  getTools?: () => McpToolInfo[];
}

let cached: { mtime: number; tools: McpToolInfo[] } | null = null;

function mcpBuildDir(): string {
  return path.resolve(__dirname, '../../mcp-server/build/tools');
}

export async function getKhefMcpTools(): Promise<McpToolInfo[]> {
  const buildDir = mcpBuildDir();
  if (!fs.existsSync(buildDir)) {
    throw new Error(`khef MCP build not found at ${buildDir}. Run 'npm run mcp:build'.`);
  }

  const buildMtime = fs.statSync(buildDir).mtimeMs;
  if (cached && cached.mtime === buildMtime) {
    return cached.tools;
  }

  const tools: McpToolInfo[] = [];
  for (const name of TOOL_MODULES) {
    const filePath = path.join(buildDir, `${name}.js`);
    if (!fs.existsSync(filePath)) continue;
    try {
      const mod: ToolModule = await import(pathToFileURL(filePath).href);
      const list = mod.getTools ? mod.getTools() : mod.tools ?? [];
      for (const t of list) {
        tools.push({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema });
      }
    } catch (err) {
      log.warn({ err, module: name }, 'Failed to load MCP tool module');
    }
  }

  tools.sort((a, b) => a.name.localeCompare(b.name));
  cached = { mtime: buildMtime, tools };
  return tools;
}
