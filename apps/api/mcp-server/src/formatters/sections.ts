/**
 * Text formatter for get_memory_outline responses.
 * Converts verbose JSON into a compact, indented outline.
 */

export function formatOutline(data: any): string {
  const lines: string[] = [];

  lines.push(`# ${data.title}`);
  lines.push(`Memory: ${data.memory_id} | Length: ${data.total_length} chars`);
  lines.push('');

  const sections = data.sections || [];
  if (sections.length === 0) {
    lines.push('No sections found.');
    return lines.join('\n');
  }

  for (const s of sections) {
    const indent = '  '.repeat(Math.max(0, s.level - 1));
    const chars = s.end - s.start;
    const contentPreview = s.content
      ? ` — ${truncate(s.content, 100)}`
      : '';
    lines.push(`${indent}${'#'.repeat(s.level)} ${s.heading} (${chars} chars)${contentPreview}`);
  }

  return lines.join('\n').trimEnd();
}

function truncate(s: string, maxLen: number): string {
  if (!s) return '';
  const clean = s.replace(/\n/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen - 3) + '...';
}
