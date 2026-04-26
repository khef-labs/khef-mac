import { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client';
import { CreateProjectInput, UpdateProjectInput, FullProjectInput, Project, SessionContext, MemorySummary, MemoryTypeRecord, MemoryTypeStatus } from '../types';
import { slugify, isValidHandle } from '../utils/slugify';
import { generateExcerpt } from '../utils/excerpt';
import { formatProjectGraph } from '../utils/graph-formatter';
import { getHiddenProjectHandles } from '../utils/hidden-projects';

/**
 * Helper function to resolve a project by handle or UUID
 * Tries handle first, then falls back to UUID
 * Lookups are case-insensitive (handles are stored lowercase)
 */
export async function resolveProject(identifier: string): Promise<Project | null> {
  // Try to find by handle first (lowercase for case-insensitive match)
  let projects = await query<Project>(
    'SELECT * FROM projects WHERE handle = $1',
    [identifier.toLowerCase()]
  );

  // If not found and identifier looks like a UUID, try UUID lookup
  if (
    projects.length === 0 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier)
  ) {
    projects = await query<Project>('SELECT * FROM projects WHERE id = $1', [identifier]);
  }

  // Fallback to name match (case-insensitive)
  if (projects.length === 0) {
    projects = await query<Project>('SELECT * FROM projects WHERE LOWER(name) = LOWER($1)', [identifier]);
  }

  return projects.length > 0 ? projects[0] : null;
}

// Build session context for a project by UUID
export async function buildSessionContextByProjectId(id: string): Promise<SessionContext> {
  const projectRows = await query<Project>('SELECT * FROM projects WHERE id = $1', [id]);
  if (projectRows.length === 0) {
    throw Object.assign(new Error('Project not found'), { statusCode: 404 });
  }
  const project = projectRows[0];

  // Summary query without content - for lightweight responses
  const summaryQuery = `
    SELECT m.id, m.project_id, m.title, m.created_at, m.updated_at,
           mt.name as type, mts.status_value as status
    FROM memories m
    INNER JOIN memory_types mt ON m.memory_type_id = mt.id
    LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
    WHERE m.project_id = $1
  `;

  const recentlyCreatedTodos = await query<MemorySummary>(
    `${summaryQuery} AND mt.name IN ('user-todo', 'assistant-todo') AND mts.status_value = 'open'
     ORDER BY m.created_at DESC
     LIMIT 5`,
    [id]
  );

  const inProgressTodos = await query<MemorySummary>(
    `${summaryQuery} AND mt.name IN ('user-todo', 'assistant-todo') AND mts.status_value = 'in_progress'
     ORDER BY m.created_at ASC`,
    [id]
  );

  const recentlyCompletedTodos = await query<MemorySummary>(
    `${summaryQuery} AND mt.name IN ('user-todo', 'assistant-todo') AND mts.status_value = 'done'
     ORDER BY m.status_updated_at DESC
     LIMIT 3`,
    [id]
  );

  const recentDecisions = await query<MemorySummary>(
    `${summaryQuery} AND mt.name = 'decision'
     ORDER BY m.updated_at DESC
     LIMIT 5`,
    [id]
  );

  const recentPatterns = await query<MemorySummary>(
    `${summaryQuery} AND mt.name = 'pattern' AND mt.parent_id IS NOT NULL
     ORDER BY m.updated_at DESC
     LIMIT 5`,
    [id]
  );

  const recentContext = await query<MemorySummary>(
    `${summaryQuery} AND mt.name = 'context' AND mt.parent_id IS NOT NULL
     ORDER BY m.updated_at DESC
     LIMIT 5`,
    [id]
  );

  return {
    project,
    todos: {
      recently_created: recentlyCreatedTodos,
      in_progress: inProgressTodos,
      recently_completed: recentlyCompletedTodos,
    },
    recent_decisions: recentDecisions,
    recent_patterns: recentPatterns,
    recent_context: recentContext,
  };
}

const projectRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request) => {
    const { name, handle, q, favorite, includeHidden } = request.query as {
      name?: string;
      handle?: string;
      q?: string;
      favorite?: string;
      includeHidden?: string;
    };

    let sql = 'SELECT * FROM projects';
    const conditions: string[] = [];
    const params: any[] = [];

    if (handle) {
      conditions.push(`handle = $${params.length + 1}`);
      params.push(handle.toLowerCase());
    } else if (name) {
      conditions.push(`LOWER(name) = LOWER($${params.length + 1})`);
      params.push(name);
    } else if (q && q.trim()) {
      conditions.push(`(
        LOWER(handle) LIKE LOWER($${params.length + 1})
        OR LOWER(name) LIKE LOWER($${params.length + 1})
        OR LOWER(display_name) LIKE LOWER($${params.length + 1})
        OR LOWER(COALESCE(description, '')) LIKE LOWER($${params.length + 1})
      )`);
      params.push(`%${q}%`);
    }

    // Filter by favorite status
    if (favorite === 'true') {
      conditions.push('is_favorite = TRUE');
    } else if (favorite === 'false') {
      conditions.push('is_favorite = FALSE');
    }

    // Exclude hidden projects unless includeHidden=true
    if (includeHidden !== 'true') {
      const hiddenHandles = await getHiddenProjectHandles();
      if (hiddenHandles.length > 0) {
        const placeholders = hiddenHandles.map((_, i) => `$${params.length + i + 1}`).join(', ');
        conditions.push(`handle NOT IN (${placeholders})`);
        params.push(...hiddenHandles);
      }
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    // Sort favorites first, then by created_at
    sql += ' ORDER BY is_favorite DESC, created_at DESC';

    const projects = await query<Project>(sql, params);
    return { projects };
  });

  fastify.get('/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      return reply.code(400).send({ error: 'projectId must be a UUID' });
    }
    const projects = await query<Project>('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (projects.length === 0) {
      return reply.code(404).send({ error: 'Project not found' });
    }
    return { project: projects[0] };
  });

  fastify.post('/', async (request, reply) => {
    const { name, handle: customHandle, display_name, description, path } = request.body as CreateProjectInput;

    if (!name) {
      return reply.code(400).send({ error: 'Name is required' });
    }

    // Auto-generate handle from name or use custom handle
    const handle = customHandle || slugify(name);

    // Validate custom handle format if provided
    if (customHandle && !isValidHandle(customHandle)) {
      return reply.code(400).send({
        error: 'Invalid handle format. Handle must be lowercase alphanumeric with hyphens only (e.g., "my-project")'
      });
    }

    // Use provided display_name or fall back to name
    const displayName = display_name || name;

    // Check if handle already exists
    const existing = await query<Project>(
      'SELECT id FROM projects WHERE handle = $1',
      [handle]
    );

    if (existing.length > 0) {
      return reply.code(409).send({ error: 'Project with this handle already exists' });
    }

    const projects = await query<Project>(
      'INSERT INTO projects (name, handle, display_name, description, path) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, handle, displayName, description || null, path || null]
    );

    return reply.code(201).send({ project: projects[0] });
  });

  // PUT - Full resource replacement (requires name)
  fastify.put('/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { name, display_name, description, path } = request.body as FullProjectInput;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      return reply.code(400).send({ error: 'projectId must be a UUID' });
    }

    // PUT requires full resource - name is required
    if (!name) {
      return reply.code(400).send({ error: 'name is required for full resource replacement. Use PATCH for partial updates.' });
    }

    const projects = await query<Project>(
      'UPDATE projects SET name = $1, display_name = $2, description = $3, path = $4 WHERE id = $5 RETURNING *',
      [name, display_name || name, description || null, path || null, projectId]
    );
    if (projects.length === 0) {
      return reply.code(404).send({ error: 'Project not found' });
    }
    return { project: projects[0] };
  });

  // PATCH - Partial update (all fields optional)
  fastify.patch('/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { name, display_name, description, path, is_favorite } = request.body as UpdateProjectInput & { is_favorite?: boolean };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      return reply.code(400).send({ error: 'projectId must be a UUID' });
    }

    // Build SET clause dynamically to handle boolean fields properly
    const sets: string[] = [];
    const params: any[] = [];

    if (name !== undefined) {
      params.push(name);
      sets.push(`name = $${params.length}`);
    }
    if (display_name !== undefined) {
      params.push(display_name);
      sets.push(`display_name = $${params.length}`);
    }
    if (description !== undefined) {
      params.push(description);
      sets.push(`description = $${params.length}`);
    }
    if (path !== undefined) {
      params.push(path);
      sets.push(`path = $${params.length}`);
    }
    if (is_favorite !== undefined) {
      params.push(is_favorite);
      sets.push(`is_favorite = $${params.length}`);
    }

    if (sets.length === 0) {
      // No fields to update, just return the existing project
      const existing = await query<Project>('SELECT * FROM projects WHERE id = $1', [projectId]);
      if (existing.length === 0) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      return { project: existing[0] };
    }

    params.push(projectId);
    const projects = await query<Project>(
      `UPDATE projects SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (projects.length === 0) {
      return reply.code(404).send({ error: 'Project not found' });
    }
    return { project: projects[0] };
  });

  fastify.delete('/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      return reply.code(400).send({ error: 'projectId must be a UUID' });
    }

    // Protect reserved "user" project from deletion
    const existing = await query<Project>('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (existing.length === 0) {
      return reply.code(404).send({ error: 'Project not found' });
    }
    if (existing[0].handle === 'user') {
      return reply.code(403).send({
        error: 'Cannot delete the reserved "user" project. This project holds general/user memories.'
      });
    }

    await query(
      'DELETE FROM projects WHERE id = $1',
      [projectId]
    );

    return reply.code(204).send();
  });

  fastify.get('/:projectId/tags', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      return reply.code(400).send({ error: 'projectId must be a UUID' });
    }
    const projectRows = await query<Project>('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (projectRows.length === 0) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Get tags used in this project with usage counts
    const tags = await query(
      `SELECT
        t.id,
        t.name,
        t.created_at,
        COUNT(DISTINCT mt.memory_id) as usage_count
       FROM tags t
       INNER JOIN memory_tags mt ON t.id = mt.tag_id
       INNER JOIN memories m ON mt.memory_id = m.id
       WHERE m.project_id = $1
       GROUP BY t.id, t.name, t.created_at
       ORDER BY usage_count DESC, t.name ASC`,
      [projectId]
    );

    return { tags };
  });

  fastify.get('/:projectId/memory-types', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const types = await query<MemoryTypeRecord & { usage_count: number; parent_name: string | null }>(
      `SELECT
         mt.id,
         mt.name,
         mt.description,
         mt.created_at,
         mt_parent.name as parent_name,
         COALESCE(usage.count, 0) as usage_count
       FROM memory_types mt
       LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
       LEFT JOIN (
         SELECT memory_type_id, COUNT(*)::int as count
         FROM memories
         WHERE project_id = $1
         GROUP BY memory_type_id
       ) usage ON usage.memory_type_id = mt.id
       ORDER BY mt.name`,
      [project.id]
    );

    const memoryTypes = await Promise.all(
      types.map(async (type) => {
        // Fetch own statuses first; fall back to parent type's statuses for children with none
        let statuses = await query<MemoryTypeStatus & { value: string }>(
          `SELECT id, memory_type_id, status_value as value, display_name, description, sort_order
           FROM memory_type_statuses
           WHERE memory_type_id = $1
           ORDER BY sort_order`,
          [type.id]
        );

        const inherited = statuses.length === 0 && type.parent_name;
        if (inherited) {
          statuses = await query<MemoryTypeStatus & { value: string }>(
            `SELECT mts.id, mts.memory_type_id, mts.status_value as value, mts.display_name, mts.description, mts.sort_order
             FROM memory_type_statuses mts
             JOIN memory_types mt ON mt.id = mts.memory_type_id
             WHERE mt.name = $1
             ORDER BY mts.sort_order`,
            [type.parent_name]
          );
        }

        return {
          type: type.name,
          description: type.description,
          ...(type.parent_name ? { parent_type: type.parent_name } : {}),
          usage_count: type.usage_count,
          statuses: statuses.map(s => ({
            value: s.value,
            display_name: s.display_name,
            description: s.description,
            sort_order: s.sort_order,
            ...(inherited ? { inherited: true } : {})
          }))
        };
      })
    );

    return {
      project_id: project.id,
      project_handle: project.handle,
      memory_types: memoryTypes
    };
  });

  fastify.get('/:projectId/memory-types/:type/statuses', async (request, reply) => {
    const { projectId, type } = request.params as { projectId: string; type: string };

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const typeResult = await query<MemoryTypeRecord & { parent_id: string | null }>(
      'SELECT id, name, parent_id FROM memory_types WHERE name = $1',
      [type]
    );

    if (typeResult.length === 0) {
      return reply.code(404).send({ error: `Memory type not found: ${type}` });
    }

    const memoryType = typeResult[0];

    let statuses = await query<
      MemoryTypeStatus & { value: string; usage_count: number }
    >(
      `SELECT
         mts.id,
         mts.memory_type_id,
         mts.status_value as value,
         mts.display_name,
         mts.description,
         mts.sort_order,
         COALESCE(usage.count, 0) as usage_count
       FROM memory_type_statuses mts
       LEFT JOIN (
         SELECT status_id, COUNT(*)::int as count
         FROM memories
         WHERE project_id = $1 AND memory_type_id = $2
         GROUP BY status_id
       ) usage ON usage.status_id = mts.id
       WHERE mts.memory_type_id = $2
       ORDER BY mts.sort_order`,
      [project.id, memoryType.id]
    );

    const inherited = statuses.length === 0 && memoryType.parent_id;
    if (inherited) {
      statuses = await query<MemoryTypeStatus & { value: string; usage_count: number }>(
        `SELECT
           mts.id,
           mts.memory_type_id,
           mts.status_value as value,
           mts.display_name,
           mts.description,
           mts.sort_order,
           COALESCE(usage.count, 0) as usage_count
         FROM memory_type_statuses mts
         LEFT JOIN (
           SELECT status_id, COUNT(*)::int as count
           FROM memories
           WHERE project_id = $1 AND memory_type_id = $2
           GROUP BY status_id
         ) usage ON usage.status_id = mts.id
         WHERE mts.memory_type_id = $3
         ORDER BY mts.sort_order`,
        [project.id, memoryType.id, memoryType.parent_id]
      );
    }

    return {
      project_id: project.id,
      project_handle: project.handle,
      type: memoryType.name,
      statuses: statuses.map(s => ({
        value: s.value,
        display_name: s.display_name,
        description: s.description,
        sort_order: s.sort_order,
        usage_count: s.usage_count,
        ...(inherited ? { inherited: true } : {})
      }))
    };
  });

  fastify.get('/:projectId/session-context', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      return reply.code(400).send({ error: 'projectId must be a UUID' });
    }
    try {
      const ctx = await buildSessionContextByProjectId(projectId);
      return ctx;
    } catch (err: any) {
      if (err?.statusCode === 404) return reply.code(404).send({ error: 'Project not found' });
      throw err;
    }
  });

  fastify.get('/:projectId/graph-health', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };

    // Resolve project to get full project object
    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Total memory count
    const totalResult = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM memories WHERE project_id = $1',
      [projectId]
    );
    const totalMemories = parseInt(totalResult[0].count, 10);

    // Orphan memories (no incoming or outgoing relations)
    const orphans = await query<{ id: string; title: string; type: string }>(
      `SELECT m.id, m.title, mt.name as type
       FROM memories m
       INNER JOIN memory_types mt ON m.memory_type_id = mt.id
       WHERE m.project_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM memory_relations mr
           WHERE mr.source_memory_id = m.id OR mr.target_memory_id = m.id
         )
       ORDER BY m.created_at DESC`,
      [projectId]
    );

    // Relation type distribution
    const relationTypes = await query<{ relation_type: string; count: string }>(
      `SELECT mr.relation_type, COUNT(*) as count
       FROM memory_relations mr
       INNER JOIN memories m ON mr.source_memory_id = m.id
       WHERE m.project_id = $1
       GROUP BY mr.relation_type
       ORDER BY count DESC`,
      [projectId]
    );

    // Memory types with relation counts
    const memoryTypeStats = await query<{ type: string; total: string; with_relations: string }>(
      `SELECT
         mt.name as type,
         COUNT(DISTINCT m.id) as total,
         COUNT(DISTINCT CASE
           WHEN EXISTS (
             SELECT 1 FROM memory_relations mr
             WHERE mr.source_memory_id = m.id OR mr.target_memory_id = m.id
           ) THEN m.id
         END) as with_relations
       FROM memories m
       INNER JOIN memory_types mt ON m.memory_type_id = mt.id
       WHERE m.project_id = $1
       GROUP BY mt.name
       ORDER BY total DESC`,
      [projectId]
    );

    // Total relation count (edges originating in this project)
    const relationCountResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM memory_relations mr
       INNER JOIN memories m ON mr.source_memory_id = m.id
       WHERE m.project_id = $1`,
      [projectId]
    );
    const totalRelations = parseInt(relationCountResult[0].count, 10);

    // Internal vs cross-project edges
    const internalEdgesResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM memory_relations mr
       INNER JOIN memories ms ON mr.source_memory_id = ms.id
       INNER JOIN memories mt ON mr.target_memory_id = mt.id
       WHERE ms.project_id = $1 AND mt.project_id = $1`,
      [projectId]
    );
    const internalEdges = parseInt(internalEdgesResult[0].count, 10);

    const crossEdgesResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM memory_relations mr
       INNER JOIN memories ms ON mr.source_memory_id = ms.id
       INNER JOIN memories mt ON mr.target_memory_id = mt.id
       WHERE ms.project_id = $1 AND mt.project_id <> $1`,
      [projectId]
    );
    const crossProjectEdges = parseInt(crossEdgesResult[0].count, 10);

    // Disconnected subgraphs (connected components) analysis
    // 1) Get all memory IDs for the project
    const memoryRows = await query<{ id: string }>(
      'SELECT id FROM memories WHERE project_id = $1',
      [projectId]
    );
    const nodeIds = memoryRows.map(r => r.id);

    // 2) Get all edges where source is in this project
    // We filter to edges where both endpoints are in project when building adjacency
    const edgeRows = await query<{ source: string; target: string }>(
      `SELECT DISTINCT mr.source_memory_id as source, mr.target_memory_id as target
       FROM memory_relations mr
       INNER JOIN memories m ON m.id = mr.source_memory_id
       WHERE m.project_id = $1`,
      [project.id]
    );

    // Build adjacency for nodes in this project (treat edges as undirected for connectivity)
    const nodeSet = new Set(nodeIds);
    const adjacency = new Map<string, Set<string>>();
    for (const id of nodeIds) adjacency.set(id, new Set());
    for (const { source, target } of edgeRows) {
      if (nodeSet.has(source) && nodeSet.has(target)) {
        adjacency.get(source)?.add(target);
        adjacency.get(target)?.add(source);
      }
    }

    // BFS/DFS to compute connected components
    const visited = new Set<string>();
    const componentSizes: number[] = [];
    for (const id of nodeIds) {
      if (visited.has(id)) continue;
      let size = 0;
      const queue = [id];
      visited.add(id);
      while (queue.length > 0) {
        const cur = queue.pop() as string;
        size += 1;
        const neighbors = adjacency.get(cur);
        if (neighbors) {
          for (const nb of neighbors) {
            if (!visited.has(nb)) {
              visited.add(nb);
              queue.push(nb);
            }
          }
        }
      }
      componentSizes.push(size);
    }

    const componentsCount = componentSizes.length;
    const largestComponentSize = componentSizes.length > 0 ? Math.max(...componentSizes) : 0;
    // How many extra components beyond a single connected graph (0 = fully connected)
    const isolatedComponentCount = componentsCount > 1 ? componentsCount - 1 : 0;

    return {
      project_id: project.id,
      project_handle: project.handle,
      summary: {
        total_memories: totalMemories,
        orphan_count: orphans.length,
        connected_count: totalMemories - orphans.length,
        total_relations: totalRelations,
        connection_rate: totalMemories > 0
          ? Math.round((1 - orphans.length / totalMemories) * 100)
          : 0,
        components_count: componentsCount,
        isolated_component_count: isolatedComponentCount,
        largest_component_size: largestComponentSize
      },
      orphan_memories: orphans,
      relation_types: relationTypes.map(r => ({
        type: r.relation_type,
        count: parseInt(r.count, 10)
      })),
      memory_type_stats: memoryTypeStats.map(s => ({
        type: s.type,
        total: parseInt(s.total, 10),
        with_relations: parseInt(s.with_relations, 10),
        orphan_count: parseInt(s.total, 10) - parseInt(s.with_relations, 10)
      })),
      cross_project: {
        edges: crossProjectEdges,
        internal_edges: internalEdges,
        ratio: totalRelations > 0 ? Math.round((crossProjectEdges / totalRelations) * 100) : 0
      }
    };
  });

  // GET /api/projects/:projectId/graph - Project-level graph visualization
  fastify.get('/:projectId/graph', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { max_nodes = '100', max_edges = '200', compact = 'true', format = 'json', type, tag } = request.query as {
      max_nodes?: string;
      max_edges?: string;
      compact?: string;
      format?: string;
      type?: string;
      tag?: string;
    };

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const maxNodes = Math.max(1, parseInt(String(max_nodes), 10) || 100);
    const maxEdges = Math.max(1, parseInt(String(max_edges), 10) || 200);
    const isCompact = compact !== 'false';

    // Build dynamic WHERE clause for type/tag filtering
    const conditions = ['m.project_id = $1'];
    const params: any[] = [project.id];
    let paramIndex = 2;

    if (type) {
      conditions.push(`(mt.name = $${paramIndex} OR mt_parent.name = $${paramIndex})`);
      params.push(type);
      paramIndex++;
    }

    if (tag) {
      conditions.push(`EXISTS (
        SELECT 1 FROM memory_tags mtg
        INNER JOIN tags t ON mtg.tag_id = t.id
        WHERE mtg.memory_id = m.id AND LOWER(t.name) = LOWER($${paramIndex})
      )`);
      params.push(tag);
      paramIndex++;
    }

    params.push(maxNodes);

    // Fetch memories with optional type/tag filters
    const memories = await query(
      `SELECT m.id, m.project_id, m.handle, m.title, m.content,
              mt.name as type, mt_parent.name as parent_type,
              mts.status_value as status,
              m.created_at, m.updated_at
       FROM memories m
       INNER JOIN memory_types mt ON m.memory_type_id = mt.id
       LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
       INNER JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY m.updated_at DESC
       LIMIT $${paramIndex}`,
      params
    );

    const memoryIds = memories.map((m: any) => m.id);

    if (memoryIds.length === 0) {
      if (format === 'text') {
        const displayName = project.display_name || project.name;
        return reply.type('text/plain').send(`# Graph: "${displayName}" (0 memories, 0 relations)\n\n(empty)`);
      }
      return { nodes: [], edges: [], truncated: false };
    }

    // Fetch relations between these memories
    const relations = await query(
      `SELECT mr.id, mr.source_memory_id as source, mr.target_memory_id as target,
              mr.relation_type, mr.created_at
       FROM memory_relations mr
       WHERE mr.source_memory_id = ANY($1)
         AND mr.target_memory_id = ANY($1)
       LIMIT $2`,
      [memoryIds, maxEdges]
    );

    const nodes = memories.map((m: any) => {
      const node: any = {
        id: m.id,
        title: m.title,
        type: m.type,
        status: m.status,
        depth: 0,
      };
      if (m.parent_type) {
        node.parent_type = m.parent_type;
      }
      if (isCompact) {
        node.content_excerpt = generateExcerpt(m.content);
      } else {
        node.content = m.content;
        node.handle = m.handle;
        node.created_at = m.created_at;
        node.updated_at = m.updated_at;
      }
      return node;
    });

    const edges = relations.map((r: any) => ({
      source: r.source,
      target: r.target,
      relation_type: r.relation_type,
    }));

    // Build count query with same filters
    const countConditions = ['m.project_id = $1'];
    const countParams: any[] = [project.id];
    let countParamIndex = 2;

    if (type) {
      countConditions.push(`(mt.name = $${countParamIndex} OR mt_parent.name = $${countParamIndex})`);
      countParams.push(type);
      countParamIndex++;
    }

    if (tag) {
      countConditions.push(`EXISTS (
        SELECT 1 FROM memory_tags mtg
        INNER JOIN tags t ON mtg.tag_id = t.id
        WHERE mtg.memory_id = m.id AND LOWER(t.name) = LOWER($${countParamIndex})
      )`);
      countParams.push(tag);
    }

    const totalMemoryCount = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM memories m
       INNER JOIN memory_types mt ON m.memory_type_id = mt.id
       LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
       WHERE ${countConditions.join(' AND ')}`,
      countParams
    );
    const totalMemories = parseInt(totalMemoryCount[0].count, 10);
    const truncated = nodes.length >= maxNodes || edges.length >= maxEdges;

    if (format === 'text') {
      const displayName = project.display_name || project.name;
      const text = formatProjectGraph(nodes, edges, displayName, { totalMemories, truncated });
      return reply.type('text/plain').send(text);
    }

    return {
      nodes,
      edges,
      truncated,
      total_nodes: totalMemories,
      total_edges: edges.length,
    };
  });
};

export default projectRoutes;
