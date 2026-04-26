import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import * as yaml from 'js-yaml';

type StepSeed = {
  key: string;
  name: string;
  step_type: string;
  assistant_handle?: string;
  model?: string;
  prompt_handle?: string;
  input_source: string;
  input_config: Record<string, any>;
  config?: Record<string, any>;
  timeout_ms?: number;
};

type InputSeed = {
  type: string;
  required: boolean;
  description?: string;
  example?: string;
};

type DefinitionSeed = {
  key: string;
  name: string;
  description?: string;
  is_system: boolean;
  inputs: InputSeed[];
  steps: StepSeed[];
};

function loadDefinitionSeeds(): DefinitionSeed[] {
  const dir = join(__dirname, 'definitions');
  // Collect .md files from top-level and any immediate subdirectories
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entry.name);
    } else if (entry.isDirectory()) {
      for (const sub of readdirSync(join(dir, entry.name))) {
        if (sub.endsWith('.md')) files.push(join(entry.name, sub));
      }
    }
  }
  files.sort();
  const seeds: DefinitionSeed[] = [];

  for (const file of files) {
    const raw = readFileSync(join(dir, file), 'utf-8');

    // Extract YAML between --- delimiters
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) {
      throw new Error(`Missing YAML frontmatter in ${file}`);
    }

    const meta = yaml.load(match[1]) as Record<string, any>;

    const missing: string[] = [];
    if (!meta.key) missing.push('key');
    if (!meta.name) missing.push('name');
    if (!meta.steps || !Array.isArray(meta.steps)) missing.push('steps');
    if (!meta.inputs || !Array.isArray(meta.inputs)) missing.push('inputs');
    if (missing.length > 0) {
      throw new Error(`Missing required fields ${missing.join(', ')} in ${file}`);
    }

    seeds.push({
      key: meta.key,
      name: meta.name,
      description: meta.description || null,
      is_system: meta.is_system === true,
      inputs: meta.inputs.map((inp: any) => ({
        type: inp.type,
        required: inp.required !== false,
        description: inp.description || null,
        example: inp.example || null,
      })),
      steps: meta.steps.map((step: any) => ({
        key: step.key,
        name: step.name,
        step_type: step.step_type || 'prompt',
        assistant_handle: step.assistant_handle || null,
        model: step.model || null,
        prompt_handle: step.prompt_handle || null,
        input_source: step.input_source || 'job_input',
        input_config: step.input_config || {},
        config: step.config || {},
        timeout_ms: step.timeout_ms || 120000,
      })),
    });
  }

  return seeds;
}

export async function seedDefinitions(client: Client): Promise<void> {
  const seeds = loadDefinitionSeeds();
  if (seeds.length === 0) return;

  console.log(`\nSeeding ${seeds.length} kdag definitions...`);

  for (const seed of seeds) {
    await client.query('BEGIN');
    try {
      // Check if definition exists
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM kdag.job_definitions WHERE key = $1',
        [seed.key]
      );

      let defId: string;

      if (existing.rows.length > 0) {
        defId = existing.rows[0].id;

        // Update definition metadata
        await client.query(
          `UPDATE kdag.job_definitions
           SET name = $1, description = $2, is_system = $3, updated_at = NOW()
           WHERE id = $4`,
          [seed.name, seed.description, seed.is_system, defId]
        );

        // Replace steps and inputs
        await client.query('DELETE FROM kdag.job_definition_steps WHERE definition_id = $1', [defId]);
        await client.query('DELETE FROM kdag.job_definition_inputs WHERE definition_id = $1', [defId]);
      } else {
        // Insert new definition
        const ins = await client.query<{ id: string }>(
          `INSERT INTO kdag.job_definitions (key, name, description, is_system)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [seed.key, seed.name, seed.description, seed.is_system]
        );
        defId = ins.rows[0].id;
      }

      // Insert steps
      for (let i = 0; i < seed.steps.length; i++) {
        const step = seed.steps[i];
        await client.query(
          `INSERT INTO kdag.job_definition_steps
           (definition_id, step_index, key, name, step_type, assistant_handle, model, prompt_handle, input_source, input_config, config, timeout_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            defId, i, step.key, step.name, step.step_type,
            step.assistant_handle, step.model,
            step.prompt_handle,
            step.input_source, JSON.stringify(step.input_config),
            JSON.stringify(step.config || {}), step.timeout_ms,
          ]
        );
      }

      // Insert inputs (auto-create missing input types)
      for (const input of seed.inputs) {
        let typeRes = await client.query<{ id: number }>(
          'SELECT id FROM kdag.input_types WHERE key = $1',
          [input.type]
        );
        if (typeRes.rows.length === 0) {
          typeRes = await client.query<{ id: number }>(
            `INSERT INTO kdag.input_types (key, description, format)
             VALUES ($1, $2, 'text')
             RETURNING id`,
            [input.type, input.description || `Auto-created from definition '${seed.key}'`]
          );
        }
        await client.query(
          `INSERT INTO kdag.job_definition_inputs (definition_id, input_type_id, required, description, example)
           VALUES ($1, $2, $3, $4, $5)`,
          [defId, typeRes.rows[0].id, input.required, input.description, input.example]
        );
      }

      await client.query('COMMIT');
      console.log(`  ✓ ${seed.key} (${seed.name})`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
}
