/**
 * Text formatter for initialize_session response.
 * Converts verbose JSON session context into compact agent-readable text.
 */

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  return dateStr.substring(0, 10);
}

function formatMemoryLine(m: any, indent = '  '): string {
  const tags = m.tags?.length ? ` #${m.tags.map((t: any) => t.name || t).join(' #')}` : '';
  const status = m.status || m.status_value || '';
  const pinned = m.is_pinned ? ' [pinned]' : '';
  const id = m.id ? ` (${m.id})` : '';
  return `${indent}[${m.type || m.memory_type}] ${m.title} (${status})${pinned}${id}${tags}`;
}

export function formatSessionContext(data: any): string {
  const lines: string[] = [];
  const project = data.project;

  // Header
  const displayName = project?.display_name || project?.name || 'Unknown';
  const handle = project?.handle || '';
  lines.push(`# Session: ${displayName} (${handle})`);
  if (project?.description) {
    lines.push(project.description);
  }
  lines.push('');

  // Rules (just titles, agent already has the content via CLAUDE.md)
  if (data.rules?.length) {
    lines.push(`## Rules (${data.rules.length})`);
    for (const rule of data.rules) {
      lines.push(`  - ${rule.title}`);
    }
    lines.push('');
  }

  // Todos grouped by status
  if (data.todos?.length) {
    lines.push('## Todos');
    const grouped: Record<string, any[]> = {};
    for (const todo of data.todos) {
      const status = todo.status || todo.status_value || 'unknown';
      if (!grouped[status]) grouped[status] = [];
      grouped[status].push(todo);
    }

    const statusOrder = ['open', 'in_progress', 'blocked', 'done', 'canceled'];
    const sortedStatuses = Object.keys(grouped).sort(
      (a, b) => (statusOrder.indexOf(a) === -1 ? 99 : statusOrder.indexOf(a)) -
                (statusOrder.indexOf(b) === -1 ? 99 : statusOrder.indexOf(b))
    );

    for (const status of sortedStatuses) {
      const todos = grouped[status];
      lines.push(`### ${capitalize(status)} (${todos.length})`);
      for (const todo of todos) {
        lines.push(formatMemoryLine(todo));
      }
    }
    lines.push('');
  }

  // Recent decisions
  if (data.recent_decisions?.length) {
    lines.push(`## Recent Decisions (${data.recent_decisions.length})`);
    for (const d of data.recent_decisions) {
      lines.push(formatMemoryLine(d));
    }
    lines.push('');
  }

  // Recent patterns
  if (data.recent_patterns?.length) {
    lines.push(`## Recent Patterns (${data.recent_patterns.length})`);
    for (const p of data.recent_patterns) {
      lines.push(formatMemoryLine(p));
    }
    lines.push('');
  }

  // Recent context
  if (data.recent_context?.length) {
    lines.push(`## Recent Context (${data.recent_context.length})`);
    for (const c of data.recent_context) {
      lines.push(formatMemoryLine(c));
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function capitalize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
