import { query } from '../db/client';

/**
 * Fetch the list of hidden project handles from settings.
 * Returns an empty array if no hidden projects are configured.
 */
export async function getHiddenProjectHandles(): Promise<string[]> {
  const rows = await query<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'projects.hidden'"
  );
  if (rows.length === 0) return [];
  const raw = rows[0].value;
  if (!raw || !raw.trim()) return [];
  return raw.split(',').map(h => h.trim()).filter(Boolean);
}
