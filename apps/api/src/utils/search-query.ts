/**
 * Helpers for interpreting user search queries.
 *
 * Khef memory search uses PostgreSQL full-text search, which is case-insensitive
 * and stemmed. To make case matter when the user types it explicitly, we detect
 * case-significant tokens in the query and emit a regex that callers can use to
 * multiply the rank when title/content/handle contains the exact case.
 */

/**
 * Extract tokens from the query that should boost rank when matched with exact case.
 * Includes words inside "quoted phrases" and bare words, and skips:
 *   - negated words starting with `-`
 *   - the literal keyword `or` (websearch_to_tsquery OR separator)
 *   - tokens without any uppercase letters
 *   - tokens shorter than 2 chars
 */
export function extractCaseTokens(q: string): string[] {
  const tokens: string[] = [];

  // Extract words inside quoted phrases first — remove them from the remaining
  // string so we don't double-count.
  const remaining = q.replace(/"([^"]+)"/g, (_, inner: string) => {
    for (const word of inner.split(/\s+/).filter(Boolean)) {
      tokens.push(word);
    }
    return '';
  });

  for (const word of remaining.split(/\s+/).filter(Boolean)) {
    if (word.startsWith('-')) continue;
    if (word.toLowerCase() === 'or') continue;
    tokens.push(word);
  }

  return [...new Set(tokens.filter(t => /[A-Z]/.test(t) && t.length >= 2))];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a PostgreSQL POSIX regex pattern that matches any of the case-significant
 * tokens with word boundaries. Returns null when no case-significant tokens are
 * present (the caller should then skip the boost).
 */
export function buildCaseBoostPattern(q: string): string | null {
  const tokens = extractCaseTokens(q);
  if (tokens.length === 0) return null;
  const alt = tokens.map(escapeRegex).join('|');
  // \y is Postgres POSIX word boundary; keeps "API" from matching inside "APId".
  return `\\y(${alt})\\y`;
}

/**
 * Normalize a user-typed query for `websearch_to_tsquery`.
 *
 * websearch syntax uses `-term` for negation; a literal `NOT` is dropped as an
 * english stopword. Users commonly type `NOT word` expecting exclusion, so this
 * rewrites `NOT word` (case-insensitive, word-bounded) into `-word`. Text inside
 * double-quoted phrases is preserved verbatim so phrase search still works.
 */
export function normalizeWebsearchQuery(q: string): string {
  let out = '';
  let i = 0;
  while (i < q.length) {
    if (q[i] === '"') {
      // Copy the quoted phrase (including the closing quote) unchanged.
      const end = q.indexOf('"', i + 1);
      if (end === -1) {
        out += q.slice(i);
        break;
      }
      out += q.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const next = q.indexOf('"', i);
    const chunk = next === -1 ? q.slice(i) : q.slice(i, next);
    out += chunk.replace(/(^|\s)NOT(\s+)/gi, '$1-');
    i += chunk.length;
  }
  return out;
}
