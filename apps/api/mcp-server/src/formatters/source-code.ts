/**
 * Text formatters for source code and commit search results.
 * Converts verbose JSON into compact agent-readable text.
 */

function truncate(s: string, maxLen: number): string {
  if (!s) return '';
  const clean = s.replace(/\n/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen - 3) + '...';
}

function groupSourceResultsForDisplay(results: any[], args: Record<string, unknown>) {
  const view = typeof args.view === 'string' ? args.view.toLowerCase() : '';
  const groupByFile = view === 'all' ? false : (args.group_by_file !== false);
  const maxPerFileRaw = Number(args.max_per_file);
  const maxPerFile = Number.isFinite(maxPerFileRaw) && maxPerFileRaw >= 1
    ? Math.floor(maxPerFileRaw)
    : 1;

  if (!groupByFile) {
    return {
      displayResults: results,
      hiddenByFile: new Map<string, any[]>(),
      maxPerFile,
      groupByFile,
    };
  }

  const byFile = new Map<string, any[]>();
  const fileOrder: string[] = [];
  for (const r of results) {
    const filePath = r.file_path || r.filePath || '';
    if (!byFile.has(filePath)) {
      byFile.set(filePath, []);
      fileOrder.push(filePath);
    }
    byFile.get(filePath)!.push(r);
  }

  const displayResults: any[] = [];
  const hiddenByFile = new Map<string, any[]>();
  for (const filePath of fileOrder) {
    const fileResults = byFile.get(filePath) || [];
    displayResults.push(...fileResults.slice(0, maxPerFile));
    hiddenByFile.set(filePath, fileResults.slice(maxPerFile));
  }

  return { displayResults, hiddenByFile, maxPerFile, groupByFile };
}

export function formatSourceResults(data: any, args: Record<string, unknown>): string {
  const lines: string[] = [];
  const results = data.results || [];
  const query = args.q as string || '';
  const { displayResults, hiddenByFile, maxPerFile, groupByFile } = groupSourceResultsForDisplay(results, args);

  // Header
  lines.push(`# Source Search: "${query}" (${displayResults.length}/${results.length} shown)`);

  // Filters
  const filters: string[] = [];
  if (args.repo) filters.push(`Repo: ${args.repo}`);
  if (args.language) filters.push(`Language: ${args.language}`);
  if (args.branch) filters.push(`Branch: ${args.branch}`);
  if (args.commit) filters.push(`Commit: ${args.commit}`);
  if (filters.length > 0) lines.push(`Filters: ${filters.join(' | ')}`);
  if (groupByFile) lines.push(`Grouped by file: yes | Max per file: ${maxPerFile}`);
  lines.push('');

  if (results.length === 0) {
    lines.push('No results found.');
    return lines.join('\n');
  }

  for (let i = 0; i < displayResults.length; i++) {
    const r = displayResults[i];
    const score = typeof r.score === 'number' ? ` (${r.score.toFixed(2)})` : '';
    const lang = r.language ? ` [${r.language}]` : '';
    const filePath = r.file_path || r.filePath || '';

    lines.push(`${i + 1}. ${filePath}${lang}${score}`);

    // Content preview (with optional context chunks)
    const hasContext = r.context_before?.length > 0 || r.context_after?.length > 0;
    if (hasContext) {
      const chunkInfo = r.chunk_index != null ? `Chunk ${r.chunk_index}` : '';
      const beforeIdx = (r.context_before || []).map((c: any) => c.chunk_index);
      const afterIdx = (r.context_after || []).map((c: any) => c.chunk_index);
      const rangeChunks = [...beforeIdx, r.chunk_index, ...afterIdx].filter((x: any) => x != null);
      const rangeStr = rangeChunks.length > 1 ? ` (chunks ${rangeChunks[0]}-${rangeChunks[rangeChunks.length - 1]})` : '';
      lines.push(`   ${chunkInfo}${rangeStr}`);

      // Before context
      for (const bc of (r.context_before || [])) {
        lines.push(`   ${bc.content}`);
      }
      // Matched chunk (full content)
      if (r.content) {
        lines.push(`   >>> ${r.content}`);
      }
      // After context
      for (const ac of (r.context_after || [])) {
        lines.push(`   ${ac.content}`);
      }
    } else if (r.content) {
      const chunkInfo = r.chunk_index != null ? `Chunk ${r.chunk_index} | ` : '';
      const charCount = r.content.length;
      lines.push(`   ${chunkInfo}${charCount} chars`);
      lines.push(`   ${truncate(r.content, 150)}`);
    }

    const hidden = hiddenByFile.get(filePath) || [];
    if (groupByFile && hidden.length > 0) {
      const hiddenChunks = hidden
        .map((x) => x.chunk_index)
        .filter((x) => x != null)
        .slice(0, 6);
      const chunkPreview = hiddenChunks.length > 0 ? ` (more chunks: ${hiddenChunks.join(', ')})` : '';
      lines.push(`   + ${hidden.length} more match${hidden.length === 1 ? '' : 'es'} in this file${chunkPreview}`);
    }

    if (i < displayResults.length - 1) lines.push('');
  }

  if (groupByFile && results.length > displayResults.length) {
    lines.push('');
    lines.push(`Tip: use format=json to inspect all raw chunks, or pass max_per_file > ${maxPerFile} if supported.`);
  }

  return lines.join('\n').trimEnd();
}

export function formatCommitSearchResults(data: any, args: Record<string, unknown>): string {
  const lines: string[] = [];
  const results = data.results || [];
  const pagination = data.pagination || {};
  const query = args.q as string || '';

  // Header
  lines.push(`# Commit Search: "${query}" (${pagination.total_count ?? results.length} results)`);

  // Filters
  const filters: string[] = [];
  if (args.repo) filters.push(`Repo: ${args.repo}`);
  if (args.author) filters.push(`Author: ${args.author}`);
  if (args.branch) filters.push(`Branch: ${args.branch}`);
  if (args.since) filters.push(`Since: ${args.since}`);
  if (args.until) filters.push(`Until: ${args.until}`);
  if (filters.length > 0) lines.push(`Filters: ${filters.join(' | ')}`);
  lines.push('');

  if (results.length === 0) {
    lines.push('No results found.');
    return lines.join('\n');
  }

  const offset = pagination.offset || 0;
  for (let i = 0; i < results.length; i++) {
    const c = results[i];
    const date = c.date ? c.date.slice(0, 10) : '';
    const score = typeof c.score === 'number' ? ` (${c.score.toFixed(2)})` : '';
    const subject = (c.message || '').split('\n')[0];

    lines.push(`${offset + i + 1}. [${c.short_sha || c.sha?.substring(0, 7) || ''}] ${subject}${score}`);
    lines.push(`   ${c.author || ''} | ${date}${c.repo ? ` | ${c.repo}` : ''}`);

    if (i < results.length - 1) lines.push('');
  }

  // Pagination
  if (pagination.has_more) {
    lines.push('');
    lines.push(`Showing ${offset + 1}-${offset + results.length} of ${pagination.total_count}`);
  }

  return lines.join('\n').trimEnd();
}

export function formatSessionSummary(data: any): string {
  const lines: string[] = [];
  const summary = data.summary || null;
  const snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
  const job = data.job || null;

  lines.push('# Session Summary');

  if (!summary) {
    lines.push('');
    lines.push('No summary available for this session.');
    if (job) {
      lines.push(`Job status: ${job.status || 'unknown'}`);
    }
    return lines.join('\n').trimEnd();
  }

  lines.push(`Snapshot: ${summary.id}`);
  if (summary.assistant_handle) {
    lines.push(`Assistant: ${summary.assistant_handle}`);
  }
  if (summary.created_at) {
    lines.push(`Generated: ${summary.created_at.substring(0, 10)}`);
  }
  if (summary.updated_at) {
    lines.push(`Updated: ${summary.updated_at.substring(0, 10)}`);
  }
  if (snapshots.length > 0) {
    lines.push(`Snapshots: ${snapshots.length}`);
  }
  lines.push('');
  lines.push(summary.content);

  if (job) {
    lines.push('');
    lines.push(`Job: ${job.status || 'unknown'}`);
  }

  return lines.join('\n').trimEnd();
}

export function formatSourceFileView(data: any): string {
  const lines: string[] = [];
  const repo = data.repo || '';
  const filePath = data.path || '';
  const ref = data.ref || null;
  const start = typeof data.start === 'number' ? data.start : 1;
  const end = typeof data.end === 'number' ? data.end : start;
  const total = typeof data.total_lines === 'number' ? data.total_lines : end;
  const content = typeof data.content === 'string' ? data.content : '';

  const refLabel = ref ? ` @ ${ref}` : '';
  const header = repo ? `${repo}:${filePath}` : filePath;
  lines.push(`# ${header}${refLabel}`);
  lines.push(`Lines ${start}-${end} of ${total}`);
  lines.push('');

  const bodyLines = content.split('\n');
  const width = String(start + bodyLines.length - 1).length;
  for (let i = 0; i < bodyLines.length; i++) {
    const lineNum = String(start + i).padStart(width, ' ');
    lines.push(`${lineNum}  ${bodyLines[i]}`);
  }

  return lines.join('\n').trimEnd();
}
