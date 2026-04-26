import { FastifyPluginAsync } from 'fastify';
import { getClient, query } from '../db/client';
import { resolveProject } from './projects';
import { isValidHandle } from '../utils/slugify';
import { generateExcerpt } from '../utils/excerpt';
import { TagRef } from '../types';

type ViewMode = 'list' | 'board' | 'grid';
const VALID_VIEW_MODES: ViewMode[] = ['list', 'board', 'grid'];

interface BoardConfig {
  hiddenColumns?: string[];
  columnOrder?: string[];
}

interface CreateCollectionInput {
  handle: string;
  name: string;
  description?: string;
  parent_id?: string;
  view_mode?: ViewMode;
  board_config?: BoardConfig;
}

interface UpdateCollectionInput {
  name?: string;
  description?: string | null;
  view_mode?: ViewMode;
  board_config?: BoardConfig;
  parent_id?: string | null;
}

interface AddMemoryInput {
  memory_id: string;
  position?: number;
}

interface ReorderItem {
  memory_id: string;
  position: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const collectionRoutes: FastifyPluginAsync = async (fastify) => {

  // List collections for a project
  fastify.get('/', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { limit, offset, parent_id } = request.query as { limit?: string; offset?: string; parent_id?: string };

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const limitNum = parseInt(limit || '20', 10);
    const offsetNum = parseInt(offset || '0', 10);

    // Build parent_id filter: ?parent_id=<uuid> for children, ?parent_id=null for roots only
    let parentFilter = '';
    const params: any[] = [project.id];
    if (parent_id === 'null') {
      parentFilter = ' AND c.parent_id IS NULL';
    } else if (parent_id && UUID_RE.test(parent_id)) {
      parentFilter = ` AND c.parent_id = $${params.length + 1}`;
      params.push(parent_id);
    }

    params.push(limitNum, offsetNum);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const rows = await query<{
      id: string;
      project_id: string;
      handle: string;
      name: string;
      description: string | null;
      parent_id: string | null;
      view_mode: string;
      board_config: BoardConfig;
      memory_count: string;
      child_count: string;
      created_at: string;
      updated_at: string;
      total_count: string;
    }>(
      `SELECT c.id, c.project_id, c.handle, c.name, c.description,
              c.parent_id, c.view_mode, c.board_config,
              c.created_at, c.updated_at,
              COUNT(cm.memory_id)::text AS memory_count,
              (SELECT COUNT(*)::text FROM collections sub WHERE sub.parent_id = c.id) AS child_count,
              COUNT(*) OVER() AS total_count
       FROM collections c
       LEFT JOIN collection_memories cm ON c.id = cm.collection_id
       WHERE c.project_id = $1${parentFilter}
       GROUP BY c.id
       ORDER BY c.updated_at DESC, c.id ASC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    const totalCount = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;

    const collectionIds = rows.filter(r => parseInt(r.child_count, 10) > 0).map(r => r.id);
    const childrenMap = new Map<string, { id: string; name: string; handle: string; view_mode: string; memory_count: number }[]>();

    if (collectionIds.length > 0) {
      const childRows = await query<{
        parent_id: string;
        id: string;
        name: string;
        handle: string;
        view_mode: string;
        memory_count: string;
      }>(
        `SELECT c.parent_id, c.id, c.name, c.handle, c.view_mode,
                COUNT(cm.memory_id)::text AS memory_count
         FROM collections c
         LEFT JOIN collection_memories cm ON c.id = cm.collection_id
         WHERE c.parent_id = ANY($1)
         GROUP BY c.id
         ORDER BY c.name ASC`,
        [collectionIds]
      );
      for (const row of childRows) {
        if (!childrenMap.has(row.parent_id)) {
          childrenMap.set(row.parent_id, []);
        }
        childrenMap.get(row.parent_id)!.push({
          id: row.id,
          name: row.name,
          handle: row.handle,
          view_mode: row.view_mode,
          memory_count: parseInt(row.memory_count, 10),
        });
      }
    }

    const collections = rows.map(({ total_count, memory_count, child_count, ...rest }) => ({
      ...rest,
      memory_count: parseInt(memory_count, 10),
      child_count: parseInt(child_count, 10),
      children: childrenMap.get(rest.id) || [],
    }));

    return {
      collections,
      pagination: {
        total_count: totalCount,
        limit: limitNum,
        offset: offsetNum,
        has_more: offsetNum + limitNum < totalCount,
      },
    };
  });

  // Create collection
  fastify.post('/', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { handle, name, description, parent_id, view_mode, board_config } = request.body as CreateCollectionInput;

    if (!handle || !name) {
      return reply.code(400).send({ error: 'handle and name are required' });
    }

    if (!isValidHandle(handle)) {
      return reply.code(400).send({ error: 'Invalid handle format. Use lowercase letters, numbers and hyphens (e.g., "my-collection").' });
    }

    if (view_mode && !VALID_VIEW_MODES.includes(view_mode)) {
      return reply.code(400).send({ error: `Invalid view_mode. Must be one of: ${VALID_VIEW_MODES.join(', ')}` });
    }

    if (parent_id && !UUID_RE.test(parent_id)) {
      return reply.code(400).send({ error: 'parent_id must be a valid UUID' });
    }

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Validate parent exists and belongs to same project
    if (parent_id) {
      const parentCheck = await query(
        'SELECT id, parent_id FROM collections WHERE id = $1 AND project_id = $2',
        [parent_id, project.id]
      );
      if (parentCheck.length === 0) {
        return reply.code(404).send({ error: 'Parent collection not found in this project' });
      }
      if (parentCheck[0].parent_id !== null) {
        return reply.code(400).send({ error: 'Cannot nest under a sub-collection (single-level nesting only)' });
      }
    }

    const existing = await query(
      'SELECT id FROM collections WHERE project_id = $1 AND handle = $2',
      [project.id, handle]
    );
    if (existing.length > 0) {
      return reply.code(409).send({ error: 'A collection with this handle already exists in this project' });
    }

    const rows = await query<{
      id: string;
      project_id: string;
      handle: string;
      name: string;
      description: string | null;
      parent_id: string | null;
      view_mode: string;
      board_config: BoardConfig;
      created_at: string;
      updated_at: string;
    }>(
      `INSERT INTO collections (project_id, handle, name, description, parent_id, view_mode, board_config)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, project_id, handle, name, description, parent_id, view_mode, board_config, created_at, updated_at`,
      [project.id, handle, name, description || null, parent_id || null, view_mode || 'list', JSON.stringify(board_config || {})]
    );

    return reply.code(201).send({ collection: { ...rows[0], memory_count: 0 } });
  });

  // Get collection with memories
  fastify.get('/:collectionId', async (request, reply) => {
    const { projectId, collectionId } = request.params as { projectId: string; collectionId: string };

    if (!UUID_RE.test(collectionId)) {
      return reply.code(400).send({ error: 'collectionId must be a UUID' });
    }

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const collections = await query<{
      id: string;
      project_id: string;
      handle: string;
      name: string;
      description: string | null;
      parent_id: string | null;
      view_mode: string;
      board_config: BoardConfig;
      created_at: string;
      updated_at: string;
    }>(
      'SELECT id, project_id, handle, name, description, parent_id, view_mode, board_config, created_at, updated_at FROM collections WHERE id = $1 AND project_id = $2',
      [collectionId, project.id]
    );

    if (collections.length === 0) {
      return reply.code(404).send({ error: 'Collection not found in this project' });
    }

    const collection = collections[0];

    // Fetch sub-collections if this is a root collection
    const children = collection.parent_id === null
      ? await query<{
          id: string;
          handle: string;
          name: string;
          description: string | null;
          view_mode: string;
          memory_count: string;
        }>(
          `SELECT c.id, c.handle, c.name, c.description, c.view_mode,
                  COUNT(cm.memory_id)::text AS memory_count
           FROM collections c
           LEFT JOIN collection_memories cm ON c.id = cm.collection_id
           WHERE c.parent_id = $1
           GROUP BY c.id
           ORDER BY c.name ASC`,
          [collection.id]
        )
      : [];

    // Fetch memories with compact fields, ordered by position
    const memories = await query<{
      id: string;
      handle: string;
      title: string;
      content: string;
      type: string;
      parent_type: string | null;
      status: string | null;
      project_id: string;
      position: number;
      added_at: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT m.id, m.handle, m.title, m.content,
              mt.name as type, mt_parent.name as parent_type,
              mts.status_value as status,
              m.project_id,
              cm.position, cm.added_at, m.created_at, m.updated_at
       FROM collection_memories cm
       INNER JOIN memories m ON cm.memory_id = m.id
       INNER JOIN memory_types mt ON m.memory_type_id = mt.id
       LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
       LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE cm.collection_id = $1
       ORDER BY cm.position ASC, cm.added_at ASC`,
      [collectionId]
    );

    // Fetch tags for all memories in one query
    const memoryIds = memories.map(m => m.id);
    const tagsMap = new Map<string, TagRef[]>();

    if (memoryIds.length > 0) {
      const tagResults = await query<{ memory_id: string; tag_id: string; name: string }>(
        `SELECT mtag.memory_id, t.id as tag_id, t.name
         FROM memory_tags mtag
         INNER JOIN tags t ON mtag.tag_id = t.id
         WHERE mtag.memory_id = ANY($1)`,
        [memoryIds]
      );

      for (const { memory_id, tag_id, name } of tagResults) {
        if (!tagsMap.has(memory_id)) {
          tagsMap.set(memory_id, []);
        }
        tagsMap.get(memory_id)!.push({ id: tag_id, name });
      }
    }

    // Fetch metadata for all memories (external source + associated project)
    const metaMap = new Map<string, Record<string, string>>();

    if (memoryIds.length > 0) {
      const metaResults = await query<{ memory_id: string; field: string; value: string }>(
        `SELECT mm.memory_id, md.field, mm.value
         FROM memory_metadata mm
         INNER JOIN metadata md ON mm.metadata_id = md.id
         WHERE mm.memory_id = ANY($1) AND (md.field LIKE 'external-%' OR md.field IN ('associated-project', 'slide-order'))`,
        [memoryIds]
      );

      for (const { memory_id, field, value } of metaResults) {
        if (!metaMap.has(memory_id)) {
          metaMap.set(memory_id, {});
        }
        metaMap.get(memory_id)![field] = value;
      }
    }

    // Resolve project handles for memories from other projects
    const foreignProjectIds = new Set(
      memories.filter(m => m.project_id !== project.id).map(m => m.project_id)
    );
    const projectHandleMap = new Map<string, string>();
    if (foreignProjectIds.size > 0) {
      const projectRows = await query<{ id: string; handle: string }>(
        `SELECT id, handle FROM projects WHERE id = ANY($1)`,
        [Array.from(foreignProjectIds)]
      );
      for (const row of projectRows) {
        projectHandleMap.set(row.id, row.handle);
      }
    }

    const memoryList = memories.map(({ content, project_id, ...mem }) => {
      const meta = metaMap.get(mem.id);
      // Determine display project: associated-project metadata > actual project (if foreign)
      const foreignHandle = project_id !== project.id ? projectHandleMap.get(project_id) : undefined;
      const displayProject = meta?.['associated-project'] || foreignHandle || undefined;
      return {
        ...mem,
        content_excerpt: generateExcerpt(content),
        tags: tagsMap.get(mem.id) || [],
        ...(meta && Object.keys(meta).length > 0 ? { metadata: meta } : {}),
        ...(displayProject ? { display_project: displayProject } : {}),
      };
    });

    return {
      collection: {
        ...collection,
        memory_count: memoryList.length,
        children: children.map(({ memory_count, ...c }) => ({
          ...c,
          memory_count: parseInt(memory_count, 10),
        })),
        memories: memoryList,
      },
    };
  });

  // Get collection as board (memories grouped by status columns)
  fastify.get('/:collectionId/board', async (request, reply) => {
    const { projectId, collectionId } = request.params as { projectId: string; collectionId: string };

    if (!UUID_RE.test(collectionId)) {
      return reply.code(400).send({ error: 'collectionId must be a UUID' });
    }

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const collections = await query<{
      id: string;
      handle: string;
      name: string;
      description: string | null;
      parent_id: string | null;
      view_mode: string;
      board_config: BoardConfig;
    }>(
      'SELECT id, handle, name, description, parent_id, view_mode, board_config FROM collections WHERE id = $1 AND project_id = $2',
      [collectionId, project.id]
    );

    if (collections.length === 0) {
      return reply.code(404).send({ error: 'Collection not found in this project' });
    }

    const collection = collections[0];

    // Fetch all memories in this collection with their status info
    const memories = await query<{
      id: string;
      handle: string;
      title: string;
      content: string;
      type: string;
      parent_type: string | null;
      status_id: string;
      status_value: string;
      status_display_name: string;
      status_sort_order: number;
      project_id: string;
      position: number;
      updated_at: string;
    }>(
      `SELECT m.id, m.handle, m.title, m.content,
              mt.name as type, mt_parent.name as parent_type,
              mts.id as status_id, mts.status_value, mts.display_name as status_display_name,
              mts.sort_order as status_sort_order,
              m.project_id,
              cm.position, m.updated_at
       FROM collection_memories cm
       INNER JOIN memories m ON cm.memory_id = m.id
       INNER JOIN memory_types mt ON m.memory_type_id = mt.id
       LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
       INNER JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE cm.collection_id = $1
       ORDER BY mts.sort_order ASC, cm.position ASC`,
      [collectionId]
    );

    // Fetch tags for all memories
    const memoryIds = memories.map(m => m.id);
    const tagsMap = new Map<string, TagRef[]>();

    if (memoryIds.length > 0) {
      const tagResults = await query<{ memory_id: string; tag_id: string; name: string }>(
        `SELECT mtag.memory_id, t.id as tag_id, t.name
         FROM memory_tags mtag
         INNER JOIN tags t ON mtag.tag_id = t.id
         WHERE mtag.memory_id = ANY($1)`,
        [memoryIds]
      );

      for (const { memory_id, tag_id, name } of tagResults) {
        if (!tagsMap.has(memory_id)) {
          tagsMap.set(memory_id, []);
        }
        tagsMap.get(memory_id)!.push({ id: tag_id, name });
      }
    }

    // Fetch metadata for all memories (external source info)
    const metaMap = new Map<string, Record<string, string>>();

    if (memoryIds.length > 0) {
      const metaResults = await query<{ memory_id: string; field: string; value: string }>(
        `SELECT mm.memory_id, md.field, mm.value
         FROM memory_metadata mm
         INNER JOIN metadata md ON mm.metadata_id = md.id
         WHERE mm.memory_id = ANY($1) AND (md.field LIKE 'external-%' OR md.field IN ('associated-project', 'slide-order'))`,
        [memoryIds]
      );

      for (const { memory_id, field, value } of metaResults) {
        if (!metaMap.has(memory_id)) {
          metaMap.set(memory_id, {});
        }
        metaMap.get(memory_id)![field] = value;
      }
    }

    // Resolve project handles for memories from other projects
    const boardForeignProjectIds = new Set(
      memories.filter(m => m.project_id !== project.id).map(m => m.project_id)
    );
    const boardProjectHandleMap = new Map<string, string>();
    if (boardForeignProjectIds.size > 0) {
      const projectRows = await query<{ id: string; handle: string }>(
        `SELECT id, handle FROM projects WHERE id = ANY($1)`,
        [Array.from(boardForeignProjectIds)]
      );
      for (const row of projectRows) {
        boardProjectHandleMap.set(row.id, row.handle);
      }
    }

    // Group memories into columns by status
    const columnMap = new Map<string, {
      status_id: string;
      status_value: string;
      display_name: string;
      sort_order: number;
      memories: any[];
    }>();

    for (const mem of memories) {
      if (!columnMap.has(mem.status_value)) {
        columnMap.set(mem.status_value, {
          status_id: mem.status_id,
          status_value: mem.status_value,
          display_name: mem.status_display_name,
          sort_order: mem.status_sort_order,
          memories: [],
        });
      }

      const { content, status_id, status_value, status_display_name, status_sort_order, project_id, ...rest } = mem;
      const meta = metaMap.get(mem.id);
      const foreignHandle = project_id !== project.id ? boardProjectHandleMap.get(project_id) : undefined;
      const displayProject = meta?.['associated-project'] || foreignHandle || undefined;
      columnMap.get(mem.status_value)!.memories.push({
        ...rest,
        content_excerpt: generateExcerpt(content),
        tags: tagsMap.get(mem.id) || [],
        ...(meta && Object.keys(meta).length > 0 ? { metadata: meta } : {}),
        ...(displayProject ? { display_project: displayProject } : {}),
      });
    }

    // Also fetch all possible statuses for the memory types in this collection
    // so empty columns are shown
    if (memoryIds.length > 0) {
      const allStatuses = await query<{
        status_id: string;
        status_value: string;
        display_name: string;
        sort_order: number;
      }>(
        `SELECT DISTINCT mts.id as status_id, mts.status_value, mts.display_name, mts.sort_order
         FROM collection_memories cm
         INNER JOIN memories m ON cm.memory_id = m.id
         INNER JOIN memory_types mt ON m.memory_type_id = mt.id
         INNER JOIN memory_type_statuses mts ON mts.memory_type_id = mt.id
            OR (mt.parent_id IS NOT NULL AND mts.memory_type_id = mt.parent_id)
         WHERE cm.collection_id = $1
         ORDER BY mts.sort_order ASC`,
        [collectionId]
      );

      for (const s of allStatuses) {
        if (!columnMap.has(s.status_value)) {
          columnMap.set(s.status_value, {
            status_id: s.status_id,
            status_value: s.status_value,
            display_name: s.display_name,
            sort_order: s.sort_order,
            memories: [],
          });
        }
      }
    }

    const columnOrder = collection.board_config?.columnOrder;
    const columns = Array.from(columnMap.values()).sort((a, b) => {
      if (columnOrder && columnOrder.length > 0) {
        const idxA = columnOrder.indexOf(a.status_value);
        const idxB = columnOrder.indexOf(b.status_value);
        // Listed columns come first in specified order; unlisted append by sort_order
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
      }
      return a.sort_order - b.sort_order;
    });

    return {
      collection: {
        id: collection.id,
        handle: collection.handle,
        name: collection.name,
        description: collection.description,
        parent_id: collection.parent_id,
        view_mode: collection.view_mode,
        board_config: collection.board_config,
      },
      columns,
    };
  });

  // Update collection
  fastify.patch('/:collectionId', async (request, reply) => {
    const { projectId, collectionId } = request.params as { projectId: string; collectionId: string };
    const { name, description, view_mode, board_config, parent_id } = request.body as UpdateCollectionInput;

    if (!UUID_RE.test(collectionId)) {
      return reply.code(400).send({ error: 'collectionId must be a UUID' });
    }

    if (view_mode && !VALID_VIEW_MODES.includes(view_mode)) {
      return reply.code(400).send({ error: `Invalid view_mode. Must be one of: ${VALID_VIEW_MODES.join(', ')}` });
    }

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const updateFields: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (name !== undefined) {
      updateFields.push(`name = $${paramIdx++}`);
      params.push(name);
    }
    if (description !== undefined) {
      updateFields.push(`description = $${paramIdx++}`);
      params.push(description);
    }
    if (view_mode !== undefined) {
      updateFields.push(`view_mode = $${paramIdx++}`);
      params.push(view_mode);
    }
    if (board_config !== undefined) {
      updateFields.push(`board_config = $${paramIdx++}`);
      params.push(JSON.stringify(board_config));
    }
    if (parent_id !== undefined) {
      if (parent_id !== null && !UUID_RE.test(parent_id)) {
        return reply.code(400).send({ error: 'parent_id must be a valid UUID or null' });
      }
      updateFields.push(`parent_id = $${paramIdx++}`);
      params.push(parent_id);
    }

    if (updateFields.length === 0) {
      return reply.code(400).send({ error: 'At least one field (name, description, view_mode, board_config, parent_id) is required' });
    }

    params.push(collectionId, project.id);

    let rows;
    try {
      rows = await query<{
        id: string;
        project_id: string;
        handle: string;
        name: string;
        description: string | null;
        parent_id: string | null;
        view_mode: string;
        board_config: BoardConfig;
        created_at: string;
        updated_at: string;
      }>(
        `UPDATE collections SET ${updateFields.join(', ')} WHERE id = $${paramIdx++} AND project_id = $${paramIdx}
         RETURNING id, project_id, handle, name, description, parent_id, view_mode, board_config, created_at, updated_at`,
        params
      );
    } catch (err: any) {
      // Catch trigger errors (P0001) for nesting constraint violations
      if (err.code === 'P0001') {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Collection not found in this project' });
    }

    return { collection: rows[0] };
  });

  // Delete collection
  fastify.delete('/:collectionId', async (request, reply) => {
    const { projectId, collectionId } = request.params as { projectId: string; collectionId: string };

    if (!UUID_RE.test(collectionId)) {
      return reply.code(400).send({ error: 'collectionId must be a UUID' });
    }

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const result = await query(
      'DELETE FROM collections WHERE id = $1 AND project_id = $2 RETURNING id',
      [collectionId, project.id]
    );

    if (result.length === 0) {
      return reply.code(404).send({ error: 'Collection not found in this project' });
    }

    return reply.code(204).send();
  });

  // Add memory to collection
  fastify.post('/:collectionId/memories', async (request, reply) => {
    const { projectId, collectionId } = request.params as { projectId: string; collectionId: string };
    const { memory_id, position } = request.body as AddMemoryInput;

    if (!UUID_RE.test(collectionId)) {
      return reply.code(400).send({ error: 'collectionId must be a UUID' });
    }
    if (!memory_id || !UUID_RE.test(memory_id)) {
      return reply.code(400).send({ error: 'memory_id must be a valid UUID' });
    }

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Validate collection belongs to project
    const collectionCheck = await query(
      'SELECT id FROM collections WHERE id = $1 AND project_id = $2',
      [collectionId, project.id]
    );
    if (collectionCheck.length === 0) {
      return reply.code(404).send({ error: 'Collection not found in this project' });
    }

    // Validate memory exists (cross-project additions are allowed)
    const memoryCheck = await query(
      'SELECT id FROM memories WHERE id = $1',
      [memory_id]
    );
    if (memoryCheck.length === 0) {
      return reply.code(400).send({ error: 'Memory not found' });
    }

    // If no position specified, put at the end
    let pos = position;
    if (pos === undefined || pos === null) {
      const maxResult = await query<{ max_pos: string | null }>(
        'SELECT MAX(position)::text as max_pos FROM collection_memories WHERE collection_id = $1',
        [collectionId]
      );
      pos = maxResult[0].max_pos !== null ? parseInt(maxResult[0].max_pos, 10) + 1 : 0;
    }

    try {
      await query(
        'INSERT INTO collection_memories (collection_id, memory_id, position) VALUES ($1, $2, $3)',
        [collectionId, memory_id, pos]
      );
    } catch (err: any) {
      if (err.code === '23505') {
        return reply.code(409).send({ error: 'Memory is already in this collection' });
      }
      throw err;
    }

    return reply.code(201).send({ collection_id: collectionId, memory_id, position: pos });
  });

  // Remove memory from collection
  fastify.delete('/:collectionId/memories/:memoryId', async (request, reply) => {
    const { projectId, collectionId, memoryId } = request.params as {
      projectId: string;
      collectionId: string;
      memoryId: string;
    };

    if (!UUID_RE.test(collectionId)) {
      return reply.code(400).send({ error: 'collectionId must be a UUID' });
    }
    if (!UUID_RE.test(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Validate collection belongs to project
    const collectionCheck = await query(
      'SELECT id FROM collections WHERE id = $1 AND project_id = $2',
      [collectionId, project.id]
    );
    if (collectionCheck.length === 0) {
      return reply.code(404).send({ error: 'Collection not found in this project' });
    }

    const result = await query(
      'DELETE FROM collection_memories WHERE collection_id = $1 AND memory_id = $2 RETURNING memory_id',
      [collectionId, memoryId]
    );

    if (result.length === 0) {
      return reply.code(404).send({ error: 'Memory not found in this collection' });
    }

    return reply.code(204).send();
  });

  // Reorder memories in collection
  fastify.put('/:collectionId/memories/reorder', async (request, reply) => {
    const { projectId, collectionId } = request.params as { projectId: string; collectionId: string };
    const { items } = request.body as { items: ReorderItem[] };

    if (!UUID_RE.test(collectionId)) {
      return reply.code(400).send({ error: 'collectionId must be a UUID' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return reply.code(400).send({ error: 'items array is required with at least one entry' });
    }

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Validate collection belongs to project
    const collectionCheck = await query(
      'SELECT id FROM collections WHERE id = $1 AND project_id = $2',
      [collectionId, project.id]
    );
    if (collectionCheck.length === 0) {
      return reply.code(404).send({ error: 'Collection not found in this project' });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      for (const item of items) {
        if (!UUID_RE.test(item.memory_id)) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: `Invalid memory_id: ${item.memory_id}` });
        }
        await client.query(
          'UPDATE collection_memories SET position = $1 WHERE collection_id = $2 AND memory_id = $3',
          [item.position, collectionId, item.memory_id]
        );
      }

      // Touch collection updated_at
      await client.query(
        'UPDATE collections SET updated_at = NOW() WHERE id = $1',
        [collectionId]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return { success: true };
  });
};

/**
 * Global collections list across all projects.
 * Registered under /api/collections
 */
export const globalCollectionsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (_request, _reply) => {
    const rows = await query<{
      id: string;
      handle: string;
      name: string;
      description: string | null;
      project_id: string;
      project_handle: string;
      project_name: string;
      memory_count: string;
    }>(
      `SELECT c.id, c.handle, c.name, c.description, c.project_id,
              p.handle AS project_handle, p.name AS project_name,
              COUNT(cm.memory_id)::text AS memory_count
       FROM collections c
       JOIN projects p ON c.project_id = p.id
       LEFT JOIN collection_memories cm ON c.id = cm.collection_id
       GROUP BY c.id, p.handle, p.name
       ORDER BY p.name ASC, c.name ASC`
    );

    return {
      collections: rows.map((r) => ({
        ...r,
        memory_count: parseInt(r.memory_count, 10),
      })),
    };
  });
};

/**
 * Route for fetching which collections a memory belongs to.
 * Registered under /api/projects/:projectId/memories/:memoryId/collections
 */
export const memoryCollectionsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request, reply) => {
    const { projectId, memoryId } = request.params as { projectId: string; memoryId: string };

    if (!UUID_RE.test(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const rows = await query<{ id: string; handle: string; name: string; project_id: string; project_handle: string; project_name: string }>(
      `SELECT c.id, c.handle, c.name, c.project_id, p.handle AS project_handle, p.name AS project_name
       FROM collections c
       JOIN collection_memories cm ON cm.collection_id = c.id
       JOIN projects p ON c.project_id = p.id
       WHERE cm.memory_id = $1
       ORDER BY c.name ASC`,
      [memoryId]
    );

    return { collections: rows };
  });
};

export default collectionRoutes;
