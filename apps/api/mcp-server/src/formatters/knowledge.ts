/**
 * Text formatters for knowledge and agent rules responses.
 * Renders commands, context, patterns, and rules as organized markdown sections.
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

export function formatAgentRules(data: any, projectId?: string): string {
  const lines: string[] = [];
  const memories = data.memories || data.results || [];
  const total = data.pagination?.total_count ?? memories.length;
  const project = projectId || 'unknown';

  lines.push(`# Agent Rules: ${project} (${total} rules)`);
  lines.push('');

  if (memories.length === 0) {
    lines.push('No rules found.');
    return lines.join('\n');
  }

  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    const status = m.status || m.status_value || 'active';
    const handle = m.handle || '';
    const updated = formatDate(m.updated_at);

    const id = m.id || '';
    lines.push(`${i + 1}. ${m.title} (${status})`);
    lines.push(`   ID: ${id} | Handle: ${handle} | Updated: ${updated}`);

    if (m.content_excerpt || m.content) {
      lines.push(`   ${truncate(m.content_excerpt || m.content, 150)}`);
    }

    if (i < memories.length - 1) lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function formatProjectKnowledge(data: any): string {
  const lines: string[] = [];
  const projectName = data.project?.name || data.project?.handle || 'Unknown';

  lines.push(`# Knowledge: ${projectName}`);
  lines.push('');

  // Commands
  const commandEntries = data.commands || [];
  if (commandEntries.length > 0) {
    lines.push(`## Commands (${commandEntries.length} entries)`);
    lines.push('');
    for (const entry of commandEntries) {
      const entryId = entry.id ? ` (${entry.id})` : '';
      lines.push(`### ${entry.title}${entryId}`);
      lines.push(entry.content || '(empty)');
      lines.push('');
    }
  }

  // Context entries
  const contextEntries = data.context || [];
  if (contextEntries.length > 0) {
    lines.push(`## Context (${contextEntries.length} entries)`);
    lines.push('');
    for (const entry of contextEntries) {
      const entryId = entry.id ? ` (${entry.id})` : '';
      lines.push(`### ${entry.title}${entryId}`);
      lines.push(entry.content || '(empty)');
      lines.push('');
    }
  }

  // Pattern entries
  const patternEntries = data.patterns || [];
  if (patternEntries.length > 0) {
    lines.push(`## Patterns (${patternEntries.length} entries)`);
    lines.push('');
    for (const entry of patternEntries) {
      const entryId = entry.id ? ` (${entry.id})` : '';
      lines.push(`### ${entry.title}${entryId}`);
      lines.push(entry.content || '(empty)');
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}
