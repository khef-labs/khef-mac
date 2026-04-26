import { query } from '../db/client';

/**
 * Fetch the list of hidden kdag definition keys from settings.
 * Returns an empty array if no hidden definitions are configured.
 */
export async function getHiddenDefinitionKeys(): Promise<string[]> {
  const rows = await query<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'kdag.definitions.hidden'"
  );
  if (rows.length === 0) return [];
  const raw = rows[0].value;
  if (!raw || !raw.trim()) return [];
  return raw.split(',').map(k => k.trim()).filter(Boolean);
}
