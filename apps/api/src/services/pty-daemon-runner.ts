import { spawn, IPty } from 'node-pty';
import { AUGMENTED_PATH, getSpawnFailureMessage, NODE_PTY_SPAWN_HELPER, ensureNodePtySpawnHelperExecutable, ptyRuntimeLogger } from './pty-runtime';
import type { PtyAttachResult, PtyDaemonRequest, PtyDaemonResponse } from './pty-daemon-types';

ensureNodePtySpawnHelperExecutable();

const log = ptyRuntimeLogger.child({ component: 'pty-daemon' });

interface ManagedPty {
  id: string;
  key: string;
  pty: IPty;
}

const ptysById = new Map<string, ManagedPty>();
const ptyIdsByKey = new Map<string, string>();

function send(msg: PtyDaemonResponse): void {
  if (typeof process.send === 'function') {
    process.send(msg);
  }
}

function registerPty(key: string, pty: IPty): ManagedPty {
  const id = key;
  const managed: ManagedPty = { id, key, pty };
  ptysById.set(id, managed);
  ptyIdsByKey.set(key, id);

  pty.onData((data) => {
    send({ type: 'pty_data', ptyId: id, data });
  });

  pty.onExit(({ exitCode, signal }) => {
    ptysById.delete(id);
    ptyIdsByKey.delete(key);
    send({ type: 'pty_exit', ptyId: id, code: exitCode, signal: signal ?? null });
  });

  return managed;
}

function killManagedPty(managed: ManagedPty): void {
  try {
    managed.pty.kill();
  } catch (err) {
    log.warn({ err, ptyId: managed.id }, 'failed to kill managed pty');
  }
}

function killAllPtys(): void {
  for (const managed of ptysById.values()) {
    killManagedPty(managed);
  }
}

function createOrAttachPty(request: Extract<PtyDaemonRequest, { type: 'create_or_attach' }>): PtyAttachResult {
  const existingId = ptyIdsByKey.get(request.key);
  if (existingId) {
    const existing = ptysById.get(existingId);
    if (existing) {
      try { existing.pty.resize(request.config.cols, request.config.rows); } catch (err) { log.warn({ err, ptyId: existingId }, 'failed to resize existing pty'); }
      return { ptyId: existing.id, pid: existing.pty.pid, reused: true };
    }
    ptyIdsByKey.delete(request.key);
  }

  // Adoption fallback: if the canonical key has no PTY but the caller
  // supplied a known child pid, look for a managed PTY whose pid matches.
  // Used when the browser reconnects to a fresh-spawn chat-PTY using its
  // resolved sessionId — the existing PTY was keyed by cwd, so the
  // sessionId-based key would otherwise spawn a brand-new one and orphan
  // the live process.
  if (request.adoptByPid && request.adoptByPid > 0) {
    for (const managed of ptysById.values()) {
      if (managed.pty.pid !== request.adoptByPid) continue;
      ptyIdsByKey.set(request.key, managed.id);
      try { managed.pty.resize(request.config.cols, request.config.rows); } catch (err) {
        log.warn({ err, ptyId: managed.id }, 'failed to resize adopted pty');
      }
      log.info({ key: request.key, adoptedFromPid: request.adoptByPid, ptyId: managed.id }, 'adopted existing daemon pty by pid');
      return { ptyId: managed.id, pid: managed.pty.pid, reused: true };
    }
  }

  const env = {
    ...request.config.env,
    PATH: request.config.env.PATH || AUGMENTED_PATH,
  };

  let pty: IPty | null = null;
  let warning: string | undefined;

  try {
    pty = spawn(request.config.command, request.config.args, {
      name: request.config.name,
      cols: request.config.cols,
      rows: request.config.rows,
      cwd: request.config.cwd,
      env,
    });
    log.info({ key: request.key, command: request.config.command, cwd: request.config.cwd }, 'spawned daemon pty');
  } catch (err: any) {
    log.warn({ err, key: request.key, command: request.config.command }, 'primary pty spawn failed; trying fallback shell');
  }

  if (!pty) {
    if (request.config.missingCommandMessage) {
      warning = request.config.missingCommandMessage;
    } else if (NODE_PTY_SPAWN_HELPER) {
      warning = getSpawnFailureMessage(new Error('spawn failed'));
    }
    pty = spawn(request.config.fallbackCommand, request.config.fallbackArgs, {
      name: request.config.name,
      cols: request.config.cols,
      rows: request.config.rows,
      cwd: request.config.cwd,
      env,
    });
    log.info({ key: request.key, shell: request.config.fallbackCommand, cwd: request.config.cwd }, 'spawned daemon fallback shell');
  }

  const managed = registerPty(request.key, pty);
  return {
    ptyId: managed.id,
    pid: pty.pid,
    reused: false,
    warning,
  };
}

function handleRequest(request: PtyDaemonRequest): void {
  try {
    switch (request.type) {
      case 'create_or_attach': {
        const data = createOrAttachPty(request);
        send({ type: 'response', requestId: request.requestId, ok: true, data });
        return;
      }
      case 'write': {
        const managed = ptysById.get(request.ptyId);
        if (!managed) throw new Error(`PTY not found: ${request.ptyId}`);
        managed.pty.write(request.data);
        send({ type: 'response', requestId: request.requestId, ok: true });
        return;
      }
      case 'resize': {
        const managed = ptysById.get(request.ptyId);
        if (!managed) throw new Error(`PTY not found: ${request.ptyId}`);
        managed.pty.resize(request.cols, request.rows);
        send({ type: 'response', requestId: request.requestId, ok: true });
        return;
      }
      case 'kill': {
        const managed = ptysById.get(request.ptyId);
        if (managed) killManagedPty(managed);
        send({ type: 'response', requestId: request.requestId, ok: true });
        return;
      }
      case 'list_pids': {
        const pids = Array.from(ptysById.values()).map((m) => m.pty.pid);
        send({ type: 'response', requestId: request.requestId, ok: true, data: { pids } });
        return;
      }
      case 'find_by_key': {
        const ptyId = ptyIdsByKey.get(request.key) ?? null;
        send({ type: 'response', requestId: request.requestId, ok: true, data: { ptyId } });
        return;
      }
      case 'find_by_pid': {
        let ptyId: string | null = null;
        for (const managed of ptysById.values()) {
          if (managed.pty.pid === request.pid) {
            ptyId = managed.id;
            break;
          }
        }
        send({ type: 'response', requestId: request.requestId, ok: true, data: { ptyId } });
        return;
      }
      case 'shutdown': {
        killAllPtys();
        send({ type: 'response', requestId: request.requestId, ok: true });
        setTimeout(() => process.exit(0), 50);
        return;
      }
    }
  } catch (err: any) {
    send({ type: 'response', requestId: request.requestId, ok: false, error: err?.message || String(err) });
  }
}

process.on('message', (msg: PtyDaemonRequest) => {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  handleRequest(msg);
});

const shutdown = () => {
  try {
    killAllPtys();
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  log.error({ err }, 'pty daemon uncaught exception');
  shutdown();
});
process.on('unhandledRejection', (err) => {
  log.error({ err }, 'pty daemon unhandled rejection');
  shutdown();
});

send({ type: 'daemon_ready' });
