/**
 * Text formatters for plan tools:
 * get_plan_by_id, get_plan_by_name, search_plans, search_plan
 */

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  return String(dateStr).substring(0, 10);
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.substring(0, max - 1) + '…';
}

function formatComment(c: any): string {
  const author = c.author || 'user';
  const cId = c.id ? ` ${c.id}` : '';
  const status = c.status !== 'active' ? ` [${c.status}]` : '';
  const anchor = c.anchor_text ? ` (on: "${truncate(c.anchor_text, 60)}")` : '';
  const reply = c.parent_comment_id ? '  ↳ ' : '- ';
  return `${reply}**${author}**${cId}${status}${anchor}: ${truncate(c.content, 200)}`;
}

export function formatPlan(data: any): string {
  const lines: string[] = [];
  const p = data.plan || data;

  lines.push(`# ${p.title || 'Untitled Plan'}`);
  lines.push(`Filename: \`${p.filename}\` | Status: ${p.status} | Version: ${p.current_version}/${p.version_count ?? '?'}`);
  lines.push(`ID: ${p.id} | Updated: ${formatDate(p.updated_at)}`);
  if (p.project_id) lines.push(`Project: ${p.project_id}`);
  lines.push('');

  if (p.content) {
    lines.push('## Content');
    lines.push(p.content);
  }

  const comments = data.comments;
  if (comments && comments.length > 0) {
    lines.push('');
    lines.push(`## Comments (${comments.length})`);
    for (const c of comments) {
      lines.push(formatComment(c));
    }
  }

  return lines.join('\n').trimEnd();
}

export function formatPlanSearchResults(rows: any[]): string {
  if (rows.length === 0) return 'No plans found.';

  const lines: string[] = [`Found ${rows.length} plan(s):\n`];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const project = r.project_name ? ` | Project: ${r.project_name}` : '';
    const size = r.size ? ` | ${r.size} bytes` : '';
    lines.push(`${i + 1}. **${r.title || 'Untitled'}** (\`${r.filename}\`)`);
    lines.push(`   ID: ${r.id} | Status: ${r.status} | v${r.current_version}${size}${project}`);
    lines.push(`   Updated: ${formatDate(r.updated_at)}`);
    if (r.content_excerpt) {
      lines.push(`   > ${truncate(r.content_excerpt, 150)}`);
    }
  }
  return lines.join('\n').trimEnd();
}

export interface PlanContentMatch {
  section: string;
  excerpts: string[];
}

export function formatPlanContentSearch(
  plan: { id: string; title: string; filename: string },
  query: string,
  matches: PlanContentMatch[]
): string {
  const totalHits = matches.reduce((sum, m) => sum + m.excerpts.length, 0);
  if (totalHits === 0) return `No matches for "${query}" in plan "${plan.title}".`;

  const lines: string[] = [
    `# Search: "${query}" in ${plan.title}`,
    `Plan: \`${plan.filename}\` | ID: ${plan.id} | ${totalHits} match(es)\n`,
  ];

  for (const m of matches) {
    lines.push(`## ${m.section}`);
    for (const excerpt of m.excerpts) {
      lines.push(`> …${excerpt}…`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
