/**
 * Text formatters for project tools.
 * Converts verbose JSON into compact agent-readable text.
 */

function formatProject(p: any): string[] {
  const lines: string[] = [];
  const fav = p.is_favorite ? ' ★' : '';
  const display = p.display_name && p.display_name !== p.name ? ` (${p.display_name})` : '';

  lines.push(`**${p.name}**${display}${fav}`);
  lines.push(`  Handle: ${p.handle} | ID: ${p.id}`);

  if (p.description) lines.push(`  ${p.description}`);
  if (p.path) lines.push(`  Path: ${p.path}`);

  return lines;
}

export function formatProjectList(data: any): string {
  const lines: string[] = [];
  const projects = data.projects || [];

  lines.push(`# Projects (${projects.length})`);
  lines.push('');

  if (projects.length === 0) {
    lines.push('No projects found.');
    return lines.join('\n');
  }

  for (let i = 0; i < projects.length; i++) {
    lines.push(`${i + 1}. ${formatProject(projects[i]).join('\n   ')}`);
    if (i < projects.length - 1) lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function formatProjectDetail(project: any): string {
  const lines: string[] = [];

  lines.push(`# Project: ${project.name}`);
  lines.push('');
  lines.push(...formatProject(project));

  const created = project.created_at?.substring(0, 10);
  const updated = project.updated_at?.substring(0, 10);
  if (created || updated) {
    lines.push(`  Created: ${created || '?'} | Updated: ${updated || '?'}`);
  }

  return lines.join('\n').trimEnd();
}
