import { FastifyPluginAsync } from 'fastify';
import { querySingle } from '../db/client';

interface ServiceStatus {
  status: 'ok' | 'unavailable' | 'error';
  port?: number;
  url?: string;
  error?: string;
  details?: Record<string, unknown>;
}

async function checkService(
  url: string,
  timeoutMs = 3000
): Promise<ServiceStatus> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) {
      return { status: 'error', url, error: `HTTP ${response.status}` };
    }

    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return { status: 'ok', url, details: body ?? undefined };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return { status: 'unavailable', url, error: 'timeout' };
    }
    return { status: 'unavailable', url, error: err.message };
  }
}

function parsePort(url: string): number | undefined {
  try {
    return parseInt(new URL(url).port, 10) || undefined;
  } catch {
    return undefined;
  }
}

const systemHealthRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/system/health — aggregate health check for all services
  fastify.get('/', async () => {
    const apiPort = parseInt(process.env.PORT || '3100', 10);
    const krokiPort = process.env.KROKI_PORT || '8100';
    const krokiUrl = process.env.KROKI_URL || `http://localhost:${krokiPort}`;
    const embedUrl = process.env.EMBED_SERVER_URL || 'http://127.0.0.1:9100';
    const pgHost = process.env.POSTGRES_HOST || 'localhost';
    const pgPort = parseInt(process.env.POSTGRES_PORT || '5432', 10);

    const [postgres, kroki, embed] = await Promise.all([
      // Postgres
      (async (): Promise<ServiceStatus> => {
        try {
          const result = await querySingle<{ version: string }>(
            'SELECT version() AS version'
          );
          return {
            status: 'ok',
            port: pgPort,
            url: `${pgHost}:${pgPort}`,
            details: { version: result?.version?.split(' ').slice(0, 2).join(' ') },
          };
        } catch (err: any) {
          return {
            status: 'unavailable',
            port: pgPort,
            url: `${pgHost}:${pgPort}`,
            error: err.message,
          };
        }
      })(),

      // Kroki
      checkService(`${krokiUrl}/health`).then((s) => ({
        ...s,
        port: parsePort(krokiUrl) || parseInt(krokiPort, 10),
        url: krokiUrl,
        details: s.details
          ? { version: (s.details as any)?.version?.kroki?.number }
          : undefined,
      })),

      // Embed server (sentence-transformers)
      checkService(`${embedUrl}/health`).then((s) => ({
        ...s,
        port: parsePort(embedUrl),
        url: embedUrl,
      })),
    ]);

    const services: Record<string, ServiceStatus> = {
      api: { status: 'ok', port: apiPort, url: `http://localhost:${apiPort}` },
      postgres,
      kroki,
      embed,
    };

    const allOk = Object.values(services).every((s) => s.status === 'ok');

    return {
      status: allOk ? 'healthy' : 'degraded',
      services,
    };
  });
};

export default systemHealthRoutes;
