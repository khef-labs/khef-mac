import * as dotenv from 'dotenv';
import { expand } from 'dotenv-expand';

expand(dotenv.config());
import { readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

interface Migration {
  version: string;
  filename: string;
  applied: boolean;
  appliedAt?: Date;
}

/**
 * Get all migrations (applied and pending)
 */
async function getAllMigrations(client: Client): Promise<Migration[]> {
  const migrationsDir = join(__dirname, '..', 'migrations');

  // Get all migration files
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql') && !f.includes('README'))
    .sort();

  // Get applied migrations
  const result = await client.query(
    'SELECT version, applied_at FROM schema_migrations ORDER BY version'
  );
  const appliedMap = new Map(
    result.rows.map(r => [r.version, r.applied_at])
  );

  // Combine into single list
  return files.map(filename => {
    const version = filename.split('_')[0];
    const appliedAt = appliedMap.get(version);

    return {
      version,
      filename,
      applied: appliedMap.has(version),
      appliedAt
    };
  });
}

/**
 * Format date for display
 */
function formatDate(date: Date): string {
  return date.toISOString().replace('T', ' ').split('.')[0];
}

/**
 * Show migration status
 */
async function showStatus() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  try {
    await client.connect();

    const migrations = await getAllMigrations(client);

    console.log('');
    console.log('Migration Status');
    console.log('================');
    console.log('');

    if (migrations.length === 0) {
      console.log('No migrations found');
      console.log('');
      return;
    }

    // Show each migration
    for (const migration of migrations) {
      const status = migration.applied ? '✓' : ' ';
      console.log(`[${status}] ${migration.filename}`);

      if (migration.applied && migration.appliedAt) {
        console.log(`    Applied: ${formatDate(migration.appliedAt)}`);
      }
    }

    console.log('');

    // Summary
    const appliedCount = migrations.filter(m => m.applied).length;
    const pendingCount = migrations.filter(m => !m.applied).length;

    console.log(`Applied: ${appliedCount} migration(s)`);
    console.log(`Pending: ${pendingCount} migration(s)`);
    console.log('');

    if (pendingCount > 0) {
      console.log('Run "npm run db:migrate" to apply pending migrations');
      console.log('');
    }
  } catch (error) {
    console.error('Error getting migration status:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

showStatus();
