/**
 * Session event bus.
 * Publishes session deltas to Redis so SSE connections on any API instance
 * can forward them to subscribed clients. Keeps a bounded per-room ring
 * buffer so reconnecting clients can replay missed events via Last-Event-Id.
 */

import { EventEmitter } from 'events';
import Redis from 'ioredis';
import { logger } from '../lib/logger';
import { getRedis } from './redis';

const log = logger.child({ component: 'session-events' });

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6399';
const CHANNEL_PREFIX = 'khef:sse:';
const BACKLOG_PER_ROOM = 100;

export type SessionDelta =
  | { type: 'session.created'; session_id: string; project_id: string | null; started_at: string | null }
  | { type: 'session.updated'; session_id: string; message_count: number; usage_delta?: UsageDelta; at: string }
  | { type: 'session.ended'; session_id: string; ended_at: string }
  | { type: 'session.nickname'; session_id: string; nickname: string };

export interface UsageDelta {
  input: number;
  output: number;
  cache_creation?: number;
  cache_read?: number;
  model: string | null;
}

/**
 * Known room namespaces:
 *   session:<id>             — per-session deltas
 *   sessions:active          — broadcast for all active sessions
 *   agent-questions          — broadcast for agent-question events
 *   agent-questions:<nick>   — agent-question events filtered by nickname
 *
 * The `delta` payload is opaque to the bus; senders type their own shapes.
 */
export interface PublishedEvent {
  id: string;
  room: string;
  delta: unknown;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const backlog: Map<string, PublishedEvent[]> = new Map();

let idCounter = 0;
function nextEventId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${Date.now()}-${idCounter}`;
}

function channelFor(room: string): string {
  return `${CHANNEL_PREFIX}${room}`;
}

function roomFromChannel(channel: string): string {
  return channel.startsWith(CHANNEL_PREFIX) ? channel.slice(CHANNEL_PREFIX.length) : channel;
}

function pushBacklog(event: PublishedEvent): void {
  let buf = backlog.get(event.room);
  if (!buf) {
    buf = [];
    backlog.set(event.room, buf);
  }
  buf.push(event);
  if (buf.length > BACKLOG_PER_ROOM) {
    buf.splice(0, buf.length - BACKLOG_PER_ROOM);
  }
}

/**
 * Publish a delta to a room. Fire-and-forget; network errors are logged, not thrown.
 * `delta` is opaque — any JSON-serializable value works.
 */
export async function publishToRoom(room: string, delta: unknown): Promise<void> {
  const event: PublishedEvent = { id: nextEventId(), room, delta };
  try {
    const redis = getRedis();
    await redis.publish(channelFor(room), JSON.stringify(event));
  } catch (err) {
    log.warn({ err, room }, 'publish failed');
  }
}

/** @deprecated Use `publishToRoom`. Kept for back-compat. */
export const publishSessionDelta = publishToRoom;

/**
 * Replay backlog entries for a room that occurred after the given Last-Event-Id.
 * Returns [] if the id is unknown or the backlog has already rolled past it.
 */
export function replayAfter(room: string, lastEventId: string | undefined): PublishedEvent[] {
  if (!lastEventId) return [];
  const buf = backlog.get(room);
  if (!buf) return [];
  const idx = buf.findIndex((e) => e.id === lastEventId);
  if (idx === -1) return [];
  return buf.slice(idx + 1);
}

/**
 * Subscribe to session deltas on the event bus. Returns an unsubscribe fn.
 */
export function onSessionEvent(listener: (event: PublishedEvent) => void): () => void {
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}

let subscriber: Redis | null = null;

export async function startSessionEventBus(): Promise<void> {
  if (subscriber) return;
  subscriber = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

  subscriber.on('error', (err) => log.warn({ err }, 'subscriber error'));

  try {
    await subscriber.connect();
    await subscriber.psubscribe(`${CHANNEL_PREFIX}*`);
  } catch (err) {
    log.warn({ err }, 'failed to start event bus — live updates disabled');
    await subscriber.quit().catch(() => {});
    subscriber = null;
    return;
  }

  subscriber.on('pmessage', (_pattern, channel, message) => {
    try {
      const event = JSON.parse(message) as PublishedEvent;
      if (!event.room) event.room = roomFromChannel(channel);
      pushBacklog(event);
      emitter.emit('event', event);
    } catch (err) {
      log.warn({ err, channel }, 'failed to parse pub/sub message');
    }
  });

  log.info({ channel: `${CHANNEL_PREFIX}*` }, 'Session event bus started');
}

export async function stopSessionEventBus(): Promise<void> {
  if (!subscriber) return;
  try {
    await subscriber.punsubscribe();
    await subscriber.quit();
  } catch {
    // ignore shutdown errors
  }
  subscriber = null;
  backlog.clear();
  emitter.removeAllListeners();
}

export function roomForSession(sessionId: string): string {
  return `session:${sessionId}`;
}
export const ROOM_SESSIONS_ACTIVE = 'sessions:active';
