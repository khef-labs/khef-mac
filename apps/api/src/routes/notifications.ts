import { FastifyPluginAsync } from 'fastify';
import {
  clearNotification,
  dismissNotification,
  listNotifications,
  raiseNotification,
  type NotificationSeverity,
} from '../services/notifications';

const notificationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { include_dismissed?: string } }>('/', async (request) => {
    const includeDismissed = request.query.include_dismissed === 'true';
    return { notifications: listNotifications({ includeDismissed }) };
  });

  fastify.post<{ Params: { id: string } }>('/:id/dismiss', async (request, reply) => {
    const result = dismissNotification(request.params.id);
    if (!result) {
      return reply.code(404).send({ error: 'Notification not found' });
    }
    return { notification: result };
  });

  // Dev-only manual trigger so the SSE-push wiring can be smoke-tested without
  // waiting for a real watcher event.
  if (process.env.NODE_ENV !== 'production') {
    fastify.post<{
      Body: {
        id?: string;
        kind?: string;
        severity?: NotificationSeverity;
        title?: string;
        body?: string;
      };
    }>('/_debug-raise', async (request) => {
      const b = request.body ?? {};
      const id = b.id ?? `debug-${Date.now()}`;
      const notification = raiseNotification({
        id,
        kind: b.kind ?? 'debug',
        severity: b.severity ?? 'info',
        title: b.title ?? 'Test notification',
        body: b.body ?? 'Manually raised for SSE smoke test.',
      });
      return { notification };
    });

    fastify.post<{ Params: { id: string } }>('/:id/_debug-clear', async (request, reply) => {
      const cleared = clearNotification(request.params.id);
      if (!cleared) return reply.code(404).send({ error: 'Notification not found' });
      return { cleared: true };
    });
  }
};

export default notificationRoutes;
