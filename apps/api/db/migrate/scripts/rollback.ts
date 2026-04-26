import * as dotenv from 'dotenv';
import { expand } from 'dotenv-expand';

expand(dotenv.config());
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { autoBackup } from './auto-backup';

interface Migration {
  version: string;
  filename: string;
  filepath: string;
}

interface ParsedMigration {
  up: string;
  down: string;
}

/**
 * Parse a migration file to extract UP and DOWN sections
 */
function parseMigrationFile(filepath: string): ParsedMigration {
  const content = readFileSync(filepath, 'utf-8');

  // Split on -- DOWN marker
  const downMarkerRegex = /^--\s*DOWN\s*$/m;
  const parts = content.split(downMarkerRegex);

  if (parts.length !== 2) {
    throw new Error(`Migration file ${filepath} must have exactly one "-- DOWN" marker`);
  }

  let upSection = parts[0];
  const downSection = parts[1];

  // Remove everything before -- UP marker in up section
  const upMarkerRegex = /^--\s*UP\s*$/m;
  const upMatch = upSection.match(upMarkerRegex);
  if (upMatch && upMatch.index !== undefined) {
    upSection = upSection.substring(upMatch.index + upMatch[0].length);
  }

  return {
    up: upSection.trim(),
    down: downSection.trim()
  };
}

/**
 * Find migration file by version
 */
function findMigrationFile(version: string): string {
  const migrationsDir = join(__dirname, '..', 'migrations');

  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql') && f.startsWith(version));

  if (files.length === 0) {
    throw new Error(`Migration file not found for version: ${version}`);
  }

  if (files.length > 1) {
    throw new Error(`Multiple migration files found for version: ${version}`);
  }

  return join(migrationsDir, files[0]);
}

/**
 * Find the most recently applied migration
 */
async function findLastAppliedMigration(client: Client): Promise<string | null> {
  const result = await client.query(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].version;
}

/**
 * Rollback a single migration
 */
async function rollbackMigration(client: Client, version: string): Promise<void> {
  const filepath = findMigrationFile(version);
  const filename = filepath.split('/').pop() || version;

  console.log(`Rolling back migration: ${filename}`);

  const parsed = parseMigrationFile(filepath);

  // Run rollback in a transaction
  await client.query('BEGIN');
  try {
    // Execute DOWN section
    await client.query(parsed.down);

    // Remove from schema_migrations
    await client.query(
      'DELETE FROM schema_migrations WHERE version = $1',
      [version]
    );

    await client.query('COMMIT');
    console.log(`✓ Rolled back: ${filename}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw new Error(`Failed to rollback ${filename}: ${error}`);
  }
}

/**
 * Main rollback function
 */
async function rollback() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  try {
    await client.connect();
    console.log('Connected to database');

    // Find last applied migration
    const lastVersion = await findLastAppliedMigration(client);

    if (!lastVersion) {
      console.log('No migrations to rollback');
      return;
    }

    // Auto-backup before rollback
    autoBackup();

    // Rollback the migration
    await rollbackMigration(client, lastVersion);

    console.log('Rollback completed successfully');
  } catch (error) {
    console.error('Rollback failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

// Run if called directly
if (require.main === module) {
  rollback();
}

export default rollback;
