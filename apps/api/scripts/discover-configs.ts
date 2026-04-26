#!/usr/bin/env tsx
/**
 * Discover and import configs for all assistants.
 *
 * Usage:
 *   npm run discover:configs           # Discover global + all project configs
 *   npm run discover:configs -- global # Discover global configs only
 *   npm run discover:configs -- <project-handle>  # Discover configs for specific project
 */
import '../src/env';
import { query, closePool } from '../src/db/client';
import { discoverAndImportGlobalConfigs, discoverAndImportProjectConfigs } from '../src/services/assistant-discovery';

async function main() {
  const arg = process.argv[2];

  try {
    // Get all assistants
    const assistants = await query<{ handle: string; name: string }>(
      'SELECT handle, name FROM assistants ORDER BY name'
    );

    if (assistants.length === 0) {
      console.log('No assistants found.');
      return;
    }

    // Discover global configs (unless a specific project was requested)
    if (!arg || arg === 'global') {
      console.log(`Discovering global configs for ${assistants.length} assistant(s)...\n`);

      for (const assistant of assistants) {
        console.log(`[${assistant.name}] (global)`);
        try {
          const result = await discoverAndImportGlobalConfigs(assistant.handle);
          console.log(`  imported: ${result.imported}, updated: ${result.updated}, unchanged: ${result.unchanged}`);
        } catch (err) {
          console.error(`  Error: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Discover project configs
    if (arg !== 'global') {
      let projectQuery = "SELECT id, handle, name, path FROM projects WHERE path IS NOT NULL AND path != ''";
      const params: string[] = [];

      if (arg && arg !== 'global') {
        // Specific project requested
        projectQuery += ' AND (handle = $1 OR LOWER(name) = LOWER($1))';
        params.push(arg);
      }

      const projects = await query<{ id: string; handle: string; name: string; path: string }>(
        projectQuery,
        params
      );

      if (projects.length === 0 && arg && arg !== 'global') {
        console.log(`\nProject "${arg}" not found or has no path configured.`);
      } else if (projects.length > 0) {
        console.log(`\nDiscovering project configs for ${projects.length} project(s)...\n`);

        for (const project of projects) {
          console.log(`[Project: ${project.handle}] (${project.path})`);
          for (const assistant of assistants) {
            try {
              const result = await discoverAndImportProjectConfigs(assistant.handle, project.id, project.path);
              const total = result.imported + result.updated + result.unchanged;
              if (total > 0) {
                console.log(`  ${assistant.name}: imported ${result.imported}, updated ${result.updated}, unchanged ${result.unchanged}`);
              }
            } catch (err) {
              console.error(`  ${assistant.name}: Error - ${err instanceof Error ? err.message : err}`);
            }
          }
        }
      }
    }

    console.log('\nDone.');
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
