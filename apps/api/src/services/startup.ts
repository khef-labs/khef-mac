/**
 * Startup tasks that run when the server starts.
 */
import { logger } from '../lib/logger';
import { query } from '../db/client';

const log = logger.child({ component: 'startup' });
import { discoverAndImportGlobalConfigs, discoverAndImportProjectConfigs } from './assistant-discovery';
import { resolveProjectPath, getProjectsBasePath } from './project-path';
import { syncBuiltInCommands } from './assistant-commands';

/**
 * Run config discovery for all assistants on startup.
 * This ensures configs are always fresh when the server starts.
 * Discovers both global configs and project configs (for projects with paths).
 */
export async function runStartupDiscovery(): Promise<void> {
  try {
    const assistants = await query<{ handle: string; name: string }>(
      'SELECT handle, name FROM assistants ORDER BY name'
    );

    if (assistants.length === 0) {
      log.info('No assistants found, skipping config discovery');
      return;
    }

    log.info({ count: assistants.length }, 'Discovering configs');

    // Discover global configs for each assistant
    for (const assistant of assistants) {
      try {
        const result = await discoverAndImportGlobalConfigs(assistant.handle);
        const changes = result.imported + result.updated;
        if (changes > 0) {
          log.info({ assistant: assistant.name, scope: 'global', imported: result.imported, updated: result.updated }, 'Config discovery');
        }
      } catch (err) {
        log.warn({ assistant: assistant.name, err: err instanceof Error ? err.message : err }, 'Failed to discover global configs');
      }
    }

    // Discover project configs for projects with resolvable paths
    const projects = await query<{ id: string; handle: string; path: string | null }>(
      'SELECT id, handle, path FROM projects'
    );

    // Pre-fetch base path once for efficiency
    const basePath = await getProjectsBasePath();

    // Resolve paths for all projects
    const projectsWithPaths: Array<{ id: string; handle: string; resolvedPath: string }> = [];
    for (const project of projects) {
      const resolvedPath = await resolveProjectPath(project, basePath);
      if (resolvedPath) {
        projectsWithPaths.push({ id: project.id, handle: project.handle, resolvedPath });
      }
    }

    if (projectsWithPaths.length > 0) {
      log.info({ count: projectsWithPaths.length }, 'Discovering project configs');

      for (const project of projectsWithPaths) {
        for (const assistant of assistants) {
          try {
            const result = await discoverAndImportProjectConfigs(assistant.handle, project.id, project.resolvedPath);
            const changes = result.imported + result.updated;
            if (changes > 0) {
              log.info({ assistant: assistant.name, project: project.handle, imported: result.imported, updated: result.updated }, 'Config discovery');
            }
          } catch (err) {
            log.warn({ assistant: assistant.name, project: project.handle, err: err instanceof Error ? err.message : err }, 'Failed to discover project configs');
          }
        }
      }
    }

    // Sync built-in kf-* commands to assistant directories.
    // Include defaults so sync still runs even if assistants are not yet seeded.
    // Only sync for assistants that have command/skill directory support.
    const SYNCABLE_ASSISTANTS = new Set(['claude-code', 'codex-cli']);
    const startupSyncHandles = Array.from(
      new Set([
        ...assistants.map((a) => a.handle).filter((h) => SYNCABLE_ASSISTANTS.has(h)),
        'claude-code',
        'codex-cli',
      ])
    );

    for (const handle of startupSyncHandles) {
      try {
        const results = syncBuiltInCommands(handle);
        const changes = results.filter((r) => r.action !== 'unchanged');
        if (changes.length > 0) {
          log.info({ assistant: handle, synced: changes.length }, 'Built-in commands synced');
        }
      } catch (err) {
        log.warn({ assistant: handle, err: err instanceof Error ? err.message : err }, 'Failed to sync built-in commands');
      }
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, 'Config discovery failed');
  }
}
