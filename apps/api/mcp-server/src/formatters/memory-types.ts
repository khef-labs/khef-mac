/**
 * Text formatter for memory type list results.
 * Converts verbose JSON into compact agent-readable text.
 */

export function formatMemoryTypes(data: any): string {
  const lines: string[] = [];
  const types = data.types || data.memory_types || [];

  lines.push(`# Memory Types (${types.length} types)`);
  lines.push('');

  if (types.length === 0) {
    lines.push('No memory types found.');
    return lines.join('\n');
  }

  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    const builtIn = t.built_in ? 'built-in' : 'custom';
    const count = t.memory_count ?? t.count ?? '';
    const countStr = count !== '' ? `, ${count} memories` : '';
    const parent = t.parent_name ? ` (child of ${t.parent_name})` : '';
    const desc = t.description ? `  ${t.description}` : '';

    lines.push(`- **${t.type || t.name}** (${builtIn}${countStr})${parent}`);

    if (desc) {
      lines.push(desc);
    }

    // Statuses
    const statuses = t.statuses || [];
    if (statuses.length > 0) {
      const statusValues = statuses
        .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((s: any) => s.status_value || s.value);
      lines.push(`  Statuses: ${statusValues.join(' → ')}`);
    }

    // Children
    const children = t.children || [];
    if (children.length > 0) {
      const childNames = children.map((c: any) => typeof c === 'string' ? c : (c.type || c.name));
      lines.push(`  Children: ${childNames.join(', ')}`);
    }

    if (i < types.length - 1) lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function formatMemoryType(data: any): string {
  const lines: string[] = [];
  const t = data.memory_type && typeof data.memory_type === 'object' ? data.memory_type : data;

  const typeName = t.type || t.name || '';
  const builtIn = t.built_in ? 'built-in' : 'custom';
  const parent = t.parent_name || t.parent_type ? ` (child of ${t.parent_name || t.parent_type})` : '';
  lines.push(`# ${typeName} (${builtIn})${parent}`);

  if (t.description) {
    lines.push(t.description);
  }

  const statuses = t.statuses || [];
  if (statuses.length > 0) {
    lines.push('');
    lines.push('## Statuses');
    const sorted = statuses.sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    lines.push(sorted.map((s: any) => s.status_value || s.value).join(' → '));
  }

  const children = t.children || [];
  if (children.length > 0) {
    lines.push('');
    lines.push('## Children');
    lines.push(children.map((c: any) => typeof c === 'string' ? c : (c.type || c.name)).join(', '));
  }

  return lines.join('\n').trimEnd();
}

export function formatMemoryTypeStatuses(data: any): string {
  const lines: string[] = [];
  const statuses = data.statuses || [];
  const typeName = data.type_name || data.memory_type || data.type || data.name || '';

  lines.push(`# Statuses for "${typeName}" (${statuses.length})`);
  lines.push('');

  if (statuses.length === 0) {
    lines.push('No statuses defined.');
    return lines.join('\n');
  }

  const sorted = statuses.sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  for (const s of sorted) {
    const display = s.display_name ? ` (${s.display_name})` : '';
    const isDefault = s.sort_order === 0 ? ' [default]' : '';
    lines.push(`- ${s.status_value || s.value}${display}${isDefault}`);
  }

  return lines.join('\n').trimEnd();
}

export function formatProjectMemoryTypes(data: any): string {
  const lines: string[] = [];
  const types = data.types || data.memory_types || [];

  lines.push(`# Project Memory Types (${types.length})`);
  lines.push('');

  if (types.length === 0) {
    lines.push('No types found.');
    return lines.join('\n');
  }

  for (const t of types) {
    const count = t.memory_count ?? t.count ?? 0;
    lines.push(`- **${t.type || t.name}**: ${count} memories`);
  }

  return lines.join('\n').trimEnd();
}
