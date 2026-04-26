import { FastifyPluginAsync } from 'fastify';
import { join } from 'path';

interface SeedBody {
  project?: string;
}

const seedRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /api/seed
   * Run database seeds (memory types, statuses, definitions, memories, prompts, relations).
   * Optionally scoped to a single project.
   *
   * Body: { project?: string }
   * Response: { status: "success", project?: string }
   */
  fastify.post<{ Body: SeedBody }>('/', async (request, reply) => {
    const { project } = request.body || {};

    try {
      // Dynamic require to avoid tsc rootDir constraint (seed.ts lives in db/seed/)
      const seedPath = join(__dirname, '..', '..', 'db', 'seed', 'seed');
      const seed = require(seedPath).default as (projectHandle?: string) => Promise<void>;
      await seed(project || undefined);
      return { status: 'success', ...(project ? { project } : {}) };
    } catch (error: any) {
      request.log.error({ err: error }, 'Seed failed');
      return reply.status(500).send({
        error: 'Seed failed',
        message: error?.message || 'Unknown error during seed',
      });
    }
  });
};

export default seedRoutes;
