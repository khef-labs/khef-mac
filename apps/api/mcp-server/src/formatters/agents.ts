/**
 * Text formatters for agent tools:
 * get_user_agents, get_project_agents, get_user_agent, get_project_agent
 */

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.substring(0, max - 1) + '…';
}

export function formatAgentList(data: any, args: Record<string, unknown>): string {
  const lines: string[] = [];
  const agents = data.agents || [];
  const scope = agents[0]?.scope || (args.project_id ? 'project' : 'user');

  lines.push(`# Agents (${agents.length} ${scope}-level)`);
  if (data.agentsPath) lines.push(`Path: ${data.agentsPath}`);
  lines.push('');

  if (agents.length === 0) {
    lines.push('No agents found.');
    return lines.join('\n');
  }

  for (const a of agents) {
    const model = a.model ? ` [${a.model}]` : '';
    const desc = a.description ? ' — ' + truncate(a.description, 100) : '';
    lines.push(`- **${a.name}**${model}${desc}`);
  }

  return lines.join('\n').trimEnd();
}

export function formatAgent(data: any): string {
  const lines: string[] = [];
  const a = data.agent || data;

  lines.push(`# ${a.name}`);
  const meta: string[] = [];
  if (a.model) meta.push(`Model: ${a.model}`);
  if (a.scope) meta.push(`Scope: ${a.scope}`);
  if (meta.length) lines.push(meta.join(' | '));
  if (a.filePath) lines.push(`File: ${a.filePath}`);
  lines.push('');

  if (a.description) {
    lines.push(`## Description`);
    lines.push(a.description);
    lines.push('');
  }

  if (a.tools?.length) {
    lines.push(`## Tools`);
    lines.push(a.tools.join(', '));
    lines.push('');
  }

  if (a.disallowedTools?.length) {
    lines.push(`## Disallowed Tools`);
    lines.push(a.disallowedTools.join(', '));
    lines.push('');
  }

  if (a.prompt) {
    lines.push(`## Prompt`);
    lines.push(a.prompt);
  }

  return lines.join('\n').trimEnd();
}
