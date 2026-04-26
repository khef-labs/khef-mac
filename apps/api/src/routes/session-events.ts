/**
 * Server-Sent Events endpoint for push-based session sync.
 * GET /api/sse?rooms=session:<id>,sessions:active
 * Honors Last-Event-Id header for replay from the per-room backlog.
 */

import type { FastifyPluginAsync } from 'fastify';
import {
  onSessionEvent,
  replayAfter,
  type PublishedEvent,
} from '../services/session-events';

const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_ROOMS_PER_CONNECTION = 64;

function formatEvent(id: string, room: string, delta: unknown): string {
  return `id: ${id}\nevent: ${room}\ndata: ${JSON.stringify(delta)}\n\n`;
}

const sessionEventRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request, reply) => {
    const query = request.query as { rooms?: string };
    const roomsParam = (query.rooms || '').trim();
    if (!roomsParam) {
      return reply.code(400).send({ error: 'rooms query parameter required' });
    }

    const requestedRooms = new Set(
      roomsParam
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean)
        .slice(0, MAX_ROOMS_PER_CONNECTION)
    );
    if (requestedRooms.size === 0) {
      return reply.code(400).send({ error: 'rooms must contain at least one room' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders?.();
    reply.hijack();

    // Kick the stream so the client knows we're connected
    reply.raw.write(`retry: 3000\n: connected\n\n`);

    const lastEventId = request.headers['last-event-id'] as string | undefined;
    if (lastEventId) {
      for (const room of requestedRooms) {
        for (const event of replayAfter(room, lastEventId)) {
          reply.raw.write(formatEvent(event.id, event.room, event.delta));
        }
      }
    }

    const onEvent = (event: PublishedEvent) => {
      if (!requestedRooms.has(event.room)) return;
      reply.raw.write(formatEvent(event.id, event.room, event.delta));
    };
    const unsubscribe = onSessionEvent(onEvent);

    const heartbeat = setInterval(() => {
      reply.raw.write(`: heartbeat\n\n`);
    }, HEARTBEAT_INTERVAL_MS);

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      try {
        reply.raw.end();
      } catch {
        // already ended
      }
    };

    request.raw.on('close', close);
    request.raw.on('error', close);
  });
};

export default sessionEventRoutes;
