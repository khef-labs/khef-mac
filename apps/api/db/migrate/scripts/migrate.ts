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
 * Ensure schema_migrations table exists
 */
async function ensureSchemaMigrationsTable(client: Client): Promise<void> {
  const migrationsTableSQL = readFileSync(
    join(__dirname, 'migrations-table.sql'),
    'utf-8'
  );
  await client.query(migrationsTableSQL);
}

/**
 * Find all migration files in the migrations directory
 */
function findAllMigrations(): Migration[] {
  const migrationsDir = join(__dirname, '..', 'migrations');

  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql') && !f.includes('README'))
    .sort(); // Alphabetical = timestamp order

  return files.map(filename => {
    // Extract version from filename: 20241229093000_description.sql -> 20241229093000
    const version = filename.split('_')[0];
    return {
      version,
      filename,
      filepath: join(migrationsDir, filename)
    };
  });
}

/**
 * Find pending migrations (not yet applied)
 */
async function findPendingMigrations(client: Client): Promise<Migration[]> {
  const allMigrations = findAllMigrations();

  // Get applied migrations
  const result = await client.query(
    'SELECT version FROM schema_migrations ORDER BY version'
  );
  const appliedVersions = new Set(result.rows.map(r => r.version));

  // Filter to pending only
  return allMigrations.filter(m => !appliedVersions.has(m.version));
}

/**
 * Run a single migration UP
 */
async function runMigrationUp(client: Client, migration: Migration): Promise<void> {
  console.log(`Applying migration: ${migration.filename}`);

  const parsed = parseMigrationFile(migration.filepath);

  // Run migration in a transaction
  await client.query('BEGIN');
  try {
    // Execute UP section
    await client.query(parsed.up);

    // Record in schema_migrations
    await client.query(
      'INSERT INTO schema_migrations (version) VALUES ($1)',
      [migration.version]
    );

    await client.query('COMMIT');
    console.log(`✓ Applied: ${migration.filename}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw new Error(`Failed to apply ${migration.filename}: ${error}`);
  }
}

/**
 * Main migration function
 */
async function migrate() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  try {
    await client.connect();
    console.log('Connected to database');

    // Ensure schema_migrations table exists
    await ensureSchemaMigrationsTable(client);

    // Find pending migrations
    const pending = await findPendingMigrations(client);

    if (pending.length === 0) {
      console.log('No pending migrations');
    } else {
      autoBackup();
      console.log(`Running ${pending.length} pending migration(s)...`);
      for (const migration of pending) {
        await runMigrationUp(client, migration);
      }
    }

    console.log('Migration completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

// Run if called directly
if (require.main === module) {
  migrate();
}

export default migrate;
