/**
 * Text formatter for suggested relations results.
 * Converts verbose JSON into compact agent-readable text.
 */

function truncate(s: string, maxLen: number): string {
  if (!s) return '';
  const clean = s.replace(/\n/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen - 3) + '...';
}

export function formatSuggestedRelations(data: any): string {
  const lines: string[] = [];
  const source = data.source || {};
  const suggestions = data.suggestions || [];
  const sourceTitle = source.title || 'Unknown';

  lines.push(`# Suggested Relations for "${sourceTitle}" (${suggestions.length} suggestions)`);
  lines.push('');

  if (suggestions.length === 0) {
    lines.push('No suggestions found.');
    return lines.join('\n');
  }

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    const m = s.memory || s;
    const type = m.type || m.memory_type || '';
    const title = m.title || '';
    const handle = m.handle || '';
    const score = typeof s.score === 'number' ? ` (score: ${s.score.toFixed(2)})` : '';
    const relationType = s.suggested_relation_type || s.suggested_relation || s.relation_type || 'relates_to';

    lines.push(`${i + 1}. → ${relationType} "${title}" [${type}]${score}`);

    const idParts: string[] = [];
    if (m.id) idParts.push(`ID: ${m.id}`);
    if (handle) idParts.push(`Handle: ${handle}`);
    if (idParts.length) lines.push(`   ${idParts.join(' | ')}`);

    if (m.content_excerpt || m.excerpt) {
      lines.push(`   ${truncate(m.content_excerpt || m.excerpt, 120)}`);
    }

    if (i < suggestions.length - 1) lines.push('');
  }

  return lines.join('\n').trimEnd();
}
