import * as dotenv from 'dotenv';
import { expand } from 'dotenv-expand';

expand(dotenv.config());
import { readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

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
function findMigrationFile(version: string): string | null {
  const migrationsDir = join(__dirname, '..', 'migrations');

  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql') && f.startsWith(version));

  if (files.length === 0) {
    return null;
  }

  if (files.length > 1) {
    throw new Error(`Multiple migration files found for version: ${version}`);
  }

  return join(migrationsDir, files[0]);
}

/**
 * Check if migration is applied
 */
async function isMigrationApplied(client: Client, version: string): Promise<boolean> {
  const result = await client.query(
    'SELECT version FROM schema_migrations WHERE version = $1',
    [version]
  );
  return result.rows.length > 0;
}

/**
 * Delete a migration
 */
async function deleteMigration() {
  const versionOrFilename = process.argv[2];

  if (!versionOrFilename) {
    console.error('Error: Migration version or filename is required');
    console.error('Usage: npm run db:migrate:delete <version>');
    console.error('Example: npm run db:migrate:delete 20251229104220');
    console.error('     or: npm run db:migrate:delete 20251229104220_test_migration');
    process.exit(1);
  }

  // Extract version from input (handle both version and filename)
  const version = versionOrFilename.split('_')[0].replace('.sql', '');

  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  try {
    await client.connect();
    console.log('Connected to database');

    // Find migration file
    const filepath = findMigrationFile(version);

    if (!filepath) {
      console.error(`Migration file not found for version: ${version}`);
      process.exit(1);
    }

    const filename = filepath.split('/').pop() || version;

    // Check if migration is applied
    const isApplied = await isMigrationApplied(client, version);

    if (isApplied) {
      console.log(`Migration ${filename} is applied. Rolling back...`);

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
    } else {
      console.log(`Migration ${filename} is not applied (skipping rollback)`);
    }

    // Delete the migration file
    unlinkSync(filepath);
    console.log(`✓ Deleted file: ${filename}`);

    console.log('');
    console.log('Migration deleted successfully');
  } catch (error) {
    console.error('Delete migration failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

deleteMigration();
