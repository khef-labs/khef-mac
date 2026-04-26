import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';
import { setupTestDb, TEST_DATABASE_URL } from '../setup';

process.env.DATABASE_URL = TEST_DATABASE_URL;

import { loadBackupConfig } from '../../src/services/session-backup-worker';

describe('session-backup-worker loadBackupConfig', () => {
  let client: Client;

  beforeAll(async () => {
    await setupTestDb();
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query(
      `DELETE FROM settings WHERE key IN ('sessions.backupPath', 'sessions.backupEnabled', 'sessions.backupIntervalMinutes')`
    );
  });

  async function setSettings(values: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      await client.query(
        `INSERT INTO settings (key, value, description, value_type) VALUES ($1, $2, 'test', 'string')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value]
      );
    }
  }

  it('returns disabled with default interval when no settings exist', async () => {
    const config = await loadBackupConfig();
    expect(config.enabled).toBe(false);
    expect(config.backupPath).toBe('');
    expect(config.intervalMinutes).toBe(10);
  });

  it('treats missing backup path as disabled even when the flag is on', async () => {
    await setSettings({
      'sessions.backupEnabled': 'true',
      'sessions.backupPath': '',
    });
    const config = await loadBackupConfig();
    expect(config.enabled).toBe(false);
    expect(config.backupPath).toBe('');
  });

  it('returns enabled when flag is true and a path is set', async () => {
    await setSettings({
      'sessions.backupEnabled': 'true',
      'sessions.backupPath': '/tmp/archive',
    });
    const config = await loadBackupConfig();
    expect(config.enabled).toBe(true);
    expect(config.backupPath).toBe('/tmp/archive');
  });

  it('uses the configured interval when it is within bounds', async () => {
    await setSettings({
      'sessions.backupEnabled': 'true',
      'sessions.backupPath': '/tmp/archive',
      'sessions.backupIntervalMinutes': '60',
    });
    const config = await loadBackupConfig();
    expect(config.intervalMinutes).toBe(60);
  });

  it('clamps interval below the minimum up to 1', async () => {
    await setSettings({
      'sessions.backupEnabled': 'true',
      'sessions.backupPath': '/tmp/archive',
      'sessions.backupIntervalMinutes': '0',
    });
    // Worker treats non-positive values as invalid and falls back to the default.
    const config = await loadBackupConfig();
    expect(config.intervalMinutes).toBe(10);
  });

  it('clamps interval above the maximum down to 1440', async () => {
    await setSettings({
      'sessions.backupEnabled': 'true',
      'sessions.backupPath': '/tmp/archive',
      'sessions.backupIntervalMinutes': '99999',
    });
    const config = await loadBackupConfig();
    expect(config.intervalMinutes).toBe(1440);
  });

  it('falls back to default interval when setting is not a valid number', async () => {
    await setSettings({
      'sessions.backupEnabled': 'true',
      'sessions.backupPath': '/tmp/archive',
      'sessions.backupIntervalMinutes': 'banana',
    });
    const config = await loadBackupConfig();
    expect(config.intervalMinutes).toBe(10);
  });
});
