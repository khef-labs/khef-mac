import { FastifyPluginAsync } from 'fastify';
import { query, getClient } from '../db/client';
import { Memory } from '../types';
import { normalizeWebsearchQuery } from '../utils/search-query';
import {
  parseMarkdownSections,
  findSection,
  findSectionForOffset,
  extractSectionContent,
  replaceSectionContent,
  getDirectContent,
  MemoryOutline,
  SectionContent,
  WithinMemorySearchResult,
  WithinMemorySearchSectionResult
} from '../utils/markdown-sections';
import { generateExcerpt } from '../utils/excerpt';
import { isUuid, isPartialUuid, resolvePartialMemoryId } from '../utils/uuid';

interface MemoryRow extends Memory {
  type: string;
  parent_type?: string;
  status?: string;
  project_handle: string;
  project_name: string;
}

interface SearchMatchRow {
  chunk_index: number | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSearchTerms(queryText: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const normalized = queryText.trim();

  if (!normalized) {
    return [];
  }

  for (const match of normalized.matchAll(/"([^"]+)"/g)) {
    const phrase = match[1].trim();
    const key = phrase.toLowerCase();
    if (phrase && !seen.has(key)) {
      seen.add(key);
      terms.push(phrase);
    }
  }

  const unquoted = normalized.replace(/"[^"]+"/g, ' ');
  for (const token of unquoted.split(/\s+/)) {
    const cleaned = token
      .replace(/^[+\-()]+|[+\-()]+$/g, '')
      .replace(/[^\p{L}\p{N}_-]+/gu, '')
      .trim();
    const lower = cleaned.toLowerCase();
    if (!cleaned || cleaned.length < 2 || ['and', 'or', 'not'].includes(lower)) {
      continue;
    }
    if (!seen.has(lower)) {
      seen.add(lower);
      terms.push(cleaned);
    }
  }

  if (terms.length === 0) {
    return [normalized];
  }

  return terms.sort((a, b) => b.length - a.length);
}

function collectMatches(content: string, terms: string[]): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  const occupied: Array<{ start: number; end: number }> = [];

  for (const term of terms) {
    const regex = new RegExp(escapeRegExp(term), 'giu');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const overlaps = occupied.some((range) => start < range.end && end > range.start);
      if (!overlaps) {
        matches.push({ start, end });
        occupied.push({ start, end });
      }
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

function buildExcerpt(content: string, matchStart: number, matchEnd: number, contextChars: number = 90): string {
  const excerptStart = Math.max(0, matchStart - contextChars);
  const excerptEnd = Math.min(content.length, matchEnd + contextChars);
  const prefix = excerptStart > 0 ? '...' : '';
  const suffix = excerptEnd < content.length ? '...' : '';
  const before = content.slice(excerptStart, matchStart).replace(/\s+/g, ' ');
  const matched = content.slice(matchStart, matchEnd).replace(/\s+/g, ' ');
  const after = content.slice(matchEnd, excerptEnd).replace(/\s+/g, ' ');
  return `${prefix}${before}**${matched}**${after}${suffix}`.trim();
}

function formatWithinMemorySearch(result: WithinMemorySearchResult): string {
  const lines: string[] = [
    `# ${result.title}`,
    `Query: \`${result.query}\``,
    `Matches: ${result.match_count} excerpt${result.match_count === 1 ? '' : 's'} in ${result.sections.length} section${result.sections.length === 1 ? '' : 's'}`,
    ''
  ];

  if (result.sections.length === 0) {
    lines.push('No matches found.');
    return lines.join('\n').trimEnd();
  }

  for (const section of result.sections) {
    lines.push(`${'#'.repeat(Math.max(2, section.level + 1))} ${section.heading}`);
    for (const hit of section.hits) {
      lines.push(`> ${hit.excerpt}`);
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}

async function searchWithinMemory(memory: MemoryRow, queryText: string): Promise<WithinMemorySearchResult> {
  const searchRows = await query<SearchMatchRow>(
    `WITH search_query AS (
       SELECT websearch_to_tsquery('english', $2) AS q
     )
     SELECT NULL::integer AS chunk_index
     FROM memories m, search_query sq
     WHERE m.id = $1 AND m.content_tsv @@ sq.q
     UNION
     SELECT mc.chunk_index
     FROM memory_chunks mc, search_query sq
     WHERE mc.memory_id = $1 AND mc.content_tsv @@ sq.q
     ORDER BY chunk_index NULLS FIRST`,
    [memory.id, normalizeWebsearchQuery(queryText)]
  );

  if (searchRows.length === 0) {
    return {
      memory_id: memory.id,
      title: memory.title,
      query: queryText,
      match_count: 0,
      sections: [],
      markdown: formatWithinMemorySearch({
        memory_id: memory.id,
        title: memory.title,
        query: queryText,
        match_count: 0,
        sections: [],
        markdown: ''
      })
    };
  }

  const sections = parseMarkdownSections(memory.content);
  const fallbackSection = sections.length === 0
    ? [{
        heading: 'Document body',
        level: 1,
        start: 0,
        end: memory.content.length,
        contentStart: 0
      }]
    : sections;
  const terms = extractSearchTerms(queryText);
  const allMatches = collectMatches(memory.content, terms);
  const matchedChunkIndexes = new Set(
    searchRows
      .map((row) => row.chunk_index)
      .filter((value): value is number => value !== null)
  );
  const sectionMap = new Map<string, WithinMemorySearchSectionResult>();

  for (const match of allMatches) {
    const section = findSectionForOffset(fallbackSection, match.start) ?? fallbackSection[0];
    const excerpt = buildExcerpt(memory.content, match.start, match.end);
    const key = `${section.start}:${section.heading}`;
    const existing = sectionMap.get(key) ?? {
      heading: section.heading,
      level: section.level,
      start: section.start,
      end: section.end,
      hits: []
    };

    if (!existing.hits.some((hit) => hit.match_start === match.start && hit.match_end === match.end)) {
      existing.hits.push({
        excerpt,
        match_start: match.start,
        match_end: match.end
      });
    }

    sectionMap.set(key, existing);
  }

  if (sectionMap.size === 0 && matchedChunkIndexes.size > 0) {
    for (const chunkIndex of matchedChunkIndexes) {
      const section = fallbackSection[0];
      const key = `${section.start}:${section.heading}`;
      sectionMap.set(key, {
        heading: section.heading,
        level: section.level,
        start: section.start,
        end: section.end,
        hits: [{
          excerpt: generateExcerpt(memory.content, 240),
          match_start: 0,
          match_end: 0
        }]
      });
    }
  }

  const sectionsWithHits = Array.from(sectionMap.values())
    .map((section) => ({
      ...section,
      hits: section.hits
        .sort((a, b) => a.match_start - b.match_start)
        .slice(0, 5)
    }))
    .sort((a, b) => a.start - b.start);

  const result: WithinMemorySearchResult = {
    memory_id: memory.id,
    title: memory.title,
    query: queryText,
    match_count: sectionsWithHits.reduce((sum, section) => sum + section.hits.length, 0),
    sections: sectionsWithHits,
    markdown: ''
  };
  result.markdown = formatWithinMemorySearch(result);
  return result;
}

/**
 * Fetch a memory by UUID with all relevant fields.
 */
async function fetchMemory(memoryId: string): Promise<MemoryRow> {
  const rows = await query<MemoryRow>(
    `SELECT m.id, m.project_id, m.handle, m.title, m.content, m.memory_type_id, m.status_id,
            m.status_updated_at, m.created_at, m.updated_at,
            mt.name as type, mt_parent.name as parent_type,
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
    throw { statusCode: 404, message: 'Memory not found' };
  }

  return rows[0];
}

/**
 * Update memory content and handle re-chunking if needed.
 */
async function updateMemoryContent(memoryId: string, newContent: string): Promise<MemoryRow> {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // Update the memory content (mark for vector sync)
    await client.query(
      `UPDATE memories SET content = $1, updated_at = NOW(), vector_synced_at = NULL WHERE id = $2`,
      [newContent, memoryId]
    );

    // Delete existing chunks
    await client.query('DELETE FROM memory_chunks WHERE memory_id = $1', [memoryId]);

    // Re-chunk if content exceeds threshold (2000 chars)
    const CHUNK_SIZE = 2000;
    if (newContent.length > CHUNK_SIZE) {
      const chunks: string[] = [];
      let remaining = newContent;

      while (remaining.length > 0) {
        if (remaining.length <= CHUNK_SIZE) {
          chunks.push(remaining);
          break;
        }

        // Find a good break point (paragraph or sentence)
        let breakPoint = remaining.lastIndexOf('\n\n', CHUNK_SIZE);
        if (breakPoint === -1 || breakPoint < CHUNK_SIZE * 0.5) {
          breakPoint = remaining.lastIndexOf('. ', CHUNK_SIZE);
        }
        if (breakPoint === -1 || breakPoint < CHUNK_SIZE * 0.5) {
          breakPoint = remaining.lastIndexOf(' ', CHUNK_SIZE);
        }
        if (breakPoint === -1) {
          breakPoint = CHUNK_SIZE;
        }

        chunks.push(remaining.slice(0, breakPoint + 1));
        remaining = remaining.slice(breakPoint + 1);
      }

      // Insert chunks
      for (let i = 0; i < chunks.length; i++) {
        await client.query(
          'INSERT INTO memory_chunks (memory_id, chunk_index, content) VALUES ($1, $2, $3)',
          [memoryId, i, chunks[i]]
        );
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // Fetch and return the updated memory
  return fetchMemory(memoryId);
}

const memorySectionsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/memories/:memoryId/outline
  fastify.get<{
    Params: { memoryId: string };
    Querystring: { include_content?: string };
  }>('/:memoryId/outline', async (request, reply) => {
    let { memoryId } = request.params;
    const includeContent = request.query.include_content !== 'false';

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

    try {
      const memory = await fetchMemory(memoryId);
      const sections = parseMarkdownSections(memory.content);

      const outline: MemoryOutline = {
        memory_id: memoryId,
        title: memory.title,
        sections: sections.map(s => ({
          heading: s.heading,
          level: s.level,
          start: s.start,
          end: s.end,
          ...(includeContent ? { content: getDirectContent(memory.content, s) } : {})
        })),
        total_length: memory.content.length
      };

      return outline;
    } catch (error: any) {
      if (error.statusCode === 404) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
  });

  // GET /api/memories/:memoryId/sections/:heading
  fastify.get<{
    Params: { memoryId: string; heading: string };
    Querystring: { include_subsections?: string; index?: string };
  }>('/:memoryId/sections/:heading', async (request, reply) => {
    let { memoryId, heading } = request.params;
    const { include_subsections, index: indexStr } = request.query;
    const index = indexStr ? parseInt(indexStr, 10) : 0;

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

    try {
      const memory = await fetchMemory(memoryId);
      const sections = parseMarkdownSections(memory.content);
      const decodedHeading = decodeURIComponent(heading);
      const section = findSection(sections, decodedHeading, index);

      if (!section) {
        const indexMsg = index > 0 ? ` at index ${index}` : '';
        return reply.code(404).send({ error: `Section "${decodedHeading}"${indexMsg} not found` });
      }

      const includeSubsections = include_subsections !== 'false';
      const content = extractSectionContent(memory.content, section, includeSubsections);

      const result: SectionContent = {
        memory_id: memoryId,
        heading: section.heading,
        level: section.level,
        content,
        start: section.start,
        end: section.end
      };

      return result;
    } catch (error: any) {
      if (error.statusCode === 404) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
  });

  // GET /api/memories/:memoryId/search
  fastify.get<{
    Params: { memoryId: string };
    Querystring: { q?: string };
  }>('/:memoryId/search', async (request, reply) => {
    let { memoryId } = request.params;
    const queryText = request.query.q?.trim();

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

    if (!queryText) {
      return reply.code(400).send({ error: 'q is required' });
    }

    try {
      const memory = await fetchMemory(memoryId);
      return await searchWithinMemory(memory, queryText);
    } catch (error: any) {
      if (error.statusCode === 404) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
  });

  // PATCH /api/memories/:memoryId/sections/:heading
  fastify.patch<{
    Params: { memoryId: string; heading: string };
    Body: { content: string; new_heading?: string; index?: number; replace_subsections?: boolean };
  }>('/:memoryId/sections/:heading', async (request, reply) => {
    let { memoryId, heading } = request.params;
    const { content: newContent, new_heading: newHeading, index = 0, replace_subsections: replaceSubsections } = request.body;

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

    if (typeof newContent !== 'string') {
      return reply.code(400).send({ error: 'content is required' });
    }

    try {
      const memory = await fetchMemory(memoryId);
      const sections = parseMarkdownSections(memory.content);
      const decodedHeading = decodeURIComponent(heading);
      const section = findSection(sections, decodedHeading, index);

      if (!section) {
        const indexMsg = index > 0 ? ` at index ${index}` : '';
        return reply.code(404).send({ error: `Section "${decodedHeading}"${indexMsg} not found` });
      }

      const updatedContent = replaceSectionContent(memory.content, section, newContent, newHeading, { replaceSubsections: replaceSubsections ?? false });
      const updated = await updateMemoryContent(memoryId, updatedContent);

      // Return compact memory format
      return {
        memory: {
          id: updated.id,
          project_id: updated.project_id,
          project_handle: updated.project_handle,
          project_name: updated.project_name,
          handle: updated.handle,
          title: updated.title,
          type: updated.type,
          ...(updated.parent_type ? { parent_type: updated.parent_type } : {}),
          status: updated.status,
          updated_at: updated.updated_at,
          content_excerpt: generateExcerpt(updatedContent)
        }
      };
    } catch (error: any) {
      if (error.statusCode === 404) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
  });
};

export default memorySectionsRoutes;
