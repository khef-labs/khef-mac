/**
 * Kdag input type routes.
 * Prefix: /api/kdag/input-types
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query, querySingle } from '../db/client';

const ALLOWED_FORMATS = ['text', 'json', 'csv', 'markdown', 'url-list', 'code', 'xml'];

interface CreateInputTypeBody {
  key: string;
  description?: string;
  format?: string;
}

export default async function kdagInputTypeRoutes(fastify: FastifyInstance) {
  /**
   * GET / - List all registered input types
   */
  fastify.get('/', async () => {
    const rows = await query<{ id: string; key: string; description: string | null; format: string | null }>(
      'SELECT id, key, description, format FROM kdag.input_types ORDER BY key'
    );

    return { input_types: rows };
  });

  /**
   * POST / - Register a new input type
   */
  fastify.post('/', async (
    request: FastifyRequest<{ Body: CreateInputTypeBody }>,
    reply: FastifyReply
  ) => {
    const { key, description, format } = request.body;

    if (!key) {
      return reply.status(400).send({ error: 'key is required' });
    }

    // Validate key format: lowercase letters, digits, hyphens, underscores
    if (!/^[a-z][a-z0-9_-]*$/.test(key)) {
      return reply.status(400).send({ error: 'key must start with a lowercase letter and contain only lowercase letters, digits, hyphens, and underscores' });
    }

    // Validate format if provided
    if (format && !ALLOWED_FORMATS.includes(format)) {
      return reply.status(400).send({ error: `Invalid format '${format}'. Allowed: ${ALLOWED_FORMATS.join(', ')}` });
    }

    // Check for duplicate
    const existing = await querySingle('SELECT id FROM kdag.input_types WHERE key = $1', [key]);
    if (existing) {
      return reply.status(409).send({ error: `Input type '${key}' already exists` });
    }

    const row = await querySingle<{ id: string; key: string; description: string | null; format: string | null }>(
      'INSERT INTO kdag.input_types (key, description, format) VALUES ($1, $2, $3) RETURNING id, key, description, format',
      [key, description || null, format || null]
    );

    return reply.status(201).send({ input_type: row });
  });
}
