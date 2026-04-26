/**
 * Plan file management for coding assistants
 *
 * Claude Code stores plans in ~/.claude/plans/ as markdown files
 * with random adjective-noun filenames (e.g., elegant-snacking-snowflake.md)
 *
 * This service provides:
 * - Auto-discovery: scans disk on each list call
 * - Versioning: new content creates new version, never overwrites
 * - History: full content history preserved in plan_versions
 * - File watching: auto-sync when plan files change on disk
 */

import { readdir, readFile, stat, unlink, access } from 'node:fs/promises';
import { watch, FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { query, querySingle } from '../db/client';
import { logger } from '../lib/logger';

const log = logger.child({ component: 'plan-watcher' });

// ── Types ────────────────────────────────────────────────────────────

export interface PlanRecord {
  id: string;
  assistant_id: string;
  project_id: string | null;
  filename: string;
  file_path: string | null;
  current_version: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface PlanVersionRecord {
  id: string;
  plan_id: string;
  version: number;
  title: string;
  content: string;
  file_hash: string;
  size: number | null;
  created_at: Date;
}

export interface PlanSummary {
  id: string;
  filename: string;
  file_path: string | null;
  title: string;
  current_version: number;
  version_count: number;
  status: string;
  project_id: string | null;
  project_name: string | null;
  has_file: boolean;
  size: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface Plan {
  id: string;
  filename: string;
  file_path: string | null;
  title: string;
  content: string;
  current_version: number;
  version_count: number;
  status: string;
  project_id: string | null;
  has_file: boolean;
  size: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface PlanVersionSummary {
  version: number;
  title: string;
  size: number | null;
  file_hash: string;
  created_at: Date;
}

export interface PlanVersion {
  id: string;
  version: number;
  title: string;
  content: string;
  size: number | null;
  file_hash: string;
  created_at: Date;
}

// ── Constants ────────────────────────────────────────────────────────

// Plans directory paths per assistant
const PLANS_PATHS: Record<string, string> = {
  'claude-code': join(homedir(), '.claude', 'plans'),
};

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Get the plans directory path for an assistant
 */
export function getPlansPath(assistantHandle: string): string | null {
  return PLANS_PATHS[assistantHandle] ?? null;
}

/**
 * Extract title from plan content
 * Plans start with "# Plan: <Title>" or just "# <Title>"
 */
function extractTitle(content: string, filename: string): string {
  const firstLine = content.split('\n')[0]?.trim() ?? '';

  // Match "# Plan: Title" or "# Title"
  const planMatch = firstLine.match(/^#\s+Plan:\s*(.+)$/i);
  if (planMatch) return planMatch[1].trim();

  const headingMatch = firstLine.match(/^#\s+(.+)$/);
  if (headingMatch) return headingMatch[1].trim();

  // Fallback to filename without extension
  return filename.replace(/\.md$/, '').replace(/-/g, ' ');
}

/**
 * Compute SHA-256 hash of content
 */
function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Validate filename to prevent path traversal
 */
function validateFilename(filename: string): boolean {
  return !filename.includes('/') && !filename.includes('\\') && !filename.includes('..');
}

/**
 * Get assistant ID by handle
 */
async function getAssistantId(handle: string): Promise<string | null> {
  const result = await querySingle<{ id: string }>(
    'SELECT id FROM assistants WHERE handle = $1',
    [handle]
  );
  return result?.id ?? null;
}

/**
 * Extract project name from plan content.
 * Looks for "Project: <name>" line near the top of the file.
 */
function extractProjectName(content: string): string | null {
  // Look in the first 500 chars (should be near the title)
  const head = content.slice(0, 500);
  const match = head.match(/^Project:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Look up project ID by name or handle (case-insensitive)
 */
async function resolveProjectId(nameOrHandle: string): Promise<string | null> {
  const result = await querySingle<{ id: string }>(
    `SELECT id FROM projects
     WHERE LOWER(name) = LOWER($1) OR LOWER(handle) = LOWER($1)`,
    [nameOrHandle]
  );
  return result?.id ?? null;
}

// ── Discovery ────────────────────────────────────────────────────────

/**
 * Discover and sync plans from disk to database.
 * - New files → create plan + version 1
 * - Changed files → add new version
 * - Deleted files → set file_path = NULL
 */
export async function discoverPlans(assistantHandle: string): Promise<void> {
  const plansPath = getPlansPath(assistantHandle);
  if (!plansPath) return;

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return;

  // Read files from disk
  let diskFiles: string[];
  try {
    diskFiles = await readdir(plansPath);
  } catch {
    diskFiles = [];
  }

  const mdFiles = diskFiles.filter((f) => f.endsWith('.md'));

  // Get existing plans from DB
  const dbPlans = await query<PlanRecord>(
    'SELECT * FROM plans WHERE assistant_id = $1',
    [assistantId]
  );
  const plansByFilename = new Map(dbPlans.map((p) => [p.filename, p]));

  // Process each file on disk
  for (const filename of mdFiles) {
    const filePath = join(plansPath, filename);

    let content: string;
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      [content, stats] = await Promise.all([
        readFile(filePath, 'utf-8'),
        stat(filePath),
      ]);
    } catch {
      continue;
    }

    const fileHash = computeHash(content);
    const title = extractTitle(content, filename);
    const size = stats.size;

    const existingPlan = plansByFilename.get(filename);

    if (!existingPlan) {
      // New plan: create plan + version 1
      // Try to extract project from content
      const projectName = extractProjectName(content);
      const projectId = projectName ? await resolveProjectId(projectName) : null;

      const [newPlan] = await query<{ id: string }>(
        `INSERT INTO plans (assistant_id, filename, file_path, current_version, status, project_id)
         VALUES ($1, $2, $3, 1, 'active', $4)
         RETURNING id`,
        [assistantId, filename, filePath, projectId]
      );

      await query(
        `INSERT INTO plan_versions (plan_id, version, title, content, file_hash, size)
         VALUES ($1, 1, $2, $3, $4, $5)
         ON CONFLICT (plan_id, version) DO NOTHING`,
        [newPlan.id, title, content, fileHash, size]
      );
    } else {
      // Existing plan: check if content changed
      const latestVersion = await querySingle<{ file_hash: string }>(
        `SELECT file_hash FROM plan_versions
         WHERE plan_id = $1 AND version = $2`,
        [existingPlan.id, existingPlan.current_version]
      );

      if (latestVersion && latestVersion.file_hash !== fileHash) {
        // Content changed: create new version
        const newVersion = existingPlan.current_version + 1;

        await query(
          `INSERT INTO plan_versions (plan_id, version, title, content, file_hash, size)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (plan_id, version) DO NOTHING`,
          [existingPlan.id, newVersion, title, content, fileHash, size]
        );

        // Check if we can now extract project (if not already set)
        let projectUpdate = '';
        const updateParams: (string | number | null)[] = [newVersion, filePath];
        if (!existingPlan.project_id) {
          const projectName = extractProjectName(content);
          const projectId = projectName ? await resolveProjectId(projectName) : null;
          if (projectId) {
            projectUpdate = ', project_id = $3';
            updateParams.push(projectId);
          }
        }
        updateParams.push(existingPlan.id);

        await query(
          `UPDATE plans SET current_version = $1, file_path = $2, updated_at = NOW()${projectUpdate}
           WHERE id = $${updateParams.length}`,
          updateParams
        );
      } else if (!existingPlan.file_path) {
        // File reappeared (was deleted, now back): update file_path
        await query(
          `UPDATE plans SET file_path = $1, updated_at = NOW() WHERE id = $2`,
          [filePath, existingPlan.id]
        );
      }

      plansByFilename.delete(filename);
    }
  }

  // Mark deleted files (remaining in plansByFilename with non-null file_path)
  for (const [, plan] of plansByFilename) {
    if (plan.file_path !== null) {
      await query(
        `UPDATE plans SET file_path = NULL, updated_at = NOW() WHERE id = $1`,
        [plan.id]
      );
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * List all plans for an assistant (with auto-discovery)
 */
export interface PlanListOptions {
  sort?: 'date' | 'name';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface PlanListResult {
  plans: PlanSummary[];
  pagination: {
    total_count: number;
    limit: number;
    offset: number;
    has_more: boolean;
  };
}

export async function listPlans(
  assistantHandle: string,
  options?: PlanListOptions
): Promise<PlanListResult> {
  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) {
    return {
      plans: [],
      pagination: { total_count: 0, limit: 50, offset: 0, has_more: false },
    };
  }

  // Discover/sync plans from disk
  await discoverPlans(assistantHandle);

  const sort = options?.sort ?? 'date';
  const order = options?.order ?? 'desc';
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const orderBy =
    sort === 'name'
      ? `pv.title ${order === 'asc' ? 'ASC' : 'DESC'}`
      : `p.updated_at ${order === 'asc' ? 'ASC' : 'DESC'}`;

  const plans = await query<PlanSummary & { version_count: string; total_count: string }>(
    `SELECT
       p.id,
       p.filename,
       p.file_path,
       pv.title,
       p.current_version,
       (SELECT COUNT(*) FROM plan_versions WHERE plan_id = p.id) as version_count,
       p.status,
       p.project_id,
       proj.name as project_name,
       (p.file_path IS NOT NULL) as has_file,
       pv.size,
       p.created_at,
       p.updated_at,
       COUNT(*) OVER() as total_count
     FROM plans p
     JOIN plan_versions pv ON pv.plan_id = p.id AND pv.version = p.current_version
     LEFT JOIN projects proj ON proj.id = p.project_id
     WHERE p.assistant_id = $1
     ORDER BY ${orderBy}
     LIMIT $2 OFFSET $3`,
    [assistantId, limit, offset]
  );

  const totalCount = plans.length > 0 ? parseInt(plans[0].total_count, 10) : 0;

  return {
    plans: plans.map((p) => ({
      ...p,
      version_count: parseInt(p.version_count as unknown as string, 10),
    })),
    pagination: {
      total_count: totalCount,
      limit,
      offset,
      has_more: offset + limit < totalCount,
    },
  };
}

/**
 * List plans associated with a specific project
 */
export async function listPlansByProject(
  projectId: string,
  options?: PlanListOptions
): Promise<PlanListResult> {
  const sort = options?.sort ?? 'date';
  const order = options?.order ?? 'desc';
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const orderBy =
    sort === 'name'
      ? `pv.title ${order === 'asc' ? 'ASC' : 'DESC'}`
      : `p.updated_at ${order === 'asc' ? 'ASC' : 'DESC'}`;

  const plans = await query<PlanSummary & { version_count: string; total_count: string }>(
    `SELECT
       p.id,
       p.filename,
       p.file_path,
       pv.title,
       p.current_version,
       (SELECT COUNT(*) FROM plan_versions WHERE plan_id = p.id) as version_count,
       p.status,
       p.project_id,
       proj.name as project_name,
       (p.file_path IS NOT NULL) as has_file,
       pv.size,
       p.created_at,
       p.updated_at,
       COUNT(*) OVER() as total_count
     FROM plans p
     JOIN plan_versions pv ON pv.plan_id = p.id AND pv.version = p.current_version
     LEFT JOIN projects proj ON proj.id = p.project_id
     WHERE p.project_id = $1
     ORDER BY ${orderBy}
     LIMIT $2 OFFSET $3`,
    [projectId, limit, offset]
  );

  const totalCount = plans.length > 0 ? parseInt(plans[0].total_count, 10) : 0;

  return {
    plans: plans.map((p) => ({
      ...p,
      version_count: parseInt(p.version_count as unknown as string, 10),
    })),
    pagination: {
      total_count: totalCount,
      limit,
      offset,
      has_more: offset + limit < totalCount,
    },
  };
}

/**
 * Get a specific plan by filename (current version)
 */
export async function getPlan(
  assistantHandle: string,
  filename: string
): Promise<Plan | null> {
  if (!validateFilename(filename)) return null;

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return null;

  // Discover/sync to ensure we have latest
  await discoverPlans(assistantHandle);

  const plan = await querySingle<Plan & { version_count: string }>(
    `SELECT
       p.id,
       p.filename,
       p.file_path,
       pv.title,
       pv.content,
       p.current_version,
       (SELECT COUNT(*) FROM plan_versions WHERE plan_id = p.id) as version_count,
       p.status,
       p.project_id,
       (p.file_path IS NOT NULL) as has_file,
       pv.size,
       p.created_at,
       p.updated_at
     FROM plans p
     JOIN plan_versions pv ON pv.plan_id = p.id AND pv.version = p.current_version
     WHERE p.assistant_id = $1 AND p.filename = $2`,
    [assistantId, filename]
  );

  if (!plan) return null;

  return {
    ...plan,
    version_count: parseInt(plan.version_count as unknown as string, 10),
  };
}

/**
 * Get all versions of a plan
 */
export async function getPlanVersions(
  assistantHandle: string,
  filename: string
): Promise<{ versions: PlanVersionSummary[] } | null> {
  if (!validateFilename(filename)) return null;

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return null;

  const plan = await querySingle<{ id: string }>(
    'SELECT id FROM plans WHERE assistant_id = $1 AND filename = $2',
    [assistantId, filename]
  );

  if (!plan) return null;

  const versions = await query<PlanVersionSummary>(
    `SELECT version, title, size, file_hash, created_at
     FROM plan_versions
     WHERE plan_id = $1
     ORDER BY version DESC`,
    [plan.id]
  );

  return { versions };
}

/**
 * Get a specific version of a plan
 */
export async function getPlanVersion(
  assistantHandle: string,
  filename: string,
  version: number
): Promise<PlanVersion | null> {
  if (!validateFilename(filename)) return null;

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return null;

  const result = await querySingle<PlanVersion>(
    `SELECT pv.id, pv.version, pv.title, pv.content, pv.size, pv.file_hash, pv.created_at
     FROM plan_versions pv
     JOIN plans p ON p.id = pv.plan_id
     WHERE p.assistant_id = $1 AND p.filename = $2 AND pv.version = $3`,
    [assistantId, filename, version]
  );

  return result;
}

/**
 * Delete a specific plan version
 * Returns true if deleted, false if not found
 * Cannot delete the only remaining version
 */
export async function deletePlanVersion(
  assistantHandle: string,
  filename: string,
  version: number
): Promise<{ deleted: boolean; error?: string }> {
  if (!validateFilename(filename)) return { deleted: false, error: 'Invalid filename' };

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return { deleted: false, error: 'Assistant not found' };

  // Get plan and check version count
  const plan = await querySingle<{ id: string; version_count: number }>(
    `SELECT p.id, (SELECT COUNT(*) FROM plan_versions WHERE plan_id = p.id) as version_count
     FROM plans p
     WHERE p.assistant_id = $1 AND p.filename = $2`,
    [assistantId, filename]
  );

  if (!plan) return { deleted: false, error: 'Plan not found' };

  if (plan.version_count <= 1) {
    return { deleted: false, error: 'Cannot delete the only remaining version' };
  }

  // Delete the specific version
  const result = await query(
    `DELETE FROM plan_versions WHERE plan_id = $1 AND version = $2 RETURNING id`,
    [plan.id, version]
  );

  if (result.length === 0) {
    return { deleted: false, error: 'Version not found' };
  }

  return { deleted: true };
}

/**
 * Update plan metadata (status, project_id)
 */
export async function updatePlan(
  assistantHandle: string,
  filename: string,
  updates: { status?: string; project_id?: string | null }
): Promise<Plan | null> {
  if (!validateFilename(filename)) return null;

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return null;

  const plan = await querySingle<{ id: string }>(
    'SELECT id FROM plans WHERE assistant_id = $1 AND filename = $2',
    [assistantId, filename]
  );

  if (!plan) return null;

  const setClauses: string[] = ['updated_at = NOW()'];
  const params: (string | null)[] = [];
  let paramIndex = 1;

  if (updates.status !== undefined) {
    setClauses.push(`status = $${paramIndex++}`);
    params.push(updates.status);
  }

  if (updates.project_id !== undefined) {
    setClauses.push(`project_id = $${paramIndex++}`);
    params.push(updates.project_id);
  }

  params.push(plan.id);

  await query(
    `UPDATE plans SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
    params
  );

  return getPlan(assistantHandle, filename);
}

/**
 * Delete a plan (from disk if exists, and from DB including all versions)
 */
export async function deletePlan(
  assistantHandle: string,
  filename: string
): Promise<{ success: boolean; error?: string }> {
  if (!validateFilename(filename)) {
    return { success: false, error: 'Invalid filename' };
  }

  const plansPath = getPlansPath(assistantHandle);
  const assistantId = await getAssistantId(assistantHandle);

  if (!assistantId) {
    return { success: false, error: 'Unknown assistant' };
  }

  // Check if plan exists in DB
  const plan = await querySingle<{ id: string; file_path: string | null }>(
    'SELECT id, file_path FROM plans WHERE assistant_id = $1 AND filename = $2',
    [assistantId, filename]
  );

  if (!plan) {
    return { success: false, error: 'Plan not found' };
  }

  // Delete from disk if file exists
  if (plan.file_path && plansPath) {
    const filePath = join(plansPath, filename);
    try {
      await unlink(filePath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        return { success: false, error: `Failed to delete file: ${err.message}` };
      }
    }
  }

  // Delete from DB (cascade deletes versions)
  await query('DELETE FROM plans WHERE id = $1', [plan.id]);

  return { success: true };
}

// ── File Watcher ─────────────────────────────────────────────────────

const watchers: Map<string, FSWatcher> = new Map();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start watching plans directories for changes.
 * When a .md file changes, triggers discovery for that assistant.
 */
export async function startPlanFileWatcher(): Promise<void> {
  for (const [assistantHandle, plansPath] of Object.entries(PLANS_PATHS)) {
    // Check if directory exists
    try {
      await access(plansPath);
    } catch {
      log.info({ plansPath }, 'Plans directory not found');
      continue;
    }

    // Skip if already watching
    if (watchers.has(assistantHandle)) {
      continue;
    }

    try {
      const watcher = watch(plansPath, { persistent: true }, (event, filename) => {
        if (filename?.endsWith('.md')) {
          // Debounce: wait 500ms before running discovery to batch rapid changes
          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }
          debounceTimer = setTimeout(async () => {
            log.info({ file: filename }, 'Change detected, syncing');
            try {
              await discoverPlans(assistantHandle);
            } catch (err) {
              log.warn({ err, assistant: assistantHandle }, 'Discovery error');
            }
          }, 500);
        }
      });

      watchers.set(assistantHandle, watcher);
      log.info({ plansPath }, 'Watching plans directory');
    } catch (err) {
      log.warn({ err, plansPath }, 'Failed to watch plans directory');
    }
  }
}

/**
 * Stop all plan file watchers.
 */
export function stopPlanFileWatcher(): void {
  for (const [handle, watcher] of watchers) {
    watcher.close();
    log.info({ handle }, 'Stopped watching');
  }
  watchers.clear();

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
