/**
 * Text formatters for tag tools.
 * Converts verbose JSON into compact agent-readable text.
 */

export function formatTagList(data: any): string {
  const lines: string[] = [];
  const tags = data.tags || [];

  lines.push(`# Tags (${tags.length})`);
  lines.push('');

  if (tags.length === 0) {
    lines.push('No tags found.');
    return lines.join('\n');
  }

  for (const t of tags) {
    const count = t.memory_count != null ? ` (${t.memory_count})` : '';
    const id = t.id ? ` [${t.id}]` : '';
    lines.push(`- ${t.name}${count}${id}`);
  }

  return lines.join('\n').trimEnd();
}

export function formatTagMemories(data: any): string {
  const lines: string[] = [];
  const memories = data.memories || [];
  const tag = data.tag || '';

  lines.push(`# Memories tagged "${tag}" (${memories.length})`);
  lines.push('');

  if (memories.length === 0) {
    lines.push('No memories found.');
    return lines.join('\n');
  }

  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    const type = m.type || m.memory_type || '';
    const status = m.status || m.status_value || '';
    const project = m.project_handle || m.project_name || '';
    lines.push(`${i + 1}. [${type}] ${m.title} (${status}) [${project}]`);
    if (m.id) lines.push(`   ID: ${m.id}`);
    if (i < memories.length - 1) lines.push('');
  }

  return lines.join('\n').trimEnd();
}
