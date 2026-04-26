/**
 * Text formatters for Slack search and document listing.
 * Converts verbose JSON into compact agent-readable text.
 */

function truncate(s: string, maxLen: number): string {
  if (!s) return '';
  const clean = s.replace(/\n/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen - 3) + '...';
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  return dateStr.substring(0, 10);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatSlackSearchResults(data: any, args: Record<string, unknown>): string {
  const lines: string[] = [];
  const results = data.results || [];
  const query = args.q as string || '';

  lines.push(`# Slack Search: "${query}" (${data.total_count ?? results.length} results)`);

  const filters: string[] = [];
  if (args.channel) filters.push(`Channel: ${args.channel}`);
  if (args.workspace) filters.push(`Workspace: ${args.workspace}`);
  if (filters.length > 0) lines.push(`Filters: ${filters.join(' | ')}`);
  lines.push('');

  if (results.length === 0) {
    lines.push('No results found.');
    return lines.join('\n');
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const score = typeof r.score === 'number' ? ` (${r.score.toFixed(2)})` : '';
    const docId = r.document_id || '';
    const meta = r.metadata || {};
    const channel = meta.channel ? `#${meta.channel}` : '';
    const workspace = meta.workspace ? `[${meta.workspace}]` : '';

    const header = [workspace, channel, docId].filter(Boolean).join(' ');
    lines.push(`${i + 1}. ${header}${score}`);

    if (meta.source_file) {
      lines.push(`   Source: ${meta.source_file}`);
    }

    if (r.content) {
      lines.push(`   ${truncate(r.content, 300)}`);
    }

    if (i < results.length - 1) lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function formatSlackChannelList(data: any): string {
  const lines: string[] = [];
  const channels = data.channels || [];

  lines.push(`# Slack Channels (${data.total_count ?? channels.length})`);
  lines.push('');

  if (channels.length === 0) {
    lines.push('No channels found.');
    return lines.join('\n');
  }

  for (const ch of channels) {
    const docs = ch.document_count != null ? `${ch.document_count} docs` : '';
    const chunks = ch.chunk_count != null ? `${ch.chunk_count} chunks` : '';
    const updated = formatDate(ch.last_updated);
    const details = [docs, chunks, updated ? `Updated: ${updated}` : ''].filter(Boolean).join(' | ');
    lines.push(`- #${ch.channel}  ${details}`);
  }

  return lines.join('\n').trimEnd();
}

export function formatSlackDocumentList(data: any): string {
  const lines: string[] = [];
  const docs = data.documents || [];
  const pagination = data.pagination;
  const total = pagination?.total_count ?? docs.length;

  lines.push(`# Slack Documents (${docs.length} of ${total})`);
  lines.push('');

  if (docs.length === 0) {
    lines.push('No documents found.');
    return lines.join('\n');
  }

  const offset = pagination?.offset ?? 0;
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const docId = d.document_id || d.file_path || '';
    const meta = d.metadata || {};
    const channel = meta.channel ? `#${meta.channel}` : '';
    const workspace = meta.workspace ? `[${meta.workspace}]` : '';
    const chunks = d.chunk_count != null ? `${d.chunk_count} chunks` : '';
    const size = d.file_size ? formatSize(d.file_size) : '';
    const updated = formatDate(d.updated_at);

    const header = [workspace, channel].filter(Boolean).join(' ');
    lines.push(`${offset + i + 1}. ${docId}${header ? ` ${header}` : ''}`);

    const details: string[] = [];
    if (chunks) details.push(chunks);
    if (size) details.push(size);
    if (updated) details.push(`Updated: ${updated}`);
    if (details.length) lines.push(`   ${details.join(' | ')}`);

    if (i < docs.length - 1) lines.push('');
  }

  if (pagination?.has_more) {
    lines.push('');
    lines.push(`Showing ${offset + 1}-${offset + docs.length} of ${total}`);
  }

  return lines.join('\n').trimEnd();
}
