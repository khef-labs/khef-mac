/**
 * Text formatters for get_graph_health and get_stats responses.
 */

function formatArrayDistribution(items: any[], nameKey: string, countKey: string): string {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items
    .filter((item: any) => (item[countKey] || 0) > 0)
    .map((item: any) => `${item[countKey]} ${item[nameKey]}`)
    .join(', ');
}

export function formatGraphHealth(data: any): string {
  const lines: string[] = [];

  lines.push('# Graph Health');
  lines.push('');

  // Summary
  const summary = data.summary || {};
  lines.push(`Total memories: ${summary.total_memories ?? '?'}`);
  lines.push(`Connected: ${summary.connected_memories ?? '?'}`);
  lines.push(`Orphans: ${summary.orphan_count ?? '?'}`);
  lines.push('');

  // Connected components
  const components = data.components || summary.components || {};
  if (components.total !== undefined) {
    lines.push('## Components');
    lines.push(`Total: ${components.total}, Isolated: ${components.isolated ?? 0}, Largest: ${components.largest_size ?? 0}`);
    lines.push('');
  }

  // Relation type distribution (may be array or object)
  const relations = data.relation_types || data.relations || [];
  if (Array.isArray(relations) && relations.length > 0) {
    lines.push('## Relation Types');
    for (const r of relations) {
      lines.push(`  ${r.type || r.name}: ${r.count}`);
    }
    lines.push('');
  } else if (typeof relations === 'object' && !Array.isArray(relations) && Object.keys(relations).length > 0) {
    lines.push('## Relation Types');
    for (const [type, count] of Object.entries(relations)) {
      lines.push(`  ${type}: ${count}`);
    }
    lines.push('');
  }

  // Per-type stats (may be array or object)
  const typeStats = data.type_stats || data.by_type || [];
  if (Array.isArray(typeStats) && typeStats.length > 0) {
    lines.push('## By Type');
    for (const t of typeStats) {
      const orphans = t.orphans !== undefined ? ` (${t.orphans} orphans)` : '';
      lines.push(`  ${t.type || t.name}: ${t.total ?? t.count}${orphans}`);
    }
    lines.push('');
  }

  // Orphan list (if present and not too long)
  const orphans = data.orphans || [];
  if (orphans.length > 0) {
    lines.push(`## Orphan Memories (${orphans.length})`);
    const shown = orphans.slice(0, 20);
    for (const o of shown) {
      const type = o.type || o.memory_type || '';
      const handlePart = o.handle ? ` handle: ${o.handle}` : '';
      lines.push(`  [${type}] ${o.title} (${o.id})${handlePart}`);
    }
    if (orphans.length > 20) {
      lines.push(`  ... and ${orphans.length - 20} more`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function formatStats(data: any): string {
  const lines: string[] = [];

  lines.push('# System Stats');
  lines.push('');

  // Memory counts
  const memories = data.memories || {};
  const total = memories.total ?? '?';
  lines.push(`Memories: ${total}`);

  // By type (array of {type, count})
  const byType = memories.by_type || [];
  if (Array.isArray(byType) && byType.length > 0) {
    const typeParts = formatArrayDistribution(byType, 'type', 'count');
    if (typeParts) lines.push(`  By type: ${typeParts}`);
  }

  // By project (array of {handle, name, count})
  const byProject = memories.by_project || [];
  if (Array.isArray(byProject) && byProject.length > 0) {
    const projParts = formatArrayDistribution(byProject, 'handle', 'count');
    if (projParts) lines.push(`  By project: ${projParts}`);
  }

  // Other counts
  lines.push('');
  const projects = data.projects;
  if (projects !== undefined) {
    lines.push(`Projects: ${projects.total ?? projects}`);
  }

  const tags = data.tags;
  if (tags !== undefined) {
    const tagTotal = tags.total ?? tags;
    const topTags = tags.top;
    if (Array.isArray(topTags) && topTags.length > 0) {
      const tagList = topTags.map((t: any) => `${t.name} (${t.count})`).join(', ');
      lines.push(`Tags: ${tagTotal} — top: ${tagList}`);
    } else {
      lines.push(`Tags: ${tagTotal}`);
    }
  }

  const relations = data.relations;
  if (relations !== undefined) {
    const relTotal = relations.total ?? relations;
    const byRelType = relations.by_type;
    if (Array.isArray(byRelType) && byRelType.length > 0) {
      const relParts = formatArrayDistribution(byRelType, 'type', 'count');
      if (relParts) {
        lines.push(`Relations: ${relTotal} (${relParts})`);
      } else {
        lines.push(`Relations: ${relTotal}`);
      }
    } else {
      lines.push(`Relations: ${relTotal}`);
    }
  }

  const files = data.files;
  if (files !== undefined) {
    const fileTotal = files.total ?? files;
    const fileSize = files.total_size ? formatBytes(files.total_size) : '';
    lines.push(`Files: ${fileTotal}${fileSize ? ` (${fileSize})` : ''}`);
  }

  const db = data.database;
  if (db) {
    lines.push(`Database: ${db.size_human || formatBytes(db.size)}`);
  }

  return lines.join('\n').trimEnd();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
