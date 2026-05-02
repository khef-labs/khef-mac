import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { workerLogger } from '../lib/logger';
import type { PtyAttachResult, PtyDaemonRequest, PtyDaemonResponse, PtySpawnConfig } from './pty-daemon-types';

const log = workerLogger.child({ component: 'pty-daemon-client' });

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

type PtySubscriber = {
  onData: (data: string) => void;
  onExit: (exit: { code: number; signal: string | null }) => void;
};

let daemonChild: ChildProcess | null = null;
let daemonReadyPromise: Promise<void> | null = null;
let daemonFailed = false;
let nextRequestId = 1;

const pendingRequests = new Map<string, PendingRequest>();
const subscribers = new Map<string, Set<PtySubscriber>>();
const pendingDataUntilSubscribe = new Map<string, string[]>();

function childEntryPath(): string {
  const ext = path.extname(__filename);
  return path.join(__dirname, `pty-daemon-runner${ext}`);
}

function makeRequestId(): string {
  return `pty-${process.pid}-${nextRequestId++}`;
}

function clearPendingRequests(err: Error): void {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(err);
  }
  pendingRequests.clear();
}

function failAllSubscribers(exit: { code: number; signal: string | null }): void {
  for (const [, current] of subscribers) {
    for (const subscriber of current) subscriber.onExit(exit);
  }
  subscribers.clear();
  pendingDataUntilSubscribe.clear();
}

function handleDaemonMessage(message: PtyDaemonResponse): void {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;

  if (message.type === 'daemon_ready') return;

  if (message.type === 'response') {
    const pending = pendingRequests.get(message.requestId);
    if (!pending) return;
    pendingRequests.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.data);
    } else {
      pending.reject(new Error(message.error));
    }
    return;
  }

  if (message.type === 'pty_data') {
    const current = subscribers.get(message.ptyId);
    if (current && current.size > 0) {
      for (const subscriber of current) subscriber.onData(message.data);
      return;
    }
    const pending = pendingDataUntilSubscribe.get(message.ptyId);
    if (pending) pending.push(message.data);
    return;
  }

  if (message.type === 'pty_exit') {
    pendingDataUntilSubscribe.delete(message.ptyId);
    const current = subscribers.get(message.ptyId);
    if (!current) return;
    subscribers.delete(message.ptyId);
    const signal = message.signal == null ? null : String(message.signal);
    for (const subscriber of current) subscriber.onExit({ code: message.code, signal });
  }
}

function spawnDaemon(): Promise<void> {
  const entry = childEntryPath();
  log.info({ entry }, 'starting PTY daemon');

  daemonFailed = false;
  daemonChild = spawn(process.execPath, [...process.execArgv, entry], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: process.env,
  });

  daemonChild.stdout?.on('data', (chunk: Buffer) => {
    log.info({ msg: chunk.toString('utf8').trim() }, 'pty daemon stdout');
  });

  daemonChild.stderr?.on('data', (chunk: Buffer) => {
    log.warn({ msg: chunk.toString('utf8').trim() }, 'pty daemon stderr');
  });

  daemonChild.on('message', (message: PtyDaemonResponse) => {
    if (message.type === 'daemon_ready') {
      readyResolve?.();
      readyResolve = null;
      readyReject = null;
      return;
    }
    handleDaemonMessage(message);
  });

  daemonChild.on('exit', (code, signal) => {
    const err = new Error(`PTY daemon exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    log.warn({ code, signal }, 'PTY daemon exited');
    daemonFailed = true;
    clearPendingRequests(err);
    failAllSubscribers({ code: code ?? 1, signal: signal ?? null });
    daemonChild = null;
    daemonReadyPromise = null;
  });

  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  return new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
    const timer = setTimeout(() => {
      readyResolve = null;
      readyReject = null;
      reject(new Error('Timed out waiting for PTY daemon readiness'));
    }, 5000);

    const wrapResolve = () => {
      clearTimeout(timer);
      resolve();
    };

    const wrapReject = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };

    readyResolve = wrapResolve;
    readyReject = wrapReject;

    daemonChild?.once('error', (err) => {
      if (readyReject) {
        const rejectFn = readyReject;
        readyResolve = null;
        readyReject = null;
        rejectFn(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

export async function startPtyDaemon(): Promise<void> {
  if (daemonFailed) throw new Error('PTY daemon previously failed; restart the API process to recover');
  if (daemonReadyPromise) return daemonReadyPromise;
  if (daemonChild && daemonChild.connected) return;
  daemonReadyPromise = spawnDaemon().finally(() => {
    if (!daemonChild) daemonReadyPromise = null;
  });
  return daemonReadyPromise;
}

async function sendRequest<T = void>(request: PtyDaemonRequest): Promise<T> {
  await startPtyDaemon();
  if (!daemonChild?.connected) throw new Error('PTY daemon is not connected');
  const child = daemonChild;
  if (!child) throw new Error('PTY daemon disappeared before request send');

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(request.requestId);
      reject(new Error(`PTY daemon request timed out: ${request.type}`));
    }, 5000);

    pendingRequests.set(request.requestId, { resolve, reject, timer });

    try {
      child.send(request);
    } catch (err: any) {
      clearTimeout(timer);
      pendingRequests.delete(request.requestId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export async function createOrAttachPty(
  key: string,
  config: PtySpawnConfig,
  opts?: { adoptByPid?: number },
): Promise<PtyAttachResult> {
  const result = await sendRequest<PtyAttachResult | undefined>({
    type: 'create_or_attach',
    requestId: makeRequestId(),
    key,
    config,
    adoptByPid: opts?.adoptByPid,
  });
  if (!result) throw new Error('PTY daemon returned no attach result');
  pendingDataUntilSubscribe.set(result.ptyId, []);
  return result;
}

export async function writeToPty(ptyId: string, data: string): Promise<void> {
  await sendRequest({
    type: 'write',
    requestId: makeRequestId(),
    ptyId,
    data,
  });
}

export async function resizePty(ptyId: string, cols: number, rows: number): Promise<void> {
  await sendRequest({
    type: 'resize',
    requestId: makeRequestId(),
    ptyId,
    cols,
    rows,
  });
}

export async function killPty(ptyId: string): Promise<void> {
  pendingDataUntilSubscribe.delete(ptyId);
  await sendRequest({
    type: 'kill',
    requestId: makeRequestId(),
    ptyId,
  });
}

/**
 * Look up a daemon-owned PTY by its terminal key (e.g. `claude:resume:<sessionId>`).
 * Returns the ptyId if a PTY for that key is currently running, or null.
 */
export async function findPtyIdByKey(key: string): Promise<string | null> {
  if (!daemonChild?.connected) return null;
  try {
    const result = await sendRequest<{ ptyId: string | null } | undefined>({
      type: 'find_by_key',
      requestId: makeRequestId(),
      key,
    });
    return result?.ptyId ?? null;
  } catch {
    return null;
  }
}

/**
 * Look up a daemon-owned PTY by the OS pid of its child process. Independent
 * of how the PTY was keyed — works for both fresh-spawn (cwd-based key) and
 * resume (sessionId-based key) PTYs.
 */
export async function findPtyIdByPid(pid: number): Promise<string | null> {
  if (!daemonChild?.connected) return null;
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    const result = await sendRequest<{ ptyId: string | null } | undefined>({
      type: 'find_by_pid',
      requestId: makeRequestId(),
      pid,
    });
    return result?.ptyId ?? null;
  } catch {
    return null;
  }
}

/**
 * Find the daemon-owned PTY (if any) currently running a given session_id.
 * Probes by sessionId-based key first (resume case), then by cwd-based key
 * (fresh-spawn case is keyed by cwd, not sessionId). Returns the first
 * match, or null if no daemon PTY for that session is running.
 */
export async function findDaemonPtyForSession(sessionId: string): Promise<string | null> {
  if (!sessionId) return null;
  const claudeId = await findPtyIdByKey(`claude:resume:${sessionId}`);
  if (claudeId) return claudeId;
  const codexId = await findPtyIdByKey(`codex:resume:${sessionId}`);
  if (codexId) return codexId;
  return null;
}

/**
 * List PIDs of every claude/shell process currently owned by the PTY daemon.
 * Used to distinguish "session is active in our own browser PTY" from
 * "session is active in another terminal" — only the latter should gate the
 * Connect button. Returns an empty set when the daemon is unreachable.
 */
export async function listDaemonPtyPids(): Promise<Set<number>> {
  if (!daemonChild?.connected) return new Set();
  try {
    const result = await sendRequest<{ pids: number[] } | undefined>({
      type: 'list_pids',
      requestId: makeRequestId(),
    });
    return new Set(result?.pids ?? []);
  } catch (err) {
    log.warn({ err }, 'failed to list daemon PTY pids; assuming none');
    return new Set();
  }
}

export function subscribeToPty(
  ptyId: string,
  handlers: { onData: (data: string) => void; onExit: (exit: { code: number; signal: string | null }) => void }
): () => void {
  // A new subscriber reattaching cancels any pending idle-kill — typical for
  // browser-refresh reconnects.
  cancelIdleKill(ptyId);

  let set = subscribers.get(ptyId);
  if (!set) {
    set = new Set<PtySubscriber>();
    subscribers.set(ptyId, set);
  }
  const subscriber: PtySubscriber = {
    onData: handlers.onData,
    onExit: handlers.onExit,
  };
  set.add(subscriber);

  const pending = pendingDataUntilSubscribe.get(ptyId);
  if (pending && pending.length > 0) {
    for (const chunk of pending) handlers.onData(chunk);
    pending.length = 0;
  }
  pendingDataUntilSubscribe.delete(ptyId);

  return () => {
    const current = subscribers.get(ptyId);
    if (!current) return;
    current.delete(subscriber);
    if (current.size === 0) subscribers.delete(ptyId);
  };
}

// ── Idle-kill timer ────────────────────────────────────────────────
//
// When the last subscriber departs (browser tab closed without clicking
// Disconnect), we don't want the underlying claude process to linger
// forever — but we also can't kill immediately because a browser refresh
// drops the websocket for a brief moment before the new tab attaches.
// markPtyMaybeIdle schedules a kill after a short grace; cancelIdleKill is
// called from subscribeToPty when a fresh subscriber reattaches.

const idleKillTimers = new Map<string, NodeJS.Timeout>();
// Long enough that a user can hand a task to claude in the browser, navigate
// away (or refresh / close the tab), and come back to find the same PTY
// still running with whatever output claude produced in the meantime. 30
// minutes covers most "step out for a coffee" cases without leaving stale
// claude processes around forever.
const IDLE_KILL_GRACE_MS = 30 * 60_000;

function cancelIdleKill(ptyId: string): void {
  const timer = idleKillTimers.get(ptyId);
  if (timer) {
    clearTimeout(timer);
    idleKillTimers.delete(ptyId);
  }
}

export function markPtyMaybeIdle(ptyId: string, delayMs: number = IDLE_KILL_GRACE_MS): void {
  cancelIdleKill(ptyId);
  const set = subscribers.get(ptyId);
  if (set && set.size > 0) return;
  const timer = setTimeout(() => {
    idleKillTimers.delete(ptyId);
    if ((subscribers.get(ptyId)?.size ?? 0) > 0) return;
    log.info({ ptyId, graceMs: delayMs }, 'idle PTY had no subscribers within grace; killing');
    void killPty(ptyId).catch((err) => {
      log.warn({ err, ptyId }, 'idle-kill failed');
    });
  }, delayMs);
  idleKillTimers.set(ptyId, timer);
}

export async function stopPtyDaemon(): Promise<void> {
  if (!daemonChild?.connected) return;
  try {
    await sendRequest({
      type: 'shutdown',
      requestId: makeRequestId(),
    });
  } catch (err) {
    log.warn({ err }, 'graceful PTY daemon shutdown failed; sending SIGTERM');
  }
  try {
    daemonChild.kill('SIGTERM');
  } catch {
    // ignore
  }
}
