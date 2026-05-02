import * as dotenv from 'dotenv';
import { expand } from 'dotenv-expand';
expand(dotenv.config());
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { seedMemoriesForProject, listSeedProjects } from './memories';
import { seedPrompts } from './prompts';
import { seedDefinitions } from './definitions';
import { seedConfigNotes } from './config-notes';

const CHUNK_SIZE = 2000;

type AgentRuleSeed = {
  project: string; // target project handle (e.g., 'user')
  title: string;
  content: string;
  handle?: string;
  tags?: string[];
};

type ProjectRow = { id: string; handle: string; name: string };

const chunkText = (text: string): string[] => {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + CHUNK_SIZE));
    start += CHUNK_SIZE;
  }
  return chunks;
};


/**
 * Run SQL seed files (memory types, statuses, projects)
 */
async function runSqlSeeds(client: Client): Promise<void> {
  const seedFiles = [
    'seeds/memory_types.sql',
    'seeds/memory_type_statuses.sql',
    'seeds/default_statuses.sql',
    'seeds/samples_project.sql',
    'seeds/demo_projects.sql',
    'seeds/kdag_input_types.sql',
    'seeds/kdag_input_types_local.sql',
    'seeds/dbx_saved_queries.sql',
    'seeds/kapi_requests.sql',
  ];

  for (const file of seedFiles) {
    const filepath = join(__dirname, file);
    // Some seed files (e.g. *_local.sql) ship only with the private source
    // repo and are intentionally absent from public clones. Skip silently.
    if (!existsSync(filepath)) {
      console.log(`- ${file} (skipped — not present)`);
      continue;
    }
    const sql = readFileSync(filepath, 'utf-8');
    await client.query(sql);
    console.log(`✓ ${file}`);
  }
}

/**
 * Run SQL seeds that must run after memories are created (relations)
 */
async function runPostMemorySqlSeeds(client: Client): Promise<void> {
  const seedFiles = [
    'seeds/samples_relations.sql',
    'seeds/samples_collections.sql',
  ];

  console.log('\nSeeding relations and collections...');
  for (const file of seedFiles) {
    const filepath = join(__dirname, file);
    const sql = readFileSync(filepath, 'utf-8');
    await client.query(sql);
    console.log(`✓ ${file}`);
  }
}


/**
 * Main seed function
 * @param projectHandle - Optional project handle to seed only that project
 */
async function seed(projectHandle?: string) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log('Connected to database\n');

    // Run SQL seeds first (memory types, statuses)
    console.log('Running SQL seeds...');
    await runSqlSeeds(client);

    // Seed kdag definitions (must run before memories that might reference them)
    await seedDefinitions(client);

    // Seed memories (markdown-based).
    // If a project handle is provided, seed only that project; otherwise seed all projects present in seeds.
    if (projectHandle) {
      await seedMemoriesForProject(client, projectHandle);
    } else {
      const projects = listSeedProjects();
      console.log(`Seeding all projects from seeds: ${projects.join(', ')}`);
      for (const p of projects) {
        await seedMemoriesForProject(client, p);
      }
    }

    // Seed prompts
    await seedPrompts(client);

    // Seed config notes
    await seedConfigNotes(client);

    // Run post-memory seeds (relations between memories)
    await runPostMemorySqlSeeds(client);

    console.log('\nSeed completed successfully');
  } finally {
    await client.end();
  }
}

// Run if called directly
if (require.main === module) {
  const projectHandle = process.argv[2];
  seed(projectHandle).catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  });
}

export default seed;
