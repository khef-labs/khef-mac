import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import settingsRoutes from '../../src/routes/settings';

describe('Settings Runtime API', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('returns runtime status without requiring database access', async () => {
    const app = Fastify();
    apps.push(app);
    app.register(settingsRoutes, { prefix: '/api/settings' });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/runtime',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.generated_at).toBe('string');
    expect(Array.isArray(body.ports)).toBe(true);
    expect(body.docker).toBeDefined();
    expect(typeof body.docker.available).toBe('boolean');
    expect(Array.isArray(body.docker.containers)).toBe(true);
    expect(Array.isArray(body.docker.images)).toBe(true);
    expect(Array.isArray(body.docker.volumes)).toBe(true);
    expect(body.huggingface).toBeDefined();
    expect(typeof body.huggingface.embed_server_available).toBe('boolean');
    expect(Array.isArray(body.huggingface.models)).toBe(true);
  });
});
