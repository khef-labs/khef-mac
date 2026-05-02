/**
 * Live PTY bridge over WebSocket.
 *
 * PTYs are owned by a single daemon child process so they survive browser
 * refresh / websocket reconnects. The API is only a broker between the
 * browser websocket and the daemon's IPC control plane.
 *
 * Wire protocol (text frames, JSON):
 *   client → server: { type: 'input', data: '...' }
 *                  | { type: 'resize', cols: number, rows: number }
 *                  | { type: 'kill' }
 *   server → client: { type: 'data', data: '...' }      (stdout chunks)
 *                  | { type: 'exit', code: number, signal: string|null }
 *                  | { type: 'error', message: string }
 *                  | { type: 'ready', pid: number, ptyId: string, reused: boolean }
 */

import { FastifyInstance } from 'fastify';
import {
  AUGMENTED_PATH,
  getCliBin,
  getSpawnFailureMessage,
  makeTerminalKey,
  resolveCwd,
  SHELL,
  type PtyCommand,
} from '../services/pty-runtime';
import {
  createOrAttachPty,
  killPty,
  markPtyMaybeIdle,
  resizePty,
  subscribeToPty,
  writeToPty,
} from '../services/pty-daemon';
import { getActiveSessionBySessionId } from '../services/active-sessions';
import { workerLogger } from '../lib/logger';

const log = workerLogger.child({ component: 'pty-bridge' });
log.info({ pathLen: AUGMENTED_PATH.length }, 'PTY route loaded with augmented PATH');

interface PtyQuery {
  cmd?: string;
  resume?: string;
  cwd?: string;
  filePath?: string;
  cols?: string;
  rows?: string;
  fresh?: string;
}

export default async function ptyRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: PtyQuery }>(
    '/spawn',
    { websocket: true },
    (socket, req) => {
      const q = req.query;
      const cols = Math.max(20, Math.min(500, parseInt(q.cols ?? '120', 10) || 120));
      const rows = Math.max(5, Math.min(200, parseInt(q.rows ?? '32', 10) || 32));
      const cmd: PtyCommand = q.cmd === 'codex' ? 'codex' : 'claude';
      const resume = typeof q.resume === 'string' && q.resume.length > 0 ? q.resume : null;
      const fresh = q.fresh === 'true';
      const { cwd, source: cwdSource } = resolveCwd(q.cwd, resume, q.filePath);
      const terminalKey = makeTerminalKey({
        cmd,
        resume,
        fresh,
        preferredFilePath: q.filePath,
        cwd,
      });

      // codex doesn't have a `--resume` flag; resume only applies to claude.
      const args: string[] = [];
      if (cmd === 'claude' && resume && !fresh) args.push('--resume', resume);

      const cliBin = getCliBin(cmd);
      // Strip iTerm-specific env vars so the SessionStart hook does not
      // capture a $ITERM_SESSION_ID inherited from whatever shell launched
      // the API. Daemon PTYs are not iTerm sessions; leaking the GUID makes
      // the active-session row look iTerm-owned and breaks live-message
      // delivery (osascript writes into a stale tab, or none at all).
      const inheritedEnv = { ...process.env };
      delete inheritedEnv.ITERM_SESSION_ID;
      delete inheritedEnv.ITERM_PROFILE;
      delete inheritedEnv.TERM_PROGRAM;
      delete inheritedEnv.TERM_PROGRAM_VERSION;
      const ptyEnv = {
        ...inheritedEnv,
        PATH: AUGMENTED_PATH,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORCE_COLOR: '1',
      };

      let closed = false;
      let ptyId: string | null = null;
      let disposeSubscription: (() => void) | null = null;

      const send = (msg: unknown) => {
        if (closed) return;
        try {
          socket.send(JSON.stringify(msg));
        } catch (err) {
          log.warn({ err, ptyId }, 'failed to send PTY websocket frame');
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        try { disposeSubscription?.(); } catch { /* ignore */ }
        disposeSubscription = null;
        // If this was the last subscriber, schedule the PTY for idle-kill so
        // closing a tab without clicking Disconnect doesn't leave zombies.
        // Refresh-style reconnects within the grace window cancel the timer.
        if (ptyId) markPtyMaybeIdle(ptyId);
      };

      void (async () => {
        try {
          // For resume reconnects, look up the active-session pid so the
          // daemon can adopt an existing PTY keyed by something else (e.g. a
          // fresh-spawn chat-PTY originally keyed by cwd). Without this, a
          // browser refresh would orphan the live process and spawn a new
          // claude at $HOME because resolveCwd can't recover the original
          // cwd until claude has written to the JSONL.
          let adoptByPid: number | undefined;
          if (resume) {
            try {
              const session = await getActiveSessionBySessionId(resume);
              if (session?.pid && session.pid > 0) adoptByPid = session.pid;
            } catch (err) {
              log.warn({ err, resume }, 'failed to look up session pid for adoption');
            }
          }

          const result = await createOrAttachPty(terminalKey, {
            cols,
            rows,
            cwd,
            env: ptyEnv,
            name: 'xterm-256color',
            command: cliBin || SHELL,
            args: cliBin ? args : [],
            fallbackCommand: SHELL,
            fallbackArgs: [],
            missingCommandMessage: cliBin
              ? undefined
              : `${cmd} not found in PATH; spawning shell — type \`${cmd}\` to start.`,
          }, { adoptByPid });

          ptyId = result.ptyId;
          disposeSubscription = subscribeToPty(result.ptyId, {
            onData: (data) => send({ type: 'data', data }),
            onExit: ({ code, signal }) => {
              log.info({ code, signal, ptyId: result.ptyId }, 'daemon PTY exited');
              send({ type: 'exit', code, signal });
              try { socket.close(); } catch { /* ignore */ }
            },
          });

          if (result.warning) send({ type: 'error', message: result.warning });
          send({ type: 'ready', pid: result.pid, ptyId: result.ptyId, reused: result.reused });
          log.info({ ptyId: result.ptyId, pid: result.pid, reused: result.reused, cwd, cwdSource, cmd, resume, fresh }, 'daemon PTY attached');
        } catch (err: any) {
          log.error({ err, cmd, resume, fresh, cwd }, 'failed to create or attach daemon PTY');
          send({ type: 'error', message: getSpawnFailureMessage(err) });
          try { socket.close(); } catch { /* ignore */ }
        }
      })();

      socket.on('message', (raw: Buffer) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString('utf8'));
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object' || !ptyId) return;

        if (msg.type === 'input' && typeof msg.data === 'string') {
          void writeToPty(ptyId, msg.data).catch((err) => {
            log.warn({ err, ptyId }, 'daemon PTY write failed');
          });
        } else if (msg.type === 'resize') {
          const c = Math.max(20, Math.min(500, Number(msg.cols) || cols));
          const r = Math.max(5, Math.min(200, Number(msg.rows) || rows));
          void resizePty(ptyId, c, r).catch((err) => {
            log.warn({ err, ptyId }, 'daemon PTY resize failed');
          });
        } else if (msg.type === 'kill') {
          void killPty(ptyId).catch((err) => {
            log.warn({ err, ptyId }, 'daemon PTY kill failed');
          });
        }
      });

      socket.on('close', () => {
        log.info({ ptyId }, 'ws closed; detaching from daemon PTY');
        cleanup();
      });

      socket.on('error', (err: Error) => {
        log.warn({ err, ptyId }, 'ws error; detaching from daemon PTY');
        cleanup();
      });
    }
  );
}
