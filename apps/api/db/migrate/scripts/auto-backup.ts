import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Run an automatic backup before a migration or rollback.
 *
 * - Skips silently if the backup script is missing (e.g. first-time setup)
 * - Skips silently if the Docker container is not running
 * - Warns but does not abort on backup failure (safety net, not a gate)
 */
export function autoBackup(): void {
  // Skip backup when migrating against the test database
  const dbUrl = process.env.DATABASE_URL || '';
  const testDbUrl = process.env.TEST_DATABASE_URL || '';
  if (testDbUrl && dbUrl === testDbUrl) {
    return;
  }

  const scriptPath = join(__dirname, '..', '..', 'scripts', 'backup.sh');

  if (!existsSync(scriptPath)) {
    return;
  }

  try {
    console.log('Creating automatic backup...');
    execSync(`bash "${scriptPath}"`, { stdio: 'inherit' });
  } catch (error: any) {
    // Exit code 1 from backup.sh means container not running — skip silently
    if (error.status === 1 && error.stderr?.toString().includes('not running')) {
      return;
    }
    console.warn('Warning: automatic backup failed, continuing anyway');
    console.warn(`  ${error.message || error}`);
  }
}
