/**
 * Text formatter for document search results.
 * Converts verbose JSON into compact agent-readable text.
 */

function truncate(s: string, maxLen: number): string {
  if (!s) return '';
  const clean = s.replace(/\n/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen - 3) + '...';
}

export function formatDocSearchResults(data: any, args: Record<string, unknown>): string {
  const lines: string[] = [];
  const results = data.results || [];
  const query = args.q as string || '';

  // Header
  lines.push(`# Doc Search: "${query}" (${results.length} results)`);

  // Filters
  const filters: string[] = [];
  if (args.project) filters.push(`Project: ${args.project}`);
  if (args.tag) filters.push(`Tag: ${args.tag}`);
  if (args.file_type) filters.push(`Type: ${args.file_type}`);
  if (filters.length > 0) lines.push(`Filters: ${filters.join(' | ')}`);
  lines.push('');

  if (results.length === 0) {
    lines.push('No results found.');
    return lines.join('\n');
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const score = typeof r.score === 'number' ? ` (${r.score.toFixed(2)})` : '';
    const fileType = r.file_type ? ` [${r.file_type}]` : '';
    const displayPath = r.source_path || r.file_path || '';
    const title = r.title ? `${r.title} — ` : '';

    lines.push(`${i + 1}. ${title}${displayPath}${fileType}${score}`);

    // Metadata line
    const meta: string[] = [];
    if (r.project_handle) meta.push(`project: ${r.project_handle}`);
    if (r.tags && r.tags.length > 0) meta.push(`tags: ${r.tags.join(', ')}`);
    if (meta.length > 0) lines.push(`   ${meta.join(' | ')}`);

    // Content preview
    if (r.content) {
      lines.push(`   ${truncate(r.content, 200)}`);
    }

    if (i < results.length - 1) lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function formatDocContent(data: any): string {
  const lines: string[] = [];
  const chunks = data.chunks || [];
  const pagination = data.pagination || {};
  const title = data.title || data.document_id || 'Unknown document';
  const fileType = data.file_type ? ` [${data.file_type}]` : '';

  // Header
  lines.push(`# ${title}${fileType}`);

  const meta: string[] = [];
  if (data.project_handle) meta.push(`Project: ${data.project_handle}`);
  if (data.tags && data.tags.length > 0) meta.push(`Tags: ${data.tags.join(', ')}`);
  if (data.source_path) meta.push(`Path: ${data.source_path}`);
  if (meta.length > 0) lines.push(meta.join(' | '));

  lines.push(`Chunks ${pagination.offset + 1}-${pagination.offset + chunks.length} of ${pagination.total_chunks}`);
  lines.push('');

  if (chunks.length === 0) {
    lines.push('No content available.');
    return lines.join('\n');
  }

  for (const chunk of chunks) {
    lines.push(chunk.content);
    lines.push('');
  }

  if (pagination.has_more) {
    lines.push(`--- More content available. Use offset=${pagination.offset + pagination.limit} to continue reading. ---`);
  }

  return lines.join('\n').trimEnd();
}
