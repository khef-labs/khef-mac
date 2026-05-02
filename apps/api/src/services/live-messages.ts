import { execFile } from 'child_process';
import { promisify } from 'util';
import { getRedis } from './redis';
import { getActiveSessionBySessionId } from './active-sessions';
import { findDaemonPtyForSession, findPtyIdByPid, writeToPty } from './pty-daemon';

const execFileAsync = promisify(execFile);

const NUDGE_SHORT_THRESHOLD = 500;
const NUDGE_PREVIEW_LEN = 140;

export interface LiveMessage {
  id: string;
  from_session_id: string;
  to_session_id: string;
  content: string;
  created_at: string;
}

export interface LiveDeliveryResult {
  message: LiveMessage;
  delivered: boolean;
  delivery_method?: 'iterm' | 'daemon-pty';
  delivery_error?: string;
}

const KEY_PREFIX = 'livemsg:';
const TTL_SECONDS = 86400; // 24 hours

function inboxKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function sendLiveMessage(
  fromSessionId: string,
  toSessionId: string,
  content: string,
  opts?: { persist?: boolean }
): Promise<LiveMessage> {
  const msg: LiveMessage = {
    id: generateId(),
    from_session_id: fromSessionId,
    to_session_id: toSessionId,
    content,
    created_at: new Date().toISOString(),
  };

  if (opts?.persist !== false) {
    const redis = getRedis();
    const key = inboxKey(toSessionId);
    await redis.lpush(key, JSON.stringify(msg));
    await redis.expire(key, TTL_SECONDS);
  }

  return msg;
}

/**
 * Send a live message and attempt synchronous iTerm2 delivery so the agent
 * receives it without waiting for its next prompt. The full content is typed
 * into the terminal as user input when short enough; longer messages get a
 * preview nudge with a `check_live_messages` hint and full content persisted
 * to Redis.
 *
 * Returns the LiveMessage record. The `delivered` flag indicates whether the
 * iTerm delivery succeeded (the message was typed into the terminal).
 */
export async function deliverLiveMessage(
  fromSessionId: string,
  toSessionId: string,
  content: string,
  opts?: { fromNickname?: string; senderLabel?: string },
): Promise<LiveDeliveryResult> {
  const sender = opts?.senderLabel
    ?? (opts?.fromNickname
      ? `${opts.fromNickname} (${fromSessionId})`
      : fromSessionId);
  const flat = content.replace(/\s+/g, ' ').trim();
  const isShort = flat.length <= NUDGE_SHORT_THRESHOLD;
  const nudge = isShort
    ? (opts?.fromNickname || opts?.senderLabel
        ? `Live message from ${sender}: ${flat}`
        : flat)
    : `Message from ${sender}: ${flat.slice(0, NUDGE_PREVIEW_LEN)}… (use check_live_messages to read)`;

  let delivered = false;
  let deliveryMethod: LiveDeliveryResult['delivery_method'];
  let deliveryError: string | undefined;
  try {
    const session = await getActiveSessionBySessionId(toSessionId);
    // iTerm-registered sessions get the osascript path. Daemon-owned PTYs
    // (chat-spawned claude / codex) have no terminal_session_id, so we write
    // the bytes directly into the PTY instead. Look up by PID since the
    // daemon's terminalKey can be cwd-based or sessionId-based depending on
    // how the PTY was spawned.
    if (session?.terminal_session_id) {
      const result = await deliverViaIterm(session.terminal_session_id, nudge);
      delivered = result.delivered;
      deliveryMethod = 'iterm';
      deliveryError = result.error;
    } else if (session?.pid) {
      const result = await deliverViaDaemonPty(toSessionId, nudge, session.pid);
      delivered = result.delivered;
      deliveryMethod = 'daemon-pty';
      deliveryError = result.error;
    }
  } catch (err: any) {
    delivered = false;
    deliveryError = err?.message || String(err);
  }

  // Persist only if the iTerm delivery missed or the message is too long to inline.
  const persist = !(isShort && delivered);
  const message = await sendLiveMessage(fromSessionId, toSessionId, content, { persist });
  return { message, delivered, delivery_method: deliveryMethod, delivery_error: deliveryError };
}

export async function checkLiveMessages(
  sessionId: string,
  opts?: { limit?: number; peek?: boolean }
): Promise<LiveMessage[]> {
  const redis = getRedis();
  const key = inboxKey(sessionId);
  const limit = opts?.limit ?? 50;

  const raw = await redis.lrange(key, 0, limit - 1);

  if (!opts?.peek && raw.length > 0) {
    // Clear read messages
    await redis.ltrim(key, raw.length, -1);
  }

  return raw.map((s) => JSON.parse(s) as LiveMessage);
}

export async function countLiveMessages(sessionId: string): Promise<number> {
  const redis = getRedis();
  return redis.llen(inboxKey(sessionId));
}

export async function deleteLiveMessage(
  toSessionId: string,
  messageId: string,
  fromSessionId: string
): Promise<{ deleted: boolean; message?: LiveMessage }> {
  const redis = getRedis();
  const key = inboxKey(toSessionId);

  const raw = await redis.lrange(key, 0, -1);

  for (const entry of raw) {
    const msg = JSON.parse(entry) as LiveMessage;
    if (msg.id === messageId) {
      if (msg.from_session_id !== fromSessionId) {
        return { deleted: false };
      }
      await redis.lrem(key, 1, entry);
      return { deleted: true, message: msg };
    }
  }

  return { deleted: false };
}

export async function clearLiveMessages(sessionId: string): Promise<number> {
  const redis = getRedis();
  const key = inboxKey(sessionId);
  const count = await redis.llen(key);
  await redis.del(key);
  return count;
}

/**
 * Deliver a nudge to a daemon-owned PTY (chat-spawned claude / codex) by
 * writing the message bytes directly into the PTY's stdin. claude reads it
 * as user input and submits on the trailing CR. Returns { delivered: false }
 * if no daemon PTY is currently hosting the session.
 *
 * Looks up the PTY by `pid` first (works for both fresh-spawn and resume
 * keys), then falls back to a sessionId-based key probe.
 */
export async function deliverViaDaemonPty(
  sessionId: string,
  nudgeText: string,
  pid?: number | null,
): Promise<{ delivered: boolean; error?: string }> {
  try {
    let ptyId: string | null = null;
    if (pid) ptyId = await findPtyIdByPid(pid);
    if (!ptyId) ptyId = await findDaemonPtyForSession(sessionId);
    if (!ptyId) return { delivered: false };
    // Two-step write mirrors the iTerm path: type the text first, then a
    // separate CR to land outside any bracketed-paste envelope claude may
    // have set up around the typed run.
    await writeToPty(ptyId, nudgeText);
    await writeToPty(ptyId, '\r');
    return { delivered: true };
  } catch (err: any) {
    return { delivered: false, error: err?.message || String(err) };
  }
}

/**
 * Deliver a nudge to an iTerm2 terminal session via osascript `write text`.
 * This types the message into the target terminal as user input, triggering
 * Claude Code's UserPromptSubmit hook which checks for live messages.
 */
export async function deliverViaIterm(
  terminalSessionId: string,
  nudgeText: string
): Promise<{ delivered: boolean; error?: string }> {
  try {
    const normalizedTerminalSessionId = terminalSessionId.trim().split(':').pop() || terminalSessionId;
    const escaped = nudgeText.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    // Two-step write: text without newline, then a standalone newline.
    // Claude Code's TUI uses bracketed paste mode, so a trailing \n inside the
    // paste envelope is treated as a literal newline rather than Enter. Sending
    // the Return as a separate write lands it outside the paste block.
    const script = `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if id of s is "${normalizedTerminalSessionId}" then
          tell s to write text "${escaped}" newline no
          delay 0.05
          tell s to write text ""
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "not_found"`;

    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
    return { delivered: stdout.trim() === 'ok' };
  } catch (err: any) {
    return { delivered: false, error: err.message || String(err) };
  }
}
