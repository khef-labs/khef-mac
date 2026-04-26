/**
 * Job definition routes.
 * Prefix: /api/kdag/definitions
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query, querySingle, getClient } from '../db/client';
import { getHiddenDefinitionKeys } from '../utils/hidden-definitions';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import archiver from 'archiver';
import * as yaml from 'js-yaml';

const REPO_ROOT = resolve(process.cwd(), '..', '..');

/**
 * Normalize literal backslash-n/t sequences in string values within an object.
 * LLMs sometimes double-escape newlines in JSON tool calls, producing literal
 * two-character "\n" instead of actual newline characters.
 */
function normalizeEscapes(obj: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!obj) return obj;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      result[k] = v.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    } else {
      result[k] = v;
    }
  }
  return result;
}

interface DefinitionStepInput {
  key: string;
  name: string;
  step_type?: string;
  assistant_handle?: string | null;
  model?: string | null;
  prompt_handle?: string | null;
  input_source?: string;
  input_config?: Record<string, unknown>;
  config?: Record<string, unknown>;
  timeout_ms?: number;
}

interface DefinitionInputDecl {
  input_type: string;
  required?: boolean;
  description?: string;
  example?: string;
}

interface CreateDefinitionBody {
  key: string;
  name: string;
  description?: string;
  steps: DefinitionStepInput[];
  inputs?: DefinitionInputDecl[];
}

interface UpdateDefinitionBody {
  name?: string;
  description?: string;
  steps?: DefinitionStepInput[];
  inputs?: DefinitionInputDecl[];
}

/**
 * Snapshot the current state of a definition's steps and inputs.
 * Must be called within an existing transaction (pass the transaction client).
 */
export async function snapshotDefinition(
  txClient: any,
  definitionId: string,
  source: string = 'pre-update'
): Promise<number> {
  // Lock definition row to prevent concurrent snapshot number races
  const defResult = await txClient.query(
    'SELECT name, description FROM kdag.job_definitions WHERE id = $1 FOR UPDATE',
    [definitionId]
  );
  const def = defResult.rows[0];

  // Read current steps
  const stepsResult = await txClient.query(
    `SELECT key, name, step_type, assistant_handle, model, prompt_handle,
            input_source, input_config, config, timeout_ms
     FROM kdag.job_definition_steps WHERE definition_id = $1 ORDER BY step_index`,
    [definitionId]
  );

  // Read current inputs with type keys
  const inputsResult = await txClient.query(
    `SELECT it.key as input_type, jdi.required, jdi.description, jdi.example
     FROM kdag.job_definition_inputs jdi
     JOIN kdag.input_types it ON it.id = jdi.input_type_id
     WHERE jdi.definition_id = $1 ORDER BY it.key`,
    [definitionId]
  );

  // Get next snapshot number
  const maxResult = await txClient.query(
    'SELECT COALESCE(MAX(snapshot_number), 0) as max_num FROM kdag.definition_snapshots WHERE definition_id = $1',
    [definitionId]
  );
  const nextNum = maxResult.rows[0].max_num + 1;

  await txClient.query(
    `INSERT INTO kdag.definition_snapshots (definition_id, snapshot_number, name, description, steps_json, inputs_json, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      definitionId,
      nextNum,
      def.name,
      def.description,
      JSON.stringify(stepsResult.rows),
      JSON.stringify(inputsResult.rows),
      source,
    ]
  );

  return nextNum;
}

export default async function jobDefinitionRoutes(fastify: FastifyInstance) {
  /**
   * GET / - List all definitions with step counts and job counts
   */
  fastify.get('/', async (
    request: FastifyRequest<{ Querystring: { sort?: string; order?: string; limit?: string; offset?: string; includeHidden?: string } }>,
  ) => {
    const { sort, order, limit: limitStr, offset: offsetStr, includeHidden } = request.query;

    // Allowed sort columns
    const sortMap: Record<string, string> = {
      name: 'jd.name',
      updated_at: 'jd.updated_at',
      created_at: 'jd.created_at',
      last_used: 'last_used_at',
    };
    const sortCol = sortMap[sort || ''] || 'jd.updated_at';
    const sortDir = order === 'asc' ? 'ASC' : 'DESC';
    const nullsClause = sort === 'last_used' ? ` NULLS LAST` : '';

    const limit = Math.min(Math.max(parseInt(limitStr || '20', 10) || 20, 1), 100);
    const offset = Math.max(parseInt(offsetStr || '0', 10) || 0, 0);

    // Exclude hidden definitions unless includeHidden=true
    const hiddenKeys = includeHidden === 'true' ? [] : await getHiddenDefinitionKeys();
    const hiddenFilter = hiddenKeys.length > 0
      ? ` WHERE jd.key NOT IN (${hiddenKeys.map((_, i) => `$${i + 1}`).join(', ')})`
      : '';
    const countFilter = hiddenKeys.length > 0
      ? ` WHERE key NOT IN (${hiddenKeys.map((_, i) => `$${i + 1}`).join(', ')})`
      : '';

    const countResult = await querySingle<{ count: string }>(
      `SELECT COUNT(*)::int as count FROM kdag.job_definitions${countFilter}`,
      hiddenKeys
    );
    const totalCount = parseInt(countResult?.count || '0', 10);

    const definitions = await query<any>(
      `SELECT jd.id, jd.key, jd.name, jd.description, jd.is_system,
              jd.created_at, jd.updated_at,
              (SELECT COUNT(*)::int FROM kdag.job_definition_steps WHERE definition_id = jd.id) as step_count,
              (SELECT COUNT(*)::int FROM kdag.jobs WHERE definition_id = jd.id) as job_count,
              (SELECT MAX(j.created_at) FROM kdag.jobs j WHERE j.definition_id = jd.id) as last_used_at
       FROM kdag.job_definitions jd${hiddenFilter}
       ORDER BY ${sortCol} ${sortDir}${nullsClause}
       LIMIT $${hiddenKeys.length + 1} OFFSET $${hiddenKeys.length + 2}`,
      [...hiddenKeys, limit, offset]
    );

    return {
      definitions: definitions.map(d => ({
        id: d.id,
        key: d.key,
        name: d.name,
        description: d.description,
        is_system: d.is_system,
        step_count: d.step_count,
        job_count: d.job_count,
        last_used_at: d.last_used_at,
        created_at: d.created_at,
        updated_at: d.updated_at,
      })),
      pagination: {
        total_count: totalCount,
        limit,
        offset,
        has_more: offset + limit < totalCount,
      },
    };
  });

  /**
   * GET /:key - Get definition with steps and required inputs
   */
  fastify.get('/:key', async (
    request: FastifyRequest<{ Params: { key: string } }>,
    reply: FastifyReply
  ) => {
    const { key } = request.params;

    const definition = await querySingle<any>(
      `SELECT id, key, name, description, is_system, created_at, updated_at
       FROM kdag.job_definitions WHERE key = $1`,
      [key]
    );

    if (!definition) {
      return reply.status(404).send({ error: 'Definition not found' });
    }

    const steps = await query<any>(
      `SELECT id, step_index, key, name, step_type, assistant_handle, model,
              prompt_handle, input_source, input_config, config, timeout_ms
       FROM kdag.job_definition_steps
       WHERE definition_id = $1
       ORDER BY step_index`,
      [definition.id]
    );

    const inputs = await query<any>(
      `SELECT jdi.id, it.key as input_type, it.format, jdi.required, jdi.description, jdi.example
       FROM kdag.job_definition_inputs jdi
       JOIN kdag.input_types it ON it.id = jdi.input_type_id
       WHERE jdi.definition_id = $1
       ORDER BY it.key`,
      [definition.id]
    );

    return {
      definition: {
        id: definition.id,
        key: definition.key,
        name: definition.name,
        description: definition.description,
        is_system: definition.is_system,
        created_at: definition.created_at,
        updated_at: definition.updated_at,
      },
      steps: steps.map((s: any) => ({
        id: s.id,
        step_index: s.step_index,
        key: s.key,
        name: s.name,
        step_type: s.step_type,
        assistant_handle: s.assistant_handle,
        model: s.model,
        prompt_handle: s.prompt_handle,
        input_source: s.input_source,
        input_config: s.input_config,
        config: s.config,
        timeout_ms: s.timeout_ms,
      })),
      inputs: inputs.map((i: any) => ({
        id: i.id,
        input_type: i.input_type,
        format: i.format,
        required: i.required,
        description: i.description,
        example: i.example,
      })),
    };
  });

  /**
   * POST / - Create a new definition with steps and input declarations
   */
  fastify.post('/', async (
    request: FastifyRequest<{ Body: CreateDefinitionBody }>,
    reply: FastifyReply
  ) => {
    const { key, name, description, steps, inputs } = request.body;

    if (!key || !name) {
      return reply.status(400).send({ error: 'key and name are required' });
    }
    if (!Array.isArray(steps)) {
      return reply.status(400).send({ error: 'steps must be an array' });
    }
    if (!steps || steps.length === 0) {
      return reply.status(400).send({ error: 'At least one step is required' });
    }
    if (inputs !== undefined && !Array.isArray(inputs)) {
      return reply.status(400).send({ error: 'inputs must be an array when provided' });
    }

    // Validate each step has required fields
    for (let i = 0; i < steps.length; i++) {
      if (!steps[i].key || !steps[i].name) {
        return reply.status(400).send({ error: `Step at index ${i} is missing required field 'key' or 'name'` });
      }
    }

    // Validate key format
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) {
      return reply.status(400).send({ error: 'key must be lowercase kebab-case' });
    }

    // Check for duplicate key
    const existing = await querySingle('SELECT id FROM kdag.job_definitions WHERE key = $1', [key]);
    if (existing) {
      return reply.status(409).send({ error: `Definition with key '${key}' already exists` });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      const defRow = await client.query(
        `INSERT INTO kdag.job_definitions (key, name, description) VALUES ($1, $2, $3) RETURNING id`,
        [key, name, description || null]
      );
      const defId = defRow.rows[0].id;

      // Insert steps
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        await client.query(
          `INSERT INTO kdag.job_definition_steps
           (definition_id, step_index, key, name, step_type, assistant_handle, model, prompt_handle, input_source, input_config, config, timeout_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            defId, i, step.key, step.name,
            step.step_type || 'prompt',
            step.assistant_handle || null,
            step.model || null,
            step.prompt_handle || null,
            step.input_source || 'job_input',
            JSON.stringify(normalizeEscapes(step.input_config) || {}),
            JSON.stringify(normalizeEscapes(step.config) || {}),
            step.timeout_ms || 120000,
          ]
        );
      }

      // Insert input declarations
      if (inputs && inputs.length > 0) {
        for (const input of inputs) {
          const inputType = await client.query(
            'SELECT id FROM kdag.input_types WHERE key = $1',
            [input.input_type]
          );
          if (inputType.rows.length === 0) {
            await client.query('ROLLBACK');
            return reply.status(400).send({ error: `Unknown input_type: ${input.input_type}` });
          }
          await client.query(
            `INSERT INTO kdag.job_definition_inputs (definition_id, input_type_id, required, description, example)
             VALUES ($1, $2, $3, $4, $5)`,
            [defId, inputType.rows[0].id, input.required !== false, input.description || null, input.example || null]
          );
        }
      }

      await client.query('COMMIT');

      return reply.status(201).send({ definition: { id: defId, key, name } });
    } catch (err: any) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return reply.status(409).send({ error: 'Duplicate step key or index' });
      }
      throw err;
    } finally {
      client.release();
    }
  });

  /**
   * PATCH /:key - Update definition name/description and optionally replace steps/inputs
   */
  fastify.patch('/:key', async (
    request: FastifyRequest<{ Params: { key: string }; Body: UpdateDefinitionBody }>,
    reply: FastifyReply
  ) => {
    const { key } = request.params;
    const body = request.body;

    const definition = await querySingle<{ id: string; is_system: boolean }>(
      'SELECT id, is_system FROM kdag.job_definitions WHERE key = $1',
      [key]
    );
    if (!definition) {
      return reply.status(404).send({ error: 'Definition not found' });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Update name/description
      const updates: string[] = [];
      const params: any[] = [];
      let paramIdx = 1;

      if (body.name !== undefined) {
        updates.push(`name = $${paramIdx++}`);
        params.push(body.name);
      }
      if (body.description !== undefined) {
        updates.push(`description = $${paramIdx++}`);
        params.push(body.description);
      }
      if (updates.length > 0) {
        updates.push(`updated_at = NOW()`);
        params.push(definition.id);
        await client.query(
          `UPDATE kdag.job_definitions SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
          params
        );
      }

      // Auto-snapshot before replacing steps or inputs
      if (body.steps || body.inputs) {
        await snapshotDefinition(client, definition.id, 'pre-update');
      }

      // Replace steps if provided
      if (body.steps) {
        if (!Array.isArray(body.steps)) {
          await client.query('ROLLBACK');
          return reply.status(400).send({ error: 'steps must be an array' });
        }
        for (let i = 0; i < body.steps.length; i++) {
          if (!body.steps[i].key || !body.steps[i].name) {
            await client.query('ROLLBACK');
            return reply.status(400).send({ error: `Step at index ${i} is missing required field 'key' or 'name'` });
          }
        }
        await client.query('DELETE FROM kdag.job_definition_steps WHERE definition_id = $1', [definition.id]);
        for (let i = 0; i < body.steps.length; i++) {
          const step = body.steps[i];
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
              JSON.stringify(normalizeEscapes(step.input_config) || {}),
              JSON.stringify(normalizeEscapes(step.config) || {}),
              step.timeout_ms || 120000,
            ]
          );
        }
        // Touch updated_at
        await client.query('UPDATE kdag.job_definitions SET updated_at = NOW() WHERE id = $1', [definition.id]);
      }

      // Replace inputs if provided
      if (body.inputs) {
        if (!Array.isArray(body.inputs)) {
          await client.query('ROLLBACK');
          return reply.status(400).send({ error: 'inputs must be an array when provided' });
        }
        await client.query('DELETE FROM kdag.job_definition_inputs WHERE definition_id = $1', [definition.id]);
        for (const input of body.inputs) {
          const inputType = await client.query(
            'SELECT id FROM kdag.input_types WHERE key = $1',
            [input.input_type]
          );
          if (inputType.rows.length === 0) {
            await client.query('ROLLBACK');
            return reply.status(400).send({ error: `Unknown input_type: ${input.input_type}` });
          }
          await client.query(
            `INSERT INTO kdag.job_definition_inputs (definition_id, input_type_id, required, description, example)
             VALUES ($1, $2, $3, $4, $5)`,
            [definition.id, inputType.rows[0].id, input.required !== false, input.description || null, input.example || null]
          );
        }
      }

      await client.query('COMMIT');

      return { updated: true };
    } catch (err: any) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return reply.status(409).send({ error: 'Duplicate step key or index' });
      }
      throw err;
    } finally {
      client.release();
    }
  });

  /**
   * DELETE /:key - Delete a definition. The jobs FK is ON DELETE CASCADE,
   * so all jobs (and their runs, steps, inputs, outputs, queue entries)
   * are removed automatically. Blocked only for system definitions.
   */
  fastify.delete('/:key', async (
    request: FastifyRequest<{ Params: { key: string } }>,
    reply: FastifyReply
  ) => {
    const { key } = request.params;

    const definition = await querySingle<{ id: string; is_system: boolean }>(
      'SELECT id, is_system FROM kdag.job_definitions WHERE key = $1',
      [key]
    );
    if (!definition) {
      return reply.status(404).send({ error: 'Definition not found' });
    }
    if (definition.is_system) {
      return reply.status(400).send({ error: 'Cannot delete system definitions' });
    }

    await query('DELETE FROM kdag.job_definitions WHERE id = $1', [definition.id]);

    return reply.status(204).send();
  });

  /**
   * POST /:key/clone - Clone a definition to a new key
   */
  fastify.post('/:key/clone', async (
    request: FastifyRequest<{ Params: { key: string }; Body: { new_key: string; new_name?: string } }>,
    reply: FastifyReply
  ) => {
    const { key } = request.params;
    const { new_key, new_name } = request.body;

    if (!new_key) {
      return reply.status(400).send({ error: 'new_key is required' });
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(new_key)) {
      return reply.status(400).send({ error: 'new_key must be lowercase kebab-case' });
    }

    const source = await querySingle<any>(
      'SELECT id, name, description FROM kdag.job_definitions WHERE key = $1',
      [key]
    );
    if (!source) {
      return reply.status(404).send({ error: 'Source definition not found' });
    }

    const existing = await querySingle('SELECT id FROM kdag.job_definitions WHERE key = $1', [new_key]);
    if (existing) {
      return reply.status(409).send({ error: `Definition with key '${new_key}' already exists` });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Create new definition
      const defRow = await client.query(
        `INSERT INTO kdag.job_definitions (key, name, description) VALUES ($1, $2, $3) RETURNING id`,
        [new_key, new_name || `${source.name} (copy)`, source.description]
      );
      const newDefId = defRow.rows[0].id;

      // Copy steps
      const steps = await client.query(
        `SELECT step_index, key, name, step_type, assistant_handle, model, prompt_handle,
                input_source, input_config, config, timeout_ms
         FROM kdag.job_definition_steps WHERE definition_id = $1 ORDER BY step_index`,
        [source.id]
      );
      for (const step of steps.rows) {
        await client.query(
          `INSERT INTO kdag.job_definition_steps
           (definition_id, step_index, key, name, step_type, assistant_handle, model, prompt_handle, input_source, input_config, config, timeout_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            newDefId, step.step_index, step.key, step.name,
            step.step_type, step.assistant_handle, step.model,
            step.prompt_handle, step.input_source,
            JSON.stringify(step.input_config),
            JSON.stringify(step.config),
            step.timeout_ms,
          ]
        );
      }

      // Copy inputs
      const inputs = await client.query(
        `SELECT input_type_id, required, description, example
         FROM kdag.job_definition_inputs WHERE definition_id = $1`,
        [source.id]
      );
      for (const input of inputs.rows) {
        await client.query(
          `INSERT INTO kdag.job_definition_inputs (definition_id, input_type_id, required, description, example)
           VALUES ($1, $2, $3, $4, $5)`,
          [newDefId, input.input_type_id, input.required, input.description, input.example]
        );
      }

      await client.query('COMMIT');

      return reply.status(201).send({
        definition: { id: newDefId, key: new_key, name: new_name || `${source.name} (copy)` },
        cloned_from: key,
      });
    } catch (err: any) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return reply.status(409).send({ error: 'Duplicate key' });
      }
      throw err;
    } finally {
      client.release();
    }
  });

  /**
   * GET /:key/export - Export definition + prompts + code scripts as a seed-compatible bundle
   *
   * Accept: application/json → { definition_key, files: [{ path, content }] }
   * Accept: application/zip  → zip archive download
   */
  fastify.get('/:key/export', async (
    request: FastifyRequest<{ Params: { key: string } }>,
    reply: FastifyReply
  ) => {
    const { key } = request.params;

    // Fetch definition
    const definition = await querySingle<any>(
      `SELECT id, key, name, description, is_system FROM kdag.job_definitions WHERE key = $1`,
      [key]
    );
    if (!definition) {
      return reply.status(404).send({ error: 'Definition not found' });
    }

    // Fetch steps
    const steps = await query<any>(
      `SELECT key, name, step_type, assistant_handle, model, prompt_handle,
              input_source, input_config, config, timeout_ms
       FROM kdag.job_definition_steps WHERE definition_id = $1 ORDER BY step_index`,
      [definition.id]
    );

    // Fetch inputs with type keys
    const inputs = await query<any>(
      `SELECT it.key as input_type, jdi.required, jdi.description, jdi.example
       FROM kdag.job_definition_inputs jdi
       JOIN kdag.input_types it ON it.id = jdi.input_type_id
       WHERE jdi.definition_id = $1 ORDER BY it.key`,
      [definition.id]
    );

    // Collect all prompt handles referenced by steps
    const promptHandles = new Set<string>();
    for (const step of steps) {
      if (step.prompt_handle) promptHandles.add(step.prompt_handle);
      const cfg = step.config || {};
      if (cfg.batch_prompt_handle) promptHandles.add(cfg.batch_prompt_handle);
      if (cfg.single_prompt_handle) promptHandles.add(cfg.single_prompt_handle);
    }

    // Fetch prompts by handle
    const prompts: Array<{ handle: string; title: string; description: string | null; content: string }> = [];
    for (const handle of promptHandles) {
      const prompt = await querySingle<any>(
        `SELECT handle, title, description, content FROM prompts WHERE handle = $1`,
        [handle]
      );
      if (prompt) {
        prompts.push(prompt);
      }
    }

    // Collect code step scripts — flatten to scripts/<basename>
    const scriptFiles: Array<{ path: string; content: string }> = [];
    for (const step of steps) {
      const cfg = step.config || {};
      if (step.step_type === 'code' && cfg.script_path) {
        const scriptPath = resolve(REPO_ROOT, cfg.script_path);
        if (existsSync(scriptPath)) {
          const basename = cfg.script_path.split('/').pop() as string;
          scriptFiles.push({
            path: `scripts/${basename}`,
            content: readFileSync(scriptPath, 'utf-8'),
          });
        }
      }
    }

    // Build seed-compatible definition YAML
    const seedDef: Record<string, any> = {
      key: definition.key,
      name: definition.name,
    };
    if (definition.description) seedDef.description = definition.description;
    seedDef.is_system = definition.is_system || false;

    seedDef.inputs = inputs.map((inp: any) => {
      const entry: Record<string, any> = { type: inp.input_type, required: inp.required };
      if (inp.description) entry.description = inp.description;
      if (inp.example) entry.example = inp.example;
      return entry;
    });

    seedDef.steps = steps.map((s: any) => {
      const entry: Record<string, any> = {
        key: s.key,
        name: s.name,
        step_type: s.step_type || 'prompt',
      };
      if (s.assistant_handle) entry.assistant_handle = s.assistant_handle;
      if (s.model) entry.model = s.model;
      if (s.prompt_handle) entry.prompt_handle = s.prompt_handle;
      if (s.input_source && s.input_source !== 'job_input') entry.input_source = s.input_source;
      else if (s.input_source) entry.input_source = s.input_source;

      const inputConfig = s.input_config || {};
      if (Object.keys(inputConfig).length > 0) entry.input_config = inputConfig;

      const config = s.config || {};
      if (Object.keys(config).length > 0) entry.config = config;

      if (s.timeout_ms && s.timeout_ms !== 120000) entry.timeout_ms = s.timeout_ms;

      return entry;
    });

    const definitionYaml = `---\n${yaml.dump(seedDef, { lineWidth: -1, noRefs: true, quotingType: '"' })}---\n`;

    // Build prompt seed files
    const promptFiles = prompts.map(p => {
      const fm: Record<string, string> = { handle: p.handle, title: p.title };
      if (p.description) fm.description = p.description;
      const frontmatter = yaml.dump(fm, { lineWidth: -1, noRefs: true, quotingType: '"' });
      return {
        path: `prompts/${p.handle}.md`,
        content: `---\n${frontmatter}---\n${p.content}`,
      };
    });

    // Assemble all files
    const files = [
      { path: `${definition.key}.md`, content: definitionYaml },
      ...promptFiles,
      ...scriptFiles,
    ];

    // Check Accept header for zip vs JSON
    const accept = request.headers.accept || '';
    if (accept.includes('application/zip')) {
      reply.type('application/zip');
      reply.header('Content-Disposition', `attachment; filename="${definition.key}-export.zip"`);

      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err: Error) => { throw err; });

      for (const file of files) {
        archive.append(file.content, { name: file.path });
      }

      archive.pipe(reply.raw);
      await archive.finalize();
      return reply;
    }

    return {
      definition_key: definition.key,
      files,
    };
  });
}
