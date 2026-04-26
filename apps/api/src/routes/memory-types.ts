import { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client';
import { MemoryTypeRecord, MemoryTypeStatus } from '../types';
import { isUuid } from '../utils/uuid';

type ResolvedType = MemoryTypeRecord & { is_parent_type: boolean };

/** Resolve a memory type by name or UUID */
async function resolveType(typeParam: string): Promise<ResolvedType | null> {
  const where = isUuid(typeParam) ? 'id = $1' : 'name = $1';
  const result = await query<ResolvedType>(
    `SELECT id, name, description, built_in, created_at, parent_id, is_parent_type FROM memory_types WHERE ${where}`,
    [typeParam]
  );
  return result.length > 0 ? result[0] : null;
}

interface CreateTypeBody {
  name: string;
  description?: string;
  parent_type?: string;
  statuses?: Array<{
    value: string;
    display_name?: string;
    description?: string;
    sort_order?: number;
  }>;
}

interface UpdateTypeBody {
  name?: string;
  description?: string;
}

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const memoryTypeRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/memory-types
  // List all memory types with their available status values and hierarchy
  fastify.get('/', async (_request, _reply) => {
    const types = await query<MemoryTypeRecord & { parent_name: string | null; is_parent_type: boolean }>(
      `SELECT mt.id, mt.name, mt.description, mt.built_in, mt.created_at, mt.parent_id,
              mt.is_parent_type, mt_parent.name as parent_name
       FROM memory_types mt
       LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
       ORDER BY mt.name`
    );

    const memoryTypes = await Promise.all(
      types.map(async (type) => {
        // Get own statuses
        const statuses = await query<MemoryTypeStatus & { value: string }>(
          `SELECT id, memory_type_id, status_value as value, display_name, description, sort_order
           FROM memory_type_statuses
           WHERE memory_type_id = $1
           ORDER BY sort_order`,
          [type.id]
        );

        // If this is a child type, also include parent's statuses (inherited)
        let inheritedStatuses: typeof statuses = [];
        if (type.parent_id) {
          inheritedStatuses = await query<MemoryTypeStatus & { value: string }>(
            `SELECT id, memory_type_id, status_value as value, display_name, description, sort_order
             FROM memory_type_statuses
             WHERE memory_type_id = $1
             ORDER BY sort_order`,
            [type.parent_id]
          );
        }

        // Find children of this type
        const children = types
          .filter(t => t.parent_id === type.id)
          .map(t => t.name);

        // Count memories using this type
        const countResult = await query<{ count: string }>(
          'SELECT COUNT(*) as count FROM memories WHERE memory_type_id = $1',
          [type.id]
        );
        const memoryCount = parseInt(countResult[0].count, 10);

        return {
          type: type.name,
          description: type.description,
          built_in: type.built_in,
          memory_count: memoryCount,
          ...(type.is_parent_type ? { is_parent_type: true } : {}),
          ...(type.parent_name ? { parent_type: type.parent_name } : {}),
          ...(children.length > 0 ? { children } : {}),
          statuses: [
            ...statuses.map(s => ({
              value: s.value,
              display_name: s.display_name,
              description: s.description,
              sort_order: s.sort_order
            })),
            ...inheritedStatuses
              .filter(is => !statuses.some(s => s.value === is.value))
              .map(s => ({
                value: s.value,
                display_name: s.display_name,
                description: s.description,
                sort_order: s.sort_order,
                inherited: true
              }))
          ]
        };
      })
    );

    return { memory_types: memoryTypes };
  });

  // GET /api/memory-types/:type
  // Get a single memory type by name or UUID
  fastify.get('/:type', async (request, reply) => {
    const { type: typeParam } = request.params as { type: string };

    const memoryType = await resolveType(typeParam);
    if (!memoryType) {
      return reply.code(404).send({ error: `Memory type not found: ${typeParam}` });
    }

    // Get parent name if child type
    let parentName: string | null = null;
    if (memoryType.parent_id) {
      const parentResult = await query<{ name: string }>(
        'SELECT name FROM memory_types WHERE id = $1',
        [memoryType.parent_id]
      );
      if (parentResult.length > 0) parentName = parentResult[0].name;
    }

    // Get statuses
    const statuses = await query<MemoryTypeStatus & { value: string }>(
      `SELECT id, memory_type_id, status_value as value, display_name, description, sort_order
       FROM memory_type_statuses
       WHERE memory_type_id = $1
       ORDER BY sort_order`,
      [memoryType.id]
    );

    // Include inherited parent statuses
    let inheritedStatuses: typeof statuses = [];
    if (memoryType.parent_id) {
      inheritedStatuses = await query<MemoryTypeStatus & { value: string }>(
        `SELECT id, memory_type_id, status_value as value, display_name, description, sort_order
         FROM memory_type_statuses
         WHERE memory_type_id = $1
         ORDER BY sort_order`,
        [memoryType.parent_id]
      );
    }

    // Find children
    const children = await query<{ name: string }>(
      'SELECT name FROM memory_types WHERE parent_id = $1 ORDER BY name',
      [memoryType.id]
    );

    // Count memories
    const countResult = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM memories WHERE memory_type_id = $1',
      [memoryType.id]
    );

    return {
      memory_type: {
        id: memoryType.id,
        type: memoryType.name,
        description: memoryType.description,
        built_in: memoryType.built_in,
        memory_count: parseInt(countResult[0].count, 10),
        ...(memoryType.is_parent_type ? { is_parent_type: true } : {}),
        ...(parentName ? { parent_type: parentName } : {}),
        ...(children.length > 0 ? { children: children.map(c => c.name) } : {}),
        statuses: [
          ...statuses.map(s => ({
            value: s.value,
            display_name: s.display_name,
            description: s.description,
            sort_order: s.sort_order
          })),
          ...inheritedStatuses
            .filter(is => !statuses.some(s => s.value === is.value))
            .map(s => ({
              value: s.value,
              display_name: s.display_name,
              description: s.description,
              sort_order: s.sort_order,
              inherited: true
            }))
        ]
      }
    };
  });

  // GET /api/memory-types/:type/statuses
  // Get available status values for a specific memory type (including parent inheritance)
  fastify.get('/:type/statuses', async (request, reply) => {
    const { type } = request.params as { type: string };

    const memoryType = await resolveType(type);
    if (!memoryType) {
      return reply.code(404).send({ error: `Memory type not found: ${type}` });
    }

    // Get own statuses
    const statuses = await query<MemoryTypeStatus & { value: string }>(
      `SELECT id, memory_type_id, status_value as value, display_name, description, sort_order
       FROM memory_type_statuses
       WHERE memory_type_id = $1
       ORDER BY sort_order`,
      [memoryType.id]
    );

    // Include inherited parent statuses if this is a child type
    let allStatuses = statuses.map(s => ({
      value: s.value,
      display_name: s.display_name,
      description: s.description,
      sort_order: s.sort_order
    }));

    if (memoryType.parent_id) {
      const parentStatuses = await query<MemoryTypeStatus & { value: string }>(
        `SELECT id, memory_type_id, status_value as value, display_name, description, sort_order
         FROM memory_type_statuses
         WHERE memory_type_id = $1
         ORDER BY sort_order`,
        [memoryType.parent_id]
      );

      // Add parent statuses that don't conflict with own
      const ownValues = new Set(statuses.map(s => s.value));
      for (const ps of parentStatuses) {
        if (!ownValues.has(ps.value)) {
          allStatuses.push({
            value: ps.value,
            display_name: ps.display_name,
            description: ps.description,
            sort_order: ps.sort_order
          });
        }
      }
    }

    return {
      memory_type: memoryType.name,
      description: memoryType.description,
      built_in: memoryType.built_in,
      statuses: allStatuses
    };
  });

  // POST /api/memory-types
  // Create a custom memory type
  fastify.post<{ Body: CreateTypeBody }>('/', async (request, reply) => {
    const { name, description, parent_type, statuses } = request.body;

    // Validate name
    if (!name || typeof name !== 'string') {
      return reply.code(400).send({ error: 'Name is required' });
    }

    if (name.length < 2 || name.length > 50) {
      return reply.code(400).send({ error: 'Name must be 2-50 characters' });
    }

    if (!KEBAB_CASE_REGEX.test(name)) {
      return reply.code(400).send({
        error: 'Name must be lowercase kebab-case (e.g., "my-type")'
      });
    }

    // Resolve parent_id if parent_type provided
    let parentId: string | null = null;
    if (parent_type) {
      const parentResult = await query<{ id: string; parent_id: string | null }>(
        'SELECT id, parent_id FROM memory_types WHERE name = $1',
        [parent_type]
      );
      if (parentResult.length === 0) {
        return reply.code(400).send({ error: `Parent type not found: ${parent_type}` });
      }
      if (parentResult[0].parent_id !== null) {
        return reply.code(400).send({ error: `Cannot nest under ${parent_type}: only single-level nesting allowed` });
      }
      parentId = parentResult[0].id;
    }

    // Check for duplicate within same parent scope
    const existing = await query<{ id: string }>(
      `SELECT id FROM memory_types
       WHERE name = $1
       AND COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)`,
      [name, parentId]
    );

    if (existing.length > 0) {
      const scope = parent_type ? ` under ${parent_type}` : '';
      return reply.code(409).send({ error: `Memory type already exists: ${name}${scope}` });
    }

    // Validate statuses if provided
    const statusList = statuses && statuses.length > 0 ? statuses : [
      { value: 'active', display_name: 'Active', sort_order: 0 }
    ];

    for (const status of statusList) {
      if (!status.value || typeof status.value !== 'string') {
        return reply.code(400).send({ error: 'Each status must have a value' });
      }
      if (!KEBAB_CASE_REGEX.test(status.value) && !/^[a-z_]+$/.test(status.value)) {
        return reply.code(400).send({
          error: `Invalid status value: ${status.value}. Use kebab-case or snake_case.`
        });
      }
    }

    // Create type
    const typeResult = await query<MemoryTypeRecord>(
      `INSERT INTO memory_types (name, description, built_in, parent_id)
       VALUES ($1, $2, FALSE, $3)
       RETURNING id, name, description, built_in, created_at, parent_id`,
      [name, description || null, parentId]
    );

    const newType = typeResult[0];

    // Create statuses
    for (let i = 0; i < statusList.length; i++) {
      const s = statusList[i];
      await query(
        `INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [newType.id, s.value, s.display_name || s.value, s.description || null, s.sort_order ?? i]
      );
    }

    // Fetch created statuses
    const createdStatuses = await query<MemoryTypeStatus & { value: string }>(
      `SELECT status_value as value, display_name, description, sort_order
       FROM memory_type_statuses
       WHERE memory_type_id = $1
       ORDER BY sort_order`,
      [newType.id]
    );

    return reply.code(201).send({
      memory_type: {
        type: newType.name,
        description: newType.description,
        built_in: newType.built_in,
        ...(parent_type ? { parent_type } : {}),
        memory_count: 0,
        statuses: createdStatuses.map(s => ({
          value: s.value,
          display_name: s.display_name,
          description: s.description,
          sort_order: s.sort_order
        }))
      }
    });
  });

  // PATCH /api/memory-types/:type
  // Update a memory type (built-in types can only update description)
  fastify.patch<{ Body: UpdateTypeBody }>('/:type', async (request, reply) => {
    const { type } = request.params as { type: string };
    const { name, description } = request.body;

    const existingType = await resolveType(type);
    if (!existingType) {
      return reply.code(404).send({ error: `Memory type not found: ${type}` });
    }

    // Built-in types can only update description
    if (existingType.built_in && name && name !== existingType.name) {
      return reply.code(403).send({
        error: `Cannot rename built-in memory type: ${type}`
      });
    }

    // Validate new name if provided
    if (name && name !== existingType.name) {
      if (name.length < 2 || name.length > 50) {
        return reply.code(400).send({ error: 'Name must be 2-50 characters' });
      }

      if (!KEBAB_CASE_REGEX.test(name)) {
        return reply.code(400).send({
          error: 'Name must be lowercase kebab-case (e.g., "my-type")'
        });
      }

      // Check for duplicate
      const duplicate = await query<{ id: string }>(
        'SELECT id FROM memory_types WHERE name = $1 AND id != $2',
        [name, existingType.id]
      );

      if (duplicate.length > 0) {
        return reply.code(409).send({ error: `Memory type already exists: ${name}` });
      }
    }

    // Update
    const updates: string[] = [];
    const values: (string | null)[] = [];
    let paramIndex = 1;

    if (name !== undefined && name !== existingType.name) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }

    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description || null);
    }

    if (updates.length === 0) {
      return reply.code(400).send({ error: 'No updates provided' });
    }

    values.push(existingType.id);

    const updated = await query<MemoryTypeRecord>(
      `UPDATE memory_types SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING id, name, description, built_in`,
      values
    );

    // Get statuses
    const statuses = await query<MemoryTypeStatus & { value: string }>(
      `SELECT status_value as value, display_name, description, sort_order
       FROM memory_type_statuses
       WHERE memory_type_id = $1
       ORDER BY sort_order`,
      [existingType.id]
    );

    // Get memory count
    const countResult = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM memories WHERE memory_type_id = $1',
      [existingType.id]
    );

    return {
      type: updated[0].name,
      description: updated[0].description,
      built_in: updated[0].built_in,
      memory_count: parseInt(countResult[0].count, 10),
      statuses: statuses.map(s => ({
        value: s.value,
        display_name: s.display_name,
        description: s.description,
        sort_order: s.sort_order
      }))
    };
  });

  // DELETE /api/memory-types/:type
  // Delete a custom memory type (blocked if built-in or has memories)
  fastify.delete('/:type', async (request, reply) => {
    const { type } = request.params as { type: string };

    const existingType = await resolveType(type);
    if (!existingType) {
      return reply.code(404).send({ error: `Memory type not found: ${type}` });
    }

    // Cannot delete built-in types
    if (existingType.built_in) {
      return reply.code(403).send({
        error: `Cannot delete built-in memory type: ${type}`
      });
    }

    // Cannot delete if memories exist with this type
    const countResult = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM memories WHERE memory_type_id = $1',
      [existingType.id]
    );

    const memoryCount = parseInt(countResult[0].count, 10);
    if (memoryCount > 0) {
      return reply.code(409).send({
        error: `Cannot delete memory type with existing memories`,
        memory_count: memoryCount
      });
    }

    // Delete (statuses cascade)
    await query('DELETE FROM memory_types WHERE id = $1', [existingType.id]);

    return reply.code(204).send();
  });
};

export default memoryTypeRoutes;
