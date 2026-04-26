import { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client';

interface RelationType {
  value: string;
  forward_label: string;
  inverse_value: string;
  inverse_label: string;
}

const relationTypeRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/relation-types
  // List all relation types with their forward and inverse labels
  fastify.get('/', async () => {
    const types = await query<RelationType>(
      `SELECT value, forward_label, inverse_value, inverse_label
       FROM relation_types
       ORDER BY value`
    );

    return { relation_types: types };
  });
};

export default relationTypeRoutes;
