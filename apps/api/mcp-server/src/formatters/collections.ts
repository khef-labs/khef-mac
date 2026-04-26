/**
 * Text formatters for collection tools.
 * Converts verbose JSON into compact agent-readable text.
 */

export function formatCollectionList(data: any): string {
  const lines: string[] = [];
  const collections = data.collections || [];
  const pagination = data.pagination;

  lines.push(`# Collections (${pagination?.total_count ?? collections.length})`);
  lines.push('');

  if (collections.length === 0) {
    lines.push('No collections found.');
    return lines.join('\n');
  }

  for (const c of collections) {
    const desc = c.description ? ` — ${c.description.slice(0, 80)}` : '';
    const viewMode = c.view_mode && c.view_mode !== 'list' ? ` [${c.view_mode}]` : '';
    const childCount = c.child_count ? ` | ${c.child_count} sub` : '';
    lines.push(`- **${c.name}** (${c.memory_count} memories${childCount})${viewMode}${desc}`);
    lines.push(`  Handle: ${c.handle} | ID: ${c.id}${c.parent_id ? ` | Parent: ${c.parent_id}` : ''}`);
    if (c.children && c.children.length > 0) {
      const subs = c.children.map((ch: any) => `${ch.name} (${ch.memory_count})`).join(', ');
      lines.push(`  Sub-collections: ${subs}`);
    }
  }

  if (pagination?.has_more) {
    lines.push('');
    lines.push(`Showing ${collections.length} of ${pagination.total_count}. Use offset=${(pagination.offset || 0) + (pagination.limit || 20)} for more.`);
  }

  return lines.join('\n').trimEnd();
}

export function formatCollectionDetail(data: any): string {
  const lines: string[] = [];
  const c = data.collection;

  if (!c) return 'Collection not found.';

  lines.push(`# ${c.name}`);
  const meta = [`Handle: ${c.handle}`, `ID: ${c.id}`, `Memories: ${c.memory_count ?? 0}`];
  if (c.view_mode && c.view_mode !== 'list') meta.push(`View: ${c.view_mode}`);
  if (c.parent_id) meta.push(`Parent: ${c.parent_id}`);
  lines.push(meta.join(' | '));
  if (c.description) {
    lines.push(`Description: ${c.description}`);
  }
  lines.push('');

  // Show sub-collections if any
  const children = c.children || [];
  if (children.length > 0) {
    lines.push(`## Sub-collections (${children.length})`);
    for (const ch of children) {
      const mode = ch.view_mode && ch.view_mode !== 'list' ? ` [${ch.view_mode}]` : '';
      lines.push(`- ${ch.name} (${ch.memory_count} memories)${mode}`);
      lines.push(`  Handle: ${ch.handle} | ID: ${ch.id}`);
    }
    lines.push('');
  }

  const memories = c.memories || [];
  if (memories.length === 0) {
    lines.push('No memories in this collection.');
    return lines.join('\n');
  }

  for (const m of memories) {
    const status = m.status ? ` (${m.status})` : '';
    const type = m.type || '';
    lines.push(`${m.position}. [${type}] ${m.title}${status}`);
    lines.push(`   ID: ${m.id} | Handle: ${m.handle}`);
    if (m.content_excerpt) {
      lines.push(`   ${m.content_excerpt.slice(0, 120)}`);
    }
  }

  return lines.join('\n').trimEnd();
}
