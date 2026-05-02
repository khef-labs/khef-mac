/**
 * Text formatters for saved query tools.
 */

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  return dateStr.substring(0, 10);
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.substring(0, max - 1) + '…';
}

export function formatSavedQueryList(data: any): string {
  const queries = data.saved_queries || [];
  const lines: string[] = [];
  lines.push(`# Saved queries (${queries.length})`);
  lines.push('');

  if (queries.length === 0) {
    lines.push('No saved queries found.');
    return lines.join('\n');
  }

  for (const q of queries) {
    const star = q.is_favorite ? '★ ' : '';
    const shared = q.is_shared ? ' [shared]' : '';
    const conn = q.connection_id ? ` · conn ${q.connection_id.substring(0, 8)}` : ' · any conn';
    const desc = q.description ? ` — ${truncate(q.description, 100)}` : '';
    lines.push(`- ${star}**${q.name}** (\`${q.handle}\`)${shared}${desc}`);
    lines.push(`  ID: ${q.id}${conn} · v${q.version} · updated ${formatDate(q.updated_at)}`);
  }

  return lines.join('\n');
}

export function formatSavedQuery(data: any): string {
  const q = data.saved_query;
  if (!q) return 'Saved query not found.';

  const lines: string[] = [];
  const star = q.is_favorite ? '★ ' : '';
  lines.push(`# ${star}${q.name}`);
  lines.push('');
  lines.push(`- Handle: \`${q.handle}\``);
  lines.push(`- ID: ${q.id}`);
  if (q.connection_id) {
    lines.push(`- Connection: ${q.connection_id}`);
  } else {
    lines.push(`- Connection: any`);
  }
  if (q.schema_scope) lines.push(`- Schema scope: \`${q.schema_scope}\``);
  lines.push(`- Version: ${q.version} · ${q.is_readonly ? 'read-only' : 'writable'}${q.is_shared ? ' · shared' : ''}`);
  lines.push(`- Updated: ${formatDate(q.updated_at)}`);

  if (q.description) {
    lines.push('');
    lines.push(`## Description`);
    lines.push(q.description);
  }

  if (q.params && q.params.length > 0) {
    lines.push('');
    lines.push('## Parameters');
    for (const p of q.params) {
      const req = p.required ? ' required' : '';
      const def = p.default_value !== null && p.default_value !== undefined ? ` default=${JSON.stringify(p.default_value)}` : '';
      const opts = p.options ? ` options=${JSON.stringify(p.options)}` : '';
      lines.push(`- \`:${p.name}\` (${p.value_type}${req})${def}${opts}`);
    }
  }

  lines.push('');
  lines.push('## SQL');
  lines.push('```sql');
  lines.push(q.sql || '');
  lines.push('```');

  return lines.join('\n');
}

export function formatSavedQuerySnapshotList(data: any): string {
  const snapshots = data.snapshots || [];
  const lines: string[] = [];
  lines.push(`# Saved query snapshots (${snapshots.length})`);
  lines.push('');
  if (snapshots.length === 0) {
    lines.push('_No snapshots yet._');
    return lines.join('\n');
  }
  for (const s of snapshots) {
    const author = s.edited_by ? ` by \`${s.edited_by}\`` : '';
    const preview = (s.sql || '').replace(/\n/g, ' ').trim();
    const trimmed = preview.length > 100 ? preview.substring(0, 99) + '…' : preview;
    lines.push(`- **v${s.snapshot_number}** (${s.source}) — ${formatDate(s.edited_at)}${author}`);
    lines.push(`  \`${trimmed}\``);
  }
  return lines.join('\n');
}

export function formatSavedQueryRunResult(data: any): string {
  const lines: string[] = [];
  const truncated = data.truncated ? ' (truncated)' : '';
  lines.push(`# Saved query run`);
  lines.push('');
  lines.push(`- Rows: ${data.rowCount}${truncated}`);
  lines.push(`- Duration: ${data.duration}ms`);
  lines.push(`- queryId: ${data.queryId}`);

  const cols = data.columns || [];
  const rows = data.rows || [];

  if (cols.length === 0 || rows.length === 0) {
    lines.push('');
    lines.push('_No rows returned._');
    return lines.join('\n');
  }

  // Markdown table
  const header = cols.map((c: any) => c.name).join(' | ');
  const sep = cols.map(() => '---').join(' | ');
  lines.push('');
  lines.push(`| ${header} |`);
  lines.push(`| ${sep} |`);

  const max = Math.min(rows.length, 50);
  for (let i = 0; i < max; i++) {
    const row = rows[i] || [];
    const cells = row.map((cell: unknown) => {
      if (cell === null || cell === undefined) return '_null_';
      if (typeof cell === 'object') return JSON.stringify(cell);
      const s = String(cell);
      return s.length > 80 ? s.substring(0, 79) + '…' : s;
    }).join(' | ');
    lines.push(`| ${cells} |`);
  }
  if (rows.length > max) {
    lines.push('');
    lines.push(`_…${rows.length - max} more rows omitted._`);
  }

  return lines.join('\n');
}
