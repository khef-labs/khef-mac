import { FastifyPluginAsync } from 'fastify';
import archiver from 'archiver';
import { getClient, query } from '../db/client';
import { saveSnapshot, saveSnapshotIfContentChanged } from '../services/snapshots';
import { CreateMemoryInput, Memory, Comment, UpdateMemoryInput, FullMemoryInput, MemorySearchParams, PaginationMetadata, SearchMode, CompactMemory, RelationType, TagRef, ENTITY_TYPE } from '../types';
import { resolveProject } from './projects';
import { isValidHandle } from '../utils/slugify';
import { generateExcerpt } from '../utils/excerpt';
import { sanitizeTags } from '../utils/tags';
import { buildCaseBoostPattern, normalizeWebsearchQuery } from '../utils/search-query';
import { deleteMemoryFiles } from '../services/google';
import { MemoryExportData } from '../services/memory-to-markdown';
import { memoryToDocx } from '../services/markdown-to-docx';
import {
  resolveExportImageTheme,
  resolveExportDiagramScale,
  resolveExportPngRenderScale,
  resolveExportPngDisplayScalePercent,
} from '../services/export-image-theme';

const CHUNK_SIZE = 2000;

const chunkText = (text: string): string[] => {
  if (text.length <= CHUNK_SIZE) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    chunks.push(text.slice(start, start + CHUNK_SIZE));
    start += CHUNK_SIZE;
  }

  return chunks;
};

const isTodoType = (type: string): boolean => type.endsWith('-todo');

/** Strip a memory response to minimal fields for compact mutation responses. */
const compactMutationResponse = (memory: Record<string, any>) => ({
  id: memory.id,
  handle: memory.handle,
  status: memory.status,
  created_at: memory.created_at,
  updated_at: memory.updated_at,
});

const isPatternType = (type: string): boolean => type === 'pattern' || type === 'pattern-child';
const isContextType = (type: string): boolean => type === 'context' || type === 'context-child';
const isKnowledgeFamily = (type: string): boolean => type === 'knowledge' || type === 'commands' || isContextType(type) || isPatternType(type);

const suggestRelationType = (sourceType: string, targetType: string): RelationType | null => {
  if (isPatternType(sourceType) && targetType === 'decision') return 'supports';
  if (isContextType(sourceType) && targetType === 'decision') return 'supports';
  if (sourceType === 'reference' && (targetType === 'decision' || isContextType(targetType))) return 'supports';
  if (sourceType === 'decision' && isContextType(targetType)) return 'depends_on';
  if (sourceType === 'decision' && targetType === 'reference') return 'references';
  if (isContextType(sourceType) && targetType === 'reference') return 'references';
  if (isTodoType(sourceType) && targetType === 'decision') return 'relates_to';
  if (sourceType === 'decision' && isTodoType(targetType)) return 'relates_to';
  if (sourceType === 'decision' && isPatternType(targetType)) return 'relates_to';
  if (isPatternType(sourceType) && isContextType(targetType)) return 'relates_to';
  if (isContextType(sourceType) && isPatternType(targetType)) return 'relates_to';
  if (sourceType === targetType) return 'relates_to';
  return null;
};

function buildSeedFrontmatter(
  project: string,
  handle: string,
  title: string,
  type: string,
  subtype: string,
  tags: string[],
  metadata?: Record<string, string>,
): string {
  const lines = [
    '---',
    `project: ${project}`,
    `handle: ${handle}`,
    `title: ${title}`,
    `type: ${type}`,
    `subtype: ${subtype}`,
  ];
  if (tags.length > 0) {
    lines.push(`tags: [${tags.join(', ')}]`);
  }
  if (metadata) {
    for (const [field, value] of Object.entries(metadata)) {
      if (value && value.trim().length > 0) {
        lines.push(`${field}: ${value}`);
      }
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function sendEmptyZip(reply: any, projectHandle: string) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  reply.raw.setHeader('Content-Type', 'application/zip');
  reply.raw.setHeader('Content-Disposition', `attachment; filename="${projectHandle}-export.zip"`);
  archive.pipe(reply.raw);
  archive.finalize();
  return reply;
}

const projectMemoryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { type, tag, status, q, search_mode, sort, order, limit, offset, compact } = request.query as MemorySearchParams;
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
      if (sortKey === 'relevance') return 'desc';
      if (!order) {
        if (sortKey === 'title') return 'asc';
        return 'desc';
      }
      return (order.toLowerCase() === 'asc' ? 'asc' : 'desc');
    })();

    // Enforce UUID-only for projectId path
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      return reply.code(400).send({ error: 'project_id must be a UUID' });
    }

    // Fetch project to get handle and display_name for compact responses
    const projectResult = await query<{ id: string; handle: string; display_name: string }>(
      'SELECT id, handle, display_name FROM projects WHERE id = $1',
      [projectId]
    );
    if (projectResult.length === 0) {
      return reply.code(404).send({ error: 'Project not found' });
    }
    const project = projectResult[0];

    let sql: string;
    const params: any[] = [];

    // If search query is provided, use full-text search
    if (q && q.trim()) {
      // Rewrite literal `NOT word` to `-word` so websearch_to_tsquery honors it.
      const searchText = normalizeWebsearchQuery(q);
      // Build search conditions for CTE
      const searchConditions: string[] = [];
      searchConditions.push('m.project_id = $1');
      params.push(project.id);

      let ctaParamIndex = 2;
      let memoryTypeId: string | undefined;

      // Convert type name to memory_type_id for filtering
      if (type) {
        // Expand knowledge to include all children
        if (type === 'knowledge') {
          const familyResult = await query<{ id: string }>(
            `SELECT id FROM memory_types WHERE name = $1 OR parent_id = (SELECT id FROM memory_types WHERE name = $1)`,
            ['knowledge']
          );
          if (familyResult.length === 0) {
            return reply.code(400).send({ error: `Invalid memory type: ${type}` });
          }
          const familyIds = familyResult.map(r => r.id);
          searchConditions.push(`m.memory_type_id = ANY($${ctaParamIndex})`);
          params.push(familyIds);
          ctaParamIndex++;
        } else {
          const typeResult = await query<{ id: string }>(
            'SELECT id FROM memory_types WHERE name = $1',
            [type]
          );
          if (typeResult.length === 0) {
            return reply.code(400).send({ error: `Invalid memory type: ${type}` });
          }
          memoryTypeId = typeResult[0].id;
          searchConditions.push(`m.memory_type_id = $${ctaParamIndex}`);
          params.push(memoryTypeId);
          ctaParamIndex++;
        }
      }

      // Convert status value to status_id for filtering
      if (status) {
        // Need memory type to look up correct status
        if (!memoryTypeId && !type) {
          return reply.code(400).send({ error: 'type is required when filtering by status' });
        }

        if (memoryTypeId) {
          // Look up status in the type itself, or in its parent type
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
          searchConditions.push(`m.status_id = $${ctaParamIndex}`);
          params.push(statusResult[0].id);
          ctaParamIndex++;
        }
      }

      // Pinned filter for search path
      if (pinnedFilter === 'true') {
        searchConditions.push(`EXISTS (SELECT 1 FROM memory_metadata mm_pin JOIN metadata md_pin ON mm_pin.metadata_id = md_pin.id WHERE mm_pin.memory_id = m.id AND md_pin.field = 'is-pinned' AND mm_pin.value = 'true')`);
      } else if (pinnedFilter === 'false') {
        searchConditions.push(`NOT EXISTS (SELECT 1 FROM memory_metadata mm_pin JOIN metadata md_pin ON mm_pin.metadata_id = md_pin.id WHERE mm_pin.memory_id = m.id AND md_pin.field = 'is-pinned' AND mm_pin.value = 'true')`);
      }

      const searchWhereClause = searchConditions.join(' AND ');

      // Push search parameter
      params.push(searchText);
      const searchParamIndex = ctaParamIndex;
      const searchQuery = `websearch_to_tsquery('english', $${searchParamIndex})`;
      const tagSearchPattern = `$${searchParamIndex}`;

      // Case-sensitive boost (see memories.ts for rationale).
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

      // Title starts-with bonus (see memories.ts for rationale).
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
        // Title weight
        cteUnions.push(`
          SELECT DISTINCT m.id, ts_rank_cd(to_tsvector('english', coalesce(m.title,'')), ${searchQuery}) * 3.0 AS rank
          FROM memories m
          WHERE ${searchWhereClause}
            AND to_tsvector('english', coalesce(m.title,'')) @@ ${searchQuery}
        `);
        // Content weight
        cteUnions.push(`
          SELECT DISTINCT m.id, ts_rank_cd(m.content_tsv, ${searchQuery}) * 1.0 AS rank
          FROM memories m
          WHERE ${searchWhereClause}
            AND m.content_tsv @@ ${searchQuery}
        `);
        // Chunk weight
        cteUnions.push(`
          SELECT DISTINCT mc.memory_id AS id, ts_rank_cd(mc.content_tsv, ${searchQuery}) * 0.8 AS rank
          FROM memory_chunks mc
          INNER JOIN memories m ON mc.memory_id = m.id
          WHERE ${searchWhereClause}
            AND mc.content_tsv @@ ${searchQuery}
        `);
      }

      if (mode === 'all' || mode === 'tags') {
        // Matches in tag names (case-insensitive partial match)
        cteUnions.push(`
          SELECT DISTINCT m.id, 0.05 AS rank
          FROM memories m
          INNER JOIN memory_tags mta ON m.id = mta.memory_id
          INNER JOIN tags t ON mta.tag_id = t.id
          WHERE ${searchWhereClause}
            AND LOWER(t.name) LIKE '%' || LOWER(${tagSearchPattern}) || '%'
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
          (MAX(mm.rank) ${caseBoostExpr} ${titleBonusExpr}) AS search_rank,
          COUNT(*) OVER() AS total_count,
          (SELECT mm_p.value FROM memory_metadata mm_p JOIN metadata md_p ON mm_p.metadata_id = md_p.id WHERE mm_p.memory_id = m.id AND md_p.field = 'is-pinned') AS is_pinned_raw,
          EXISTS(SELECT 1 FROM memory_metadata mm_s JOIN metadata md_s ON mm_s.metadata_id = md_s.id WHERE mm_s.memory_id = m.id AND md_s.field = 'seed-path') AS is_seeded_raw
        FROM memories m
        INNER JOIN matching_memories mm ON m.id = mm.id
        INNER JOIN memory_types mt ON m.memory_type_id = mt.id
        LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
        LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
      `;

      // Add tag/handle/title filters if present
      if (tag) {
        sql += `
          INNER JOIN memory_tags mta ON m.id = mta.memory_id
          INNER JOIN tags t ON mta.tag_id = t.id
          WHERE t.name = $${params.length + 1}
        `;
        params.push(tag);
      }
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
                 m.status_updated_at, m.created_at, m.updated_at, mt.name, mt_parent.name, mt_parent.id, mts.status_value
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

      // Project filter from route parameter
      conditions.push(`m.project_id = $${params.length + 1}`);
      params.push(project.id);

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
        // Expand knowledge to include all children
        if (type === 'knowledge') {
          const familyResult = await query<{ id: string }>(
            `SELECT id FROM memory_types WHERE name = $1 OR parent_id = (SELECT id FROM memory_types WHERE name = $1)`,
            ['knowledge']
          );
          if (familyResult.length === 0) {
            return reply.code(400).send({ error: `Invalid memory type: ${type}` });
          }
          const familyIds = familyResult.map(r => r.id);
          conditions.push(`m.memory_type_id = ANY($${params.length + 1})`);
          params.push(familyIds);
        } else {
          const typeResult = await query<{ id: string }>(
            'SELECT id FROM memory_types WHERE name = $1',
            [type]
          );
          if (typeResult.length === 0) {
            return reply.code(400).send({ error: `Invalid memory type: ${type}` });
          }
          memoryTypeId = typeResult[0].id;
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
          // Look up status in the type itself, or in its parent type
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
               mts.status_value as status, t.cnt::text AS total_count,
               (SELECT mm_p.value FROM memory_metadata mm_p JOIN metadata md_p ON mm_p.metadata_id = md_p.id WHERE mm_p.memory_id = m.id AND md_p.field = 'is-pinned') AS is_pinned_raw,
          EXISTS(SELECT 1 FROM memory_metadata mm_s JOIN metadata md_s ON mm_s.metadata_id = md_s.id WHERE mm_s.memory_id = m.id AND md_s.field = 'seed-path') AS is_seeded_raw
        FROM memories m
        INNER JOIN memory_types mt ON m.memory_type_id = mt.id
        LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
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

    const results = await query<Memory & { total_count: string; type: string; parent_type?: string; parent_type_id?: string; status: string; search_rank?: number; is_pinned_raw?: string; is_seeded_raw?: boolean }>(sql, params);

    let totalCount = 0;
    if (results.length > 0) {
      totalCount = parseInt(results[0].total_count, 10);
    } else {
      // When no results (e.g., offset beyond total), get total count separately
      let countSql: string;
      const countParams: any[] = [];

      if (q && q.trim()) {
        // Count for search query
        const searchText = normalizeWebsearchQuery(q);
        const searchConditions: string[] = [];
        searchConditions.push('m.project_id = $1');
        countParams.push(project.id);

        let paramIndex = 2;
        let countMemoryTypeId: string | undefined;

        // Convert type name to memory_type_id for count query
        if (type) {
          const typeResult = await query<{ id: string }>(
            'SELECT id FROM memory_types WHERE name = $1',
            [type]
          );
          if (typeResult.length > 0) {
            countMemoryTypeId = typeResult[0].id;
            searchConditions.push(`m.memory_type_id = $${paramIndex}`);
            countParams.push(countMemoryTypeId);
            paramIndex++;
          }
        }

        // Convert status value to status_id for count query
        if (status && countMemoryTypeId) {
          const statusResult = await query<{ id: string }>(
            'SELECT id FROM memory_type_statuses WHERE status_value = $1 AND memory_type_id = $2',
            [status, countMemoryTypeId]
          );
          if (statusResult.length > 0) {
            searchConditions.push(`m.status_id = $${paramIndex}`);
            countParams.push(statusResult[0].id);
            paramIndex++;
          }
        }

        countParams.push(searchText);

        // Build count unions based on mode
        const countUnions: string[] = [];

        if (mode === 'all' || mode === 'content') {
          countUnions.push(`
            SELECT m.id as memory_id
            FROM memories m
            WHERE ${searchConditions.join(' AND ')}
              AND m.content_tsv @@ websearch_to_tsquery('english', $${paramIndex})
          `);
          countUnions.push(`
            SELECT mc.memory_id
            FROM memory_chunks mc
            INNER JOIN memories m ON mc.memory_id = m.id
            WHERE ${searchConditions.join(' AND ')}
              AND mc.content_tsv @@ websearch_to_tsquery('english', $${paramIndex})
          `);
        }

        if (mode === 'all' || mode === 'tags') {
          countUnions.push(`
            SELECT m.id as memory_id
            FROM memories m
            INNER JOIN memory_tags mta ON m.id = mta.memory_id
            INNER JOIN tags t ON mta.tag_id = t.id
            WHERE ${searchConditions.join(' AND ')}
              AND LOWER(t.name) LIKE '%' || LOWER($${paramIndex}) || '%'
          `);
        }

        countSql = `
          SELECT COUNT(DISTINCT memory_id) as cnt FROM (
            ${countUnions.join(' UNION ')}
          ) matches
        `;
      } else {
        // Count for regular query
        const conditions: string[] = [];
        let countMemoryTypeId: string | undefined;

        if (tag) {
          conditions.push(`EXISTS (
            SELECT 1 FROM memory_tags mt
            INNER JOIN tags t ON mt.tag_id = t.id
            WHERE mt.memory_id = m.id AND t.name = $${countParams.length + 1}
          )`);
          countParams.push(tag);
        }

        conditions.push(`m.project_id = $${countParams.length + 1}`);
        countParams.push(project.id);

        // Convert type name to memory_type_id for count query
        if (type) {
          const typeResult = await query<{ id: string }>(
            'SELECT id FROM memory_types WHERE name = $1',
            [type]
          );
          if (typeResult.length > 0) {
            countMemoryTypeId = typeResult[0].id;
            conditions.push(`m.memory_type_id = $${countParams.length + 1}`);
            countParams.push(countMemoryTypeId);
          }
        }

        // Convert status value to status_id for count query
        if (status && countMemoryTypeId) {
          const statusResult = await query<{ id: string }>(
            'SELECT id FROM memory_type_statuses WHERE status_value = $1 AND memory_type_id = $2',
            [status, countMemoryTypeId]
          );
          if (statusResult.length > 0) {
            conditions.push(`m.status_id = $${countParams.length + 1}`);
            countParams.push(statusResult[0].id);
          }
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        countSql = `SELECT COUNT(*) as cnt FROM memories m ${whereClause}`;
      }

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

      const compactMemories: CompactMemory[] = results.map(({ total_count, search_rank, is_pinned_raw, is_seeded_raw, ...memory }) => ({
        id: memory.id,
        project_id: memory.project_id,
        project_handle: project.handle,
        project_name: project.display_name,
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

    const memories = results.map(({ total_count, is_pinned_raw, is_seeded_raw, ...memory }) => ({
      ...memory,
      is_pinned: is_pinned_raw === 'true',
      is_seeded: is_seeded_raw === true,
    }));

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

  fastify.get('/:memoryId', async (request, reply) => {
    const { projectId, memoryId } = request.params as { projectId: string; memoryId: string };
    const { comments: includeComments } = request.query as { comments?: string };

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(projectId)) {
      return reply.code(400).send({ error: 'projectId must be a UUID' });
    }
    if (!uuidRe.test(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    const memories = await query<Memory & { type: string; parent_type?: string; parent_type_id?: string; status?: string; status_updated_at?: Date }>(
      `SELECT m.id, m.project_id, m.handle, m.title, m.content, m.memory_type_id, m.status_id,
              m.status_updated_at, m.created_at, m.updated_at,
              mt.name as type, mt_parent.name as parent_type, mt_parent.id as parent_type_id,
              mts.status_value as status
       FROM memories m
       INNER JOIN memory_types mt ON m.memory_type_id = mt.id
       LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
       LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE m.id = $1 AND m.project_id = $2`,
      [memoryId, projectId]
    );

    if (memories.length === 0) {
      return reply.code(404).send({ error: 'Memory not found in this project' });
    }

    const tags = await query<{ id: string; name: string }>(
      `SELECT t.id, t.name FROM tags t
       INNER JOIN memory_tags mt ON t.id = mt.tag_id
       WHERE mt.memory_id = $1`,
      [memories[0].id]
    );

    const chunks = await query<{ chunk_index: number; content: string }>(
      'SELECT chunk_index, content FROM memory_chunks WHERE memory_id = $1 ORDER BY chunk_index',
      [memories[0].id]
    );

    // Fetch metadata
    const metadataRows = await query<{ field: string; value: string }>(
      `SELECT md.field, mm.value
       FROM memory_metadata mm
       INNER JOIN metadata md ON mm.metadata_id = md.id
       WHERE mm.memory_id = $1`,
      [memories[0].id]
    );
    const metadata: Record<string, string> = {};
    for (const row of metadataRows) {
      metadata[row.field] = row.value;
    }

    const memory: any = {
      ...memories[0],
      tags: tags.map(t => ({ id: t.id, name: t.name })),
      is_pinned: metadata['is-pinned'] === 'true',
      is_seeded: !!metadata['seed-path'],
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined
    };

    if (includeComments === 'true') {
      memory.comments = await query<Comment>(
        "SELECT * FROM comments WHERE entity_type = 'memory' AND entity_id = $1 ORDER BY created_at ASC",
        [memoryId]
      );
    }

    return {
      memory,
      chunks: chunks.length > 0 ? chunks : undefined
    };
  });

  fastify.get('/:memoryId/suggestions', async (request, reply) => {
    const { projectId, memoryId } = request.params as { projectId: string; memoryId: string };
    const { limit } = request.query as { limit?: string };

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(projectId)) {
      return reply.code(400).send({ error: 'projectId must be a UUID' });
    }
    if (!uuidRe.test(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    const limitValue = parseInt(limit || '10', 10);
    const limitNum = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(limitValue, 50) : 10;

    const memoryRows = await query<Memory & { type: string; parent_type?: string; parent_type_id?: string }>(
      `SELECT m.id, m.project_id, m.handle, m.title, m.content, m.memory_type_id, m.status_id,
              m.status_updated_at, m.created_at, m.updated_at,
              mt.name as type, mt_parent.name as parent_type, mt_parent.id as parent_type_id
       FROM memories m
       INNER JOIN memory_types mt ON m.memory_type_id = mt.id
       LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
       WHERE m.id = $1 AND m.project_id = $2`,
      [memoryId, projectId]
    );

    if (memoryRows.length === 0) {
      return reply.code(404).send({ error: 'Memory not found in this project' });
    }

    const sourceMemory = memoryRows[0];
    const tagRows = await query<{ name: string }>(
      `SELECT t.name FROM tags t
       INNER JOIN memory_tags mt ON t.id = mt.tag_id
       WHERE mt.memory_id = $1`,
      [memoryId]
    );
    const tags = tagRows.map(t => t.name);
    const titleTerms = sourceMemory.title.split(/\s+/).filter(Boolean);
    const contentTerms = generateExcerpt(sourceMemory.content, 240).split(/\s+/).filter(Boolean);
    const searchTerms = [...tags, ...titleTerms, ...contentTerms]
      .filter(Boolean)
      .map(term => term.replace(/[^a-zA-Z0-9_-]/g, ''))
      .filter(Boolean);
    const searchText = searchTerms.slice(0, 12).join(' ').trim();

    if (!searchText) {
      return { source_memory_id: memoryId, suggestions: [] };
    }

    const searchQuery = `websearch_to_tsquery('english', $3)`;
    const sql = `
      WITH matching_memories AS (
        SELECT DISTINCT m.id, ts_rank_cd(to_tsvector('english', coalesce(m.title,'')), ${searchQuery}) * 1.5 AS rank
        FROM memories m
        WHERE m.project_id = $1 AND m.id <> $2
          AND to_tsvector('english', coalesce(m.title,'')) @@ ${searchQuery}
        UNION
        SELECT DISTINCT m.id, ts_rank_cd(m.content_tsv, ${searchQuery}) * 1.0 AS rank
        FROM memories m
        WHERE m.project_id = $1 AND m.id <> $2
          AND m.content_tsv @@ ${searchQuery}
        UNION
        SELECT DISTINCT mc.memory_id AS id, ts_rank_cd(mc.content_tsv, ${searchQuery}) * 0.8 AS rank
        FROM memory_chunks mc
        INNER JOIN memories m ON mc.memory_id = m.id
        WHERE m.project_id = $1 AND m.id <> $2
          AND mc.content_tsv @@ ${searchQuery}
        UNION
        SELECT DISTINCT m.id, 0.05 AS rank
        FROM memories m
        INNER JOIN memory_tags mta ON m.id = mta.memory_id
        INNER JOIN tags t ON mta.tag_id = t.id
        WHERE m.project_id = $1 AND m.id <> $2
          AND t.name = ANY($4)
      ),
      related_ids AS (
        SELECT target_memory_id AS id FROM memory_relations WHERE source_memory_id = $2
        UNION
        SELECT source_memory_id AS id FROM memory_relations WHERE target_memory_id = $2
      )
      SELECT
        m.id, m.project_id, m.handle, m.title, m.content, m.memory_type_id, m.status_id,
        m.status_updated_at, m.created_at, m.updated_at,
        mt.name as type,
        mt_parent.name as parent_type,
        mt_parent.id as parent_type_id,
        mts.status_value as status,
        MAX(mm.rank) AS search_rank
      FROM memories m
      INNER JOIN matching_memories mm ON m.id = mm.id
      INNER JOIN memory_types mt ON m.memory_type_id = mt.id
      LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
      LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
      WHERE m.project_id = $1
        AND m.id <> $2
        AND m.id NOT IN (SELECT id FROM related_ids)
        GROUP BY m.id, m.project_id, m.handle, m.title, m.content, m.memory_type_id, m.status_id,
                 m.status_updated_at, m.created_at, m.updated_at, mt.name, mt_parent.name, mt_parent.id, mts.status_value
      ORDER BY search_rank DESC, m.updated_at DESC, m.id ASC
      LIMIT $5
    `;

    const results = await query<Memory & { type: string; parent_type?: string; parent_type_id?: string; status?: string; search_rank?: number }>(
      sql,
      [projectId, memoryId, searchText, tags, limitNum]
    );

    const suggestions = results.map((memory) => ({
      memory: {
        id: memory.id,
        project_id: memory.project_id,
        handle: memory.handle,
        title: memory.title,
        type: memory.type,
        ...(memory.parent_type ? { parent_type: memory.parent_type } : {}),
        ...(memory.parent_type_id ? { parent_type_id: memory.parent_type_id } : {}),
        status: memory.status,
        created_at: memory.created_at,
        updated_at: memory.updated_at,
        content_excerpt: generateExcerpt(memory.content)
      },
      suggested_relation_type: suggestRelationType(sourceMemory.type, memory.type),
      score: memory.search_rank ?? null
    }));

    return {
      source_memory_id: memoryId,
      suggestions
    };
  });

  fastify.post('/', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { handle, title, content, type, tags, metadata } = request.body as CreateMemoryInput;

    if (!handle || !title || !content || !type) {
      return reply.code(400).send({ error: 'handle, title, content and type are required' });
    }

    if (!isValidHandle(handle)) {
      return reply.code(400).send({ error: 'Invalid handle format. Use lowercase letters, numbers and hyphens (e.g., "my-handle").' });
    }

    // Block knowledge child types from direct creation (use knowledge endpoints)
    if (type === 'commands' || type === 'knowledge') {
      return reply.code(400).send({ error: `Type '${type}' cannot be created directly. Use the knowledge endpoints (/knowledge/commands, /knowledge/context, /knowledge/patterns) instead.` });
    }

    // Enforce UUID-only for projectId path
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      return reply.code(400).send({ error: 'project_id must be a UUID' });
    }

    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Get memory_type_id from type name
      const typeResult = await client.query<{ id: string }>(
        'SELECT id FROM memory_types WHERE name = $1',
        [type]
      );

      if (typeResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: `Invalid memory type: ${type}` });
      }

      const memoryTypeId = typeResult.rows[0].id;

      // Get default status for this memory type (sort_order = 0), with parent fallback
      let defaultStatusResult = await client.query<{ id: string; status_value: string }>(
        'SELECT id, status_value FROM memory_type_statuses WHERE memory_type_id = $1 AND sort_order = 0 LIMIT 1',
        [memoryTypeId]
      );
      // Fall back to parent type's default status if none found
      if (defaultStatusResult.rows.length === 0) {
        defaultStatusResult = await client.query<{ id: string; status_value: string }>(
          `SELECT mts.id, mts.status_value FROM memory_type_statuses mts
           INNER JOIN memory_types mt ON mt.parent_id = mts.memory_type_id
           WHERE mt.id = $1
           ORDER BY mts.sort_order LIMIT 1`,
          [memoryTypeId]
        );
      }

      const defaultStatusId = defaultStatusResult.rows.length > 0 ? defaultStatusResult.rows[0].id : null;
      const defaultStatusValue = defaultStatusResult.rows.length > 0 ? defaultStatusResult.rows[0].status_value : null;

      // Check for title uniqueness within project
      const titleCheck = await client.query(
        'SELECT id FROM memories WHERE project_id = $1 AND title = $2',
        [projectId, title]
      );

      if (titleCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'A memory with this title already exists in this project' });
      }

      // Check for handle uniqueness within project
      const handleCheck = await client.query(
        'SELECT id FROM memories WHERE project_id = $1 AND handle = $2',
        [projectId, handle]
      );

      if (handleCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'A memory with this handle already exists in this project' });
      }

      const memoryResult = await client.query<Memory>(
        'INSERT INTO memories (project_id, handle, title, content, memory_type_id, status_id, status_updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id, project_id, handle, title, content, memory_type_id, status_id, status_updated_at, created_at, updated_at',
        [projectId, handle, title, content, memoryTypeId, defaultStatusId]
      );

      const memory = { ...memoryResult.rows[0], type, status: defaultStatusValue };

      const chunks = chunkText(content);
      if (chunks.length > 1) {
        for (let i = 0; i < chunks.length; i++) {
          await client.query(
            'INSERT INTO memory_chunks (memory_id, chunk_index, content) VALUES ($1, $2, $3)',
            [memory.id, i, chunks[i]]
          );
        }
      }

      const validTags = sanitizeTags(tags);
      if (validTags.length > 0) {
        for (const tagName of validTags) {
          const tagResult = await client.query(
            'INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
            [tagName]
          );
          const tagId = tagResult.rows[0].id;

          await client.query(
            'INSERT INTO memory_tags (memory_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [memory.id, tagId]
          );
        }
      }

      // Handle metadata
      if (metadata && typeof metadata === 'object') {
        for (const [field, value] of Object.entries(metadata)) {
          if (!value || typeof value !== 'string' || value.trim().length === 0) continue;
          const metaDefResult = await client.query<{ id: string }>(
            `SELECT id FROM metadata WHERE entity_type = $1 AND field = $2`,
            [ENTITY_TYPE.MEMORY, field]
          );
          if (metaDefResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return reply.code(400).send({ error: `Unknown metadata field: ${field}` });
          }
          await client.query(
            `INSERT INTO memory_metadata (memory_id, metadata_id, value) VALUES ($1, $2, $3)`,
            [memory.id, metaDefResult.rows[0].id, value]
          );
        }
      }

      await client.query('COMMIT');

      const compact = (request.query as Record<string, string>).compact !== 'false';
      return reply.code(201).send({ memory: compact ? compactMutationResponse(memory) : memory });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  // PUT - Full resource replacement (requires title, content, type)
  fastify.put('/:memoryId', async (request, reply) => {
    const { projectId, memoryId } = request.params as { projectId: string; memoryId: string };
    const { title, content, type, parent_type, tags } = request.body as FullMemoryInput;

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(projectId)) {
      return reply.code(400).send({ error: 'projectId must be a UUID' });
    }
    if (!uuidRe.test(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    // PUT requires full resource - title, content, and type are required
    if (!title || !content || !type) {
      return reply.code(400).send({ error: 'title, content, and type are required for full resource replacement. Use PATCH for partial updates.' });
    }

    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Validate memory exists and belongs to project
      const checkMemory = await client.query<{ id: string; memory_type_id: string }>(
        'SELECT id, memory_type_id FROM memories WHERE id = $1 AND project_id = $2',
        [memoryId, projectId]
      );

      if (checkMemory.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Memory not found in this project' });
      }
      const currentMemoryTypeId = checkMemory.rows[0].memory_type_id;

      // Check for title uniqueness within project (excluding current memory)
      const titleCheck = await client.query(
        'SELECT id FROM memories WHERE project_id = $1 AND title = $2 AND id != $3',
        [projectId, title, memoryId]
      );

      if (titleCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'A memory with this title already exists in this project' });
      }

      // Get memory_type_id from type name (optionally scoped to parent type)
      const typeResult = parent_type
        ? await client.query<{ id: string }>(
            `SELECT mt.id
             FROM memory_types mt
             INNER JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
             WHERE mt.name = $1 AND mt_parent.name = $2`,
            [type, parent_type]
          )
        : parent_type === null
          ? await client.query<{ id: string }>(
              'SELECT id FROM memory_types WHERE name = $1 AND parent_id IS NULL',
              [type]
            )
          : await client.query<{ id: string }>(
              'SELECT id FROM memory_types WHERE name = $1',
              [type]
            );

      if (typeResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: `Invalid memory type: ${type}` });
      }

      const memoryTypeId = typeResult.rows[0].id;
      let statusIdToSet: string | null = null;
      if (memoryTypeId !== currentMemoryTypeId) {
        // Try own statuses first, then parent type fallback
        let defaultStatusResult = await client.query<{ id: string }>(
          'SELECT id FROM memory_type_statuses WHERE memory_type_id = $1 AND sort_order = 0 LIMIT 1',
          [memoryTypeId]
        );
        if (defaultStatusResult.rows.length === 0) {
          defaultStatusResult = await client.query<{ id: string }>(
            `SELECT mts.id FROM memory_type_statuses mts
             INNER JOIN memory_types mt ON mt.parent_id = mts.memory_type_id
             WHERE mt.id = $1
             ORDER BY mts.sort_order LIMIT 1`,
            [memoryTypeId]
          );
        }

        if (defaultStatusResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: `No default status found for memory type: ${type}` });
        }

        statusIdToSet = defaultStatusResult.rows[0].id;
      }

      // Full replacement - update all fields (mark for vector sync)
      const updateFields = ['title = $1', 'content = $2', 'memory_type_id = $3', 'vector_synced_at = NULL'];
      const updateParams: Array<string | null> = [title, content, memoryTypeId];
      let updateParamIndex = 4;
      if (statusIdToSet) {
        updateFields.push(`status_id = $${updateParamIndex++}`);
        updateParams.push(statusIdToSet);
      }
      updateParams.push(memoryId);

      await client.query(
        `UPDATE memories SET ${updateFields.join(', ')} WHERE id = $${updateParamIndex}`,
        updateParams
      );

      // Re-chunk content
      await client.query('DELETE FROM memory_chunks WHERE memory_id = $1', [memoryId]);
      const chunks = chunkText(content);
      if (chunks.length > 1) {
        for (let i = 0; i < chunks.length; i++) {
          await client.query(
            'INSERT INTO memory_chunks (memory_id, chunk_index, content) VALUES ($1, $2, $3)',
            [memoryId, i, chunks[i]]
          );
        }
      }

      // Replace all tags (or remove all if tags not provided)
      await client.query('DELETE FROM memory_tags WHERE memory_id = $1', [memoryId]);
      const validTagsPut = sanitizeTags(tags);
      if (validTagsPut.length > 0) {
        for (const tagName of validTagsPut) {
          const tagResult = await client.query(
            'INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
            [tagName]
          );
          const tagId = tagResult.rows[0].id;

          await client.query(
            'INSERT INTO memory_tags (memory_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [memoryId, tagId]
          );
        }
      }

      const memories = await client.query<Memory>('SELECT * FROM memories WHERE id = $1', [memoryId]);

      await client.query('COMMIT');
      return { memory: memories.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  // PATCH - Partial update (all fields optional)
  // Query param: ?snapshot=true to save current content as a version before updating
  fastify.patch('/:memoryId', async (request, reply) => {
    const { projectId, memoryId } = request.params as { projectId: string; memoryId: string };
    const { snapshot } = request.query as { snapshot?: string };
    const { project_id, handle, title, content, type, parent_type, status, tags, metadata } = request.body as UpdateMemoryInput;

    const shouldSnapshot = snapshot === 'true';

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(projectId)) {
      return reply.code(400).send({ error: 'projectId must be a UUID' });
    }
    if (!uuidRe.test(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    const client = await getClient();

    try {
      await client.query('BEGIN');

      // If snapshot requested, save current content as a snapshot before updating
      if (shouldSnapshot) {
        await saveSnapshot(memoryId, 'manual', client);
      }

      // Validate memory exists and belongs to project
      const checkMemory = await client.query<{ id: string; memory_type_id: string; title: string; handle: string }>(
        'SELECT id, memory_type_id, title, handle FROM memories WHERE id = $1 AND project_id = $2',
        [memoryId, projectId]
      );

      if (checkMemory.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Memory not found in this project' });
      }

      // Auto-snapshot: when the caller is changing memory content (and did not
      // already request a manual snapshot), record a pre-update snapshot so a
      // bad agent edit can be rolled back from the snapshot management modal.
      // Skipped when content is unchanged or only metadata fields are being
      // updated.
      if (content !== undefined && !shouldSnapshot) {
        await saveSnapshotIfContentChanged(memoryId, content, 'pre-update', client);
      }
      const currentMemoryTypeId = checkMemory.rows[0].memory_type_id;
      const currentTitle = checkMemory.rows[0].title;
      const currentHandle = checkMemory.rows[0].handle;

      const updateFields: string[] = [];
      const updateParams: any[] = [];
      let paramIndex = 1;

      // Determine target project (for uniqueness checks)
      let targetProjectId = projectId;
      if (project_id !== undefined && project_id !== projectId) {
        if (!uuidRe.test(project_id)) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: 'project_id must be a UUID' });
        }

        // Validate target project exists
        const targetProject = await client.query('SELECT id FROM projects WHERE id = $1', [project_id]);
        if (targetProject.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'Target project not found' });
        }

        targetProjectId = project_id;

        // Check title uniqueness in target project (use new title if provided, else current)
        const titleToCheck = title !== undefined ? title : currentTitle;
        const titleCheck = await client.query(
          'SELECT id FROM memories WHERE project_id = $1 AND title = $2',
          [targetProjectId, titleToCheck]
        );
        if (titleCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'A memory with this title already exists in the target project' });
        }

        // Check handle uniqueness in target project
        const handleCheck = await client.query(
          'SELECT id FROM memories WHERE project_id = $1 AND handle = $2',
          [targetProjectId, currentHandle]
        );
        if (handleCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'A memory with this handle already exists in the target project' });
        }

        updateFields.push(`project_id = $${paramIndex++}`);
        updateParams.push(project_id);
      }

      if (title !== undefined) {
        // Check for title uniqueness within target project (excluding current memory)
        // Skip if we already checked during project change
        if (project_id === undefined || project_id === projectId) {
          const titleCheck = await client.query(
            'SELECT id FROM memories WHERE project_id = $1 AND title = $2 AND id != $3',
            [targetProjectId, title, memoryId]
          );

          if (titleCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return reply.code(409).send({ error: 'A memory with this title already exists in this project' });
          }
        }

        updateFields.push(`title = $${paramIndex++}`);
        updateParams.push(title);
      }

      if (handle !== undefined) {
        const handleCheck = await client.query(
          'SELECT id FROM memories WHERE project_id = $1 AND handle = $2 AND id != $3',
          [targetProjectId, handle, memoryId]
        );
        if (handleCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'A memory with this handle already exists in this project' });
        }

        updateFields.push(`handle = $${paramIndex++}`);
        updateParams.push(handle);
      }

      if (content !== undefined) {
        updateFields.push(`content = $${paramIndex++}`);
        updateParams.push(content);

        await client.query('DELETE FROM memory_chunks WHERE memory_id = $1', [memoryId]);

        const chunks = chunkText(content);
        if (chunks.length > 1) {
          for (let i = 0; i < chunks.length; i++) {
            await client.query(
              'INSERT INTO memory_chunks (memory_id, chunk_index, content) VALUES ($1, $2, $3)',
              [memoryId, i, chunks[i]]
            );
          }
        }
      }

      let nextMemoryTypeId: string | null = null;
      if (type !== undefined) {
        // Get memory_type_id from type name (optionally scoped to parent type)
        const typeResult = parent_type
          ? await client.query<{ id: string }>(
              `SELECT mt.id
               FROM memory_types mt
               INNER JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
               WHERE mt.name = $1 AND mt_parent.name = $2`,
              [type, parent_type]
            )
          : parent_type === null
            ? await client.query<{ id: string }>(
                'SELECT id FROM memory_types WHERE name = $1 AND parent_id IS NULL',
                [type]
              )
            : await client.query<{ id: string }>(
                'SELECT id FROM memory_types WHERE name = $1',
                [type]
              );

        if (typeResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: `Invalid memory type: ${type}` });
        }

        nextMemoryTypeId = typeResult.rows[0].id;
        updateFields.push(`memory_type_id = $${paramIndex++}`);
        updateParams.push(nextMemoryTypeId);
      }

      if (status !== undefined) {
        const statusMemoryTypeId = nextMemoryTypeId ?? currentMemoryTypeId;
        const statusResult = await client.query<{ id: string }>(
          `SELECT mts.id FROM memory_type_statuses mts
           WHERE mts.status_value = $1
             AND (mts.memory_type_id = $2
                  OR mts.memory_type_id = (SELECT parent_id FROM memory_types WHERE id = $2))
           LIMIT 1`,
          [status, statusMemoryTypeId]
        );

        if (statusResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: `Status '${status}' does not match memory type or is invalid` });
        }

        updateFields.push(`status_id = $${paramIndex++}`);
        updateParams.push(statusResult.rows[0].id);
      } else if (nextMemoryTypeId && nextMemoryTypeId !== currentMemoryTypeId) {
        // Try own statuses first, then parent type fallback
        let defaultStatusResult = await client.query<{ id: string }>(
          'SELECT id FROM memory_type_statuses WHERE memory_type_id = $1 AND sort_order = 0 LIMIT 1',
          [nextMemoryTypeId]
        );
        if (defaultStatusResult.rows.length === 0) {
          defaultStatusResult = await client.query<{ id: string }>(
            `SELECT mts.id FROM memory_type_statuses mts
             INNER JOIN memory_types mt ON mt.parent_id = mts.memory_type_id
             WHERE mt.id = $1
             ORDER BY mts.sort_order LIMIT 1`,
            [nextMemoryTypeId]
          );
        }

        if (defaultStatusResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: `No default status found for memory type: ${type}` });
        }

        updateFields.push(`status_id = $${paramIndex++}`);
        updateParams.push(defaultStatusResult.rows[0].id);
      }

      if (updateFields.length > 0) {
        // Mark for vector sync
        updateFields.push('vector_synced_at = NULL');
        updateParams.push(memoryId);
        const sql = `UPDATE memories SET ${updateFields.join(', ')} WHERE id = $${paramIndex} RETURNING id, project_id, title, content, memory_type_id, status_id, status_updated_at, created_at, updated_at`;
        const result = await client.query<Memory>(sql, updateParams);

        if (result.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'Memory not found' });
        }
      }

      if (tags !== undefined) {
        const validTagsPatch = sanitizeTags(tags);
        await client.query('DELETE FROM memory_tags WHERE memory_id = $1', [memoryId]);

        for (const tagName of validTagsPatch) {
          const tagResult = await client.query(
            'INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
            [tagName]
          );
          const tagId = tagResult.rows[0].id;

          await client.query(
            'INSERT INTO memory_tags (memory_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [memoryId, tagId]
          );
        }
      }

      // Handle metadata updates
      if (metadata !== undefined) {
        for (const [field, value] of Object.entries(metadata)) {
          // Get metadata definition for this field
          const metadataDefResult = await client.query<{ id: string }>(
            `SELECT id FROM metadata WHERE entity_type = $1 AND field = $2`,
            [ENTITY_TYPE.MEMORY, field]
          );

          if (metadataDefResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return reply.code(400).send({ error: `Unknown metadata field: ${field}` });
          }

          const metadataId = metadataDefResult.rows[0].id;

          if (value === null || value === '') {
            // Delete the metadata entry if value is null or empty
            await client.query(
              'DELETE FROM memory_metadata WHERE memory_id = $1 AND metadata_id = $2',
              [memoryId, metadataId]
            );
          } else {
            // Upsert the metadata value
            await client.query(
              `INSERT INTO memory_metadata (memory_id, metadata_id, value)
               VALUES ($1, $2, $3)
               ON CONFLICT (memory_id, metadata_id)
               DO UPDATE SET value = $3, updated_at = NOW()`,
              [memoryId, metadataId, value]
            );
          }
        }
      }

      const memories = await client.query<Memory & { type: string; status: string | null }>(
        `SELECT m.*, mt.name as type, mts.status_value as status
         FROM memories m
         INNER JOIN memory_types mt ON m.memory_type_id = mt.id
         LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
         WHERE m.id = $1`,
        [memoryId]
      );

      await client.query('COMMIT');

      const compact = (request.query as Record<string, string>).compact !== 'false';
      return { memory: compact ? compactMutationResponse(memories.rows[0]) : memories.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  // Append content to an existing memory
  fastify.post('/:memoryId/append', async (request, reply) => {
    const { projectId, memoryId } = request.params as { projectId: string; memoryId: string };
    const { content, separator } = request.body as { content: string; separator?: string };

    if (!content) {
      return reply.code(400).send({ error: 'content is required' });
    }

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(projectId)) {
      return reply.code(400).send({ error: 'projectId must be a UUID' });
    }
    if (!uuidRe.test(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Get existing memory
      const memoryResult = await client.query<Memory & { type: string; status: string | null }>(
        `SELECT m.id, m.project_id, m.handle, m.title, m.content, m.memory_type_id, m.status_id,
                m.status_updated_at, m.created_at, m.updated_at,
                mt.name as type, mts.status_value as status
         FROM memories m
         INNER JOIN memory_types mt ON m.memory_type_id = mt.id
         LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
         WHERE m.id = $1 AND m.project_id = $2`,
        [memoryId, projectId]
      );

      if (memoryResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Memory not found in this project' });
      }

      const existingMemory = memoryResult.rows[0];
      const sep = separator !== undefined ? separator : '\n\n';
      const newContent = existingMemory.content + sep + content;

      // Auto-snapshot pre-append so the agent can roll back if the appended
      // content is wrong.
      await saveSnapshotIfContentChanged(memoryId, newContent, 'pre-update', client);

      // Update memory content (mark for vector sync)
      await client.query(
        'UPDATE memories SET content = $1, updated_at = NOW(), vector_synced_at = NULL WHERE id = $2',
        [newContent, memoryId]
      );

      // Re-chunk if needed
      await client.query('DELETE FROM memory_chunks WHERE memory_id = $1', [memoryId]);

      const chunks = chunkText(newContent);
      if (chunks.length > 1) {
        for (let i = 0; i < chunks.length; i++) {
          await client.query(
            'INSERT INTO memory_chunks (memory_id, chunk_index, content) VALUES ($1, $2, $3)',
            [memoryId, i, chunks[i]]
          );
        }
      }

      await client.query('COMMIT');

      // Fetch updated memory
      const updatedMemory = await query<Memory & { type: string; status: string | null }>(
        `SELECT m.id, m.project_id, m.handle, m.title, m.content, m.memory_type_id, m.status_id,
                m.status_updated_at, m.created_at, m.updated_at,
                mt.name as type, mts.status_value as status
         FROM memories m
         INNER JOIN memory_types mt ON m.memory_type_id = mt.id
         LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
         WHERE m.id = $1`,
        [memoryId]
      );

      const compact = (request.query as Record<string, string>).compact !== 'false';
      return { memory: compact ? compactMutationResponse(updatedMemory[0]) : updatedMemory[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  fastify.delete('/:memoryId', async (request, reply) => {
    const { projectId, memoryId } = request.params as { projectId: string; memoryId: string };

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(projectId)) {
      return reply.code(400).send({ error: 'projectId must be a UUID' });
    }
    if (!uuidRe.test(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    // Queue for vector delete before removing from PG
    await query(
      'INSERT INTO vector_delete_queue (memory_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [memoryId]
    );

    // Delete comments for this memory (no FK cascade since comments are polymorphic)
    await query(
      "DELETE FROM comments WHERE entity_type = 'memory' AND entity_id = $1",
      [memoryId]
    );

    // Delete associated files from disk (DB records cascade-deleted with memory)
    await deleteMemoryFiles(memoryId);

    // Validate memory belongs to project
    const result = await query(
      'DELETE FROM memories WHERE id = $1 AND project_id = $2 RETURNING id',
      [memoryId, projectId]
    );

    if (result.length === 0) {
      // Clean up delete queue if memory wasn't found
      await query('DELETE FROM vector_delete_queue WHERE memory_id = $1', [memoryId]);
      return reply.code(404).send({ error: 'Memory not found in this project' });
    }

    return reply.code(204).send();
  });

  // Status management endpoints
  fastify.get('/:memoryId/status', async (request, reply) => {
    const { projectId, memoryId } = request.params as { projectId: string; memoryId: string };

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(projectId)) {
      return reply.code(400).send({ error: 'projectId must be a UUID' });
    }
    if (!uuidRe.test(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    // Validate memory exists and belongs to project
    const memory = await query<{ status_id: string | null; status_updated_at: Date | null }>(
      'SELECT status_id, status_updated_at FROM memories WHERE id = $1 AND project_id = $2',
      [memoryId, projectId]
    );

    if (memory.length === 0) {
      return reply.code(404).send({ error: 'Memory not found in this project' });
    }

    if (!memory[0].status_id) {
      return reply.code(404).send({ error: 'No status set for this memory' });
    }

    // Get status value
    const statusResult = await query<{ status_value: string }>(
      'SELECT status_value FROM memory_type_statuses WHERE id = $1',
      [memory[0].status_id]
    );

    return {
      memory_id: memoryId,
      status: statusResult[0].status_value,
      updated_at: memory[0].status_updated_at
    };
  });

  fastify.put('/:memoryId/status', async (request, reply) => {
    const { projectId, memoryId } = request.params as { projectId: string; memoryId: string };
    const { status } = request.body as { status: string };

    if (!status) {
      return reply.code(400).send({ error: 'status is required' });
    }

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(projectId)) {
      return reply.code(400).send({ error: 'projectId must be a UUID' });
    }
    if (!uuidRe.test(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Get memory with its type
      const memoryResult = await client.query<{ memory_type_id: string }>(
        'SELECT memory_type_id FROM memories WHERE id = $1 AND project_id = $2',
        [memoryId, projectId]
      );

      if (memoryResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Memory not found in this project' });
      }

      const memoryTypeId = memoryResult.rows[0].memory_type_id;

      // Get status_id for this status value and memory type (including parent type inheritance)
      const statusResult = await client.query<{ id: string }>(
        `SELECT mts.id FROM memory_type_statuses mts
         WHERE mts.status_value = $1
           AND (mts.memory_type_id = $2
                OR mts.memory_type_id = (SELECT parent_id FROM memory_types WHERE id = $2))
         LIMIT 1`,
        [status, memoryTypeId]
      );

      if (statusResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: `Status '${status}' does not match memory type or is invalid` });
      }

      const statusId = statusResult.rows[0].id;

      // Update memory with status_id
      await client.query(
        'UPDATE memories SET status_id = $1, status_updated_at = NOW() WHERE id = $2',
        [statusId, memoryId]
      );

      await client.query('COMMIT');

      return {
        memory_id: memoryId,
        status: status,
        updated_at: new Date()
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  // GET /api/projects/:projectId/memories/export - Bulk export as zip
  fastify.get('/export', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const rq = request.query as Record<string, string | undefined>;
    const typeFilter = rq.type;    // comma-separated type names
    const tagFilter = rq.tag;
    const statusFilter = rq.status;
    const format = (rq.format || 'seed') as 'seed' | 'markdown' | 'docx';

    if (!['seed', 'markdown', 'docx'].includes(format)) {
      return reply.code(400).send({ error: 'format must be one of: seed, markdown, docx' });
    }

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Build query
    const conditions: string[] = ['m.project_id = $1'];
    const params: any[] = [project.id];
    let paramIdx = 2;

    // Type filter (comma-separated, supports 'knowledge' expansion)
    if (typeFilter) {
      const typeNames = typeFilter.split(',').map(t => t.trim()).filter(Boolean);
      const expandKnowledge = typeNames.includes('knowledge');
      const otherTypes = typeNames.filter(t => t !== 'knowledge');

      if (expandKnowledge) {
        // Include knowledge + all children
        const familyResult = await query<{ id: string }>(
          `SELECT id FROM memory_types WHERE name = 'knowledge' OR parent_id = (SELECT id FROM memory_types WHERE name = 'knowledge')`,
          []
        );
        const familyIds = familyResult.map(r => r.id);

        if (otherTypes.length > 0) {
          const otherResult = await query<{ id: string }>(
            `SELECT id FROM memory_types WHERE name = ANY($1)`,
            [otherTypes]
          );
          familyIds.push(...otherResult.map(r => r.id));
        }

        if (familyIds.length > 0) {
          conditions.push(`m.memory_type_id = ANY($${paramIdx})`);
          params.push(familyIds);
          paramIdx++;
        }
      } else {
        const typeResult = await query<{ id: string }>(
          `SELECT id FROM memory_types WHERE name = ANY($1)`,
          [typeNames]
        );
        if (typeResult.length > 0) {
          conditions.push(`m.memory_type_id = ANY($${paramIdx})`);
          params.push(typeResult.map(r => r.id));
          paramIdx++;
        } else {
          // No matching types — return empty zip
          return sendEmptyZip(reply, project.handle);
        }
      }
    }

    // Tag filter
    if (tagFilter) {
      conditions.push(`EXISTS (
        SELECT 1 FROM memory_tags mtag
        JOIN tags t ON t.id = mtag.tag_id
        WHERE mtag.memory_id = m.id AND t.name = $${paramIdx}
      )`);
      params.push(tagFilter);
      paramIdx++;
    }

    // Status filter
    if (statusFilter) {
      conditions.push(`m.status_id = (
        SELECT mts.id FROM memory_type_statuses mts
        WHERE mts.status_value = $${paramIdx}
          AND (mts.memory_type_id = m.memory_type_id
               OR mts.memory_type_id = (SELECT parent_id FROM memory_types WHERE id = m.memory_type_id))
        LIMIT 1
      )`);
      params.push(statusFilter);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    const rows = await query<{
      id: string;
      handle: string;
      title: string;
      content: string;
      type: string;
      parent_type: string | null;
      status: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT m.id, m.handle, m.title, m.content,
              mt.name as type, mt_parent.name as parent_type, mt_parent.id as parent_type_id,
              mts.status_value as status,
              m.created_at, m.updated_at
       FROM memories m
       JOIN memory_types mt ON m.memory_type_id = mt.id
       LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
       LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE ${whereClause}
       ORDER BY mt.name ASC, m.handle ASC`,
      params
    );

    if (rows.length === 0) {
      return sendEmptyZip(reply, project.handle);
    }

    // Fetch tags for all memories in one query
    const memoryIds = rows.map(r => r.id);
    const tagRows = await query<{ memory_id: string; name: string }>(
      `SELECT mt.memory_id, t.name
       FROM memory_tags mt
       JOIN tags t ON t.id = mt.tag_id
       WHERE mt.memory_id = ANY($1)`,
      [memoryIds]
    );
    const tagsByMemory = new Map<string, string[]>();
    for (const t of tagRows) {
      const list = tagsByMemory.get(t.memory_id) || [];
      list.push(t.name);
      tagsByMemory.set(t.memory_id, list);
    }

    // Fetch global export settings
    const settingsRows = await query<{ key: string; value: string }>(
      "SELECT key, value FROM settings WHERE key IN ('export.imageTheme', 'export.diagramScale', 'export.pngRenderScale', 'export.pngDisplayScalePercent')"
    );
    const settingsMap = new Map(settingsRows.map((r) => [r.key, r.value]));

    // Fetch all per-memory metadata
    const metadataRows = await query<{ memory_id: string; field: string; value: string }>(
      `SELECT mm.memory_id, md.field, mm.value
       FROM memory_metadata mm
       JOIN metadata md ON mm.metadata_id = md.id
       WHERE mm.memory_id = ANY($1)
         AND md.entity_type = 'memory'`,
      [memoryIds]
    );
    const allMetadataByMemory = new Map<string, Record<string, string>>();
    for (const row of metadataRows) {
      if (!allMetadataByMemory.has(row.memory_id)) {
        allMetadataByMemory.set(row.memory_id, {});
      }
      allMetadataByMemory.get(row.memory_id)![row.field] = row.value;
    }

    // Build zip
    const ext = format === 'docx' ? '.docx' : '.md';
    const archive = archiver('zip', { zlib: { level: 9 } });

    reply.raw.setHeader('Content-Type', 'application/zip');
    reply.raw.setHeader('Content-Disposition', `attachment; filename="${project.handle}-export.zip"`);
    archive.pipe(reply.raw);

    for (let i = 0; i < rows.length; i++) {
      const mem = rows[i];
      const tags = tagsByMemory.get(mem.id) || [];
      const num = String(i + 1).padStart(2, '0');
      const filename = `${num}-${mem.handle}${ext}`;

      if (format === 'seed') {
        const seedType = mem.parent_type || mem.type;
        const seedSubtype = mem.type;
        const metadata = allMetadataByMemory.get(mem.id);
        const frontmatter = buildSeedFrontmatter(
          project.handle,
          mem.handle,
          mem.title,
          seedType,
          seedSubtype,
          tags,
          metadata
        );
        archive.append(`${frontmatter}\n${mem.content.trim()}\n`, { name: filename });
      } else if (format === 'markdown') {
        archive.append(mem.content, { name: filename });
      } else {
        // docx
        const memMeta = allMetadataByMemory.get(mem.id) || {};
        const exportImageTheme = resolveExportImageTheme({
          memoryMetadata: memMeta['export-image-theme'],
          globalSetting: settingsMap.get('export.imageTheme'),
        });
        const exportDiagramScale = resolveExportDiagramScale({
          memoryMetadata: memMeta['export-diagram-scale'],
          globalSetting: settingsMap.get('export.diagramScale'),
        });
        const exportPngRenderScale = resolveExportPngRenderScale({
          memoryMetadata: memMeta['export-png-render-scale'],
          globalSetting: settingsMap.get('export.pngRenderScale'),
          legacyMetadata: memMeta['export-diagram-scale'],
          legacySetting: settingsMap.get('export.diagramScale'),
        });
        const exportPngDisplayScalePercent = resolveExportPngDisplayScalePercent({
          memoryMetadata: memMeta['export-png-display-scale-percent'],
          globalSetting: settingsMap.get('export.pngDisplayScalePercent'),
        });
        const exportData: MemoryExportData = {
          id: mem.id,
          handle: mem.handle,
          title: mem.title,
          content: mem.content,
          type: mem.type,
          status: mem.status || 'unknown',
          project_name: project.display_name || project.name,
          project_handle: project.handle,
          tags,
          export_image_theme: exportImageTheme,
          export_diagram_scale: exportDiagramScale,
          export_png_render_scale: exportPngRenderScale,
          export_png_display_scale_percent: exportPngDisplayScalePercent,
          created_at: mem.created_at,
          updated_at: mem.updated_at,
        };
        const buffer = await memoryToDocx(exportData);
        archive.append(buffer, { name: filename });
      }
    }

    await archive.finalize();
    return reply;
  });

};

export default projectMemoryRoutes;
