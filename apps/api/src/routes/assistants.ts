import { FastifyPluginAsync } from 'fastify';
import { query, querySingle } from '../db/client';
import { Assistant, AssistantConfig, ConfigScope, ConfigType, ConfigFormat } from '../types';
import { hashContent } from '../services/assistant-sync';
import { discoverAndImportGlobalConfigs, isAssistantInstalled } from '../services/assistant-discovery';
import { getMcpServers, addMcpServer, removeMcpServer, McpServer } from '../services/mcp-servers';
import { getKhefMcpTools } from '../services/mcp-tools';
import { expandTilde, resolveProjectPathById } from '../services/project-path';
import {
  getUserAgents,
  getProjectAgents,
  getUserAgent,
  getProjectAgent,
  createUserAgent,
  createProjectAgent,
  updateUserAgent,
  updateProjectAgent,
  deleteUserAgent,
  deleteProjectAgent,
  Agent,
} from '../services/agents';
import {
  listAssistantCommands,
  getAssistantCommand,
  createAssistantCommand,
  updateAssistantCommand,
  deleteAssistantCommand,
  syncBuiltInCommands,
  AssistantCommandType,
  AssistantCommandScope,
} from '../services/assistant-commands';
interface AssistantRow {
  id: string;
  handle: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ConfigRow {
  id: string;
  scope: string;
  type: string;
  path: string;
  format: string;
  content: string;
  file_hash: string | null;
  version: number;
  auto_sync: boolean;
  readonly: boolean;
  parent_config_id: string | null;
  is_import: boolean;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
  assistant_id: string;
  assistant_handle: string;
  assistant_name: string;
}

const COMMAND_SCOPES = new Set(['user', 'project', 'all']);
const COMMAND_TYPES = new Set(['command', 'skill', 'prompt']);

function toAssistantConfig(row: ConfigRow): AssistantConfig {
  return {
    id: row.id,
    scope: row.scope as ConfigScope,
    type: row.type as ConfigType,
    path: row.path,
    format: row.format as ConfigFormat,
    content: row.content,
    file_hash: row.file_hash ?? undefined,
    version: row.version,
    auto_sync: row.auto_sync,
    readonly: row.readonly,
    parent_config_id: row.parent_config_id ?? undefined,
    is_import: row.is_import ?? false,
    last_synced_at: row.last_synced_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    assistant: {
      id: row.assistant_id,
      handle: row.assistant_handle,
      name: row.assistant_name,
    },
  };
}

// Query for user-wide configs (system/global scope)
const assistantConfigQuery = `
  SELECT c.id, c.scope, c.type, c.path, c.format, c.content, c.file_hash,
         c.version, c.auto_sync, c.readonly, c.parent_config_id, c.is_import,
         c.last_synced_at, c.created_at, c.updated_at,
         a.id AS assistant_id, a.handle AS assistant_handle, a.name AS assistant_name
  FROM configs c
  JOIN assistant_configs ac ON ac.config_id = c.id
  JOIN assistants a ON a.id = ac.assistant_id
`;

const assistantRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/assistants - List installed assistants
  fastify.get('/', async () => {
    const rows = await query<AssistantRow>(
      `SELECT id, handle, name, description, created_at, updated_at
       FROM assistants
       ORDER BY name`
    );

    // Lazy-discover global configs so assistants appear even if startup
    // discovery did not run or the files were created after API boot.
    const installedRows: AssistantRow[] = [];
    for (const row of rows) {
      try {
        await discoverAndImportGlobalConfigs(row.handle);
      } catch {
        // Ignore discovery failures here and fall back to installed-state check.
      }
      if (await isAssistantInstalled(row.handle)) {
        installedRows.push(row);
      }
    }

    const assistants: Assistant[] = installedRows.map((r) => ({
      ...r,
      description: r.description ?? undefined,
    }));

    return { assistants };
  });

  // GET /api/assistants/:handle - Get assistant
  fastify.get<{ Params: { handle: string } }>('/:handle', async (request, reply) => {
    const { handle } = request.params;

    const rows = await query<AssistantRow>(
      `SELECT id, handle, name, description, created_at, updated_at
       FROM assistants
       WHERE handle = $1`,
      [handle]
    );

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    const assistant: Assistant = {
      ...rows[0],
      description: rows[0].description ?? undefined,
    };

    return { assistant };
  });

  // GET /api/assistants/:handle/configs - List user-wide configs (system/global)
  fastify.get<{
    Params: { handle: string };
    Querystring: { scope?: string; type?: string };
  }>('/:handle/configs', async (request, reply) => {
    const { handle } = request.params;
    const { scope, type } = request.query;

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    // Auto-discover global configs if none exist
    const existingCount = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM assistant_configs ac
       JOIN assistants a ON a.id = ac.assistant_id
       WHERE a.handle = $1`,
      [handle]
    );
    if (parseInt(existingCount[0].count) === 0) {
      await discoverAndImportGlobalConfigs(handle);
    }

    let sql = assistantConfigQuery + ' WHERE a.handle = $1';
    const params: string[] = [handle];
    let paramIndex = 2;

    if (scope) {
      sql += ` AND c.scope = $${paramIndex++}`;
      params.push(scope);
    }
    if (type) {
      sql += ` AND c.type = $${paramIndex++}`;
      params.push(type);
    }

    sql += ' ORDER BY c.scope, c.type';

    const rows = await query<ConfigRow>(sql, params);
    return { configs: rows.map(toAssistantConfig) };
  });

  // POST /api/assistants/:handle/discover - Force re-discovery of configs from disk
  fastify.post<{ Params: { handle: string } }>('/:handle/discover', async (request, reply) => {
    const { handle } = request.params;

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    const result = await discoverAndImportGlobalConfigs(handle);
    return { discovered: result };
  });

  // GET /api/assistants/:handle/commands - List commands/skills
  fastify.get<{
    Params: { handle: string };
    Querystring: { scope?: string; type?: string; project?: string; compact?: string };
  }>('/:handle/commands', async (request, reply) => {
    const { handle } = request.params;
    const { scope, type, project, compact: compactParam } = request.query;
    const resolvedScope = scope ?? 'all';
    const compact = compactParam !== 'false';

    if (!COMMAND_SCOPES.has(resolvedScope)) {
      return reply.code(400).send({ error: 'Invalid scope' });
    }
    if (type && !COMMAND_TYPES.has(type)) {
      return reply.code(400).send({ error: 'Invalid type' });
    }

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    if ((resolvedScope === 'project' || resolvedScope === 'all') && !project) {
      return reply.code(400).send({ error: 'Project is required for project scope' });
    }

    let projectPath: string | null = null;
    if (project) {
      try {
        projectPath = await resolveProjectPathById(project);
      } catch (err: any) {
        if (err.message === 'Project not found') {
          return reply.code(404).send({ error: 'Project not found' });
        }
        return reply.code(500).send({ error: err.message || 'Failed to resolve project path' });
      }
      if (!projectPath) {
        return reply.code(400).send({ error: 'Project has no path configured' });
      }
    }

    try {
      const commands = listAssistantCommands(handle, {
        scope: resolvedScope as 'user' | 'project' | 'all',
        type: type as AssistantCommandType | undefined,
        projectPath: projectPath ?? undefined,
        compact,
      });
      return { commands };
    } catch (err: any) {
      if (err.message?.includes('Unsupported assistant')) {
        return reply.code(400).send({ error: err.message });
      }
      return reply.code(500).send({ error: err.message || 'Failed to list commands' });
    }
  });

  // GET /api/assistants/:handle/commands/:name - Get a command/skill
  fastify.get<{
    Params: { handle: string; name: string };
    Querystring: { scope?: string; type?: string; project?: string };
  }>('/:handle/commands/:name', async (request, reply) => {
    const { handle, name } = request.params;
    const { scope, type, project } = request.query;

    if (!scope || !type) {
      return reply.code(400).send({ error: 'Scope and type are required' });
    }
    if (!COMMAND_SCOPES.has(scope) || scope === 'all') {
      return reply.code(400).send({ error: 'Invalid scope' });
    }
    if (!COMMAND_TYPES.has(type)) {
      return reply.code(400).send({ error: 'Invalid type' });
    }

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    if (scope === 'project' && !project) {
      return reply.code(400).send({ error: 'Project is required for project scope' });
    }

    let projectPath: string | null = null;
    if (project) {
      try {
        projectPath = await resolveProjectPathById(project);
      } catch (err: any) {
        if (err.message === 'Project not found') {
          return reply.code(404).send({ error: 'Project not found' });
        }
        return reply.code(500).send({ error: err.message || 'Failed to resolve project path' });
      }
      if (!projectPath) {
        return reply.code(400).send({ error: 'Project has no path configured' });
      }
    }

    try {
      const command = getAssistantCommand(handle, name, {
        scope: scope as AssistantCommandScope,
        type: type as AssistantCommandType,
        projectPath: projectPath ?? undefined,
      });
      if (!command) {
        return reply.code(404).send({ error: 'Command not found' });
      }
      return { command };
    } catch (err: any) {
      if (err.message?.includes('Unsupported assistant')) {
        return reply.code(400).send({ error: err.message });
      }
      return reply.code(500).send({ error: err.message || 'Failed to get command' });
    }
  });

  // POST /api/assistants/:handle/commands - Create a command/skill
  fastify.post<{
    Params: { handle: string };
    Body: {
      name: string;
      description?: string;
      content: string;
      scope: string;
      type: string;
      project?: string;
    };
  }>('/:handle/commands', async (request, reply) => {
    const { handle } = request.params;
    const { name, description, content, scope, type, project } = request.body;

    if (!name || !content || !scope || !type) {
      return reply.code(400).send({ error: 'Name, content, scope, and type are required' });
    }
    if (!COMMAND_SCOPES.has(scope) || scope === 'all') {
      return reply.code(400).send({ error: 'Invalid scope' });
    }
    if (!COMMAND_TYPES.has(type)) {
      return reply.code(400).send({ error: 'Invalid type' });
    }

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    // Type narrowing after validation
    const validatedScope = scope as AssistantCommandScope;
    const validatedType = type as AssistantCommandType;

    if (validatedScope === 'project' && !project) {
      return reply.code(400).send({ error: 'Project is required for project scope' });
    }

    let projectPath: string | null = null;
    if (project) {
      try {
        projectPath = await resolveProjectPathById(project);
      } catch (err: any) {
        if (err.message === 'Project not found') {
          return reply.code(404).send({ error: 'Project not found' });
        }
        return reply.code(500).send({ error: err.message || 'Failed to resolve project path' });
      }
      if (!projectPath) {
        return reply.code(400).send({ error: 'Project has no path configured' });
      }
    }

    try {
      const command = createAssistantCommand(handle, {
        name,
        description,
        content,
        scope: validatedScope,
        type: validatedType,
        projectPath: projectPath ?? undefined,
      });
      return reply.code(201).send({ command });
    } catch (err: any) {
      if (err.message?.includes('already exists')) {
        return reply.code(409).send({ error: err.message });
      }
      if (err.message?.includes('Unsupported assistant') || err.message?.includes('not supported')) {
        return reply.code(400).send({ error: err.message });
      }
      return reply.code(500).send({ error: err.message || 'Failed to create command' });
    }
  });

  // PATCH /api/assistants/:handle/commands/:name - Update a command/skill
  fastify.patch<{
    Params: { handle: string; name: string };
    Querystring: { scope?: string; type?: string; project?: string };
    Body: {
      name?: string;
      description?: string;
      content?: string;
      expected_hash?: string;
      force?: boolean;
    };
  }>('/:handle/commands/:name', async (request, reply) => {
    const { handle, name } = request.params;
    const { scope, type, project } = request.query;
    const updates = request.body;

    if (!scope || !type) {
      return reply.code(400).send({ error: 'Scope and type are required' });
    }
    if (!COMMAND_SCOPES.has(scope) || scope === 'all') {
      return reply.code(400).send({ error: 'Invalid scope' });
    }
    if (!COMMAND_TYPES.has(type)) {
      return reply.code(400).send({ error: 'Invalid type' });
    }

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    if (scope === 'project' && !project) {
      return reply.code(400).send({ error: 'Project is required for project scope' });
    }

    let projectPath: string | null = null;
    if (project) {
      try {
        projectPath = await resolveProjectPathById(project);
      } catch (err: any) {
        if (err.message === 'Project not found') {
          return reply.code(404).send({ error: 'Project not found' });
        }
        return reply.code(500).send({ error: err.message || 'Failed to resolve project path' });
      }
      if (!projectPath) {
        return reply.code(400).send({ error: 'Project has no path configured' });
      }
    }

    try {
      const result = updateAssistantCommand(handle, name, {
        scope: scope as AssistantCommandScope,
        type: type as AssistantCommandType,
        projectPath: projectPath ?? undefined,
        updates,
      });
      if ('type' in result && result.type === 'conflict') {
        return reply.code(409).send({
          error: result.message,
          status: 'conflict',
          expected_hash: result.expected_hash,
          file_hash: result.file_hash,
          options: result.options,
        });
      }
      return { command: result };
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return reply.code(404).send({ error: err.message });
      }
      if (err.message?.includes('already exists')) {
        return reply.code(409).send({ error: err.message });
      }
      if (err.message?.includes('Unsupported assistant') || err.message?.includes('not supported')) {
        return reply.code(400).send({ error: err.message });
      }
      return reply.code(500).send({ error: err.message || 'Failed to update command' });
    }
  });

  // DELETE /api/assistants/:handle/commands/:name - Delete a command/skill
  fastify.delete<{
    Params: { handle: string; name: string };
    Querystring: { scope?: string; type?: string; project?: string };
  }>('/:handle/commands/:name', async (request, reply) => {
    const { handle, name } = request.params;
    const { scope, type, project } = request.query;

    if (!scope || !type) {
      return reply.code(400).send({ error: 'Scope and type are required' });
    }
    if (!COMMAND_SCOPES.has(scope) || scope === 'all') {
      return reply.code(400).send({ error: 'Invalid scope' });
    }
    if (!COMMAND_TYPES.has(type)) {
      return reply.code(400).send({ error: 'Invalid type' });
    }

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    if (scope === 'project' && !project) {
      return reply.code(400).send({ error: 'Project is required for project scope' });
    }

    let projectPath: string | null = null;
    if (project) {
      try {
        projectPath = await resolveProjectPathById(project);
      } catch (err: any) {
        if (err.message === 'Project not found') {
          return reply.code(404).send({ error: 'Project not found' });
        }
        return reply.code(500).send({ error: err.message || 'Failed to resolve project path' });
      }
      if (!projectPath) {
        return reply.code(400).send({ error: 'Project has no path configured' });
      }
    }

    try {
      const deleted = deleteAssistantCommand(handle, name, {
        scope: scope as AssistantCommandScope,
        type: type as AssistantCommandType,
        projectPath: projectPath ?? undefined,
      });
      if (!deleted) {
        return reply.code(404).send({ error: 'Command not found' });
      }
      return { deleted: true };
    } catch (err: any) {
      if (err.message?.includes('Unsupported assistant')) {
        return reply.code(400).send({ error: err.message });
      }
      return reply.code(500).send({ error: err.message || 'Failed to delete command' });
    }
  });

  // POST /api/assistants/:handle/commands/sync - Sync built-in commands from lib/prompts/
  fastify.post<{
    Params: { handle: string };
  }>('/:handle/commands/sync', async (request, reply) => {
    const { handle } = request.params;

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    try {
      const results = syncBuiltInCommands(handle);
      return { results };
    } catch (err: any) {
      if (err.message?.includes('Unsupported assistant')) {
        return reply.code(400).send({ error: err.message });
      }
      return reply.code(500).send({ error: err.message || 'Failed to sync commands' });
    }
  });

  // POST /api/assistants/:handle/configs - Create user-wide config
  fastify.post<{
    Params: { handle: string };
    Body: { scope: string; type: string; path: string; format: string; content: string; auto_sync?: boolean };
  }>('/:handle/configs', async (request, reply) => {
    const { handle } = request.params;
    const { scope, type, path, format, content, auto_sync } = request.body;

    // Validate scope is user-wide
    if (scope !== 'system' && scope !== 'global') {
      return reply.code(400).send({ error: 'Only system/global scope allowed. Use project configs for project/local.' });
    }

    // Validate assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    const fileHash = hashContent(content);

    // Insert config
    const config = await querySingle<{ id: string }>(
      `INSERT INTO configs (scope, type, path, format, content, file_hash, auto_sync)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [scope, type, path, format, content, fileHash, auto_sync ?? false]
    );

    if (!config) {
      return reply.code(500).send({ error: 'Failed to create config' });
    }

    // Link to assistant
    await query(
      `INSERT INTO assistant_configs (assistant_id, config_id) VALUES ($1, $2)`,
      [assistants[0].id, config.id]
    );

    // Fetch full config
    const rows = await query<ConfigRow>(assistantConfigQuery + ' WHERE c.id = $1', [config.id]);
    return reply.code(201).send({ config: toAssistantConfig(rows[0]) });
  });

  // GET /api/assistants/:handle/mcp-servers - List MCP servers
  fastify.get<{ Params: { handle: string } }>('/:handle/mcp-servers', async (request, reply) => {
    const { handle } = request.params;

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    const result = await getMcpServers(handle);
    return {
      servers: result.servers,
      configPath: result.configPath,
      issues: result.issues,
    };
  });

  // POST /api/assistants/:handle/mcp-servers - Add MCP server
  fastify.post<{
    Params: { handle: string };
    Body: { name: string; type?: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; env?: Record<string, string> };
  }>('/:handle/mcp-servers', async (request, reply) => {
    const { handle } = request.params;
    const { name, type = 'stdio', command, args, url, env } = request.body;

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    if (!name) {
      return reply.code(400).send({ error: 'Server name is required' });
    }

    if (type === 'stdio' && !command) {
      return reply.code(400).send({ error: 'Command is required for stdio transport' });
    }

    if (type === 'http' && !url) {
      return reply.code(400).send({ error: 'URL is required for http transport' });
    }

    const server: McpServer = { name, type, command, args, url, env, status: 'unknown' };

    try {
      addMcpServer(handle, server);
      return reply.code(201).send({ server });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to add MCP server' });
    }
  });

  // GET /api/assistants/:handle/mcp-servers/:name/tools - List tools exposed by a known MCP server
  fastify.get<{ Params: { handle: string; name: string } }>(
    '/:handle/mcp-servers/:name/tools',
    async (request, reply) => {
      const { handle, name } = request.params;

      const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
      if (assistants.length === 0) {
        return reply.code(404).send({ error: 'Assistant not found' });
      }

      if (name !== 'khef') {
        return reply.code(404).send({ error: 'Tool introspection only supported for the khef MCP server' });
      }

      try {
        const tools = await getKhefMcpTools();
        return { server: name, tools };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message || 'Failed to load MCP tools' });
      }
    }
  );

  // DELETE /api/assistants/:handle/mcp-servers/:name - Remove MCP server
  fastify.delete<{ Params: { handle: string; name: string } }>(
    '/:handle/mcp-servers/:name',
    async (request, reply) => {
      const { handle, name } = request.params;

      // Verify assistant exists
      const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
      if (assistants.length === 0) {
        return reply.code(404).send({ error: 'Assistant not found' });
      }

      try {
        const removed = removeMcpServer(handle, name);
        if (!removed) {
          return reply.code(404).send({ error: 'MCP server not found' });
        }
        return { deleted: true };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message || 'Failed to remove MCP server' });
      }
    }
  );

  // GET /api/assistants/:handle/agents - List user-level agents
  fastify.get<{
    Params: { handle: string };
    Querystring: { compact?: string };
  }>('/:handle/agents', async (request, reply) => {
    const { handle } = request.params;
    const compact = request.query.compact !== 'false';

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    const result = getUserAgents(handle, compact);
    return {
      agents: result.agents,
      agentsPath: result.agentsPath,
    };
  });

  // GET /api/assistants/:handle/agents/project/:projectId - List project-level agents
  fastify.get<{
    Params: { handle: string; projectId: string };
    Querystring: { compact?: string };
  }>('/:handle/agents/project/:projectId', async (request, reply) => {
    const { handle, projectId } = request.params;
    const compact = request.query.compact !== 'false';

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    // Look up project by handle, name, or UUID
    const projects = await query<{ path: string | null }>(
      `SELECT path FROM projects WHERE id::text = $1 OR handle = $1 OR name = $1`,
      [projectId]
    );
    if (projects.length === 0) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const projectPath = projects[0].path ? expandTilde(projects[0].path) : null;
    const result = getProjectAgents(handle, projectPath, compact);
    return {
      agents: result.agents,
      agentsPath: result.agentsPath,
    };
  });

  // GET /api/assistants/:handle/agents/:name - Get a single user-level agent
  fastify.get<{
    Params: { handle: string; name: string };
  }>(
    '/:handle/agents/:name',
    async (request, reply) => {
      const { handle, name } = request.params;

      // Verify assistant exists
      const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
      if (assistants.length === 0) {
        return reply.code(404).send({ error: 'Assistant not found' });
      }

      const agent = getUserAgent(handle, name);
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return { agent };
    }
  );

  // GET /api/assistants/:handle/agents/project/:projectId/:name - Get a single project-level agent
  fastify.get<{
    Params: { handle: string; projectId: string; name: string };
  }>(
    '/:handle/agents/project/:projectId/:name',
    async (request, reply) => {
      const { handle, projectId, name } = request.params;

      // Verify assistant exists
      const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
      if (assistants.length === 0) {
        return reply.code(404).send({ error: 'Assistant not found' });
      }

      // Look up project
      const projects = await query<{ path: string | null }>(
        `SELECT path FROM projects WHERE id::text = $1 OR handle = $1 OR name = $1`,
        [projectId]
      );
      if (projects.length === 0) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const projectPath = projects[0].path ? expandTilde(projects[0].path) : null;
      if (!projectPath) {
        return reply.code(400).send({ error: 'Project has no path configured' });
      }

      const agent = getProjectAgent(handle, name, projectPath);
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return { agent };
    }
  );

  // POST /api/assistants/:handle/agents - Create user-level agent
  fastify.post<{
    Params: { handle: string };
    Body: {
      name: string;
      description: string;
      model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
      tools?: string[];
      disallowedTools?: string[];
      permissionMode?: 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan';
      skills?: string[];
      prompt: string;
    };
  }>('/:handle/agents', async (request, reply) => {
    const { handle } = request.params;
    const { name, description, model, tools, disallowedTools, permissionMode, skills, prompt } = request.body;

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    if (!name || !description || !prompt) {
      return reply.code(400).send({ error: 'Name, description, and prompt are required' });
    }

    try {
      const agent = createUserAgent(handle, { name, description, model, tools, disallowedTools, permissionMode, skills, prompt });
      return reply.code(201).send({ agent });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to create agent' });
    }
  });

  // POST /api/assistants/:handle/agents/project/:projectId - Create project-level agent
  fastify.post<{
    Params: { handle: string; projectId: string };
    Body: {
      name: string;
      description: string;
      model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
      tools?: string[];
      disallowedTools?: string[];
      permissionMode?: 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan';
      skills?: string[];
      prompt: string;
    };
  }>('/:handle/agents/project/:projectId', async (request, reply) => {
    const { handle, projectId } = request.params;
    const { name, description, model, tools, disallowedTools, permissionMode, skills, prompt } = request.body;

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    if (!name || !description || !prompt) {
      return reply.code(400).send({ error: 'Name, description, and prompt are required' });
    }

    // Look up project
    const projects = await query<{ path: string | null }>(
      `SELECT path FROM projects WHERE id::text = $1 OR handle = $1 OR name = $1`,
      [projectId]
    );
    if (projects.length === 0) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const projectPath = projects[0].path ? expandTilde(projects[0].path) : null;
    if (!projectPath) {
      return reply.code(400).send({ error: 'Project has no path configured' });
    }

    try {
      const agent = createProjectAgent(handle, { name, description, model, tools, disallowedTools, permissionMode, skills, prompt }, projectPath);
      return reply.code(201).send({ agent });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to create agent' });
    }
  });

  // PATCH /api/assistants/:handle/agents/:name - Update user-level agent
  fastify.patch<{
    Params: { handle: string; name: string };
    Body: Partial<{
      name: string;
      description: string;
      model: 'sonnet' | 'opus' | 'haiku' | 'inherit';
      tools: string[];
      disallowedTools: string[];
      permissionMode: 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan';
      skills: string[];
      prompt: string;
    }>;
  }>('/:handle/agents/:name', async (request, reply) => {
    const { handle, name } = request.params;
    const updates = request.body;

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    try {
      const agent = updateUserAgent(handle, name, updates);
      return { agent };
    } catch (err: any) {
      if (err.message.includes('not found')) {
        return reply.code(404).send({ error: err.message });
      }
      return reply.code(500).send({ error: err.message || 'Failed to update agent' });
    }
  });

  // PATCH /api/assistants/:handle/agents/project/:projectId/:name - Update project-level agent
  fastify.patch<{
    Params: { handle: string; projectId: string; name: string };
    Body: Partial<{
      name: string;
      description: string;
      model: 'sonnet' | 'opus' | 'haiku' | 'inherit';
      tools: string[];
      disallowedTools: string[];
      permissionMode: 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan';
      skills: string[];
      prompt: string;
    }>;
  }>('/:handle/agents/project/:projectId/:name', async (request, reply) => {
    const { handle, projectId, name } = request.params;
    const updates = request.body;

    // Verify assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
    if (assistants.length === 0) {
      return reply.code(404).send({ error: 'Assistant not found' });
    }

    // Look up project
    const projects = await query<{ path: string | null }>(
      `SELECT path FROM projects WHERE id::text = $1 OR handle = $1 OR name = $1`,
      [projectId]
    );
    if (projects.length === 0) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const projectPath = projects[0].path ? expandTilde(projects[0].path) : null;
    if (!projectPath) {
      return reply.code(400).send({ error: 'Project has no path configured' });
    }

    try {
      const agent = updateProjectAgent(handle, name, updates, projectPath);
      return { agent };
    } catch (err: any) {
      if (err.message.includes('not found')) {
        return reply.code(404).send({ error: err.message });
      }
      return reply.code(500).send({ error: err.message || 'Failed to update agent' });
    }
  });

  // DELETE /api/assistants/:handle/agents/:name - Delete user-level agent
  fastify.delete<{
    Params: { handle: string; name: string };
  }>(
    '/:handle/agents/:name',
    async (request, reply) => {
      const { handle, name } = request.params;

      // Verify assistant exists
      const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
      if (assistants.length === 0) {
        return reply.code(404).send({ error: 'Assistant not found' });
      }

      try {
        const deleted = deleteUserAgent(handle, name);
        if (!deleted) {
          return reply.code(404).send({ error: 'Agent not found' });
        }
        return { deleted: true };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message || 'Failed to delete agent' });
      }
    }
  );

  // DELETE /api/assistants/:handle/agents/project/:projectId/:name - Delete project-level agent
  fastify.delete<{
    Params: { handle: string; projectId: string; name: string };
  }>(
    '/:handle/agents/project/:projectId/:name',
    async (request, reply) => {
      const { handle, projectId, name } = request.params;

      // Verify assistant exists
      const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [handle]);
      if (assistants.length === 0) {
        return reply.code(404).send({ error: 'Assistant not found' });
      }

      // Look up project
      const projects = await query<{ path: string | null }>(
        `SELECT path FROM projects WHERE id::text = $1 OR handle = $1 OR name = $1`,
        [projectId]
      );
      if (projects.length === 0) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const projectPath = projects[0].path ? expandTilde(projects[0].path) : null;
      if (!projectPath) {
        return reply.code(400).send({ error: 'Project has no path configured' });
      }

      try {
        const deleted = deleteProjectAgent(handle, name, projectPath);
        if (!deleted) {
          return reply.code(404).send({ error: 'Agent not found' });
        }
        return { deleted: true };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message || 'Failed to delete agent' });
      }
    }
  );
};

export default assistantRoutes;
