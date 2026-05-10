import { FastifyPluginAsync } from 'fastify';
import { createHash } from 'crypto';
import { getClient, query } from '../db/client';
import { Memory, Comment, MemorySearchParams, SearchMode, CompactMemory, TagRef } from '../types';
import { resolveProject } from './projects';
import { generateExcerpt } from '../utils/excerpt';
import { isUuid, isPartialUuid, resolvePartialMemoryId } from '../utils/uuid';
import {
  checkGoogleStatus,
  fetchGoogleDoc,
  fetchDocComments,
  findAnchorContext,
  GoogleComment,
  parseGoogleDocId,
  localizeDocImages,
  deleteMemoryFiles,
} from '../services/google';
import { getCurrentSnapshot } from '../services/snapshots';
import { buildCaseBoostPattern, normalizeWebsearchQuery } from '../utils/search-query';
import { getHiddenProjectHandles } from '../utils/hidden-projects';

function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

interface GlobalMemorySearchParams extends MemorySearchParams {
  project_id?: string; // Single UUID or comma-separated UUIDs
  project_name?: string;
  project_handle?: string;
}

const memoryRoutes: FastifyPluginAsync = async (fastify) => {
  // GET a single memory by UUID (global)
  fastify.get('/:memoryId', async (request, reply) => {
    let { memoryId } = request.params as { memoryId: string };
    const { comments: includeComments } = request.query as { comments?: string };
    if (!isUuid(memoryId)) {
      if (isPartialUuid(memoryId)) {
        const resolved = await resolvePartialMemoryId(memoryId);
        if (!resolved) {
          return reply.code(404).send({ error: 'No unique memory found for partial UUID' });
        }
        memoryId = resolved;
      } else {
        return reply.code(400).send({ error: 'memoryId must be a UUID' });
      }
    }

    const rows = await query<Memory & { type: string; parent_type?: string; parent_type_id?: string; status?: string; project_handle: string; project_name: string }>(
      `SELECT m.id, m.project_id, m.handle, m.title, m.content, m.memory_type_id, m.status_id,
              m.status_updated_at, m.created_at, m.updated_at,
              mt.name as type, mt_parent.name as parent_type, mt_parent.id as parent_type_id,
              mts.status_value as status,
              p.handle as project_handle, p.display_name as project_name
       FROM memories m
       INNER JOIN memory_types mt ON m.memory_type_id = mt.id
       LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
       INNER JOIN projects p ON m.project_id = p.id
       LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE m.id = $1`,
      [memoryId]
    );

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    // Fetch all metadata for this memory
    const metadataRows = await query<{ field: string; value: string }>(
      `SELECT md.field, mm.value
       FROM memory_metadata mm
       INNER JOIN metadata md ON mm.metadata_id = md.id
       WHERE mm.memory_id = $1`,
      [memoryId]
    );
    const metadata: Record<string, string> = {};
    for (const row of metadataRows) {
      metadata[row.field] = row.value;
    }

    const memory: any = {
      ...rows[0],
      is_pinned: metadata['is-pinned'] === 'true',
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };

    if (includeComments === 'true') {
      const includeResolved = (request.query as any).include_resolved !== 'false';
      const statusFilter = includeResolved ? '' : "AND status != 'resolved'";
      memory.comments = await query<Comment>(
        `SELECT * FROM comments WHERE entity_type = 'memory' AND entity_id = $1 ${statusFilter} ORDER BY created_at ASC`,
        [memoryId]
      );
    }

    return { memory };
  });
  // Global memory search - supports cross-project search
  fastify.get('/', async (request, reply) => {
    const { type, tag, status, q, search_mode, sort, order, limit, offset, project_id, project_name, project_handle, compact, created_after, created_before, tz } = request.query as (GlobalMemorySearchParams & { handle?: string; name?: string }) & { q?: string };
    const includeHidden = (request.query as { includeHidden?: string }).includeHidden;
    // Default to UTC if no timezone provided
    const timezone = tz || 'UTC';
    const rq = request.query as any;
    const filterHandle: string | undefined = rq.handle;
    const filterName: string | undefined = rq.name;
    const pinnedFilter: string | undefined = rq.pinned;
    const mode: SearchMode = search_mode || 'all';

    // Parse pagination parameters
    const limitNum = parseInt(limit || '20', 10);
    const offsetNum = parseInt(offset || '0', 10);

    // Sorting parameters
    const isSearching = !!(q && q.trim());
    const sortKey = ((): 'relevance' | 'updated_at' | 'created_at' | 'title' => {
      if (isSearching) return (sort as any) || 'relevance';
      return (sort as any) || 'updated_at';
    })();
    const orderKey = ((): 'asc' | 'desc' => {
      if (sortKey === 'relevance') return 'desc'; // ignored in ORDER BY selection below
      if (!order) {
        if (sortKey === 'title') return 'asc';
        return 'desc';
      }
      return (order.toLowerCase() === 'asc' ? 'asc' : 'desc');
    })();

    // Resolve project if provided (UUID-only for project_id; name/handle via dedicated params)
    // project_id supports comma-separated UUIDs for multi-project filtering
    let resolvedProjectIds: string[] | undefined;
    if (project_id) {
      const ids = project_id.split(',').map(id => id.trim()).filter(Boolean);
      for (const id of ids) {
        if (!isUuid(id)) {
          return reply.code(400).send({ error: 'project_id must be a UUID' });
        }
      }
      resolvedProjectIds = ids;
    } else if (project_handle) {
      const projects = await query<{ id: string }>('SELECT id FROM projects WHERE handle = $1', [project_handle.toLowerCase()]);
      if (projects.length === 0) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      resolvedProjectIds = [projects[0].id];
    } else if (project_name) {
      const projects = await query<{ id: string }>('SELECT id FROM projects WHERE LOWER(name) = LOWER($1)', [project_name]);
      if (projects.length === 0) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      resolvedProjectIds = [projects[0].id];
    }

    // Resolve hidden project IDs once (used in both search and non-search paths)
    let hiddenProjectIds: string[] = [];
    if (includeHidden !== 'true') {
      const hiddenHandles = await getHiddenProjectHandles();
      if (hiddenHandles.length > 0) {
        const rows = await query<{ id: string }>(
          'SELECT id FROM projects WHERE handle = ANY($1)',
          [hiddenHandles]
        );
        hiddenProjectIds = rows.map(r => r.id);
      }
    }

    let sql: string;
    const params: any[] = [];

    // If search query is provided, use full-text search
    if (q && q.trim()) {
      // Rewrite literal `NOT word` to `-word` so websearch_to_tsquery honors it.
      const searchText = normalizeWebsearchQuery(q);
      // Build search conditions for CTE
      const searchConditions: string[] = [];
      let paramIndex = 1;

      // Optional project filter (supports multiple project IDs)
      if (resolvedProjectIds && resolvedProjectIds.length > 0) {
        searchConditions.push(`m.project_id = ANY($${paramIndex})`);
        params.push(resolvedProjectIds);
        paramIndex++;
      }

      // Exclude memories from hidden projects
      if (hiddenProjectIds.length > 0) {
        searchConditions.push(`m.project_id <> ALL($${paramIndex})`);
        params.push(hiddenProjectIds);
        paramIndex++;
      }

      let memoryTypeId: string | undefined;

      // Convert type name to memory_type_id for filtering
      if (type) {
        const typeResult = await query<{ id: string; is_parent_type: boolean }>(
          'SELECT id, is_parent_type FROM memory_types WHERE name = $1',
          [type]
        );
        if (typeResult.length === 0) {
          return reply.code(400).send({ error: `Invalid memory type: ${type}` });
        }

        memoryTypeId = typeResult[0].id;
        if (typeResult[0].is_parent_type) {
          const familyResult = await query<{ id: string }>(
            'SELECT id FROM memory_types WHERE id = $1 OR parent_id = $1',
            [memoryTypeId]
          );
          const familyIds = familyResult.map(r => r.id);
          searchConditions.push(`m.memory_type_id = ANY($${paramIndex})`);
          params.push(familyIds);
          paramIndex++;
        } else {
          searchConditions.push(`m.memory_type_id = $${paramIndex}`);
          params.push(memoryTypeId);
          paramIndex++;
        }
      }

      // Convert status value to status_id for filtering
      if (status) {
        // Need memory type to look up correct status
        if (!memoryTypeId && !type) {
          return reply.code(400).send({ error: 'type is required when filtering by status' });
        }

        if (memoryTypeId) {
          const statusResult = await query<{ id: string }>(
            `SELECT mts.id FROM memory_type_statuses mts
             WHERE mts.status_value = $1
               AND (mts.memory_type_id = $2
                    OR mts.memory_type_id = (SELECT parent_id FROM memory_types WHERE id = $2))
             LIMIT 1`,
            [status, memoryTypeId]
          );
          if (statusResult.length === 0) {
            return reply.code(400).send({ error: `Invalid status '${status}' for memory type '${type}'` });
          }
          searchConditions.push(`m.status_id = $${paramIndex}`);
          params.push(statusResult[0].id);
          paramIndex++;
        }
      }

      // Date filtering (convert UTC to user's timezone for comparison)
      if (created_after) {
        searchConditions.push(`(m.created_at AT TIME ZONE $${paramIndex})::date >= $${paramIndex + 1}::date`);
        params.push(timezone, created_after);
        paramIndex += 2;
      }
      if (created_before) {
        searchConditions.push(`(m.created_at AT TIME ZONE $${paramIndex})::date <= $${paramIndex + 1}::date`);
        params.push(timezone, created_before);
        paramIndex += 2;
      }

      // Pinned filter for search path
      if (pinnedFilter === 'true') {
        searchConditions.push(`EXISTS (SELECT 1 FROM memory_metadata mm_pin JOIN metadata md_pin ON mm_pin.metadata_id = md_pin.id WHERE mm_pin.memory_id = m.id AND md_pin.field = 'is-pinned' AND mm_pin.value = 'true')`);
      } else if (pinnedFilter === 'false') {
        searchConditions.push(`NOT EXISTS (SELECT 1 FROM memory_metadata mm_pin JOIN metadata md_pin ON mm_pin.metadata_id = md_pin.id WHERE mm_pin.memory_id = m.id AND md_pin.field = 'is-pinned' AND mm_pin.value = 'true')`);
      }

      const searchWhereClause = searchConditions.length > 0 ? searchConditions.join(' AND ') + ' AND ' : '';

      // Push q parameter (used for tsquery and tag LIKE)
      params.push(searchText);
      const searchParamIndex = paramIndex;
      const searchQuery = `websearch_to_tsquery('english', $${searchParamIndex})`;
      const tagSearchPattern = `$${searchParamIndex}`;

      // Case-sensitive boost: when the user's query contains uppercase tokens,
      // multiply the rank for rows whose title/content/handle contains those
      // tokens with exact case. Preserves existing behavior for all-lowercase
      // queries (no regex push, no boost).
      const casePattern = buildCaseBoostPattern(searchText);
      let caseBoostParamIndex: number | null = null;
      if (casePattern) {
        params.push(casePattern);
        caseBoostParamIndex = params.length;
      }
      const caseBoostExpr = caseBoostParamIndex
        ? `* CASE WHEN (coalesce(m.title,'') ~ $${caseBoostParamIndex}
                       OR m.content ~ $${caseBoostParamIndex}
                       OR coalesce(m.handle,'') ~ $${caseBoostParamIndex})
                  THEN 1.3 ELSE 1.0 END`
        : '';

      // Title starts-with bonus: when the first alphanumeric token of the query
      // (>= 3 chars) matches the start of a memory's title, add a flat boost.
      // Handles common "Decision: X" / "Bug: Y" prefixed titles that otherwise
      // lose to content-dense matches under ts_rank_cd.
      const firstToken = (searchText.match(/[A-Za-z0-9]+/)?.[0] ?? '').toLowerCase();
      let titlePrefixParamIndex: number | null = null;
      if (firstToken.length >= 3) {
        params.push(firstToken + '%');
        titlePrefixParamIndex = params.length;
      }
      const titleBonusExpr = titlePrefixParamIndex
        ? `+ CASE WHEN LOWER(coalesce(m.title,'')) LIKE $${titlePrefixParamIndex} THEN 0.3 ELSE 0 END`
        : '';

      // Build matching_memories CTE based on search mode
      const cteUnions: string[] = [];

      if (mode === 'all' || mode === 'content') {
        // Matches in memories.title (heavier weight)
        cteUnions.push(`
          SELECT DISTINCT m.id, ts_rank_cd(to_tsvector('english', coalesce(m.title,'')), ${searchQuery}) * 3.0 AS rank
          FROM memories m
          WHERE ${searchWhereClause} to_tsvector('english', coalesce(m.title,'')) @@ ${searchQuery}
        `);
        // Matches in memories.content
        cteUnions.push(`
          SELECT DISTINCT m.id, ts_rank_cd(m.content_tsv, ${searchQuery}) * 1.0 AS rank
          FROM memories m
          WHERE ${searchWhereClause} m.content_tsv @@ ${searchQuery}
        `);
        // Matches in memory_chunks.content (slightly lower)
        cteUnions.push(`
          SELECT DISTINCT mc.memory_id AS id, ts_rank_cd(mc.content_tsv, ${searchQuery}) * 0.8 AS rank
          FROM memory_chunks mc
          INNER JOIN memories m ON mc.memory_id = m.id
          WHERE ${searchWhereClause} mc.content_tsv @@ ${searchQuery}
        `);
      }

      if (mode === 'all' || mode === 'tags') {
        // Matches in tag names (case-insensitive partial match)
        cteUnions.push(`
          SELECT DISTINCT m.id, 0.05 AS rank
          FROM memories m
          INNER JOIN memory_tags mta ON m.id = mta.memory_id
          INNER JOIN tags t ON mta.tag_id = t.id
          WHERE ${searchWhereClause}LOWER(t.name) LIKE '%' || LOWER(${tagSearchPattern}) || '%'
        `);
      }

      sql = `
        WITH matching_memories AS (
          ${cteUnions.join(' UNION ')}
        )
        SELECT
          m.id, m.project_id, m.handle, m.title, m.content, m.memory_type_id, m.status_id,
          m.status_updated_at, m.created_at, m.updated_at,
          mt.name as type,
          mt_parent.name as parent_type,
          mt_parent.id as parent_type_id,
          mts.status_value as status,
          p.handle as project_handle,
          p.display_name as project_name,
          (MAX(mm.rank) ${caseBoostExpr} ${titleBonusExpr}) AS search_rank,
          COUNT(*) OVER() AS total_count,
          (SELECT mm_p.value FROM memory_metadata mm_p JOIN metadata md_p ON mm_p.metadata_id = md_p.id WHERE mm_p.memory_id = m.id AND md_p.field = 'is-pinned') AS is_pinned_raw,
          EXISTS(SELECT 1 FROM memory_metadata mm_s JOIN metadata md_s ON mm_s.metadata_id = md_s.id WHERE mm_s.memory_id = m.id AND md_s.field = 'seed-path') AS is_seeded_raw
        FROM memories m
        INNER JOIN matching_memories mm ON m.id = mm.id
        INNER JOIN memory_types mt ON m.memory_type_id = mt.id
        LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
        INNER JOIN projects p ON m.project_id = p.id
        LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
      `;

      // Add tag filter if present
      if (tag) {
        sql += `
          INNER JOIN memory_tags mta ON m.id = mta.memory_id
          INNER JOIN tags t ON mta.tag_id = t.id
          WHERE t.name = $${params.length + 1}
        `;
        params.push(tag);
      }

      // Add handle/title filters if present
      if (!tag) {
        const extras: string[] = [];
        if (filterHandle) {
          extras.push(`m.handle = $${params.length + 1}`);
          params.push(filterHandle);
        }
        if (filterName) {
          extras.push(`m.title = $${params.length + 1}`);
          params.push(filterName);
        }
        if (extras.length) {
          sql += (/\n\s*WHERE\s/i.test(sql) ? ' AND ' : ' WHERE ') + extras.join(' AND ');
        }
      }

      sql += `
        GROUP BY m.id, m.project_id, m.handle, m.title, m.content, m.memory_type_id, m.status_id,
                 m.status_updated_at, m.created_at, m.updated_at, mt.name, mt_parent.name, mt_parent.id, mts.status_value,
                 p.handle, p.display_name
        ${sortKey === 'relevance'
          ? `ORDER BY search_rank DESC, m.updated_at DESC, m.id ASC`
          : sortKey === 'updated_at'
            ? `ORDER BY m.updated_at ${orderKey.toUpperCase()}, m.id ASC`
            : sortKey === 'created_at'
              ? `ORDER BY m.created_at ${orderKey.toUpperCase()}, m.id ASC`
              : `ORDER BY m.title ${orderKey.toUpperCase()}, m.id ASC`}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
      params.push(limitNum, offsetNum);
    } else {
      // No search - use regular query with pagination
      const conditions: string[] = [];
      let memoryTypeId: string | undefined;

      if (tag) {
        conditions.push(`EXISTS (
          SELECT 1 FROM memory_tags mt
          INNER JOIN tags t ON mt.tag_id = t.id
          WHERE mt.memory_id = m.id AND t.name = $${params.length + 1}
        )`);
        params.push(tag);
      }

      // Optional project filter (supports multiple project IDs)
      if (resolvedProjectIds && resolvedProjectIds.length > 0) {
        conditions.push(`m.project_id = ANY($${params.length + 1})`);
        params.push(resolvedProjectIds);
      }

      // Exclude memories from hidden projects
      if (hiddenProjectIds.length > 0) {
        conditions.push(`m.project_id <> ALL($${params.length + 1})`);
        params.push(hiddenProjectIds);
      }

      if (filterHandle) {
        conditions.push(`m.handle = $${params.length + 1}`);
        params.push(filterHandle);
      }
      if (filterName) {
        conditions.push(`m.title = $${params.length + 1}`);
        params.push(filterName);
      }

      // Convert type name to memory_type_id for filtering
      if (type) {
        const typeResult = await query<{ id: string; is_parent_type: boolean }>(
          'SELECT id, is_parent_type FROM memory_types WHERE name = $1',
          [type]
        );
        if (typeResult.length === 0) {
          return reply.code(400).send({ error: `Invalid memory type: ${type}` });
        }

        memoryTypeId = typeResult[0].id;
        if (typeResult[0].is_parent_type) {
          const familyResult = await query<{ id: string }>(
            'SELECT id FROM memory_types WHERE id = $1 OR parent_id = $1',
            [memoryTypeId]
          );
          const familyIds = familyResult.map(r => r.id);
          conditions.push(`m.memory_type_id = ANY($${params.length + 1})`);
          params.push(familyIds);
        } else {
          conditions.push(`m.memory_type_id = $${params.length + 1}`);
          params.push(memoryTypeId);
        }
      }

      // Convert status value to status_id for filtering
      if (status) {
        // Need memory type to look up correct status
        if (!memoryTypeId && !type) {
          return reply.code(400).send({ error: 'type is required when filtering by status' });
        }

        if (memoryTypeId) {
          const statusResult = await query<{ id: string }>(
            `SELECT mts.id FROM memory_type_statuses mts
             WHERE mts.status_value = $1
               AND (mts.memory_type_id = $2
                    OR mts.memory_type_id = (SELECT parent_id FROM memory_types WHERE id = $2))
             LIMIT 1`,
            [status, memoryTypeId]
          );
          if (statusResult.length === 0) {
            return reply.code(400).send({ error: `Invalid status '${status}' for memory type '${type}'` });
          }
          conditions.push(`m.status_id = $${params.length + 1}`);
          params.push(statusResult[0].id);
        }
      }

      // Date filtering (convert UTC to user's timezone for comparison)
      if (created_after) {
        conditions.push(`(m.created_at AT TIME ZONE $${params.length + 1})::date >= $${params.length + 2}::date`);
        params.push(timezone, created_after);
      }
      if (created_before) {
        conditions.push(`(m.created_at AT TIME ZONE $${params.length + 1})::date <= $${params.length + 2}::date`);
        params.push(timezone, created_before);
      }

      // Pinned filter for non-search path
      if (pinnedFilter === 'true') {
        conditions.push(`EXISTS (SELECT 1 FROM memory_metadata mm_pin JOIN metadata md_pin ON mm_pin.metadata_id = md_pin.id WHERE mm_pin.memory_id = m.id AND md_pin.field = 'is-pinned' AND mm_pin.value = 'true')`);
      } else if (pinnedFilter === 'false') {
        conditions.push(`NOT EXISTS (SELECT 1 FROM memory_metadata mm_pin JOIN metadata md_pin ON mm_pin.metadata_id = md_pin.id WHERE mm_pin.memory_id = m.id AND md_pin.field = 'is-pinned' AND mm_pin.value = 'true')`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      sql = `
        WITH total AS (
          SELECT COUNT(*) as cnt
          FROM memories m
          INNER JOIN memory_types mt ON m.memory_type_id = mt.id
          LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
          ${whereClause}
        )
        SELECT m.id, m.project_id, m.handle, m.title, m.content, m.memory_type_id, m.status_id,
               m.status_updated_at, m.created_at, m.updated_at,
               mt.name as type, mt_parent.name as parent_type, mt_parent.id as parent_type_id,
               mts.status_value as status,
               p.handle as project_handle, p.display_name as project_name,
               t.cnt::text AS total_count,
               (SELECT mm_p.value FROM memory_metadata mm_p JOIN metadata md_p ON mm_p.metadata_id = md_p.id WHERE mm_p.memory_id = m.id AND md_p.field = 'is-pinned') AS is_pinned_raw,
          EXISTS(SELECT 1 FROM memory_metadata mm_s JOIN metadata md_s ON mm_s.metadata_id = md_s.id WHERE mm_s.memory_id = m.id AND md_s.field = 'seed-path') AS is_seeded_raw
        FROM memories m
        INNER JOIN memory_types mt ON m.memory_type_id = mt.id
        LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
        INNER JOIN projects p ON m.project_id = p.id
        LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
        CROSS JOIN total t
        ${whereClause}
        ${sortKey === 'updated_at'
          ? `ORDER BY m.updated_at ${orderKey.toUpperCase()}, m.id ASC`
          : sortKey === 'created_at'
            ? `ORDER BY m.created_at ${orderKey.toUpperCase()}, m.id ASC`
            : sortKey === 'title'
              ? `ORDER BY m.title ${orderKey.toUpperCase()}, m.id ASC`
              : `ORDER BY m.updated_at DESC, m.id ASC`}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
      params.push(limitNum, offsetNum);
    }

    let results = await query<Memory & { total_count: string; project_handle: string; project_name: string; type: string; parent_type?: string; parent_type_id?: string; status: string; search_rank?: number; is_pinned_raw?: string; is_seeded_raw?: boolean }>(sql, params);

    let totalCount = 0;
    if (results.length > 0) {
      totalCount = parseInt(results[0].total_count, 10);
    } else if (q && q.trim()) {
      // Count for search query when no results
      const searchText = normalizeWebsearchQuery(q);
      const countConditions: string[] = [];
      const countParams: any[] = [];
      let countParamIndex = 1;

      if (resolvedProjectIds && resolvedProjectIds.length > 0) {
        countConditions.push(`m.project_id = ANY($${countParamIndex})`);
        countParams.push(resolvedProjectIds);
        countParamIndex++;
      }

      if (hiddenProjectIds.length > 0) {
        countConditions.push(`m.project_id <> ALL($${countParamIndex})`);
        countParams.push(hiddenProjectIds);
        countParamIndex++;
      }

      let countMemoryTypeId: string | undefined;
      if (type) {
        const typeResult = await query<{ id: string; is_parent_type: boolean }>(
          'SELECT id, is_parent_type FROM memory_types WHERE name = $1',
          [type]
        );
        if (typeResult.length > 0) {
          countMemoryTypeId = typeResult[0].id;
          if (typeResult[0].is_parent_type) {
            const familyResult = await query<{ id: string }>(
              'SELECT id FROM memory_types WHERE id = $1 OR parent_id = $1',
              [countMemoryTypeId]
            );
            const familyIds = familyResult.map(r => r.id);
            countConditions.push(`m.memory_type_id = ANY($${countParamIndex})`);
            countParams.push(familyIds);
            countParamIndex++;
          } else {
            countConditions.push(`m.memory_type_id = $${countParamIndex}`);
            countParams.push(countMemoryTypeId);
            countParamIndex++;
          }
        }
      }

      if (status && countMemoryTypeId) {
        const statusResult = await query<{ id: string }>(
          'SELECT id FROM memory_type_statuses WHERE status_value = $1 AND memory_type_id = $2',
          [status, countMemoryTypeId]
        );
        if (statusResult.length > 0) {
          countConditions.push(`m.status_id = $${countParamIndex}`);
          countParams.push(statusResult[0].id);
          countParamIndex++;
        }
      }

      // Date filtering for count (convert UTC to user's timezone for comparison)
      if (created_after) {
        countConditions.push(`(m.created_at AT TIME ZONE $${countParamIndex})::date >= $${countParamIndex + 1}::date`);
        countParams.push(timezone, created_after);
        countParamIndex += 2;
      }
      if (created_before) {
        countConditions.push(`(m.created_at AT TIME ZONE $${countParamIndex})::date <= $${countParamIndex + 1}::date`);
        countParams.push(timezone, created_before);
        countParamIndex += 2;
      }

      countParams.push(searchText);
      const countWhereClause = countConditions.length > 0 ? countConditions.join(' AND ') + ' AND ' : '';

      // Build count unions based on mode
      const countUnions: string[] = [];

      if (mode === 'all' || mode === 'content') {
        countUnions.push(`
          SELECT m.id as memory_id
          FROM memories m
          WHERE ${countWhereClause}m.content_tsv @@ websearch_to_tsquery('english', $${countParamIndex})
        `);
        countUnions.push(`
          SELECT mc.memory_id
          FROM memory_chunks mc
          INNER JOIN memories m ON mc.memory_id = m.id
          WHERE ${countWhereClause}mc.content_tsv @@ websearch_to_tsquery('english', $${countParamIndex})
        `);
      }

      if (mode === 'all' || mode === 'tags') {
        countUnions.push(`
          SELECT m.id as memory_id
          FROM memories m
          INNER JOIN memory_tags mta ON m.id = mta.memory_id
          INNER JOIN tags t ON mta.tag_id = t.id
          WHERE ${countWhereClause}LOWER(t.name) LIKE '%' || LOWER($${countParamIndex}) || '%'
        `);
      }

      const countSql = `
        SELECT COUNT(DISTINCT memory_id) as cnt FROM (
          ${countUnions.join(' UNION ')}
        ) matches
      `;

      const countResult = await query<{ cnt: string }>(countSql, countParams);
      totalCount = countResult.length > 0 ? parseInt(countResult[0].cnt, 10) : 0;
      // If no strict results, attempt fallback: any-of top terms with prefix match
      if (totalCount === 0) {
        const tokens = String(q)
          .split(/\s+/)
          .map(t => t.toLowerCase().replace(/[^a-z0-9]+/g, ''))
          .filter(t => t.length >= 3)
          .slice(0, 5);
        if (tokens.length > 0) {
          // Rebuild fallback query
          const fbParams: any[] = [];
          const searchConditions: string[] = [];
          let paramIndex = 1;
          if (resolvedProjectIds && resolvedProjectIds.length > 0) { searchConditions.push(`m.project_id = ANY($${paramIndex})`); fbParams.push(resolvedProjectIds); paramIndex++; }

          let memoryTypeIdFb: string | undefined;
          if (type) {
            const typeResult = await query<{ id: string }>('SELECT id FROM memory_types WHERE name = $1', [type]);
            if (typeResult.length === 0) { return reply.code(400).send({ error: `Invalid memory type: ${type}` }); }
            memoryTypeIdFb = typeResult[0].id;
            searchConditions.push(`m.memory_type_id = $${paramIndex}`);
            fbParams.push(memoryTypeIdFb);
            paramIndex++;
          }
          if (status) {
            if (!memoryTypeIdFb && !type) { return reply.code(400).send({ error: 'type is required when filtering by status' }); }
            const statusResult = await query<{ id: string }>('SELECT id FROM memory_type_statuses WHERE status_value = $1 AND memory_type_id = $2', [status, memoryTypeIdFb]);
            if (statusResult.length === 0) { return reply.code(400).send({ error: `Invalid status '${status}' for memory type '${type}'` }); }
            searchConditions.push(`m.status_id = $${paramIndex}`);
            fbParams.push(statusResult[0].id);
            paramIndex++;
          }

          const searchWhereClause = searchConditions.length > 0 ? searchConditions.join(' AND ') + ' AND ' : '';
          const tsq = tokens.map(t => `${t}:*`).join(' | ');
          fbParams.push(tsq);
          const fbParamIndex = paramIndex;
          const fbQuery = `to_tsquery('english', $${fbParamIndex})`;

          const fbCtes: string[] = [];
          if (mode === 'all' || mode === 'content') {
            fbCtes.push(`
              SELECT DISTINCT m.id, ts_rank_cd(to_tsvector('english', coalesce(m.title,'')), ${fbQuery}) * 3.0 * 0.6 AS rank
              FROM memories m
              WHERE ${searchWhereClause} to_tsvector('english', coalesce(m.title,'')) @@ ${fbQuery}
            `);
            fbCtes.push(`
              SELECT DISTINCT m.id, ts_rank_cd(m.content_tsv, ${fbQuery}) * 1.0 * 0.6 AS rank
              FROM memories m
              WHERE ${searchWhereClause} m.content_tsv @@ ${fbQuery}
            `);
            fbCtes.push(`
              SELECT DISTINCT mc.memory_id AS id, ts_rank_cd(mc.content_tsv, ${fbQuery}) * 0.8 * 0.6 AS rank
              FROM memory_chunks mc
              INNER JOIN memories m ON mc.memory_id = m.id
              WHERE ${searchWhereClause} mc.content_tsv @@ ${fbQuery}
            `);
          }
          // Tag fallback: match any term as a whole word prefix in tag names (still lower weight)
          const tagConditions = tokens.map((_, i) => `LOWER(t.name) LIKE LOWER($${fbParamIndex + 1 + i})`).join(' OR ');
          tokens.forEach(tok => fbParams.push(`${tok}%`));
          if (mode === 'all' || mode === 'tags') {
            fbCtes.push(`
              SELECT DISTINCT m.id, 0.05 AS rank
              FROM memories m
              INNER JOIN memory_tags mta ON m.id = mta.memory_id
              INNER JOIN tags t ON mta.tag_id = t.id
              WHERE ${searchWhereClause} (${tagConditions})
            `);
          }

          // Title starts-with bonus for the fallback path. Pushed after the
          // tag-LIKE tokens so their positional indices remain stable.
          const firstTokenFb = (tokens[0] ?? '').toLowerCase();
          let titlePrefixFbParamIndex: number | null = null;
          if (firstTokenFb.length >= 3) {
            fbParams.push(firstTokenFb + '%');
            titlePrefixFbParamIndex = fbParams.length;
          }
          const titleBonusFbExpr = titlePrefixFbParamIndex
            ? `+ CASE WHEN LOWER(coalesce(m.title,'')) LIKE $${titlePrefixFbParamIndex} THEN 0.3 ELSE 0 END`
            : '';

          let fbSql = `
            WITH matching_memories AS (
              ${fbCtes.join(' UNION ')}
            )
            SELECT
              m.id, m.project_id, m.handle, m.title, m.content, m.memory_type_id, m.status_id,
              m.status_updated_at, m.created_at, m.updated_at,
              mt.name as type,
              mt_parent.name as parent_type,
              mt_parent.id as parent_type_id,
              mts.status_value as status,
              p.handle as project_handle,
              p.display_name as project_name,
              (MAX(mm.rank) ${titleBonusFbExpr}) AS search_rank,
              COUNT(*) OVER() AS total_count
            FROM memories m
            INNER JOIN matching_memories mm ON m.id = mm.id
            INNER JOIN memory_types mt ON m.memory_type_id = mt.id
            LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
            INNER JOIN projects p ON m.project_id = p.id
            LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
          `;
          if (tag) {
            fbSql += `
              INNER JOIN memory_tags mta ON m.id = mta.memory_id
              INNER JOIN tags t ON mta.tag_id = t.id
              WHERE t.name = $${fbParams.length + 1}
            `;
            fbParams.push(tag);
          }
          if (!tag) {
            const extras: string[] = [];
            if (filterHandle) { extras.push(`m.handle = $${fbParams.length + 1}`); fbParams.push(filterHandle); }
            if (filterName) { extras.push(`m.title = $${fbParams.length + 1}`); fbParams.push(filterName); }
            if (extras.length) { fbSql += (/\n\s*WHERE\s/i.test(fbSql) ? ' AND ' : ' WHERE ') + extras.join(' AND '); }
          }
          fbSql += `
            GROUP BY m.id, m.project_id, m.handle, m.title, m.content, m.memory_type_id, m.status_id,
                     m.status_updated_at, m.created_at, m.updated_at, mt.name, mt_parent.name, mt_parent.id, mts.status_value,
                     p.handle, p.display_name
            ORDER BY search_rank DESC, m.updated_at DESC, m.id ASC
            LIMIT $${fbParams.length + 1} OFFSET $${fbParams.length + 2}
          `;
          fbParams.push(limitNum, offsetNum);
          results = await query<Memory & { total_count: string; project_handle: string; project_name: string; type: string; status: string; search_rank?: number }>(fbSql, fbParams);
          totalCount = results.length > 0 ? parseInt(results[0].total_count, 10) : 0;
        }
      }
    } else {
      // Count for regular query when no results
      const countConditions: string[] = [];
      const countParams: any[] = [];

      if (tag) {
        countConditions.push(`EXISTS (
          SELECT 1 FROM memory_tags mt
          INNER JOIN tags t ON mt.tag_id = t.id
          WHERE mt.memory_id = m.id AND t.name = $${countParams.length + 1}
        )`);
        countParams.push(tag);
      }

      if (resolvedProjectIds && resolvedProjectIds.length > 0) {
        countConditions.push(`m.project_id = ANY($${countParams.length + 1})`);
        countParams.push(resolvedProjectIds);
      }

      let countMemoryTypeId: string | undefined;
      if (type) {
        const typeResult = await query<{ id: string }>(
          'SELECT id FROM memory_types WHERE name = $1',
          [type]
        );
        if (typeResult.length > 0) {
          countMemoryTypeId = typeResult[0].id;
          countConditions.push(`m.memory_type_id = $${countParams.length + 1}`);
          countParams.push(countMemoryTypeId);
        }
      }

      if (status && countMemoryTypeId) {
        const statusResult = await query<{ id: string }>(
          'SELECT id FROM memory_type_statuses WHERE status_value = $1 AND memory_type_id = $2',
          [status, countMemoryTypeId]
        );
        if (statusResult.length > 0) {
          countConditions.push(`m.status_id = $${countParams.length + 1}`);
          countParams.push(statusResult[0].id);
        }
      }

      // Date filtering for count (convert UTC to user's timezone for comparison)
      if (created_after) {
        countConditions.push(`(m.created_at AT TIME ZONE $${countParams.length + 1})::date >= $${countParams.length + 2}::date`);
        countParams.push(timezone, created_after);
      }
      if (created_before) {
        countConditions.push(`(m.created_at AT TIME ZONE $${countParams.length + 1})::date <= $${countParams.length + 2}::date`);
        countParams.push(timezone, created_before);
      }

      const countWhereClause = countConditions.length > 0 ? `WHERE ${countConditions.join(' AND ')}` : '';
      const countSql = `SELECT COUNT(*) as cnt FROM memories m ${countWhereClause}`;

      const countResult = await query<{ cnt: string }>(countSql, countParams);
      totalCount = countResult.length > 0 ? parseInt(countResult[0].cnt, 10) : 0;
    }

    const isCompact = compact === 'true';

    if (isCompact) {
      // Fetch tags for all memories in one query
      const memoryIds = results.map(r => r.id);
      const tagsMap = new Map<string, TagRef[]>();

      if (memoryIds.length > 0) {
        const tagResults = await query<{ memory_id: string; tag_id: string; name: string }>(
          `SELECT mt.memory_id, t.id as tag_id, t.name
           FROM memory_tags mt
           INNER JOIN tags t ON mt.tag_id = t.id
           WHERE mt.memory_id = ANY($1)`,
          [memoryIds]
        );

        for (const { memory_id, tag_id, name } of tagResults) {
          if (!tagsMap.has(memory_id)) {
            tagsMap.set(memory_id, []);
          }
          tagsMap.get(memory_id)!.push({ id: tag_id, name });
        }
      }

      const compactMemories: CompactMemory[] = results.map(({ total_count, project_handle, project_name, search_rank, is_pinned_raw, is_seeded_raw, ...memory }) => ({
        id: memory.id,
        project_id: memory.project_id,
        project_handle,
        project_name,
        handle: memory.handle,
        title: memory.title,
        type: memory.type as CompactMemory['type'],
        memory_type_id: memory.memory_type_id,
        ...(memory.parent_type ? { parent_type: memory.parent_type } : {}),
        ...(memory.parent_type_id ? { parent_type_id: memory.parent_type_id } : {}),
        status: memory.status,
        tags: tagsMap.get(memory.id) || [],
        is_pinned: is_pinned_raw === 'true',
        is_seeded: is_seeded_raw === true,
        updated_at: memory.updated_at,
        content_excerpt: generateExcerpt(memory.content),
        ...(isSearching && search_rank !== undefined ? { score: search_rank } : {})
      }));

      return {
        memories: compactMemories,
        pagination: {
          total_count: totalCount,
          limit: limitNum,
          offset: offsetNum,
          has_more: offsetNum + limitNum < totalCount
        }
      };
    }

    const nonCompactMemoryIds = results.map(r => r.id);
    const metadataMap = new Map<string, Record<string, string>>();
    if (nonCompactMemoryIds.length > 0) {
      const metaRows = await query<{ memory_id: string; field: string; value: string }>(
        `SELECT mm.memory_id, md.field, mm.value
         FROM memory_metadata mm
         INNER JOIN metadata md ON mm.metadata_id = md.id
         WHERE mm.memory_id = ANY($1)`,
        [nonCompactMemoryIds]
      );
      for (const { memory_id, field, value } of metaRows) {
        if (!metadataMap.has(memory_id)) metadataMap.set(memory_id, {});
        metadataMap.get(memory_id)![field] = value;
      }
    }

    const memories = results.map(({ total_count, project_handle, project_name, parent_type, parent_type_id, is_pinned_raw, is_seeded_raw, ...memory }) => {
      const meta = metadataMap.get(memory.id);
      return {
        ...memory,
        ...(parent_type ? { parent_type } : {}),
        ...(parent_type_id ? { parent_type_id } : {}),
        is_pinned: is_pinned_raw === 'true',
        is_seeded: is_seeded_raw === true,
        project: {
          id: memory.project_id,
          handle: project_handle,
          name: project_name
        },
        ...(meta && Object.keys(meta).length > 0 ? { metadata: meta } : {}),
      };
    });

    return {
      memories,
      pagination: {
        total_count: totalCount,
        limit: limitNum,
        offset: offsetNum,
        has_more: offsetNum + limitNum < totalCount
      }
    };
  });

  // GET /api/memories/:memoryId/metadata - list all metadata for a memory
  fastify.get('/:memoryId/metadata', async (request, reply) => {
    const { memoryId } = request.params as { memoryId: string };
    if (!isUuid(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    // Verify memory exists
    const [memory] = await query<{ id: string }>('SELECT id FROM memories WHERE id = $1', [memoryId]);
    if (!memory) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    const rows = await query<{ field: string; value: string; value_type: string; description: string }>(
      `SELECT md.field, mm.value, md.value_type, md.description
       FROM memory_metadata mm
       JOIN metadata md ON mm.metadata_id = md.id
       WHERE mm.memory_id = $1
       ORDER BY md.field`,
      [memoryId]
    );

    return { metadata: rows };
  });

  // PUT /api/memories/:memoryId/metadata/:field - set a metadata value
  fastify.put('/:memoryId/metadata/:field', async (request, reply) => {
    const { memoryId, field } = request.params as { memoryId: string; field: string };
    const { value } = request.body as { value: string };

    if (!isUuid(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    if (value === undefined || value === null) {
      return reply.code(400).send({ error: 'value is required' });
    }

    // Verify memory exists
    const [memory] = await query<{ id: string }>('SELECT id FROM memories WHERE id = $1', [memoryId]);
    if (!memory) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    // Get or verify metadata field definition
    const [metadataDef] = await query<{ id: string; value_type: string }>(
      `SELECT id, value_type FROM metadata WHERE entity_type = 'memory' AND field = $1`,
      [field]
    );

    if (!metadataDef) {
      return reply.code(404).send({ error: `Metadata field '${field}' not defined for memories` });
    }

    // Upsert the value
    await query(
      `INSERT INTO memory_metadata (memory_id, metadata_id, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (memory_id, metadata_id)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [memoryId, metadataDef.id, String(value)]
    );

    return {
      field,
      value: String(value),
      value_type: metadataDef.value_type
    };
  });

  // DELETE /api/memories/:memoryId/metadata/:field - remove a metadata value
  fastify.delete('/:memoryId/metadata/:field', async (request, reply) => {
    const { memoryId, field } = request.params as { memoryId: string; field: string };

    if (!isUuid(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    // Verify memory exists
    const [memory] = await query<{ id: string }>('SELECT id FROM memories WHERE id = $1', [memoryId]);
    if (!memory) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    // Get metadata field definition
    const [metadataDef] = await query<{ id: string }>(
      `SELECT id FROM metadata WHERE entity_type = 'memory' AND field = $1`,
      [field]
    );

    if (!metadataDef) {
      return reply.code(404).send({ error: `Metadata field '${field}' not defined for memories` });
    }

    const result = await query(
      `DELETE FROM memory_metadata WHERE memory_id = $1 AND metadata_id = $2`,
      [memoryId, metadataDef.id]
    );

    return reply.code(204).send();
  });

  // POST /api/memories/:memoryId/sync-external - Re-fetch from external source and update
  fastify.post('/:memoryId/sync-external', async (request, reply) => {
    const { memoryId } = request.params as { memoryId: string };
    const { mode } = request.query as { mode?: 'update' | 'snapshot' };
    const { includeComments = true } = request.body as { includeComments?: boolean } || {};
    const syncMode = mode || 'update';

    if (!isUuid(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    // Get memory with external source metadata and project handle
    const memoryResult = await query<{
      id: string;
      project_id: string;
      project_handle: string;
      handle: string;
      title: string;
      content: string;
    }>(
      `SELECT m.id, m.project_id, p.handle as project_handle, m.handle, m.title, m.content
       FROM memories m
       INNER JOIN projects p ON m.project_id = p.id
       WHERE m.id = $1`,
      [memoryId]
    );

    if (memoryResult.length === 0) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    const memory = memoryResult[0];

    // Get external source metadata
    const metadataResult = await query<{ field: string; value: string }>(
      `SELECT m.field, mm.value
       FROM memory_metadata mm
       INNER JOIN metadata m ON mm.metadata_id = m.id
       WHERE mm.memory_id = $1 AND m.field LIKE 'external-source-%'`,
      [memoryId]
    );

    const metadata: Record<string, string> = {};
    for (const row of metadataResult) {
      metadata[row.field] = row.value;
    }

    const sourceType = metadata['external-source-type'];
    const sourceUrl = metadata['external-source-url'];
    let sourceId: string | undefined = metadata['external-source-id'];

    // Backfill support: older/manual/MCP-created records may have type+url but no extracted id yet.
    if (!sourceId && sourceType === 'google-doc' && sourceUrl) {
      sourceId = parseGoogleDocId(sourceUrl) || undefined;
    }

    if (!sourceType || !sourceId) {
      return reply.code(400).send({
        error: 'Memory has no external source to sync from',
      });
    }

    // Currently only Google Docs is supported
    if (sourceType !== 'google-doc') {
      return reply.code(400).send({
        error: `External source type '${sourceType}' is not supported for sync`,
      });
    }

    // Check Google availability
    const status = await checkGoogleStatus();
    if (!status.available) {
      return reply.code(503).send({
        error: 'Google integration unavailable',
        reason: status.reason,
      });
    }

    try {
      // Fetch fresh content
      const doc = await fetchGoogleDoc(sourceId);

      // Fetch comments if requested (will sync as anchored comments, not appended markdown)
      let googleComments: GoogleComment[] = [];
      if (includeComments) {
        googleComments = await fetchDocComments(sourceId);
      }

      const client = await getClient();
      const contentHash = computeContentHash(doc.content);
      try {
        await client.query('BEGIN');

        let newSnapshotNum = await getCurrentSnapshot(memoryId, client);

        if (syncMode === 'snapshot') {
          const nextNum = newSnapshotNum;

          // Fetch current comments for snapshot
          const commentsResult = await client.query<{
            id: string;
            content: string;
            anchor_text: string | null;
            anchor_prefix: string | null;
            anchor_suffix: string | null;
            status: string;
            author: string;
            parent_comment_id: string | null;
            created_at: string;
          }>(
            `SELECT id, content, anchor_text, anchor_prefix, anchor_suffix, status, author, parent_comment_id, created_at
             FROM comments WHERE entity_type = 'memory' AND entity_id = $1 ORDER BY created_at`,
            [memoryId]
          );
          const commentsSnapshotData = commentsResult.rows.length > 0 ? JSON.stringify(commentsResult.rows) : null;

          // Save current content as pre-sync snapshot (new content becomes live, no need to snapshot it separately)
          const currentHash = computeContentHash(memory.content);
          newSnapshotNum = nextNum;
          await client.query(
            `INSERT INTO memory_snapshots (memory_id, snapshot_number, content, content_hash, source, comments_snapshot)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [memoryId, newSnapshotNum, memory.content, currentHash, 'pre-sync', commentsSnapshotData]
          );

          // Update memory content (current_snapshot is computed from snapshot records)
          await client.query(
            'UPDATE memories SET content = $1, updated_at = NOW() WHERE id = $2',
            [doc.content, memoryId]
          );
        } else {
          // Update mode: just overwrite content, no versioning
          await client.query(
            'UPDATE memories SET content = $1, updated_at = NOW() WHERE id = $2',
            [doc.content, memoryId]
          );
        }

        // Update chunks if content is chunked
        await client.query('DELETE FROM memory_chunks WHERE memory_id = $1', [memoryId]);

        const CHUNK_SIZE = 2000;
        if (doc.content.length > CHUNK_SIZE) {
          let start = 0;
          let chunkIndex = 0;
          while (start < doc.content.length) {
            const chunk = doc.content.slice(start, start + CHUNK_SIZE);
            await client.query(
              'INSERT INTO memory_chunks (memory_id, chunk_index, content) VALUES ($1, $2, $3)',
              [memoryId, chunkIndex, chunk]
            );
            start += CHUNK_SIZE;
            chunkIndex++;
          }
        }

        // Update last synced timestamp
        const syncedAt = new Date().toISOString();
        if (!metadata['external-source-id']) {
          const sourceIdMetaResult = await client.query<{ id: string }>(
            "SELECT id FROM metadata WHERE entity_type = 'memory' AND field = 'external-source-id'"
          );
          if (sourceIdMetaResult.rows.length > 0) {
            await client.query(
              `INSERT INTO memory_metadata (memory_id, metadata_id, value)
               VALUES ($1, $2, $3)
               ON CONFLICT (memory_id, metadata_id) DO UPDATE SET value = $3, updated_at = NOW()`,
              [memoryId, sourceIdMetaResult.rows[0].id, sourceId]
            );
          }
        }
        const metaResult = await client.query<{ id: string }>(
          "SELECT id FROM metadata WHERE entity_type = 'memory' AND field = 'external-source-last-synced-at'"
        );
        if (metaResult.rows.length > 0) {
          await client.query(
            `INSERT INTO memory_metadata (memory_id, metadata_id, value)
             VALUES ($1, $2, $3)
             ON CONFLICT (memory_id, metadata_id) DO UPDATE SET value = $3, updated_at = NOW()`,
            [memoryId, metaResult.rows[0].id, syncedAt]
          );
        }

        // Sync comments if requested: only delete Google-imported comments, preserve local ones
        let commentsSynced = 0;
        if (includeComments && googleComments.length > 0) {
          // Delete only Google-imported comments (author contains date pattern like "Name (Jan 1, 2026)")
          // Local comments have author = 'user', 'claude-code', etc.
          await client.query(
            `DELETE FROM comments
             WHERE entity_type = 'memory' AND entity_id = $1
             AND author ~ '\\([A-Z][a-z]{2} [0-9]{1,2}, [0-9]{4}\\)$'`,
            [memoryId]
          );

          // Create anchored comments from Google Doc comments
          for (const gComment of googleComments) {
            // Find anchor context if the comment has quoted text
            let anchorText: string | null = null;
            let anchorPrefix: string | null = null;
            let anchorSuffix: string | null = null;

            if (gComment.quotedText) {
              const context = findAnchorContext(doc.content, gComment.quotedText);
              if (context.found) {
                anchorText = gComment.quotedText;
                anchorPrefix = context.anchorPrefix;
                anchorSuffix = context.anchorSuffix;
              }
            }

            // Format author with date (truncate to 50 chars for DB constraint)
            const formatAuthor = (name: string, date?: string) => {
              const formatted = date
                ? `${name} (${new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})`
                : name;
              return formatted.slice(0, 50);
            };

            const authorWithDate = formatAuthor(gComment.author, gComment.createdTime);

            // Create the parent comment
            const parentResult = await client.query(
              `INSERT INTO comments (entity_type, entity_id, content, anchor_text, anchor_prefix, anchor_suffix, author, status)
               VALUES ('memory', $1, $2, $3, $4, $5, $6, $7)
               RETURNING id`,
              [
                memoryId,
                gComment.content,
                anchorText,
                anchorPrefix,
                anchorSuffix,
                authorWithDate,
                gComment.resolved ? 'resolved' : 'active',
              ]
            );
            commentsSynced++;

            // Create threaded replies as child comments
            const parentCommentId = parentResult.rows[0].id;
            for (const reply of gComment.replies) {
              const replyAuthor = formatAuthor(reply.author, reply.createdTime);
              await client.query(
                `INSERT INTO comments (entity_type, entity_id, content, author, parent_comment_id)
                 VALUES ('memory', $1, $2, $3, $4)`,
                [memoryId, reply.content, replyAuthor, parentCommentId]
              );
              commentsSynced++;
            }
          }
        }

        await client.query('COMMIT');
        client.release();

        // After commit: localize base64 images from Google Doc export.
        // Delete old memory-associated files first, then extract new ones.
        let imagesLocalized = 0;
        try {
          await deleteMemoryFiles(memoryId);
          const localizedContent = await localizeDocImages(
            doc.content, memory.project_id, memoryId, memory.project_handle, sourceId
          );
          if (localizedContent !== doc.content) {
            await query(
              'UPDATE memories SET content = $1, updated_at = NOW() WHERE id = $2',
              [localizedContent, memoryId]
            );
            await query('DELETE FROM memory_chunks WHERE memory_id = $1', [memoryId]);
            const CHUNK_SIZE = 2000;
            if (localizedContent.length > CHUNK_SIZE) {
              let start = 0;
              let chunkIndex = 0;
              while (start < localizedContent.length) {
                const chunk = localizedContent.slice(start, start + CHUNK_SIZE);
                await query(
                  'INSERT INTO memory_chunks (memory_id, chunk_index, content) VALUES ($1, $2, $3)',
                  [memoryId, chunkIndex, chunk]
                );
                start += CHUNK_SIZE;
                chunkIndex++;
              }
            }
            imagesLocalized = 1; // flag that images were processed
          }
        } catch {
          // Image localization is best-effort; synced content remains
        }

        return {
          id: memoryId,
          synced: true,
          mode: syncMode,
          snapshot: newSnapshotNum,
          last_synced_at: syncedAt,
          comments_synced: commentsSynced,
          images_localized: imagesLocalized,
          source: {
            type: sourceType,
            id: sourceId,
            url: metadata['external-source-url'],
          },
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        try { client.release(); } catch { /* already released after commit */ }
      }
    } catch (err: any) {
      if (err.message?.includes('Failed to fetch') || err.message?.includes('Failed to export')) {
        return reply.code(502).send({
          error: 'Failed to fetch from external source',
          message: err.message,
        });
      }
      throw err;
    }
  });
};

export default memoryRoutes;
