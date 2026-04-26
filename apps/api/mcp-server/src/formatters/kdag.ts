/**
 * Text formatters for kdag pipeline tools:
 * list_job_definitions, get_job_definition, get_kdag_job, get_kdag_step
 */

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  return dateStr.substring(0, 10);
}

export function formatJobDefinitions(data: any): string {
  const lines: string[] = [];
  const definitions = data.definitions || [];
  const pagination = data.pagination;
  const totalCount = pagination?.total_count ?? definitions.length;

  lines.push(`# Pipeline Definitions (${totalCount})`);
  if (pagination?.has_more) {
    lines.push(`Showing ${definitions.length} of ${totalCount} — use query_kdag for full list.`);
  }
  lines.push('');

  if (definitions.length === 0) {
    lines.push('No definitions found.');
    return lines.join('\n');
  }

  for (const def of definitions) {
    const system = def.is_system ? ' [system]' : '';
    const steps = def.step_count ?? def.steps?.length ?? '?';
    const jobs = def.job_count ?? '?';
    lines.push(`## ${def.name} (\`${def.key}\`)${system}`);
    if (def.description) lines.push(def.description);
    lines.push(`Steps: ${steps} | Jobs: ${jobs}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function formatJobDefinition(data: any): string {
  const lines: string[] = [];
  const def = data.definition || data;

  const system = def.is_system ? ' [system]' : '';
  lines.push(`# ${def.name} (\`${def.key}\`)${system}`);
  if (def.description) lines.push(def.description);
  lines.push('');

  // Inputs
  const inputs = data.inputs || def.inputs || [];
  if (inputs.length > 0) {
    lines.push('## Inputs');
    for (const input of inputs) {
      const req = input.required ? ' (required)' : ' (optional)';
      const fmt = input.format ? `, ${input.format}` : '';
      const desc = input.description ? ` — ${input.description}` : '';
      lines.push(`  - \`${input.input_type || input.type}\`${req}${fmt}${desc}`);
      if (input.example) {
        lines.push(`    Example: ${input.example}`);
      }
    }
    lines.push('');
  }

  // Steps
  const steps = data.steps || def.steps || [];
  if (steps.length > 0) {
    lines.push('## Steps');
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const agent = step.assistant_handle ? ` → ${step.assistant_handle}` : '';
      const model = step.model ? ` (${step.model})` : '';
      const type = step.step_type || 'prompt';
      const source = step.input_source || '';
      lines.push(`  ${i + 1}. **${step.name}** (\`${step.key}\`, ${type})${agent}${model}`);
      if (step.prompt_handle) {
        lines.push(`     Prompt: ${step.prompt_handle}`);
      }
      if (source) {
        const inputCfg = step.input_config ? ` ${JSON.stringify(step.input_config)}` : '';
        lines.push(`     Input: ${source}${inputCfg}`);
      }
      const config = step.config;
      if (config && typeof config === 'object' && Object.keys(config).length > 0) {
        lines.push(`     Config: ${JSON.stringify(config)}`);
      }
      if (step.timeout_ms && step.timeout_ms !== 120000) {
        lines.push(`     Timeout: ${step.timeout_ms}ms`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function formatJobList(data: any): string {
  const lines: string[] = [];
  const jobs = data.jobs || [];
  const pagination = data.pagination;

  const total = pagination?.total_count ?? jobs.length;
  lines.push(`# Jobs (${total})`);
  lines.push('');

  if (jobs.length === 0) {
    lines.push('No jobs found.');
    return lines.join('\n');
  }

  for (const job of jobs) {
    const def = job.definition_key || job.job_type || '?';
    const status = job.status || job.latest_run?.status || 'unknown';
    const agent = job.assistant_handle || 'default';
    const project = job.project_handle ? ` [${job.project_handle}]` : '';
    const duration = job.latest_run?.duration_ms
      ? ` ${(job.latest_run.duration_ms / 1000).toFixed(1)}s`
      : '';
    lines.push(`- **${def}** (${status}${duration}) — agent: ${agent}${project}`);
    lines.push(`  ID: ${job.id} | Created: ${formatDate(job.created_at)}`);
  }

  if (pagination?.has_more) {
    lines.push('');
    lines.push(`_Showing ${jobs.length} of ${total}. Use offset to see more._`);
  }

  return lines.join('\n').trimEnd();
}

export function formatJob(data: any): string {
  const lines: string[] = [];
  const job = data.job || data;

  lines.push(`# Job: ${job.id}`);
  lines.push(`Definition: ${job.definition_key || job.definition?.key || '?'} | Agent: ${job.assistant_handle || 'default'}`);

  const runs = data.runs || job.runs || [];
  const latestRun = runs[0];
  const status = latestRun?.status || job.status || 'unknown';
  lines.push(`Status: ${status}`);

  // Show run-level error prominently for failed jobs
  if (status === 'failed' && latestRun?.error) {
    lines.push(`Error: ${latestRun.error}`);
  }
  lines.push('');

  // Inputs
  const inputs = data.inputs || job.inputs || [];
  if (inputs.length > 0) {
    lines.push('## Inputs');
    for (const input of inputs) {
      const type = input.input_type || input.type || '?';
      const content = input.content || '';
      const truncated = content.length > 200 ? content.substring(0, 200) + '...' : content;
      lines.push(`  **${type}**: ${truncated.replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }

  // Runs
  if (runs.length > 0 && latestRun) {
    lines.push(`## Latest Run (${latestRun.status})`);
    if (latestRun.duration_ms) {
      lines.push(`Duration: ${(latestRun.duration_ms / 1000).toFixed(1)}s`);
    }
    if (latestRun.model) {
      lines.push(`Model: ${latestRun.model}`);
    }

    // Steps
    const steps = latestRun.steps || job.steps || [];
    if (steps.length > 0) {
      lines.push('');
      lines.push('### Steps');
      for (const step of steps) {
        const stepStatus = step.status || '?';
        const duration = step.duration_ms ? ` (${(step.duration_ms / 1000).toFixed(1)}s)` : '';
        lines.push(`  ${step.step_order ?? step.definition_step_index ?? '?'}. ${step.step_name || step.name || step.step_key || step.step_type || '?'} — ${stepStatus}${duration}`);

        if (stepStatus === 'completed') {
          const outputText = step.output_text || step.output_preview;
          if (outputText) {
            const output = outputText.length > 300 ? outputText.substring(0, 300) + '...' : outputText;
            lines.push(`     Output: ${output.replace(/\n/g, '\n     ')}`);
          }
        }
        if (stepStatus === 'failed') {
          // Surface error from output_preview (contains err.message) or metadata.error
          const error = step.output_text || step.output_preview || step.metadata?.error || step.error;
          if (error) {
            lines.push(`     Error: ${error}`);
          }
        }
      }
    }
    lines.push('');
  }

  // Final output
  const output = job.output || data.output;
  if (output) {
    const outputText = typeof output === 'string' ? output : output.output_text || output.content || '';
    if (outputText) {
      lines.push('## Output');
      lines.push(outputText);
    }
  }

  return lines.join('\n').trimEnd();
}

export function formatStep(data: any): string {
  const lines: string[] = [];
  const records = data.records || [];

  lines.push(`# Step: ${data.step_name} (\`${data.step_key}\`, ${data.step_type})`);
  lines.push(`Run: ${data.run_id} (${data.run_status})`);
  lines.push('');

  if (records.length === 0) {
    lines.push('No step records found (step may not have executed yet).');
    return lines.join('\n');
  }

  // Single record (prompt/code) — show inline
  if (records.length === 1) {
    const r = records[0];
    const duration = r.duration_ms ? ` (${(r.duration_ms / 1000).toFixed(1)}s)` : '';
    const model = r.metadata?.model ? ` | Model: ${r.metadata.model}` : '';
    const backend = r.metadata?.backend ? ` | Backend: ${r.metadata.backend}` : '';
    lines.push(`Status: ${r.status}${duration}${model}${backend}`);

    if (r.status === 'failed') {
      const error = r.output_text || r.metadata?.error;
      if (error) {
        lines.push('');
        lines.push('## Error');
        lines.push(error);
      }
    }

    if (r.input_text) {
      lines.push('');
      lines.push('## Input');
      lines.push(r.input_text);
    }

    if (r.output_text && r.status !== 'failed') {
      lines.push('');
      lines.push('## Output');
      lines.push(r.output_text);
    }

    return lines.join('\n').trimEnd();
  }

  // Multiple records (map_reduce) — list each
  for (const r of records) {
    const label = r.step_type === 'synthesis' ? 'Synthesis' : `Batch ${r.step_index}`;
    const duration = r.duration_ms ? ` (${(r.duration_ms / 1000).toFixed(1)}s)` : '';
    const model = r.metadata?.model ? ` | Model: ${r.metadata.model}` : '';
    lines.push(`## ${label} — ${r.status}${duration}${model}`);

    if (r.status === 'failed') {
      const error = r.output_text || r.metadata?.error;
      if (error) {
        lines.push('### Error');
        lines.push(error);
      }
    }

    if (r.output_text && r.status !== 'failed') {
      lines.push('### Output');
      lines.push(r.output_text);
    }

    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function formatInputTypes(data: any): string {
  const lines: string[] = [];
  const types = data.input_types || data.types || [];

  lines.push(`# Input Types (${types.length})`);
  lines.push('');

  if (types.length === 0) {
    lines.push('No input types registered.');
    return lines.join('\n');
  }

  for (const t of types) {
    const builtIn = t.is_builtin ? ' [built-in]' : '';
    lines.push(`- \`${t.key}\`${builtIn}`);
    if (t.description) lines.push(`  ${t.description}`);
  }

  return lines.join('\n').trimEnd();
}

export function formatDefinitionSnapshots(data: any): string {
  const lines: string[] = [];
  const snapshots = data.snapshots || [];

  lines.push(`# Definition Snapshots: \`${data.definition_key}\` (${snapshots.length})`);
  lines.push('');

  if (snapshots.length === 0) {
    lines.push('No snapshots found.');
    return lines.join('\n');
  }

  for (const s of snapshots) {
    const stepCount = Array.isArray(s.steps_json) ? s.steps_json.length : '?';
    const inputCount = Array.isArray(s.inputs_json) ? s.inputs_json.length : '?';
    lines.push(`  ${s.snapshot_number}. ${s.source} — ${formatDate(s.created_at)} (${stepCount} steps, ${inputCount} inputs)`);
  }

  return lines.join('\n').trimEnd();
}

export function formatDefinitionSnapshot(data: any): string {
  const lines: string[] = [];
  const s = data.snapshot || data;

  lines.push(`# Snapshot ${s.snapshot_number} of \`${data.definition_key || '?'}\``);
  lines.push(`Source: ${s.source} | Created: ${formatDate(s.created_at)}`);
  if (s.name) lines.push(`Name: ${s.name}`);
  if (s.description) lines.push(`Description: ${s.description}`);
  lines.push('');

  // Steps
  const steps = s.steps_json || [];
  if (steps.length > 0) {
    lines.push('## Steps');
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const agent = step.assistant_handle ? ` → ${step.assistant_handle}` : '';
      const model = step.model ? ` (${step.model})` : '';
      const type = step.step_type || 'prompt';
      lines.push(`  ${i + 1}. **${step.name}** (\`${step.key}\`, ${type})${agent}${model}`);
      if (step.prompt_handle) {
        lines.push(`     Prompt: ${step.prompt_handle}`);
      }
      if (step.input_source) {
        const inputCfg = step.input_config ? ` ${JSON.stringify(step.input_config)}` : '';
        lines.push(`     Input: ${step.input_source}${inputCfg}`);
      }
      const config = step.config;
      if (config && typeof config === 'object' && Object.keys(config).length > 0) {
        lines.push(`     Config: ${JSON.stringify(config)}`);
      }
      if (step.timeout_ms && step.timeout_ms !== 120000) {
        lines.push(`     Timeout: ${step.timeout_ms}ms`);
      }
    }
    lines.push('');
  }

  // Inputs
  const inputs = s.inputs_json || [];
  if (inputs.length > 0) {
    lines.push('## Inputs');
    for (const input of inputs) {
      const req = input.required ? ' (required)' : ' (optional)';
      const desc = input.description ? ` — ${input.description}` : '';
      lines.push(`  - \`${input.input_type}\`${req}${desc}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
