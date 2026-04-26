/**
 * Definition snapshot routes.
 * Prefix: /api/kdag/definitions/:key/snapshots
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query, querySingle, getClient } from '../db/client';
import { snapshotDefinition } from './kdag-definitions';

export default async function definitionSnapshotRoutes(fastify: FastifyInstance) {
  /**
   * GET / - List snapshots for a definition
   */
  fastify.get('/', async (
    request: FastifyRequest<{ Params: { key: string } }>,
    reply: FastifyReply
  ) => {
    const { key } = request.params;

    const definition = await querySingle<{ id: string }>(
      'SELECT id FROM kdag.job_definitions WHERE key = $1',
      [key]
    );
    if (!definition) {
      return reply.status(404).send({ error: 'Definition not found' });
    }

    const snapshots = await query<any>(
      `SELECT id, snapshot_number, name, description, steps_json, inputs_json, source, created_at
       FROM kdag.definition_snapshots
       WHERE definition_id = $1
       ORDER BY snapshot_number DESC`,
      [definition.id]
    );

    return {
      definition_key: key,
      snapshots: snapshots.map(s => ({
        snapshot_number: s.snapshot_number,
        name: s.name,
        description: s.description,
        steps_json: s.steps_json,
        inputs_json: s.inputs_json,
        source: s.source,
        created_at: s.created_at,
      })),
    };
  });

  /**
   * GET /:num - Get a specific snapshot
   */
  fastify.get('/:num', async (
    request: FastifyRequest<{ Params: { key: string; num: string } }>,
    reply: FastifyReply
  ) => {
    const { key, num } = request.params;
    const snapshotNum = parseInt(num, 10);

    if (isNaN(snapshotNum) || snapshotNum < 1) {
      return reply.status(400).send({ error: 'Snapshot number must be a positive integer' });
    }

    const definition = await querySingle<{ id: string }>(
      'SELECT id FROM kdag.job_definitions WHERE key = $1',
      [key]
    );
    if (!definition) {
      return reply.status(404).send({ error: 'Definition not found' });
    }

    const snapshot = await querySingle<any>(
      `SELECT snapshot_number, name, description, steps_json, inputs_json, source, created_at
       FROM kdag.definition_snapshots
       WHERE definition_id = $1 AND snapshot_number = $2`,
      [definition.id, snapshotNum]
    );

    if (!snapshot) {
      return reply.status(404).send({ error: `Snapshot ${snapshotNum} not found` });
    }

    return {
      definition_key: key,
      snapshot,
    };
  });

  /**
   * POST / - Create a manual snapshot of the current state
   */
  fastify.post('/', async (
    request: FastifyRequest<{ Params: { key: string } }>,
    reply: FastifyReply
  ) => {
    const { key } = request.params;

    const definition = await querySingle<{ id: string }>(
      'SELECT id FROM kdag.job_definitions WHERE key = $1',
      [key]
    );
    if (!definition) {
      return reply.status(404).send({ error: 'Definition not found' });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const snapshotNum = await snapshotDefinition(client, definition.id, 'manual');
      await client.query('COMMIT');

      return reply.status(201).send({
        definition_key: key,
        snapshot_number: snapshotNum,
        source: 'manual',
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  /**
   * POST /:num/restore - Restore a snapshot (auto-saves current state first)
   */
  fastify.post('/:num/restore', async (
    request: FastifyRequest<{ Params: { key: string; num: string } }>,
    reply: FastifyReply
  ) => {
    const { key, num } = request.params;
    const snapshotNum = parseInt(num, 10);

    if (isNaN(snapshotNum) || snapshotNum < 1) {
      return reply.status(400).send({ error: 'Snapshot number must be a positive integer' });
    }

    const definition = await querySingle<{ id: string }>(
      'SELECT id FROM kdag.job_definitions WHERE key = $1',
      [key]
    );
    if (!definition) {
      return reply.status(404).send({ error: 'Definition not found' });
    }

    const snapshot = await querySingle<any>(
      `SELECT snapshot_number, name, description, steps_json, inputs_json
       FROM kdag.definition_snapshots
       WHERE definition_id = $1 AND snapshot_number = $2`,
      [definition.id, snapshotNum]
    );

    if (!snapshot) {
      return reply.status(404).send({ error: `Snapshot ${snapshotNum} not found` });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Save current state before restoring
      const safetyNum = await snapshotDefinition(client, definition.id, 'pre-restore');

      // Replace steps from snapshot
      await client.query('DELETE FROM kdag.job_definition_steps WHERE definition_id = $1', [definition.id]);
      const steps = snapshot.steps_json as any[];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        await client.query(
          `INSERT INTO kdag.job_definition_steps
           (definition_id, step_index, key, name, step_type, assistant_handle, model, prompt_handle, input_source, input_config, config, timeout_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            definition.id, i, step.key, step.name,
            step.step_type || 'prompt',
            step.assistant_handle || null,
            step.model || null,
            step.prompt_handle || null,
            step.input_source || 'job_input',
            JSON.stringify(step.input_config || {}),
            JSON.stringify(step.config || {}),
            step.timeout_ms || 120000,
          ]
        );
      }

      // Replace inputs from snapshot
      await client.query('DELETE FROM kdag.job_definition_inputs WHERE definition_id = $1', [definition.id]);
      const inputs = snapshot.inputs_json as any[];
      for (const input of inputs) {
        const inputType = await client.query(
          'SELECT id FROM kdag.input_types WHERE key = $1',
          [input.input_type]
        );
        if (inputType.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.status(400).send({
            error: `Cannot restore: input type '${input.input_type}' no longer exists. Re-register it first.`,
          });
        }
        await client.query(
          `INSERT INTO kdag.job_definition_inputs (definition_id, input_type_id, required, description, example)
           VALUES ($1, $2, $3, $4, $5)`,
          [definition.id, inputType.rows[0].id, input.required !== false, input.description || null, input.example || null]
        );
      }

      // Restore name/description exactly as stored (including null)
      await client.query(
        'UPDATE kdag.job_definitions SET name = $1, description = $2, updated_at = NOW() WHERE id = $3',
        [snapshot.name, snapshot.description, definition.id]
      );

      await client.query('COMMIT');

      return {
        restored_from_snapshot: snapshotNum,
        safety_snapshot: safetyNum,
        message: `Restored definition from snapshot ${snapshotNum}. Previous state saved as snapshot ${safetyNum}.`,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}
