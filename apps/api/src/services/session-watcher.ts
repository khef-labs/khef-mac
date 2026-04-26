/**
 * Session file watcher.
 * Watches Claude Code and Codex CLI session JSONL files and triggers
 * per-file sync on fs change events. Runs alongside the polled syncer
 * in phase 1 — emits deltas to the logger only (no Redis publish yet).
 */

import * as fs from 'fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { workerLogger } from '../lib/logger';
import { querySingle } from '../db/client';
import {
  SESSION_PATHS,
  syncOneSessionFile,
  loadSessionProjectMap,
} from './session-sync';
import {
  publishSessionDelta,
  roomForSession,
  ROOM_SESSIONS_ACTIVE,
  type SessionDelta,
} from './session-events';

const DEFAULT_ACTIVE_WINDOW_DAYS = 7;

async function loadActiveWindowDays(): Promise<number> {
  const row = await querySingle<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'sessions.watcherActiveWindowDays'`
  );
  const parsed = row ? Number(row.value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ACTIVE_WINDOW_DAYS;
  return parsed;
}

const log = workerLogger.child({ component: 'session-watcher' });

const PROJECT_MAP_REFRESH_MS = 60_000;

let watcher: FSWatcher | null = null;
let projectMap: Map<string, string> = new Map();
let projectMapRefreshAt = 0;
let inflight = new Set<string>();
let pending = new Map<string, NodeJS.Timeout>();

async function getProjectMap(): Promise<Map<string, string>> {
  const now = Date.now();
  if (now - projectMapRefreshAt > PROJECT_MAP_REFRESH_MS) {
    projectMap = await loadSessionProjectMap();
    projectMapRefreshAt = now;
  }
  return projectMap;
}

async function handleChange(filePath: string, event: 'add' | 'change'): Promise<void> {
  if (inflight.has(filePath)) {
    const existing = pending.get(filePath);
    if (existing) clearTimeout(existing);
    pending.set(
      filePath,
      setTimeout(() => handleChange(filePath, 'change').catch(() => {}), 25)
    );
    return;
  }

  inflight.add(filePath);
  const fsEventAt = Date.now();
  try {
    const map = await getProjectMap();
    const result = await syncOneSessionFile(filePath, map);
    if (!result) return;

    const latencyMs = Date.now() - fsEventAt;

    if (result.skipped) {
      log.debug({ filePath, event, latencyMs }, 'watcher skipped (unchanged)');
      return;
    }

    log.info(
      {
        filePath,
        event,
        isNew: result.isNew,
        messageDelta: result.messageDelta,
        tokenInputDelta: result.tokenInputDelta,
        tokenOutputDelta: result.tokenOutputDelta,
        parseMs: result.parseMs,
        upsertMs: result.upsertMs,
        latencyMs,
      },
      'watcher synced session'
    );

    const now = new Date().toISOString();
    if (result.isNew) {
      const created: SessionDelta = {
        type: 'session.created',
        session_id: result.sessionId,
        project_id: result.projectId,
        started_at: result.startedAt,
      };
      await publishSessionDelta(ROOM_SESSIONS_ACTIVE, created);
    }
    if (result.messageDelta > 0 || result.tokenInputDelta > 0 || result.tokenOutputDelta > 0) {
      const updated: SessionDelta = {
        type: 'session.updated',
        session_id: result.sessionId,
        message_count: result.messageCount,
        usage_delta: {
          input: result.tokenInputDelta,
          output: result.tokenOutputDelta,
          model: result.model,
        },
        at: now,
      };
      await publishSessionDelta(roomForSession(result.sessionId), updated);
      await publishSessionDelta(ROOM_SESSIONS_ACTIVE, updated);
    }
  } catch (err) {
    log.error({ err, filePath, event }, 'watcher sync failed');
  } finally {
    inflight.delete(filePath);
    const queued = pending.get(filePath);
    if (queued) {
      clearTimeout(queued);
      pending.delete(filePath);
      handleChange(filePath, 'change').catch(() => {});
    }
  }
}

export async function startSessionWatcher(): Promise<void> {
  if (watcher) return;

  const basePaths = Object.values(SESSION_PATHS)
    .map((c) => c.basePath)
    .filter((p) => fs.existsSync(p));

  if (basePaths.length === 0) {
    log.warn('No session base paths exist — watcher not started');
    return;
  }

  // Skip files that haven't been touched recently — active sessions only.
  // Without this, chokidar opens an fd per file and exhausts the process
  // limit on histories with thousands of old .jsonl sessions.
  const activeWindowDays = await loadActiveWindowDays();
  const activeCutoff = Date.now() - activeWindowDays * 24 * 60 * 60 * 1000;

  const ignoreStale = (targetPath: string, stats?: fs.Stats): boolean => {
    if (!stats) return false;
    if (stats.isDirectory()) return false;
    if (!targetPath.endsWith('.jsonl')) return true;
    return stats.mtimeMs < activeCutoff;
  };

  watcher = chokidar.watch(basePaths, {
    persistent: true,
    ignoreInitial: true,
    ignored: ignoreStale,
    awaitWriteFinish: {
      stabilityThreshold: 50,
      pollInterval: 20,
    },
    ignorePermissionErrors: true,
  });

  const isSessionFile = (p: string) => p.endsWith('.jsonl');

  watcher.on('add', (filePath) => {
    if (!isSessionFile(filePath)) return;
    void handleChange(filePath, 'add');
  });
  watcher.on('change', (filePath) => {
    if (!isSessionFile(filePath)) return;
    void handleChange(filePath, 'change');
  });
  watcher.on('error', (err) => {
    log.error({ err }, 'chokidar error');
  });

  projectMap = await loadSessionProjectMap();
  projectMapRefreshAt = Date.now();

  log.info({ basePaths, activeWindowDays }, 'Session watcher started');
}

export async function stopSessionWatcher(): Promise<void> {
  if (!watcher) return;
  await watcher.close();
  watcher = null;
  inflight.clear();
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  log.info('Session watcher stopped');
}
