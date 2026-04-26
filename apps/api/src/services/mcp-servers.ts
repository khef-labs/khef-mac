import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { glob } from 'glob';
import { logger } from '../lib/logger';

const log = logger.child({ component: 'mcp-servers' });

export type McpServerStatus = 'available' | 'stale' | 'unavailable' | 'unknown';

/**
 * Check if a URL is reachable (with short timeout)
 */
async function isUrlReachable(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    await fetch(url, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timeout);
    // Any response (even 404) means the service is running
    return true;
  } catch {
    // Connection refused, timeout, etc.
    return false;
  }
}

export interface McpServer {
  name: string;
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  status: McpServerStatus;
  statusMessage?: string;
}

export interface McpServerConfig {
  servers: McpServer[];
  configPath: string;
  issues: number; // Count of servers with problems (stale/unavailable)
}

interface AutoRebuildTarget {
  projectDir: string;
}

interface AutoRebuildResult {
  attempted: boolean;
  success: boolean;
  message?: string;
}

const AUTO_REBUILD_COOLDOWN_MS = 30_000;
const rebuildAttemptsByProject = new Map<string, number>();
const rebuildInFlightByProject = new Map<string, Promise<AutoRebuildResult>>();

/**
 * Check the status of an MCP server based on its args path
 */
function checkServerStatus(server: { type: string; args?: string[] }): {
  status: McpServerStatus;
  message?: string;
  autoRebuildTarget?: AutoRebuildTarget;
} {
  // HTTP servers - can't easily check availability
  if (server.type === 'http') {
    return { status: 'unknown', message: 'HTTP server status not checked' };
  }

  // No args - can't check
  if (!server.args || server.args.length === 0) {
    return { status: 'unknown', message: 'No args to check' };
  }

  // Find the first arg that looks like a file path (contains path separator)
  const argsPath = server.args.find(arg => arg.includes('/') || arg.includes('\\'));

  // No file path in args - nothing to check here (backend URL checked separately)
  if (!argsPath) {
    return { status: 'unknown' };
  }

  // Check if build file exists
  if (!fs.existsSync(argsPath)) {
    return { status: 'unavailable', message: `Build file not found: ${argsPath}` };
  }

  // Check for stale build - look for sibling src directory
  const buildMatch = argsPath.match(/(.*)\/build\//);
  if (buildMatch) {
    const projectDir = buildMatch[1];
    const srcDir = path.join(projectDir, 'src');

    if (fs.existsSync(srcDir)) {
      const buildMtime = fs.statSync(argsPath).mtimeMs;

      // Find all TypeScript source files
      const sourceFiles = glob.sync('**/*.ts', { cwd: srcDir, absolute: true });

      for (const sourceFile of sourceFiles) {
        const sourceMtime = fs.statSync(sourceFile).mtimeMs;
        if (sourceMtime > buildMtime) {
          const relPath = path.relative(projectDir, sourceFile);
          const projectName = path.basename(path.dirname(projectDir)); // parent of mcp-server dir
          return {
            status: 'stale',
            message: `Source changed: ${relPath}. Rebuild needed in ${projectName}.`,
            autoRebuildTarget: { projectDir }
          };
        }
      }
    }
  }

  return { status: 'available' };
}

function runBuildInProject(projectDir: string): Promise<AutoRebuildResult> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      resolve({
        attempted: true,
        success: false,
        message: `Auto-rebuild failed to start: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({
          attempted: true,
          success: true,
          message: 'Auto-rebuilt MCP server successfully.',
        });
        return;
      }

      const trimmedErr = stderr.trim();
      resolve({
        attempted: true,
        success: false,
        message: trimmedErr
          ? `Auto-rebuild failed (exit ${code}): ${trimmedErr}`
          : `Auto-rebuild failed with exit code ${code}.`,
      });
    });
  });
}

async function maybeAutoRebuild(target: AutoRebuildTarget): Promise<AutoRebuildResult> {
  const now = Date.now();
  const lastAttempt = rebuildAttemptsByProject.get(target.projectDir);
  if (lastAttempt && now - lastAttempt < AUTO_REBUILD_COOLDOWN_MS) {
    return {
      attempted: false,
      success: false,
      message: 'Auto-rebuild skipped (cooldown active).',
    };
  }

  const existing = rebuildInFlightByProject.get(target.projectDir);
  if (existing) {
    return existing;
  }

  rebuildAttemptsByProject.set(target.projectDir, now);
  const rebuildPromise = runBuildInProject(target.projectDir).finally(() => {
    rebuildInFlightByProject.delete(target.projectDir);
  });
  rebuildInFlightByProject.set(target.projectDir, rebuildPromise);
  return rebuildPromise;
}

// Config file paths by assistant
const CONFIG_PATHS: Record<string, string> = {
  'claude-code': path.join(os.homedir(), '.claude.json'),
  'codex-cli': path.join(os.homedir(), '.codex', 'config.toml'),
};

/**
 * Parse MCP servers from Claude Code's JSON config
 */
function parseClaudeConfig(configPath: string): McpServer[] {
  if (!fs.existsSync(configPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);
    const mcpServers = config.mcpServers || {};

    return Object.entries(mcpServers).map(([name, server]: [string, any]) => ({
      name,
      type: server.type || 'stdio',
      command: server.command,
      args: server.args,
      url: server.url,
      env: server.env,
      status: 'unknown' as McpServerStatus,
    }));
  } catch (err) {
    log.error({ err }, 'Failed to parse Claude config');
    return [];
  }
}

/**
 * Parse MCP servers from Codex CLI's TOML config
 */
function parseCodexConfig(configPath: string): McpServer[] {
  if (!fs.existsSync(configPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const servers: McpServer[] = [];

    // Simple TOML parsing for mcp_servers sections
    // Format: [mcp_servers.name] followed by key = value pairs
    const lines = content.split('\n');
    let currentServer: McpServer | null = null;
    let inEnvSection = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Check for [mcp_servers.name] header
      const serverMatch = trimmed.match(/^\[mcp_servers\.([^\]]+)\]$/);
      if (serverMatch && !trimmed.includes('.env')) {
        if (currentServer) {
          servers.push(currentServer);
        }
        currentServer = { name: serverMatch[1], type: 'stdio', status: 'unknown' as McpServerStatus };
        inEnvSection = false;
        continue;
      }

      // Check for [mcp_servers.name.env] header
      const envMatch = trimmed.match(/^\[mcp_servers\.[^\]]+\.env\]$/);
      if (envMatch) {
        inEnvSection = true;
        continue;
      }

      // Check for other section headers (end current server)
      if (trimmed.startsWith('[') && !trimmed.startsWith('[mcp_servers.')) {
        if (currentServer) {
          servers.push(currentServer);
          currentServer = null;
        }
        inEnvSection = false;
        continue;
      }

      // Parse key = value pairs
      if (currentServer && trimmed.includes('=')) {
        const [key, ...valueParts] = trimmed.split('=');
        const keyTrimmed = key.trim();
        let value = valueParts.join('=').trim();

        // Remove quotes from string values
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        // Parse arrays
        if (value.startsWith('[') && value.endsWith(']')) {
          try {
            value = JSON.parse(value.replace(/'/g, '"'));
          } catch {
            // Keep as string if parsing fails
          }
        }

        if (inEnvSection) {
          if (!currentServer.env) currentServer.env = {};
          currentServer.env[keyTrimmed] = value;
        } else {
          if (keyTrimmed === 'command') currentServer.command = value;
          else if (keyTrimmed === 'args') currentServer.args = Array.isArray(value) ? value : [value];
          else if (keyTrimmed === 'url') {
            currentServer.url = value;
            currentServer.type = 'http';
          }
        }
      }
    }

    if (currentServer) {
      servers.push(currentServer);
    }

    return servers;
  } catch (err) {
    log.error({ err }, 'Failed to parse Codex config');
    return [];
  }
}

/**
 * Parse --host and --port from args to build a backend URL
 */
function parseBackendUrl(args: string[]): string | null {
  let host: string | null = null;
  let port: string | null = null;
  let ssl = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--host' && args[i + 1]) {
      host = args[i + 1];
    } else if (arg === '--port' && args[i + 1]) {
      port = args[i + 1];
    } else if (arg === '--ssl' && args[i + 1] === 'true') {
      ssl = true;
    }
  }

  if (host && port) {
    const protocol = ssl ? 'https' : 'http';
    return `${protocol}://${host}:${port}`;
  }

  return null;
}

/**
 * Check if backend URL from args (--host/--port) is reachable
 */
async function checkBackendUrl(server: McpServer): Promise<{ status: McpServerStatus; message?: string } | null> {
  if (!server.args || server.args.length === 0) return null;

  const backendUrl = parseBackendUrl(server.args);
  if (!backendUrl) return null;

  const isReachable = await isUrlReachable(backendUrl);
  if (!isReachable) {
    return {
      status: 'unavailable',
      message: `Backend ${backendUrl} is not reachable`
    };
  }

  return null;
}

/**
 * Check if env URLs (like KHEF_API_URL) are reachable
 */
async function checkEnvUrls(server: McpServer): Promise<{ status: McpServerStatus; message?: string } | null> {
  if (!server.env) return null;

  // Check common API URL env vars
  const urlEnvVars = ['KHEF_API_URL', 'API_URL', 'BASE_URL'];

  for (const envVar of urlEnvVars) {
    const url = server.env[envVar];
    if (url) {
      // Try health endpoint first, then root
      const healthUrl = url.replace(/\/$/, '') + '/health';
      const isReachable = await isUrlReachable(healthUrl);

      if (!isReachable) {
        return {
          status: 'unavailable',
          message: `${envVar}=${url} is not reachable. Check if the API is running on the correct port.`
        };
      }
    }
  }

  return null;
}

/**
 * Get MCP servers for an assistant
 */
export async function getMcpServers(assistantHandle: string): Promise<McpServerConfig> {
  const configPath = CONFIG_PATHS[assistantHandle];
  if (!configPath) {
    return { servers: [], configPath: '', issues: 0 };
  }

  let servers: McpServer[];
  if (assistantHandle === 'claude-code') {
    servers = parseClaudeConfig(configPath);
  } else if (assistantHandle === 'codex-cli') {
    servers = parseCodexConfig(configPath);
  } else {
    servers = [];
  }

  // Check status for each server
  let issues = 0;
  for (const server of servers) {
    const { status, message, autoRebuildTarget } = checkServerStatus(server);
    server.status = status;
    if (message) server.statusMessage = message;

    if (server.status === 'stale' && autoRebuildTarget) {
      const rebuildResult = await maybeAutoRebuild(autoRebuildTarget);
      if (rebuildResult.attempted && rebuildResult.success) {
        const postRebuildStatus = checkServerStatus(server);
        server.status = postRebuildStatus.status;
        server.statusMessage = postRebuildStatus.message ?? rebuildResult.message;
      } else if (rebuildResult.attempted && !rebuildResult.success && rebuildResult.message) {
        server.statusMessage = rebuildResult.message;
      }
    }

    // If basic status is OK, check env URLs
    if (server.status === 'available') {
      const envCheck = await checkEnvUrls(server);
      if (envCheck) {
        server.status = envCheck.status;
        server.statusMessage = envCheck.message;
      }
    }

    // If status is unknown (no build file), check backend URL from args
    if (server.status === 'unknown') {
      const backendCheck = await checkBackendUrl(server);
      if (backendCheck) {
        server.status = backendCheck.status;
        server.statusMessage = backendCheck.message;
      } else if (parseBackendUrl(server.args || [])) {
        // Backend URL exists and is reachable
        server.status = 'available';
      }
    }

    if (server.status === 'stale' || server.status === 'unavailable') {
      issues++;
    }
  }

  return { servers, configPath, issues };
}

/**
 * Add an MCP server to Claude Code config
 */
function addClaudeServer(configPath: string, server: McpServer): void {
  let config: any = {};

  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(content);
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const serverConfig: any = { type: server.type };
  if (server.command) serverConfig.command = server.command;
  if (server.args?.length) serverConfig.args = server.args;
  if (server.url) serverConfig.url = server.url;
  if (server.env && Object.keys(server.env).length) serverConfig.env = server.env;

  config.mcpServers[server.name] = serverConfig;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Add an MCP server to Codex CLI config
 */
function addCodexServer(configPath: string, server: McpServer): void {
  let content = '';

  if (fs.existsSync(configPath)) {
    content = fs.readFileSync(configPath, 'utf-8');
  }

  // Build the TOML section for this server
  let section = `\n[mcp_servers.${server.name}]\n`;
  if (server.command) section += `command = "${server.command}"\n`;
  if (server.args?.length) {
    section += `args = ${JSON.stringify(server.args)}\n`;
  }
  if (server.url) section += `url = "${server.url}"\n`;

  if (server.env && Object.keys(server.env).length) {
    section += `\n[mcp_servers.${server.name}.env]\n`;
    for (const [key, value] of Object.entries(server.env)) {
      section += `${key} = "${value}"\n`;
    }
  }

  // Append to file
  fs.writeFileSync(configPath, content + section);
}

/**
 * Add an MCP server for an assistant
 */
export function addMcpServer(assistantHandle: string, server: McpServer): void {
  const configPath = CONFIG_PATHS[assistantHandle];
  if (!configPath) {
    throw new Error(`Unknown assistant: ${assistantHandle}`);
  }

  if (assistantHandle === 'claude-code') {
    addClaudeServer(configPath, server);
  } else if (assistantHandle === 'codex-cli') {
    addCodexServer(configPath, server);
  }
}

/**
 * Remove an MCP server from Claude Code config
 */
function removeClaudeServer(configPath: string, serverName: string): boolean {
  if (!fs.existsSync(configPath)) {
    return false;
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(content);

  if (!config.mcpServers || !config.mcpServers[serverName]) {
    return false;
  }

  delete config.mcpServers[serverName];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return true;
}

/**
 * Remove an MCP server from Codex CLI config
 */
function removeCodexServer(configPath: string, serverName: string): boolean {
  if (!fs.existsSync(configPath)) {
    return false;
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  const lines = content.split('\n');
  const result: string[] = [];
  let inTargetServer = false;
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check if we're entering the target server section
    if (trimmed === `[mcp_servers.${serverName}]` ||
        trimmed.startsWith(`[mcp_servers.${serverName}.`)) {
      inTargetServer = true;
      found = true;
      continue;
    }

    // Check if we're entering a different section
    if (trimmed.startsWith('[') && !trimmed.startsWith(`[mcp_servers.${serverName}`)) {
      inTargetServer = false;
    }

    if (!inTargetServer) {
      result.push(line);
    }
  }

  if (found) {
    // Clean up extra blank lines
    const cleaned = result.join('\n').replace(/\n{3,}/g, '\n\n');
    fs.writeFileSync(configPath, cleaned);
  }

  return found;
}

/**
 * Remove an MCP server for an assistant
 */
export function removeMcpServer(assistantHandle: string, serverName: string): boolean {
  const configPath = CONFIG_PATHS[assistantHandle];
  if (!configPath) {
    throw new Error(`Unknown assistant: ${assistantHandle}`);
  }

  if (assistantHandle === 'claude-code') {
    return removeClaudeServer(configPath, serverName);
  } else if (assistantHandle === 'codex-cli') {
    return removeCodexServer(configPath, serverName);
  }

  return false;
}
