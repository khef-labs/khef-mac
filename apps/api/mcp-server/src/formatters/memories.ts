/**
 * Text formatters for memory search results and single memory detail.
 * Converts verbose JSON into compact agent-readable text.
 */

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  return dateStr.substring(0, 10);
}

function formatTags(tags: any[]): string {
  if (!tags?.length) return '';
  return ' #' + tags.map((t: any) => t.name || t).join(' #');
}

function formatTypeName(m: any): string {
  const type = m.type || m.memory_type || '';
  const parent = m.parent_type || '';
  return parent ? `${parent} > ${type}` : type;
}

function formatMemoryListItem(m: any, index: number): string {
  const lines: string[] = [];
  const type = formatTypeName(m);
  const status = m.status || m.status_value || '';
  const project = m.project_handle || m.project_name || '';
  const tags = formatTags(m.tags);
  const pinned = m.is_pinned ? ' [pinned]' : '';
  const score = typeof m.score === 'number' ? ` (score: ${m.score.toFixed(3)})` : '';

  lines.push(`${index}. [${type}] ${m.title} (${status})${pinned}${score} [${project}]${tags}`);

  const id = m.id || '';
  const updated = formatDate(m.updated_at);
  const excerpt = m.content_excerpt || '';
  const metaParts: string[] = [];
  if (id) metaParts.push(`ID: ${id}`);
  if (updated) metaParts.push(`Updated: ${updated}`);
  if (metaParts.length) lines.push(`   ${metaParts.join(' | ')}`);
  if (excerpt) lines.push(`   Excerpt: ${truncate(excerpt, 120)}`);

  return lines.join('\n');
}

export function formatSearchResults(data: any, query?: string): string {
  const lines: string[] = [];
  const memories = data.memories || data.results || [];
  const pagination = data.pagination;
  const total = pagination?.total_count ?? memories.length;

  // Header
  const queryPart = query ? `: "${query}"` : '';
  lines.push(`# Search${queryPart} (${memories.length} results, ${total} total)`);
  lines.push('');

  if (memories.length === 0) {
    lines.push('No results found.');
    return lines.join('\n');
  }

  // Results
  const offset = pagination?.offset ?? 0;
  for (let i = 0; i < memories.length; i++) {
    lines.push(formatMemoryListItem(memories[i], offset + i + 1));
    if (i < memories.length - 1) lines.push('');
  }

  // Pagination footer
  if (pagination && pagination.has_more) {
    const limit = pagination.limit || 20;
    const page = Math.floor(offset / limit) + 1;
    const totalPages = Math.ceil(total / limit);
    lines.push('');
    lines.push(`Page ${page} of ${totalPages} (${limit} per page)`);
  }

  return lines.join('\n').trimEnd();
}

export function formatMemory(data: any, files?: any[]): string {
  const lines: string[] = [];
  const m = data.memory || data;

  const type = formatTypeName(m);
  const status = m.status || m.status_value || '';
  const handle = m.handle || '';
  const project = m.project_handle || m.project_name || '';
  const tags = m.tags?.length ? m.tags.map((t: any) => t.name || t).join(', ') : '';
  const created = formatDate(m.created_at);
  const updated = formatDate(m.updated_at);
  const pinned = m.is_pinned ? ' [pinned]' : '';

  // Header
  lines.push(`# ${m.title}${pinned}`);
  lines.push(`ID: ${m.id || ''} | Type: ${type} | Status: ${status} | Handle: ${handle}`);

  const metaParts: string[] = [];
  if (project) metaParts.push(`Project: ${project}`);
  if (tags) metaParts.push(`Tags: ${tags}`);
  if (metaParts.length) lines.push(metaParts.join(' | '));

  lines.push(`Created: ${created} | Updated: ${updated}`);
  lines.push('');

  // Content
  if (m.content) {
    lines.push(m.content);
  }

  // Files
  if (files?.length) {
    lines.push('');
    lines.push(`## Files (${files.length})`);
    for (const f of files) {
      lines.push(`  - ${f.original_filename} (${f.mime_type}, ${formatSize(f.size)})`);
      lines.push(`    Path: ${f.disk_path}`);
    }
  }

  // Metadata
  const metadata = m.metadata || {};
  const metaKeys = Object.keys(metadata);
  if (metaKeys.length > 0) {
    lines.push('');
    lines.push('## Metadata');
    for (const key of metaKeys) {
      lines.push(`  ${key}: ${metadata[key]}`);
    }
  }

  // Comments
  const comments = m.comments || [];
  if (comments.length > 0) {
    lines.push('');
    lines.push(`## Comments (${comments.length})`);
    for (const c of comments) {
      const author = c.author || 'anonymous';
      const date = formatDate(c.created_at);
      const cId = c.id ? ` ${c.id}` : '';
      const anchor = c.anchor_text ? `\n    Anchored to: "${truncate(c.anchor_text, 80)}"` : '';
      lines.push(`  [${c.status || 'active'}]${cId} ${author} (${date}): "${truncate(c.content, 120)}"${anchor}`);
    }
  }

  return lines.join('\n').trimEnd();
}

export function formatMemorySnapshots(data: any): string {
  const lines: string[] = [];
  const snapshots = data.snapshots || [];

  lines.push(`# Memory Snapshots (${snapshots.length}) — current: #${data.current_snapshot}`);
  lines.push('');

  if (snapshots.length === 0) {
    lines.push('No snapshots found.');
    return lines.join('\n');
  }

  for (const s of snapshots) {
    const current = s.is_current ? ' ← current' : '';
    const size = s.content_size != null ? formatSize(s.content_size) : '?';
    const comments = s.comment_count > 0 ? `  ${s.comment_count} comment${s.comment_count !== 1 ? 's' : ''}` : '';
    lines.push(`  #${s.snapshot_number}  ${s.source || 'unknown'}  ${formatDate(s.created_at)}  ${size}${comments}${current}`);
  }

  return lines.join('\n').trimEnd();
}

export function formatSnapshotDiff(data: any): string {
  const lines: string[] = [];

  const from = data.from;
  const to = data.to;
  const stats = data.stats;
  const changes = data.changes || [];
  const pagination = data.pagination;

  // Header
  lines.push(`# Snapshot Diff: ${from.snapshot_number}${from.source === 'current' ? ' (current)' : ''} → ${to.snapshot_number}${to.source === 'current' ? ' (current)' : ''}`);
  lines.push(`From: snapshot ${from.snapshot_number} (${formatDate(from.created_at)}) | To: snapshot ${to.snapshot_number} (${formatDate(to.created_at)})`);
  lines.push(`Stats: +${stats.additions} -${stats.deletions} =${stats.unchanged}`);
  lines.push('');

  if (changes.length === 0) {
    lines.push('No differences found.');
    return lines.join('\n');
  }

  // Render changes as unified diff
  for (const change of changes) {
    if (change.type === 'skip') {
      lines.push(`  ... (${change.lines_skipped} unchanged lines) ...`);
    } else if (change.type === 'add') {
      for (const line of change.value.split('\n')) {
        lines.push(`+ ${line}`);
      }
    } else if (change.type === 'remove') {
      for (const line of change.value.split('\n')) {
        lines.push(`- ${line}`);
      }
    } else {
      // equal
      for (const line of change.value.split('\n')) {
        lines.push(`  ${line}`);
      }
    }
  }

  // Pagination footer
  if (pagination && pagination.has_more) {
    lines.push('');
    lines.push(`Showing ${changes.length} of ${pagination.total_changes} change blocks (offset: ${pagination.offset})`);
  }

  return lines.join('\n').trimEnd();
}

/**
 * Format a compact memory mutation result (create/update responses).
 * These return minimal fields: id, handle, status, timestamps.
 * Optionally includes a source label (e.g., the file path used).
 */
export function formatMutationResult(data: any, opts?: { action?: string; source?: string }): string {
  const lines: string[] = [];
  const m = data.memory || data;
  const action = opts?.action || 'Saved';

  lines.push(`${action}: ${m.title || m.handle || m.id}`);
  lines.push(`ID: ${m.id}`);
  if (m.handle) lines.push(`Handle: ${m.handle}`);
  if (m.status) lines.push(`Status: ${m.status}`);
  if (opts?.source) lines.push(`Source: ${opts.source}`);
  lines.push(`Updated: ${formatDate(m.updated_at)}`);

  return lines.join('\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncate(s: string, maxLen: number): string {
  if (!s) return '';
  const clean = s.replace(/\n/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen - 3) + '...';
}
