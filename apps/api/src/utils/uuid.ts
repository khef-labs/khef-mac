/**
 * UUID validation utilities
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Partial UUID: at least 8 hex chars with optional dashes */
export const PARTIAL_UUID_RE = /^[0-9a-f][0-9a-f-]{7,}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isPartialUuid(value: string): boolean {
  return !isUuid(value) && PARTIAL_UUID_RE.test(value);
}

/**
 * Resolve a partial UUID prefix to a full memory ID.
 * Returns the full UUID if exactly one match, null if 0 or 2+ matches.
 */
export async function resolvePartialMemoryId(partial: string): Promise<string | null> {
  const { query } = await import('../db/client');
  const rows = await query<{ id: string }>(
    `SELECT id::text FROM memories WHERE id::text LIKE $1 LIMIT 2`,
    [partial.toLowerCase() + '%']
  );
  return rows.length === 1 ? rows[0].id : null;
}
