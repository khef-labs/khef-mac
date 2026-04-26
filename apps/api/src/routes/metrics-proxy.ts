import { FastifyInstance } from 'fastify';
import { query } from '../db/client';

const DEFAULT_PROMETHEUS_URL = 'http://localhost:9190';

async function getPrometheusUrl(): Promise<string> {
  try {
    const rows = await query<{ value: string }>('SELECT value FROM settings WHERE key = $1', ['metrics.prometheus.url']);
    if (rows.length > 0 && rows[0].value) {
      return rows[0].value;
    }
  } catch {
    // Settings table may not have this key yet
  }
  return process.env.PROMETHEUS_URL || DEFAULT_PROMETHEUS_URL;
}

export default async function metricsProxyRoutes(fastify: FastifyInstance) {
  // Allow CORS from sandboxed iframes (null origin) and any local origin
  fastify.addHook('onRequest', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET');
  });

  // Instant query
  fastify.get('/query', async (request, reply) => {
    const { query: expr, time } = request.query as { query?: string; time?: string };
    if (!expr) return reply.status(400).send({ error: 'query parameter required' });

    const promUrl = await getPrometheusUrl();
    const params = new URLSearchParams({ query: expr });
    if (time) params.set('time', time);

    const response = await fetch(`${promUrl}/api/v1/query?${params}`);
    const data = await response.json();
    return data;
  });

  // Range query
  fastify.get('/query_range', async (request, reply) => {
    const { query: expr, start, end, step } = request.query as {
      query?: string; start?: string; end?: string; step?: string;
    };
    if (!expr || !start || !end || !step) {
      return reply.status(400).send({ error: 'query, start, end, and step parameters required' });
    }

    const promUrl = await getPrometheusUrl();
    const params = new URLSearchParams({ query: expr, start, end, step });

    const response = await fetch(`${promUrl}/api/v1/query_range?${params}`);
    const data = await response.json();
    return data;
  });

  // Labels (for discovery)
  fastify.get('/labels', async (_request, _reply) => {
    const promUrl = await getPrometheusUrl();
    const response = await fetch(`${promUrl}/api/v1/labels`);
    return response.json();
  });

  // Label values
  fastify.get('/label/:name/values', async (request, _reply) => {
    const { name } = request.params as { name: string };
    const promUrl = await getPrometheusUrl();
    const response = await fetch(`${promUrl}/api/v1/label/${encodeURIComponent(name)}/values`);
    return response.json();
  });

  // Health check
  fastify.get('/health', async (_request, reply) => {
    const promUrl = await getPrometheusUrl();
    try {
      const response = await fetch(`${promUrl}/-/healthy`, { signal: AbortSignal.timeout(3000) });
      const text = await response.text();
      return { status: 'ok', prometheus_url: promUrl, message: text.trim() };
    } catch (err) {
      return reply.status(503).send({
        status: 'unavailable',
        prometheus_url: promUrl,
        error: err instanceof Error ? err.message : 'Connection failed',
      });
    }
  });
}
