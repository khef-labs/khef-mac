/**
 * Text formatters for prompt tools:
 * list_prompts, get_prompt
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

export function formatPromptList(data: any): string {
  const lines: string[] = [];
  const prompts = data.prompts || [];
  const pagination = data.pagination;

  const total = pagination?.total_count ?? prompts.length;
  lines.push(`# Prompts (${total})`);
  lines.push('');

  if (prompts.length === 0) {
    lines.push('No prompts found.');
    return lines.join('\n');
  }

  for (const p of prompts) {
    const assistants = (p.assistants || [])
      .map((a: any) => `${a.assistant_handle}:${a.prompt_type}`)
      .join(', ');
    const assocStr = assistants ? ` [${assistants}]` : '';
    const desc = p.description
      ? truncate(p.description, 120)
      : truncate(p.content_excerpt || '', 120);
    lines.push(`- **${p.title}** (\`${p.handle}\`)${assocStr}${desc ? ' — ' + desc : ''}`);
    lines.push(`  ID: ${p.id} | Updated: ${formatDate(p.updated_at)}`);
  }

  if (pagination?.has_more) {
    lines.push('');
    lines.push(`Showing ${prompts.length} of ${total}. Use offset=${(pagination.offset || 0) + (pagination.limit || 50)} for next page.`);
  }

  return lines.join('\n').trimEnd();
}

export function formatPrompt(data: any): string {
  const lines: string[] = [];
  const p = data.prompt || data;

  lines.push(`# ${p.title} (\`${p.handle}\`)`);
  if (p.description) lines.push(p.description);
  lines.push(`ID: ${p.id} | Snapshot: ${p.current_snapshot ?? '?'} | Updated: ${formatDate(p.updated_at)}`);

  const assistants = (p.assistants || [])
    .map((a: any) => `${a.assistant_handle}:${a.prompt_type}${a.source_path ? ` (${a.source_path})` : ''}`)
    .join(', ');
  if (assistants) lines.push(`Assistants: ${assistants}`);
  lines.push('');

  if (p.content) {
    lines.push('## Content');
    lines.push(p.content);
  }

  return lines.join('\n').trimEnd();
}
