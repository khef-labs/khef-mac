/**
 * Active session detection service.
 *
 * Detects Claude Code sessions that are "open in a terminal" using a
 * three-tier approach:
 *
 * Tier 1 — PID liveness (most reliable):
 *   The UserPromptSubmit hook sends $PPID (the Claude process PID) via
 *   the heartbeat endpoint. The background scanner validates PIDs with
 *   kill(pid, 0) — instant and works for idle sessions.
 *
 * Tier 2 — fuser on task dirs (hookless fallback):
 *   Claude Code holds ~/.claude/tasks/<sessionId>/ directories open.
 *   Not all sessions create task dirs, but those that do get detected
 *   without hook setup.
 *
 * Tier 3 — JSONL mtime heuristic (lowest confidence):
 *   Sessions without a PID or task dir are detected if their .jsonl
 *   transcript file was modified recently. Less reliable for idle sessions.
 *
 * All runtime state (status, pid, terminal_session_id, last_seen_at) is
 * stored directly on the `sessions` table alongside synced content data.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { query, querySingle, getClient } from '../db/client';
import pool from '../db/client';
import { logger } from '../lib/logger';
import { uniqueNickname, type LengthConstraints } from './nickname-generator';
import { listDaemonPtyPids } from './pty-daemon';
import {
  readCodexSessionMeta,
  syncOneSessionFile,
  loadSessionProjectMap,
  type CodexSessionMeta,
} from './session-sync';

const log = logger.child({ component: 'active-sessions' });

const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// ── Nickname Generation ──────────────────────────────────────────────

const DEFAULT_STALE_DAYS = 7;

/**
 * Pick a random nickname not currently used by any active session.
 * Reads preferred names and stale threshold from settings.
 *
 * A nickname is considered free if the session holding it:
 *  - hasn't heartbeated in staleDays (configurable, default 7), or
 *  - has a JSONL file that no longer exists on disk (not resumable)
 */
async function generateNickname(): Promise<string> {
  const [used, prefRow, staleDaysRow, minLenRow, maxLenRow] = await Promise.all([
    query<{ nickname: string; last_seen_at: Date; file_path: string | null }>(
      `SELECT nickname, last_seen_at, file_path FROM sessions
       WHERE nickname IS NOT NULL AND status = 'active'`
    ),
    querySingle<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'nicknames.preferred'"
    ),
    querySingle<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'nicknames.staleDays'"
    ),
    querySingle<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'nicknames.minLength'"
    ),
    querySingle<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'nicknames.maxLength'"
    ),
  ]);

  const staleDays = staleDaysRow?.value ? parseInt(staleDaysRow.value, 10) || DEFAULT_STALE_DAYS : DEFAULT_STALE_DAYS;
  const staleThreshold = Date.now() - staleDays * 86400000;

  const usedSet = new Set<string>();
  for (const row of used) {
    // Free nicknames from stale sessions
    if (row.last_seen_at && new Date(row.last_seen_at).getTime() < staleThreshold) continue;
    // Free nicknames from non-resumable sessions (transcript deleted)
    if (row.file_path && !fs.existsSync(row.file_path)) continue;
    usedSet.add(row.nickname);
  }

  let preferredNames: string[] | undefined;
  if (prefRow?.value) {
    try {
      const parsed = JSON.parse(prefRow.value);
      if (Array.isArray(parsed)) preferredNames = parsed.filter((v: unknown) => typeof v === 'string' && v.trim());
    } catch { /* ignore malformed JSON */ }
  }

  const lengthConstraints: LengthConstraints = {
    minLength: minLenRow?.value ? parseInt(minLenRow.value, 10) || 0 : 0,
    maxLength: maxLenRow?.value ? parseInt(maxLenRow.value, 10) || 0 : 0,
  };

  return uniqueNickname(usedSet, preferredNames, lengthConstraints);
}

const SCAN_INTERVAL_MS = 10_000;
const FUSER_INTERVAL_MS = 60_000; // fuser is expensive (48+ subprocess spawns); run less often
const MTIME_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

let scannerInterval: ReturnType<typeof setInterval> | null = null;
let lastFuserScanMs = 0;

export interface ActiveSession {
  session_id: string;
  file_path: string;
  pid: number | null;
  project_dir: string | null;
  assistant: string;
}

export interface ActiveSessionRow {
  id: string;
  session_id: string;
  assistant_id: string;
  assistant_handle: string;
  assistant_name: string;
  project_id: string | null;
  project_handle: string | null;
  project_name: string | null;
  file_path: string;
  project_dir: string | null;
  pid: number | null;
  status: string;
  last_seen_at: Date;
  first_seen_at: Date;
  created_at: Date;
  updated_at: Date;
  // Direct columns on sessions (previously joined)
  name: string | null;
  summary: string | null;
  message_count: number | null;
  started_at: Date | null;
  ended_at: Date | null;
  model: string | null;
  context_window_tokens: string | null;
  nickname: string | null;
  terminal_session_id: string | null;
  // Runtime augmentation by getCachedActiveSessionsWithLiveness — true when
  // the row's pid matches a process currently owned by the local PTY daemon
  // (i.e. an in-browser session, not an external iTerm/Codex instance).
  pid_is_self?: boolean;
}

// ── OS Scanning ──────────────────────────────────────────────────────

/**
 * Check if a PID is still alive using signal 0 (no signal sent).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check a single task directory with fuser.
 * Returns the PID holding the directory open, or null.
 */
function fuserCheck(dirPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('fuser', [dirPath], { timeout: 5000 }, (_err, stdout) => {
      const match = stdout?.toString().match(/(\d+)/);
      resolve(match ? parseInt(match[1], 10) : null);
    });
  });
}

/**
 * Scan all task directories for open handles.
 * Returns a map of task UUID → PID.
 */
async function scanTaskDirs(): Promise<Map<string, number>> {
  if (!fs.existsSync(TASKS_DIR)) return new Map();

  let entries: { uuid: string; dirPath: string }[];
  try {
    entries = fs.readdirSync(TASKS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => ({ uuid: e.name, dirPath: path.join(TASKS_DIR, e.name, '/') }));
  } catch {
    return new Map();
  }

  if (entries.length === 0) return new Map();

  const results = new Map<string, number>();
  await Promise.all(entries.map(async ({ uuid, dirPath }) => {
    const pid = await fuserCheck(dirPath);
    if (pid) results.set(uuid, pid);
  }));

  return results;
}

/**
 * Scan all project directories for .jsonl files with recent mtime.
 * Returns sessions whose transcript was modified within MTIME_THRESHOLD_MS.
 */
function scanByMtime(): { session_id: string; file_path: string; project_dir: string }[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];

  const results: { session_id: string; file_path: string; project_dir: string }[] = [];
  const now = Date.now();

  try {
    const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory());

    for (const dir of projectDirs) {
      const dirPath = path.join(PROJECTS_DIR, dir.name);
      try {
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          try {
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs < MTIME_THRESHOLD_MS) {
              results.push({
                session_id: file.replace('.jsonl', ''),
                file_path: filePath,
                project_dir: dir.name,
              });
            }
          } catch { /* stat failed, skip */ }
        }
      } catch { /* readdir failed, skip */ }
    }
  } catch { /* top-level readdir failed */ }

  return results;
}

/**
 * Find the .jsonl session file for a given session UUID.
 */
function findSessionFile(sessionId: string): { filePath: string; projectDir: string } | null {
  if (!fs.existsSync(PROJECTS_DIR)) return null;

  try {
    const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory());

    for (const dir of projectDirs) {
      const candidate = path.join(PROJECTS_DIR, dir.name, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        return { filePath: candidate, projectDir: dir.name };
      }
    }
  } catch { /* skip */ }

  return null;
}

/**
 * Three-tier scan for active sessions.
 *
 * 1. PID-registered sessions (from heartbeats): validate with kill -0
 * 2. fuser on task dirs: discover sessions with open handles
 * 3. mtime on .jsonl files: catch recently-active sessions without PIDs
 */
export async function scanActiveSessions(opts?: { forceFuser?: boolean }): Promise<ActiveSession[]> {
  const seen = new Set<string>();
  const sessions: ActiveSession[] = [];

  try {
    // Tier 1: Validate PIDs of heartbeat-registered sessions
    // DISTINCT ON (pid) keeps only the most recent session per PID,
    // so /clear transitions (same PID, new session) don't show both.
    // Uses statement_timeout to fail fast if DB is unresponsive (e.g. after sleep/wake).
    const client = await getClient();
    let registered: { session_id: string; pid: number; file_path: string; project_dir: string | null; assistant: string }[];
    try {
      await client.query('SET LOCAL statement_timeout = 5000');
      const result = await client.query(
        `SELECT DISTINCT ON (s.pid)
           s.session_id,
           s.pid,
           s.file_path,
           s.project_dir,
           a.handle as assistant
         FROM sessions s
         JOIN assistants a ON a.id = s.assistant_id
         WHERE s.status = 'active'
           AND s.pid IS NOT NULL
           AND (
             (a.handle = 'claude-code' AND s.file_path LIKE $1)
             OR (a.handle = 'codex-cli' AND s.file_path LIKE $2)
             OR a.handle NOT IN ('claude-code', 'codex-cli')
           )
         ORDER BY s.pid, s.last_seen_at DESC`,
        [`${PROJECTS_DIR}/%`, `${path.join(os.homedir(), '.codex', 'sessions')}/%`]
      );
      registered = result.rows;
    } finally {
      client.release();
    }

    for (const row of registered) {
      if (isPidAlive(row.pid)) {
        sessions.push({
          session_id: row.session_id,
          file_path: row.file_path,
          pid: row.pid,
          project_dir: row.project_dir,
          assistant: row.assistant,
        });
        seen.add(`${row.assistant}:${row.session_id}`);
      }
    }

    // Tier 2: fuser on task dirs (expensive — throttled unless forced)
    const now = Date.now();
    const runFuser = opts?.forceFuser || now - lastFuserScanMs >= FUSER_INTERVAL_MS;
    const fuserMap = runFuser ? await scanTaskDirs() : new Map<string, number>();
    if (runFuser) lastFuserScanMs = now;
    for (const [sessionId, pid] of fuserMap) {
      const seenKey = `claude-code:${sessionId}`;
      if (seen.has(seenKey)) continue;
      const fileInfo = findSessionFile(sessionId);
      sessions.push({
        session_id: sessionId,
        file_path: fileInfo?.filePath ?? '',
        pid,
        project_dir: fileInfo?.projectDir ?? null,
        assistant: 'claude-code',
      });
      seen.add(seenKey);
    }

    // Tier 3: mtime heuristic
    const mtimeActive = scanByMtime();
    for (const entry of mtimeActive) {
      const seenKey = `claude-code:${entry.session_id}`;
      if (seen.has(seenKey)) continue;
      sessions.push({
        session_id: entry.session_id,
        file_path: entry.file_path,
        pid: null,
        project_dir: entry.project_dir,
        assistant: 'claude-code',
      });
      seen.add(seenKey);
    }
  } catch (err) {
    log.warn({ err }, 'Failed to scan for active sessions');
  }

  return sessions;
}

/**
 * Check if a single session is currently active by its session UUID.
 */
export async function isSessionAlive(sessionId: string): Promise<{ alive: boolean; pid?: number }> {
  // Check DB for known PID first
  const row = await querySingle<{ pid: number | null }>(
    `SELECT pid FROM sessions WHERE session_id = $1 AND status = 'active'`,
    [sessionId]
  );

  if (row?.pid && isPidAlive(row.pid)) {
    return { alive: true, pid: row.pid };
  }

  // Fallback: fuser on task dir
  const taskDir = path.join(TASKS_DIR, sessionId, '/');
  if (fs.existsSync(taskDir)) {
    const pid = await fuserCheck(taskDir);
    if (pid) return { alive: true, pid };
  }

  return { alive: false };
}

// ── Cache Management ─────────────────────────────────────────────────

/**
 * Load project map: encoded dir name → project ID.
 */
async function loadProjectMap(): Promise<Map<string, string>> {
  const projects = await query<{ id: string; path: string }>(
    `SELECT id, path FROM projects WHERE path IS NOT NULL AND path != ''`
  );

  const map = new Map<string, string>();
  for (const proj of projects) {
    const resolvedPath = proj.path.startsWith('~')
      ? path.join(os.homedir(), proj.path.slice(1))
      : proj.path;
    const encoded = resolvedPath.replace(/\//g, '-');
    map.set(encoded, proj.id);
  }
  return map;
}

/**
 * Resolve assistant handle to UUID.
 */
async function getAssistantId(handle: string): Promise<string | null> {
  const result = await querySingle<{ id: string }>(
    'SELECT id FROM assistants WHERE handle = $1',
    [handle]
  );
  return result?.id ?? null;
}

/**
 * Refresh the sessions table from scan results.
 * Updates status/pid for sessions found by the OS scanner.
 */
export async function refreshActiveSessionsCache(scanned: ActiveSession[]): Promise<void> {
  const projectMap = await loadProjectMap();
  const assistantCache = new Map<string, string>();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const foundAssistantIds: string[] = [];
    const foundSessionIds: string[] = [];

    for (const session of scanned) {
      let assistantId = assistantCache.get(session.assistant);
      if (!assistantId) {
        const id = await getAssistantId(session.assistant);
        if (!id) continue;
        assistantId = id;
        assistantCache.set(session.assistant, id);
      }

      let projectId: string | null = null;
      if (session.project_dir) {
        projectId = projectMap.get(session.project_dir) ?? null;
      }

      foundAssistantIds.push(assistantId);
      foundSessionIds.push(session.session_id);

      // Upsert: uses the UNIQUE(assistant_id, session_id) constraint.
      // pid is authoritative from the scan result — Tier 1 only emits live PIDs,
      // Tier 3 emits null (mtime-only). Direct assignment clears stale PIDs that
      // were set by a heartbeat for a process that has since died.
      await client.query(
        `INSERT INTO sessions (session_id, assistant_id, project_id, file_path, project_dir, pid, status, last_seen_at, first_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW(), NOW())
         ON CONFLICT (assistant_id, session_id) DO UPDATE SET
           project_id = COALESCE(EXCLUDED.project_id, sessions.project_id),
           file_path = EXCLUDED.file_path,
           project_dir = COALESCE(EXCLUDED.project_dir, sessions.project_dir),
           pid = EXCLUDED.pid,
           status = 'active',
           last_seen_at = NOW(),
           updated_at = NOW()`,
        [session.session_id, assistantId, projectId, session.file_path, session.project_dir, session.pid]
      );
    }

    // Find candidates for deactivation: currently-active sessions that the
    // scanner did not surface this tick. We do NOT trust the scanner miss
    // alone — many code paths (codex sessions without a recurring heartbeat,
    // fuser timeouts, transient PID races) can drop a session from a single
    // scan even though its process is still alive. Recheck each candidate's
    // PID with kill(0) and only deactivate on positive evidence of death.
    let candidatesResult;
    if (foundSessionIds.length > 0) {
      candidatesResult = await client.query<{ id: string; pid: number | null }>(
        `SELECT id, pid FROM sessions
         WHERE status = 'active'
           AND NOT EXISTS (
             SELECT 1
             FROM unnest($1::uuid[], $2::text[]) AS found(assistant_id, session_id)
             WHERE found.assistant_id = sessions.assistant_id
               AND found.session_id = sessions.session_id
           )`,
        [foundAssistantIds, foundSessionIds]
      );
    } else {
      candidatesResult = await client.query<{ id: string; pid: number | null }>(
        `SELECT id, pid FROM sessions WHERE status = 'active'`
      );
    }

    const toDeactivate: string[] = [];
    for (const row of candidatesResult.rows) {
      if (row.pid === null || !isPidAlive(row.pid)) {
        toDeactivate.push(row.id);
      }
    }

    if (toDeactivate.length > 0) {
      await client.query(
        `UPDATE sessions
         SET status = 'inactive', updated_at = NOW()
         WHERE id = ANY($1::uuid[])`,
        [toDeactivate]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get cached active sessions from the DB with joined metadata.
 * Now reads directly from the unified sessions table.
 */
export async function getCachedActiveSessions(filters?: {
  assistant?: string;
  project_id?: string;
  status?: string;
}): Promise<ActiveSessionRow[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  const status = filters?.status ?? 'active';
  conditions.push(`s.status = $${paramIndex++}`);
  params.push(status);

  if (filters?.assistant) {
    conditions.push(`a.handle = $${paramIndex++}`);
    params.push(filters.assistant);
  }

  if (filters?.project_id) {
    conditions.push(`s.project_id = $${paramIndex++}`);
    params.push(filters.project_id);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return query<ActiveSessionRow>(
    `SELECT
      s.id,
      s.session_id,
      s.assistant_id,
      a.handle as assistant_handle,
      a.name as assistant_name,
      s.project_id,
      p.handle as project_handle,
      p.name as project_name,
      s.file_path,
      s.project_dir,
      s.pid,
      s.status,
      s.last_seen_at,
      s.first_seen_at,
      s.created_at,
      s.updated_at,
      s.name,
      s.summary,
      s.message_count,
      s.started_at,
      s.ended_at,
      s.model,
      s.context_window_tokens,
      s.nickname,
      s.terminal_session_id
    FROM sessions s
    JOIN assistants a ON a.id = s.assistant_id
    LEFT JOIN projects p ON p.id = s.project_id
    ${whereClause}
    ORDER BY s.last_seen_at DESC`,
    params
  );
}

/**
 * Read cached active sessions and validate every non-null pid with kill -0.
 * Dead PIDs trigger an immediate row deactivation so subsequent reads (and
 * the UI's Connect gate) reflect reality without waiting for the next 10s
 * background scan.
 */
export async function getCachedActiveSessionsWithLiveness(filters?: {
  assistant?: string;
  project_id?: string;
  status?: string;
}): Promise<ActiveSessionRow[]> {
  const [rows, daemonOwned] = await Promise.all([
    getCachedActiveSessions(filters),
    listDaemonPtyPids(),
  ]);
  const stale: string[] = [];
  const live: ActiveSessionRow[] = [];
  for (const row of rows) {
    if (row.pid != null && !isPidAlive(row.pid)) {
      stale.push(row.id);
    } else {
      live.push({
        ...row,
        pid_is_self: row.pid != null && daemonOwned.has(row.pid),
      });
    }
  }
  if (stale.length > 0) {
    await query(
      `UPDATE sessions
       SET status = 'inactive', pid = NULL, updated_at = NOW()
       WHERE id = ANY($1::uuid[]) AND status = 'active'`,
      [stale]
    );
    log.info({ count: stale.length, sessionDbIds: stale }, 'deactivated sessions with dead PIDs on read');
  }
  return live;
}

/**
 * Get a single active session by its session_id (file UUID).
 */
export async function getActiveSessionBySessionId(sessionId: string): Promise<ActiveSessionRow | null> {
  return querySingle<ActiveSessionRow>(
    `SELECT
      s.id,
      s.session_id,
      s.assistant_id,
      a.handle as assistant_handle,
      a.name as assistant_name,
      s.project_id,
      p.handle as project_handle,
      p.name as project_name,
      s.file_path,
      s.project_dir,
      s.pid,
      s.status,
      s.last_seen_at,
      s.first_seen_at,
      s.created_at,
      s.updated_at,
      s.name,
      s.summary,
      s.message_count,
      s.started_at,
      s.ended_at,
      s.model,
      s.context_window_tokens,
      s.nickname,
      s.terminal_session_id
    FROM sessions s
    JOIN assistants a ON a.id = s.assistant_id
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE s.session_id = $1`,
    [sessionId]
  );
}

/**
 * Look up the most-recently-seen ACTIVE session attached to a given OS PID.
 *
 * Used by the MCP server's current-session resolver as a fallback when neither
 * KHEF_SESSION_ID nor the iTerm2 terminal session ID can identify the calling
 * agent. The MCP server walks its own ancestor PIDs (process.ppid, ppid of
 * ppid, ...) and asks the API to match each one against this table.
 *
 * status='active' filters out stale rows where the PID has been reused since
 * the session ended. We also pick the most recent active row in the rare case
 * a PID is double-claimed before deactivation.
 */
export async function getActiveSessionByPid(pid: number): Promise<ActiveSessionRow | null> {
  return querySingle<ActiveSessionRow>(
    `SELECT
      s.id,
      s.session_id,
      s.assistant_id,
      a.handle as assistant_handle,
      a.name as assistant_name,
      s.project_id,
      p.handle as project_handle,
      p.name as project_name,
      s.file_path,
      s.project_dir,
      s.pid,
      s.status,
      s.last_seen_at,
      s.first_seen_at,
      s.created_at,
      s.updated_at,
      s.name,
      s.summary,
      s.message_count,
      s.started_at,
      s.ended_at,
      s.model,
      s.context_window_tokens,
      s.nickname,
      s.terminal_session_id
    FROM sessions s
    JOIN assistants a ON a.id = s.assistant_id
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE s.pid = $1 AND s.status = 'active'
    ORDER BY s.last_seen_at DESC
    LIMIT 1`,
    [pid]
  );
}

export interface HeartbeatOptions {
  pid?: number;
  terminalSessionId?: string;
  /** Defaults to 'claude-code' for backward compatibility with the UserPromptSubmit hook. */
  assistantHandle?: string;
  /**
   * Absolute working directory of the session. Used by Codex (which stores
   * transcripts under ~/.codex/sessions/YYYY/MM/DD/) to derive project_dir
   * from session_meta.payload.cwd. Ignored by Claude callers, which keep
   * deriving project_dir from the ~/.claude/projects/ file path.
   */
  projectPath?: string;
}

function normalizeTerminalSessionId(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.includes(':') ? trimmed.split(':').pop() || null : trimmed;
}

/**
 * Register or refresh an active session via heartbeat.
 *
 * Claude Code: called by the UserPromptSubmit hook with $PPID; project_dir
 *   is extracted from the ~/.claude/projects/<encoded-dir>/ file path.
 * Codex CLI: called via the Codex registration helper with assistantHandle
 *   'codex-cli' and projectPath from session_meta.payload.cwd.
 *
 * When a PID is provided, any other active session with that same PID
 * is marked inactive (handles /clear session transitions in the same terminal).
 */
export async function heartbeatSession(
  sessionId: string,
  filePath: string,
  opts: HeartbeatOptions = {}
): Promise<void> {
  const { pid, terminalSessionId, assistantHandle, projectPath } = opts;
  // Infer the assistant from the transcript path when the caller did not
  // pass one explicitly. Codex transcripts live under ~/.codex/sessions and
  // Claude Code transcripts under ~/.claude/projects; without this inference
  // every codex heartbeat (which posts to the generic /heartbeat endpoint
  // with no assistant in the body) would register a phantom claude-code row
  // owning the codex session UUID, leading to duplicate rows in the active
  // list and crashes in clients that key by sessionID alone.
  const codexSessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
  const resolvedAssistantHandle = assistantHandle
    ?? (filePath.startsWith(codexSessionsRoot + path.sep) ? 'codex-cli' : 'claude-code');
  const normalizedTerminalSessionId = normalizeTerminalSessionId(terminalSessionId);

  // Derive project_dir. Claude: from the ~/.claude/projects/<encoded>/ path.
  // Codex: encode the cwd the same way (slash → dash) so project_dir means
  // the same thing across assistants and matches loadProjectMap() keys.
  let projectDir: string | null = null;
  if (projectPath) {
    const resolved = projectPath.startsWith('~')
      ? path.join(os.homedir(), projectPath.slice(1))
      : projectPath;
    projectDir = resolved.replace(/\//g, '-');
  } else {
    const projectsPrefix = PROJECTS_DIR + '/';
    if (filePath.startsWith(projectsPrefix)) {
      const relative = filePath.slice(projectsPrefix.length);
      const slashIdx = relative.indexOf('/');
      if (slashIdx > 0) {
        projectDir = relative.slice(0, slashIdx);
      }
    }
  }

  // Resolve project_id from project_dir
  let projectId: string | null = null;
  if (projectDir) {
    const projectMap = await loadProjectMap();
    projectId = projectMap.get(projectDir) ?? null;
  }

  const assistantId = await getAssistantId(resolvedAssistantHandle);
  if (!assistantId) {
    log.warn({ assistantHandle: resolvedAssistantHandle }, 'Cannot heartbeat: assistant not found');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // If a PID is provided, clear it from any other active session
    // (handles /clear — same terminal, new session ID)
    if (pid) {
      await client.query(
        `UPDATE sessions
         SET pid = NULL, status = 'inactive', updated_at = NOW()
         WHERE pid = $1 AND session_id != $2 AND status = 'active'`,
        [pid, sessionId]
      );
    }

    // Upsert this session using the UNIQUE(assistant_id, session_id) constraint
    await client.query(
      `INSERT INTO sessions (session_id, assistant_id, project_id, file_path, project_dir, pid, terminal_session_id, status, last_seen_at, first_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), NOW())
       ON CONFLICT (assistant_id, session_id) DO UPDATE SET
         project_id = COALESCE(EXCLUDED.project_id, sessions.project_id),
         file_path = EXCLUDED.file_path,
         project_dir = COALESCE(EXCLUDED.project_dir, sessions.project_dir),
         pid = COALESCE(EXCLUDED.pid, sessions.pid),
         terminal_session_id = EXCLUDED.terminal_session_id,
         status = 'active',
         last_seen_at = NOW(),
         updated_at = NOW()`,
      [sessionId, assistantId, projectId, filePath, projectDir, pid ?? null, normalizedTerminalSessionId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  log.info({ sessionId, assistantHandle: resolvedAssistantHandle, projectDir, pid: pid ?? null }, 'Session heartbeat registered');
}

/**
 * Assign a nickname to a session.
 * Called by the SessionStart hook to give each session a human-friendly name.
 *
 * If `requestedNickname` is provided, the session claims that name (allows
 * sharing — multiple sessions can hold the same nickname for lineage/handoff).
 * If not provided and the session already has a nickname, returns it.
 * Otherwise auto-generates a unique one.
 */
export async function assignNickname(sessionId: string, requestedNickname?: string): Promise<string | null> {
  const existing = await querySingle<{ nickname: string | null }>(
    'SELECT nickname FROM sessions WHERE session_id = $1',
    [sessionId]
  );

  if (!existing) return null; // session not registered yet

  // Explicit claim — always update, even if session already has a different nickname
  // Multiple sessions can share a nickname (for lineage/handoff) — no displacement
  if (requestedNickname) {
    const normalized = requestedNickname.toLowerCase().trim();

    await query(
      `UPDATE sessions SET nickname = $1, updated_at = NOW() WHERE session_id = $2`,
      [normalized, sessionId]
    );
    log.info({ sessionId, nickname: normalized, explicit: true }, 'Nickname claimed');
    return normalized;
  }

  if (existing.nickname) return existing.nickname;

  const nickname = await generateNickname();
  await query(
    `UPDATE sessions SET nickname = $1, updated_at = NOW() WHERE session_id = $2 AND nickname IS NULL`,
    [nickname, sessionId]
  );

  log.info({ sessionId, nickname }, 'Nickname assigned');
  return nickname;
}

// ── Codex Session Registration ───────────────────────────────────────

export interface CodexRegistrationResult {
  session_id: string;
  nickname: string | null;
  file_path: string;
  project_id: string | null;
  project_handle: string | null;
  cwd: string | null;
  synced: boolean;
}

/**
 * Register a Codex session as active using its real session UUID from
 * session_meta.payload.id. Reads metadata from the JSONL, optionally syncs
 * the transcript so the same row holds both runtime state and parsed
 * messages, then heartbeats with assistantHandle 'codex-cli' and assigns
 * (or fetches) a nickname.
 *
 * The Codex CLI process does not call this itself — it is invoked by the
 * Codex wrapper (lib/shell/codeks.sh) once it discovers the new JSONL on
 * disk, or directly via POST /api/active-sessions/register-codex.
 */
export async function registerCodexSessionFile(
  filePath: string,
  opts: {
    pid?: number;
    terminalSessionId?: string;
    /** Skip nickname assignment (default: assign). */
    assignNickname?: boolean;
    /** Skip syncing transcript content (default: sync). */
    syncTranscript?: boolean;
  } = {}
): Promise<CodexRegistrationResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Codex session file does not exist: ${filePath}`);
  }

  const meta: CodexSessionMeta | null = await readCodexSessionMeta(filePath);
  if (!meta) {
    throw new Error(`No session_meta found in Codex JSONL: ${filePath}`);
  }

  // Sync transcript content first so chunks/messages land before the UI shows
  // the session as active. Failure here should not block heartbeat.
  if (opts.syncTranscript !== false) {
    try {
      const projectMap = await loadSessionProjectMap();
      await syncOneSessionFile(filePath, projectMap);
    } catch (err) {
      log.warn({ err, filePath }, 'Codex transcript sync failed during registration');
    }
  }

  await heartbeatSession(meta.sessionId, filePath, {
    pid: opts.pid,
    terminalSessionId: opts.terminalSessionId,
    assistantHandle: 'codex-cli',
    projectPath: meta.cwd ?? undefined,
  });

  let nickname: string | null = null;
  if (opts.assignNickname !== false) {
    nickname = await assignNickname(meta.sessionId);
  } else {
    const row = await querySingle<{ nickname: string | null }>(
      'SELECT nickname FROM sessions WHERE session_id = $1',
      [meta.sessionId]
    );
    nickname = row?.nickname ?? null;
  }

  // Look up project handle for the response (project_id was resolved during heartbeat).
  const projectRow = await querySingle<{ project_id: string | null; project_handle: string | null }>(
    `SELECT s.project_id, p.handle as project_handle
     FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
     WHERE s.session_id = $1`,
    [meta.sessionId]
  );

  return {
    session_id: meta.sessionId,
    nickname,
    file_path: filePath,
    project_id: projectRow?.project_id ?? null,
    project_handle: projectRow?.project_handle ?? null,
    cwd: meta.cwd,
    synced: opts.syncTranscript !== false,
  };
}

/**
 * Resolve a session identifier (UUID or nickname) to all matching active session_ids.
 * Returns multiple results when a nickname is shared across sessions (lineage/handoff).
 * Results are ordered by last_seen_at DESC (most recent first).
 */
export async function resolveSessionIds(identifier: string): Promise<string[]> {
  // If it looks like a full UUID, return as-is
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier)) {
    return [identifier];
  }

  // If it looks like a partial UUID (hex with optional dashes, 8+ chars), try prefix match
  if (/^[0-9a-f-]{8,}$/i.test(identifier)) {
    const rows = await query<{ session_id: string }>(
      `SELECT session_id FROM sessions WHERE session_id LIKE $1 AND status = 'active' ORDER BY last_seen_at DESC LIMIT 2`,
      [identifier.toLowerCase() + '%']
    );
    if (rows.length === 1) return [rows[0].session_id];
    // 0 matches or ambiguous (2+) — fall through
  }

  // Nickname lookup — may return multiple active sessions sharing the same name.
  // Filter out stale active sessions: if the most recent session with this nickname
  // is inactive, any older "active" sessions are stale (never properly deactivated).
  const rows = await query<{ session_id: string; status: string }>(
    `SELECT session_id, status FROM sessions WHERE nickname = $1 ORDER BY last_seen_at DESC`,
    [identifier.toLowerCase()]
  );

  if (rows.length === 0) return [];

  // If the most recent session is inactive, don't fall back to older stale "active" ones
  if (rows[0].status === 'inactive') return [];

  return rows.filter(r => r.status === 'active').map(r => r.session_id);
}

/**
 * Check if a nickname has an inactive session (for better error messages).
 * Returns the session_id if found, null otherwise.
 */
export async function findInactiveSession(nickname: string): Promise<string | null> {
  const row = await querySingle<{ session_id: string }>(
    `SELECT session_id FROM sessions WHERE nickname = $1 AND status = 'inactive' ORDER BY last_seen_at DESC LIMIT 1`,
    [nickname.toLowerCase()]
  );
  return row?.session_id ?? null;
}

/**
 * Resolve a session identifier (UUID or nickname) to a single session_id.
 * When a nickname matches multiple active sessions, returns the most recently seen.
 */
export async function resolveSessionId(identifier: string): Promise<string | null> {
  const ids = await resolveSessionIds(identifier);
  return ids[0] ?? null;
}

// ── Session Termination ──────────────────────────────────────────────

/**
 * Terminate an active session by sending SIGTERM to its PID.
 * Returns the PID that was signaled, or null if no live PID was found.
 */
export async function terminateSession(sessionId: string): Promise<{ terminated: boolean; pid: number | null }> {
  const row = await querySingle<{ pid: number | null }>(
    `SELECT pid FROM sessions WHERE session_id = $1 AND status = 'active'`,
    [sessionId]
  );

  if (!row?.pid) {
    return { terminated: false, pid: null };
  }

  if (!isPidAlive(row.pid)) {
    // PID is already dead — mark inactive
    await deactivateSession(sessionId);
    return { terminated: false, pid: row.pid };
  }

  try {
    process.kill(row.pid, 'SIGTERM');
    log.info({ sessionId, pid: row.pid }, 'Sent SIGTERM to session');

    await deactivateSession(sessionId);

    return { terminated: true, pid: row.pid };
  } catch (err) {
    log.warn({ sessionId, pid: row.pid, err }, 'Failed to send SIGTERM');
    return { terminated: false, pid: row.pid };
  }
}

// ── Session Deactivation ─────────────────────────────────────────────

/**
 * Mark a session as inactive. Called by the SessionEnd hook and by
 * terminateSession when the PID is dead or after sending SIGTERM.
 */
export async function deactivateSession(sessionId: string): Promise<boolean> {
  const result = await query(
    `UPDATE sessions SET status = 'inactive', updated_at = NOW() WHERE session_id = $1 AND status = 'active'`,
    [sessionId]
  );
  return (result as any).rowCount > 0;
}

// ── Background Scanner ───────────────────────────────────────────────

/**
 * Run a single scan cycle: detect active sessions and refresh the cache.
 */
async function runScanCycle(): Promise<void> {
  try {
    const scanned = await scanActiveSessions();
    await refreshActiveSessionsCache(scanned);
    log.debug({ count: scanned.length }, 'Background scan complete');
  } catch (err) {
    log.warn({ err }, 'Background scan failed');
  }
}

/**
 * Start the background scanner. Runs immediately, then every SCAN_INTERVAL_MS.
 */
export function startBackgroundScanner(): void {
  if (scannerInterval) return;

  log.info({ intervalMs: SCAN_INTERVAL_MS }, 'Active session scanner started');
  runScanCycle(); // Run immediately on startup
  scannerInterval = setInterval(runScanCycle, SCAN_INTERVAL_MS);
}

/**
 * Stop the background scanner.
 */
export function stopBackgroundScanner(): void {
  if (scannerInterval) {
    clearInterval(scannerInterval);
    scannerInterval = null;
    log.info('Active session scanner stopped');
  }
}

// ── Response Formatting ──────────────────────────────────────────────

/**
 * Format an active session row for API response.
 */
export function formatActiveSession(row: ActiveSessionRow) {
  return {
    id: row.id,
    session_id: row.session_id,
    nickname: row.nickname,
    assistant: {
      id: row.assistant_id,
      handle: row.assistant_handle,
      name: row.assistant_name,
    },
    project: row.project_id ? {
      id: row.project_id,
      handle: row.project_handle,
      name: row.project_name,
    } : null,
    file_path: row.file_path,
    project_dir: row.project_dir,
    pid: row.pid,
    pid_is_self: row.pid_is_self ?? false,
    terminal_session_id: row.terminal_session_id,
    status: row.status,
    last_seen_at: row.last_seen_at?.toISOString() ?? null,
    first_seen_at: row.first_seen_at?.toISOString() ?? null,
    created_at: row.created_at?.toISOString() ?? null,
    updated_at: row.updated_at?.toISOString() ?? null,
    transcript: row.message_count != null ? {
      synced_session_id: row.id,
      name: row.name,
      summary: row.summary,
      message_count: row.message_count,
      started_at: row.started_at?.toISOString() ?? null,
      ended_at: row.ended_at?.toISOString() ?? null,
      model: row.model ?? null,
      context_window_tokens: row.context_window_tokens ? parseInt(row.context_window_tokens, 10) : null,
    } : null,
  };
}
