interface GraphNode {
  id: string;
  title: string;
  type: string;
  parent_type?: string;
  status: string;
  handle?: string;
  depth?: number;
  content_excerpt?: string;
}

interface GraphEdge {
  source: string;
  target: string;
  relation_type: string;
}

interface ProjectGraphStats {
  totalMemories: number;
  truncated: boolean;
}

/**
 * Format a project-level graph as agent-readable text.
 *
 * Output groups each memory with its outgoing/incoming relations,
 * then appends type and relation distribution stats.
 */
export function formatProjectGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  projectName: string,
  stats: ProjectGraphStats
): string {
  const lines: string[] = [];

  lines.push(`# Graph: "${projectName}" (${stats.totalMemories} memories, ${edges.length} relations)`);
  if (stats.truncated) {
    lines.push(`  (truncated — showing ${nodes.length} of ${stats.totalMemories} memories)`);
  }
  lines.push('');

  // Build lookup maps
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const outgoing = new Map<string, { type: string; targetId: string }[]>();
  const incoming = new Map<string, { type: string; sourceId: string }[]>();

  for (const edge of edges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source)!.push({ type: edge.relation_type, targetId: edge.target });

    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target)!.push({ type: edge.relation_type, sourceId: edge.source });
  }

  // Type and relation counters
  const typeCounts = new Map<string, number>();
  const relationCounts = new Map<string, number>();
  let orphanCount = 0;

  for (const edge of edges) {
    relationCounts.set(edge.relation_type, (relationCounts.get(edge.relation_type) || 0) + 1);
  }

  lines.push(`## Memories (${nodes.length})`);
  lines.push('');

  for (const node of nodes) {
    const displayType = node.parent_type ? `${node.parent_type}/${node.type}` : node.type;
    typeCounts.set(displayType, (typeCounts.get(displayType) || 0) + 1);

    lines.push(`  [${displayType}] ${node.title} (${node.status}) ${node.id}`);

    const outs = outgoing.get(node.id) || [];
    const ins = incoming.get(node.id) || [];

    if (outs.length === 0 && ins.length === 0) {
      orphanCount++;
      lines.push('    (no relations)');
    } else {
      for (const rel of outs) {
        const target = nodeMap.get(rel.targetId);
        const label = target ? `${target.title} (${rel.targetId})` : rel.targetId;
        lines.push(`    --${rel.type}--> ${label}`);
      }
      for (const rel of ins) {
        const source = nodeMap.get(rel.sourceId);
        const label = source ? `${source.title} (${rel.sourceId})` : rel.sourceId;
        lines.push(`    <--${rel.type}-- ${label}`);
      }
    }

    lines.push('');
  }

  // Stats section
  lines.push('## Stats');

  const typeEntries = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
  lines.push(`- Types: ${typeEntries.map(([t, c]) => `${c} ${t}`).join(', ')}`);

  if (relationCounts.size > 0) {
    const relEntries = [...relationCounts.entries()].sort((a, b) => b[1] - a[1]);
    lines.push(`- Relations: ${relEntries.map(([t, c]) => `${c} ${t}`).join(', ')}`);
  }

  if (orphanCount > 0) {
    lines.push(`- Orphans: ${orphanCount} memories with no relations`);
  }

  return lines.join('\n');
}

/**
 * Format a single-memory graph traversal as agent-readable text.
 *
 * Output is organized by depth from the root memory, showing
 * directional relation arrows at each level.
 */
export function formatMemoryGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  rootMemoryId: string
): string {
  const lines: string[] = [];

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const root = nodeMap.get(rootMemoryId);

  if (!root) {
    return '(empty graph)';
  }

  const displayType = root.parent_type ? `${root.parent_type}/${root.type}` : root.type;
  lines.push(`# Graph: "${root.title}" [${displayType}, ${root.status}] ${root.id}`);
  lines.push('');

  // Group nodes by depth
  const byDepth = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const d = node.depth ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(node);
  }

  // Build adjacency from edges
  const outgoing = new Map<string, { type: string; targetId: string }[]>();
  const incoming = new Map<string, { type: string; sourceId: string }[]>();

  for (const edge of edges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source)!.push({ type: edge.relation_type, targetId: edge.target });

    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target)!.push({ type: edge.relation_type, sourceId: edge.source });
  }

  const depths = [...byDepth.keys()].sort((a, b) => a - b);

  for (const depth of depths) {
    const nodesAtDepth = byDepth.get(depth)!;

    if (depth === 0) {
      lines.push(`## Depth 0 (root)`);
      const nodeType = root.parent_type ? `${root.parent_type}/${root.type}` : root.type;
      lines.push(`  ${root.title} [${nodeType}, ${root.status}] ${root.id}`);
    } else {
      const count = nodesAtDepth.length;
      lines.push(`## Depth ${depth} (${count} ${count === 1 ? 'connection' : 'connections'})`);

      for (const node of nodesAtDepth) {
        const nodeType = node.parent_type ? `${node.parent_type}/${node.type}` : node.type;

        // Find how this node connects to any node at a shallower depth
        const connectionsTo: string[] = [];
        const outs = outgoing.get(node.id) || [];
        const ins = incoming.get(node.id) || [];

        for (const rel of outs) {
          const target = nodeMap.get(rel.targetId);
          if (target && (target.depth ?? 0) < depth) {
            connectionsTo.push(`--${rel.type}--> ${target.title}`);
          }
        }
        for (const rel of ins) {
          const source = nodeMap.get(rel.sourceId);
          if (source && (source.depth ?? 0) < depth) {
            connectionsTo.push(`<--${rel.type}-- ${source.title}`);
          }
        }

        if (connectionsTo.length > 0) {
          for (const conn of connectionsTo) {
            lines.push(`  ${conn} => ${node.title} [${nodeType}, ${node.status}] ${node.id}`);
          }
        } else {
          lines.push(`  ${node.title} [${nodeType}, ${node.status}] ${node.id}`);
        }
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}
