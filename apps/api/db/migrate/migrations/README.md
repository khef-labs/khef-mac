# Database Migrations

This directory contains incremental database migrations for khef.

## Naming Convention

Migrations use timestamp-based naming:

```
YYYYMMDDHHMMSS_description.sql
```

Example: `20241229093000_add_user_preferences.sql`

## Creating a Migration

Use the migration generator:

```bash
npm run db:migrate:new add_user_preferences
```

This creates a new migration file with the current timestamp.

## Migration File Format

All migration files must have both UP and DOWN sections:

```sql
-- Migration: Add user preferences
-- Created: 2024-12-29T09:30:00.000Z

-- UP
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB;
CREATE INDEX IF NOT EXISTS idx_users_preferences ON users(preferences);

-- DOWN
DROP INDEX IF EXISTS idx_users_preferences;
ALTER TABLE users DROP COLUMN IF EXISTS preferences;
```

## Running Migrations

### Development

```bash
# Run all pending migrations
npm run db:migrate

# Check migration status
npm run db:migrate:status

# Rollback last migration
npm run db:migrate:rollback
```

### Testing

Migrations are automatically run in tests via `tests/setup.ts`.

```bash
npm run test:migrations
```

## Writing Migrations

### Best Practices

1. **Idempotent**: Use `IF NOT EXISTS`, `IF EXISTS`, `ON CONFLICT` clauses
   - Migrations should be safe to re-run if needed

2. **Small Changes**: One logical change per migration
   - Add one column, create one index, add one constraint

3. **Safe Operations**: Consider production impact
   - Avoid long-running operations during peak hours
   - Add indexes CONCURRENTLY when possible (requires separate transaction)
   - Be careful with NOT NULL on existing columns

4. **Reversible**: Always provide a DOWN section
   - Document how to reverse the change
   - Consider data preservation

### Examples

#### Adding a Column

```sql
-- UP
-- Add nullable column first
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);

-- Update existing rows if needed
UPDATE users SET email = 'unknown@example.com' WHERE email IS NULL;

-- Make NOT NULL after populating
ALTER TABLE users ALTER COLUMN email SET NOT NULL;

-- Add constraints
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_unique;
ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);

-- DOWN
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_unique;
ALTER TABLE users DROP COLUMN IF EXISTS email;
```

#### Creating an Index

```sql
-- UP
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- DOWN
DROP INDEX IF EXISTS idx_users_email;
```

#### Altering a Column

```sql
-- UP
-- Safe: Increasing varchar size (PostgreSQL doesn't rewrite table)
ALTER TABLE users ALTER COLUMN name TYPE VARCHAR(500);

-- DOWN
-- Caution: Decreasing size requires data validation
ALTER TABLE users ALTER COLUMN name TYPE VARCHAR(255);
```

## Migration Order

Migrations run in alphabetical order (which equals timestamp order).

The migration system tracks applied migrations in the `schema_migrations` table.

## Troubleshooting

### Migration Failed

If a migration fails:
1. Check the error message
2. Fix the migration SQL
3. Database will rollback automatically (migrations run in transactions)
4. Re-run `npm run db:migrate`

### Need to Undo a Migration

Use rollback for the most recent migration:

```bash
npm run db:migrate:rollback
```

For older migrations, create a new migration that reverses the changes:

```bash
npm run db:migrate:new revert_feature_x
# Edit the migration to reverse the changes
npm run db:migrate
```

### Fresh Start

To completely reset (DEVELOPMENT ONLY):

```bash
npm run db:down
npm run db:up
npm run db:migrate
```

## Migration History

- `00000000000001_initial_schema.sql` - Initial database schema with all tables, indexes, triggers, and seed data
- `20241228211600_add_project_handle.sql` - Add handle and display_name to projects
- `20241229092800_add_memory_title.sql` - Add title column to memories
