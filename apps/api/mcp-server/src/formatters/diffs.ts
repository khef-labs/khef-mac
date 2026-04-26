/**
 * Text formatters for commit list and diff comments.
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

export function formatCommitList(data: any, args: Record<string, unknown>): string {
  const lines: string[] = [];
  const commits = data.commits || [];

  lines.push(`# Commits (${commits.length} results)`);

  const branch = args.branch || data.branch;
  const path = args.path;
  const meta: string[] = [];
  if (branch) meta.push(`Branch: ${branch}`);
  if (path) meta.push(`Path: ${path}`);
  if (meta.length > 0) lines.push(meta.join(' | '));
  lines.push('');

  if (commits.length === 0) {
    lines.push('No commits found.');
    return lines.join('\n');
  }

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const sha = c.short_sha || (c.sha ? c.sha.substring(0, 7) : '');
    const message = c.message || c.subject || '';
    // Message may be multi-line; take first line only
    const subject = message.split('\n')[0];
    const author = c.author || c.author_name || '';
    const date = formatDate(c.date || c.author_date || c.created_at);

    lines.push(`${i + 1}. [${sha}] ${subject}`);
    lines.push(`   ${author} | ${date}`);

    if (i < commits.length - 1) lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function formatDiff(data: any): string {
  const lines: string[] = [];

  // API returns { diff: string, stats: { files, insertions, deletions }, refs: { branch, commit_sha, parent_sha } }
  const refs = data.refs || {};
  const stats = data.stats || {};
  const content = typeof data.diff === 'string' ? data.diff : '';

  const ref = refs.commit_sha || 'working';
  const shortRef = ref === 'working' ? 'working tree' : (ref.length > 7 ? ref.substring(0, 7) : ref);

  lines.push(`# Diff: ${shortRef}`);
  const meta: string[] = [];
  if (refs.branch) meta.push(`Branch: ${refs.branch}`);
  if (stats.files) meta.push(`${stats.files} files`);
  if (stats.insertions != null) meta.push(`+${stats.insertions}`);
  if (stats.deletions != null) meta.push(`-${stats.deletions}`);
  if (meta.length) lines.push(meta.join(' | '));
  lines.push('');

  if (content) {
    lines.push(content);
  } else {
    lines.push('No diff content.');
  }

  return lines.join('\n').trimEnd();
}

export function formatCommitComments(data: any): string {
  const lines: string[] = [];
  const comments = data.comments || [];
  const commitSha = data.commit_sha || '';
  const shortSha = commitSha.length > 7 ? commitSha.substring(0, 7) : commitSha;

  lines.push(`# Comments on ${shortSha || 'commit'} (${comments.length})`);
  lines.push('');

  if (comments.length === 0) {
    lines.push('No comments found.');
    return lines.join('\n');
  }

  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    const author = c.author || 'anonymous';
    const status = c.status || 'active';
    const date = formatDate(c.created_at);
    const content = truncate(c.content, 120);

    const cId = c.id ? ` ${c.id}` : '';
    lines.push(`${i + 1}. [${status}]${cId} ${author} (${date}): "${content}"`);

    if (c.anchor_path) {
      const lineInfo = c.anchor_line != null ? `:${c.anchor_line}` : '';
      lines.push(`   File: ${c.anchor_path}${lineInfo}`);
    } else if (c.anchor_text) {
      lines.push(`   Anchored to: "${truncate(c.anchor_text, 80)}"`);
    }

    if (i < comments.length - 1) lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function formatDiffComments(data: any): string {
  const lines: string[] = [];
  const diff = data.diff || data;
  const comments = diff.comments || data.comments || [];
  const ref = diff.commit_sha || diff.ref || 'unknown';
  const branch = diff.branch || '';
  const filesChanged = diff.stats?.files_changed || diff.files_changed || '';

  // Header
  const shortRef = ref === 'working' ? 'working tree' : (ref.length > 7 ? ref.substring(0, 7) : ref);
  lines.push(`# Diff: ${shortRef} (${comments.length} comments)`);

  const meta: string[] = [];
  if (branch) meta.push(`Branch: ${branch}`);
  if (filesChanged) meta.push(`${filesChanged} files changed`);
  if (meta.length > 0) lines.push(meta.join(' | '));
  lines.push('');

  if (comments.length === 0) {
    lines.push('No comments on this diff.');
    return lines.join('\n');
  }

  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    const author = c.author || 'anonymous';
    const status = c.status || 'active';
    const content = truncate(c.content, 120);

    const cId = c.id ? ` ${c.id}` : '';
    lines.push(`${i + 1}. [${status}]${cId} ${author}: "${content}"`);

    // Anchor info
    if (c.anchor_path) {
      const lineInfo = c.anchor_line != null ? `:${c.anchor_line}` : '';
      lines.push(`   File: ${c.anchor_path}${lineInfo}`);
    } else if (c.anchor_text) {
      lines.push(`   Anchored to: "${truncate(c.anchor_text, 80)}"`);
    }

    if (i < comments.length - 1) lines.push('');
  }

  return lines.join('\n').trimEnd();
}
