import { FastifyPluginAsync } from 'fastify';
import { query, querySingle } from '../db/client';
import { ProjectAssistantConfig, ConfigScope, ConfigType, ConfigFormat } from '../types';
import { hashContent } from '../services/assistant-sync';
import { resolveProject } from './projects';
import { discoverAndImportProjectConfigs } from '../services/assistant-discovery';
import { resolveProjectPath } from '../services/project-path';

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
  project_id: string;
  project_handle: string;
  project_name: string;
  assistant_id: string;
  assistant_handle: string;
  assistant_name: string;
}

function toProjectAssistantConfig(row: ConfigRow): ProjectAssistantConfig {
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
    project: {
      id: row.project_id,
      handle: row.project_handle,
      name: row.project_name,
    },
    assistant: {
      id: row.assistant_id,
      handle: row.assistant_handle,
      name: row.assistant_name,
    },
  };
}

// Query for project-scoped configs
const projectConfigQuery = `
  SELECT c.id, c.scope, c.type, c.path, c.format, c.content, c.file_hash,
         c.version, c.auto_sync, c.readonly, c.parent_config_id, c.is_import,
         c.last_synced_at, c.created_at, c.updated_at,
         p.id AS project_id, p.handle AS project_handle, p.name AS project_name,
         a.id AS assistant_id, a.handle AS assistant_handle, a.name AS assistant_name
  FROM configs c
  JOIN project_assistant_configs pac ON pac.config_id = c.id
  JOIN projects p ON p.id = pac.project_id
  JOIN assistants a ON a.id = pac.assistant_id
`;

const projectConfigRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/projects/:projectId/configs - List project configs
  fastify.get<{
    Params: { projectId: string };
    Querystring: { assistant?: string; scope?: string; type?: string };
  }>('/', async (request, reply) => {
    const { projectId } = request.params;
    const { assistant, scope, type } = request.query;

    // Resolve project
    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Auto-discover project configs if none exist
    const existingCount = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM project_assistant_configs WHERE project_id = $1`,
      [project.id]
    );
    if (parseInt(existingCount[0].count) === 0) {
      const expandedPath = await resolveProjectPath(project);
      if (expandedPath) {
        const assistants = await query<{ handle: string }>(
          `SELECT handle FROM assistants ORDER BY handle`
        );
        for (const a of assistants) {
          await discoverAndImportProjectConfigs(a.handle, project.id, expandedPath);
        }
      }
    }

    let sql = projectConfigQuery + ' WHERE p.id = $1';
    const params: string[] = [project.id];
    let paramIndex = 2;

    if (assistant) {
      sql += ` AND a.handle = $${paramIndex++}`;
      params.push(assistant);
    }
    if (scope) {
      sql += ` AND c.scope = $${paramIndex++}`;
      params.push(scope);
    }
    if (type) {
      sql += ` AND c.type = $${paramIndex++}`;
      params.push(type);
    }

    sql += ' ORDER BY a.handle, c.scope, c.type';

    const rows = await query<ConfigRow>(sql, params);
    return { configs: rows.map(toProjectAssistantConfig) };
  });

  // POST /api/projects/:projectId/configs/discover - Force re-discovery of project configs
  fastify.post<{
    Params: { projectId: string };
  }>('/discover', async (request, reply) => {
    const { projectId } = request.params;

    // Resolve project
    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const expandedPath = await resolveProjectPath(project);
    if (!expandedPath) {
      return reply.code(400).send({ error: 'Project has no path configured and no base path set' });
    }

    const assistants = await query<{ handle: string; name: string }>(
      `SELECT handle, name FROM assistants ORDER BY handle`
    );

    const results: Record<string, { imported: number; updated: number; unchanged: number }> = {};

    for (const a of assistants) {
      const result = await discoverAndImportProjectConfigs(a.handle, project.id, expandedPath);
      if (result.imported > 0 || result.updated > 0) {
        results[a.handle] = result;
      }
    }

    return { discovered: results };
  });

  // POST /api/projects/:projectId/configs - Create project config
  fastify.post<{
    Params: { projectId: string };
    Body: { assistant: string; scope: string; type: string; path: string; format: string; content: string; auto_sync?: boolean };
  }>('/', async (request, reply) => {
    const { projectId } = request.params;
    const { assistant, scope, type, path, format, content, auto_sync } = request.body;

    // Validate scope is project-scoped
    if (scope !== 'project' && scope !== 'local') {
      return reply.code(400).send({ error: 'Only project/local scope allowed. Use assistant configs for system/global.' });
    }

    // Resolve project
    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Validate assistant exists
    const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [assistant]);
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

    // Link to project and assistant
    await query(
      `INSERT INTO project_assistant_configs (project_id, assistant_id, config_id) VALUES ($1, $2, $3)`,
      [project.id, assistants[0].id, config.id]
    );

    // Fetch full config
    const rows = await query<ConfigRow>(projectConfigQuery + ' WHERE c.id = $1', [config.id]);
    return reply.code(201).send({ config: toProjectAssistantConfig(rows[0]) });
  });
};

export default projectConfigRoutes;
