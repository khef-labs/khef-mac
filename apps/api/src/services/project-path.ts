/**
 * Project path resolution with base path fallback.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { query } from '../db/client';

/**
 * Expand ~ to home directory.
 */
export function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return filepath.replace('~', os.homedir());
  }
  return filepath;
}

/**
 * Get the projects base path setting.
 * Returns null if not configured.
 */
export async function getProjectsBasePath(): Promise<string | null> {
  const rows = await query<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'projects.basePath'"
  );
  if (rows.length === 0 || !rows[0].value) {
    return null;
  }
  return expandTilde(rows[0].value);
}

/**
 * Resolve a project's filesystem path.
 *
 * Priority:
 * 1. Explicit project.path if set
 * 2. Derived from projects.basePath + handle (if base is set and dir exists)
 * 3. null (no path available)
 *
 * @param project - Project with path and handle
 * @param basePath - Optional pre-fetched base path (to avoid repeated DB queries)
 * @returns Resolved filesystem path or null
 */
export async function resolveProjectPath(
  project: { path?: string | null; handle: string },
  basePath?: string | null
): Promise<string | null> {
  // 1. Explicit path takes priority
  if (project.path) {
    return expandTilde(project.path);
  }

  // 2. Try deriving from base path
  const base = basePath !== undefined ? basePath : await getProjectsBasePath();
  if (base) {
    const derivedPath = path.join(base, project.handle);
    // Only use if directory exists
    if (fs.existsSync(derivedPath) && fs.statSync(derivedPath).isDirectory()) {
      return derivedPath;
    }
  }

  // 3. No path available
  return null;
}

/**
 * Resolve project path by project ID (handle, name, or UUID).
 * Throws if project not found.
 */
export async function resolveProjectPathById(projectId: string): Promise<string | null> {
  const projects = await query<{ path: string | null; handle: string }>(
    `SELECT path, handle FROM projects WHERE id::text = $1 OR handle = $1 OR LOWER(name) = LOWER($1)`,
    [projectId]
  );
  if (projects.length === 0) {
    throw new Error('Project not found');
  }
  return resolveProjectPath(projects[0]);
}
