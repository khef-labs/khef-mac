import * as dotenv from 'dotenv';
import { expand } from 'dotenv-expand';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'pg';

// Load .env relative to apps/api/ (not CWD) so tests work from any directory
const __dirname = dirname(fileURLToPath(import.meta.url));
expand(dotenv.config({ path: resolve(__dirname, '..', '.env') }));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres@localhost:5433/khef_test';

export async function setupTestDb() {
  const client = new Client({
    connectionString: TEST_DATABASE_URL
  });

  await client.connect();

  // Drop all tables if they exist (in dependency order)
  await client.query(`
    DROP TABLE IF EXISTS assistant_chat_messages CASCADE;
    DROP TABLE IF EXISTS assistant_chats CASCADE;
    DROP TABLE IF EXISTS session_summaries CASCADE;
    DROP TABLE IF EXISTS session_summary_snapshots CASCADE;
    DROP TABLE IF EXISTS job_definition_inputs CASCADE;
    DROP TABLE IF EXISTS job_definition_steps CASCADE;
    DROP TABLE IF EXISTS job_definitions CASCADE;
    DROP TABLE IF EXISTS job_steps CASCADE;
    DROP TABLE IF EXISTS job_outputs CASCADE;
    DROP TABLE IF EXISTS job_runs CASCADE;
    DROP TABLE IF EXISTS job_inputs CASCADE;
    DROP TABLE IF EXISTS jobs CASCADE;
    DROP TABLE IF EXISTS output_formats CASCADE;
    DROP TABLE IF EXISTS input_types CASCADE;
    DROP TABLE IF EXISTS job_types CASCADE;
    DROP TABLE IF EXISTS assistant_chat_delegations CASCADE;
    DROP TABLE IF EXISTS assistant_chat_messages CASCADE;
    DROP TABLE IF EXISTS assistant_chats CASCADE;
    DROP TABLE IF EXISTS active_sessions CASCADE;
    DROP TABLE IF EXISTS session_team_members CASCADE;
    DROP TABLE IF EXISTS session_teams CASCADE;
    DROP TABLE IF EXISTS session_chunks CASCADE;
    DROP TABLE IF EXISTS sessions CASCADE;
    DROP TABLE IF EXISTS gemini_messages CASCADE;
    DROP TABLE IF EXISTS gemini_conversations CASCADE;
    DROP TABLE IF EXISTS diffs CASCADE;
    DROP TABLE IF EXISTS prompt_snapshots CASCADE;
    DROP TABLE IF EXISTS assistant_prompts CASCADE;
    DROP TABLE IF EXISTS prompts CASCADE;
    DROP TABLE IF EXISTS assistant_memory_file_snapshots CASCADE;
    DROP TABLE IF EXISTS assistant_memory_file_versions CASCADE;
    DROP TABLE IF EXISTS assistant_memory_files CASCADE;
    DROP TABLE IF EXISTS plan_versions CASCADE;
    DROP TABLE IF EXISTS plans CASCADE;
    DROP TABLE IF EXISTS session_embeddings CASCADE;
    DROP TABLE IF EXISTS assistant_agents CASCADE;
    DROP TABLE IF EXISTS agents CASCADE;
    DROP TABLE IF EXISTS project_assistant_configs CASCADE;
    DROP TABLE IF EXISTS assistant_configs CASCADE;
    DROP TABLE IF EXISTS configs CASCADE;
    DROP TABLE IF EXISTS assistant_config_paths CASCADE;
    DROP TABLE IF EXISTS assistants CASCADE;
    DROP TABLE IF EXISTS comments CASCADE;
    DROP TABLE IF EXISTS files CASCADE;
    DROP TABLE IF EXISTS memory_metadata CASCADE;
    DROP TABLE IF EXISTS project_metadata CASCADE;
    DROP TABLE IF EXISTS settings CASCADE;
    DROP TABLE IF EXISTS memory_relations CASCADE;
    DROP TABLE IF EXISTS relation_types CASCADE;
    DROP TABLE IF EXISTS memory_tags CASCADE;
    DROP TABLE IF EXISTS memory_chunks CASCADE;
    DROP TABLE IF EXISTS memory_snapshots CASCADE;
    DROP TABLE IF EXISTS memory_embeddings CASCADE;
    DROP TABLE IF EXISTS vector_delete_queue CASCADE;
    DROP TABLE IF EXISTS tags CASCADE;
    DROP TABLE IF EXISTS kvec_auto_embed CASCADE;
    DROP TABLE IF EXISTS slack_channels CASCADE;
    DROP TABLE IF EXISTS collection_memories CASCADE;
    DROP TABLE IF EXISTS collections CASCADE;
    DROP TABLE IF EXISTS memories CASCADE;
    DROP TABLE IF EXISTS memory_type_statuses CASCADE;
    DROP TABLE IF EXISTS memory_types CASCADE;
    DROP TABLE IF EXISTS projects CASCADE;
    DROP TABLE IF EXISTS publish_log CASCADE;
    DROP TABLE IF EXISTS schema_migrations CASCADE;
    DROP TYPE IF EXISTS relation_type CASCADE;
    DROP FUNCTION IF EXISTS uuid_generate_v7() CASCADE;
    DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;
    DROP FUNCTION IF EXISTS validate_same_project_relation() CASCADE;
    DROP FUNCTION IF EXISTS validate_memory_status_matches_type() CASCADE;
    DROP FUNCTION IF EXISTS enforce_single_level_nesting() CASCADE;
    DROP SCHEMA IF EXISTS kdag CASCADE;
    DROP SCHEMA IF EXISTS kvec CASCADE;
    DROP SCHEMA IF EXISTS dbx CASCADE;
    DROP SCHEMA IF EXISTS kapi CASCADE;
    DROP EXTENSION IF EXISTS "uuid-ossp" CASCADE;
    DROP EXTENSION IF EXISTS vector CASCADE;
  `);

  await client.end();

  // Use migration runner to set up database
  // This ensures tests use the same migration path as production
  const { default: migrate } = await import('../db/migrate/scripts/migrate');

  // Temporarily override DATABASE_URL for migration
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  try {
    await migrate();
  } finally {
    // Restore original DATABASE_URL
    process.env.DATABASE_URL = originalUrl;
  }
}

export async function cleanupTestDb() {
  const client = new Client({
    connectionString: TEST_DATABASE_URL
  });

  await client.connect();
  await client.query(`
    DROP TABLE IF EXISTS plan_versions CASCADE;
    DROP TABLE IF EXISTS plans CASCADE;
    DROP TABLE IF EXISTS session_embeddings CASCADE;
    DROP TABLE IF EXISTS comments CASCADE;
    DROP TABLE IF EXISTS memory_relations CASCADE;
    DROP TABLE IF EXISTS memory_tags CASCADE;
    DROP TABLE IF EXISTS memory_chunks CASCADE;
    DROP TABLE IF EXISTS tags CASCADE;
    DROP TABLE IF EXISTS memories CASCADE;
    DROP TABLE IF EXISTS memory_type_statuses CASCADE;
    DROP TABLE IF EXISTS memory_types CASCADE;
    DROP TABLE IF EXISTS projects CASCADE;
    DROP TYPE IF EXISTS relation_type CASCADE;
  `);
  await client.end();
}

export { TEST_DATABASE_URL };
