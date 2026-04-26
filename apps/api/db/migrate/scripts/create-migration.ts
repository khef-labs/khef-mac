import { writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Generate timestamp in YYYYMMDDHHMMSS format
 */
function generateTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

/**
 * Validate migration description
 */
function validateDescription(description: string): void {
  if (!description) {
    console.error('Error: Migration description is required');
    console.error('Usage: npm run db:migrate:new <description>');
    console.error('Example: npm run db:migrate:new add_user_preferences');
    process.exit(1);
  }

  // Check for spaces (should use underscores)
  if (description.includes(' ')) {
    console.error('Error: Migration description should not contain spaces');
    console.error('Use underscores instead. Example: add_user_preferences');
    process.exit(1);
  }

  // Check for invalid characters
  if (!/^[a-z0-9_]+$/i.test(description)) {
    console.error('Error: Migration description should only contain letters, numbers, and underscores');
    process.exit(1);
  }
}

/**
 * Create migration template
 */
function createMigrationTemplate(description: string): string {
  const now = new Date();
  const timestamp = now.toISOString();

  // Convert underscores to spaces and capitalize for readable description
  const readableDescription = description
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return `-- Migration: ${readableDescription}
-- Created: ${timestamp}

-- UP




-- DOWN


`;
}

/**
 * Create a new migration file
 */
function createMigration() {
  const description = process.argv[2];

  validateDescription(description);

  const version = generateTimestamp();
  const filename = `${version}_${description}.sql`;
  const filepath = join(__dirname, '..', 'migrations', filename);

  const template = createMigrationTemplate(description);

  try {
    writeFileSync(filepath, template, 'utf-8');
    console.log(`✓ Created migration: ${filename}`);
    console.log(`  Location: ${filepath}`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Edit the migration file and add your SQL to the UP and DOWN sections');
    console.log('  2. Run: npm run db:migrate');
  } catch (error) {
    console.error('Error creating migration:', error);
    process.exit(1);
  }
}

createMigration();
