import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";

export const tools: Tool[] = [
  {
    name: "unified_search",
    description:
      "Unified search across all khef backends in one call. Fans out to memories (keyword + semantic), source code (per-language), commits, sessions (fulltext + semantic), docs, and slack in parallel. Returns grouped results. Use this instead of calling individual search tools sequentially.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Search query (natural language, 2+ characters)",
        },
        project: {
          type: "string",
          description: "Filter by project handle (applies to memories, sessions, docs)",
        },
        repo: {
          type: "string",
          description: "Filter by repository name (applies to source code and commits)",
        },
        limit: {
          type: "number",
          description: "Max results per backend (default: 10, minimum: 5)",
        },
        exclude_session_id: {
          type: "string",
          description: "Exclude results from this session UUID (e.g., your own current session). Applies to sessions backend only.",
        },
      },
      required: ["q"],
    },
  },
];

interface UnifiedResult {
  memories: Array<{
    id: string;
    project_handle: string;
    handle: string;
    title: string;
    type: string;
    status: string;
    content_excerpt: string;
    score: number;
    mode: string;
  }>;
  source_code: Array<{
    file_path: string;
    content: string;
    score: number;
    language: string | null;
    chunk_index: number;
  }>;
  commits: Array<{
    sha: string;
    short_sha: string;
    message: string;
    author: string;
    date: string;
    repo: string;
    score: number;
  }>;
  sessions: Array<{
    session_id: string;
    assistant_handle: string;
    project_handle: string | null;
    name: string | null;
    excerpt: string;
    rank: number;
    mode: string;
  }>;
  docs: Array<{
    file_path: string;
    title: string | null;
    content: string;
    score: number;
    file_type: string | null;
    project_handle: string | null;
  }>;
  slack: Array<{
    content: string;
    score: number;
    document_id: string;
    channel?: string;
  }>;
  meta: {
    query: string;
    duration_ms: number;
    backends: string[];
    errors: string[];
  };
}

function formatUnifiedResults(data: UnifiedResult): string {
  const lines: string[] = [];
  const q = data.meta.query;
  const dur = data.meta.duration_ms;

  lines.push(`# Unified Search: "${q}" (${dur}ms)`);

  if (data.meta.errors.length > 0) {
    lines.push(`\nErrors: ${data.meta.errors.join(', ')}`);
  }

  // Memories
  if (data.memories.length > 0) {
    lines.push(`\n## Memories (${data.memories.length} results)\n`);
    for (let i = 0; i < data.memories.length; i++) {
      const m = data.memories[i];
      const score = typeof m.score === 'number' ? m.score.toFixed(2) : m.score;
      lines.push(`${i + 1}. [${m.type}] ${m.title} (${m.status}) [${m.project_handle}] (${m.mode}, score: ${score})`);
      lines.push(`   ID: ${m.id}`);
      if (m.content_excerpt) {
        lines.push(`   ${m.content_excerpt.replace(/\n/g, ' ')}`);
      }
    }
  }

  // Source code
  if (data.source_code.length > 0) {
    lines.push(`\n## Source Code (${data.source_code.length} results)\n`);
    for (let i = 0; i < data.source_code.length; i++) {
      const s = data.source_code[i];
      lines.push(`${i + 1}. ${s.file_path} [${s.language || 'unknown'}] (${s.score.toFixed(2)})`);
      if (s.content) {
        lines.push(`   ${s.content.slice(0, 150).replace(/\n/g, ' ')}`);
      }
    }
  }

  // Commits
  if (data.commits.length > 0) {
    lines.push(`\n## Commits (${data.commits.length} results)\n`);
    for (let i = 0; i < data.commits.length; i++) {
      const c = data.commits[i];
      lines.push(`${i + 1}. ${c.short_sha} ${c.message} (${c.author}, ${c.date?.slice(0, 10) || '?'}) [${c.repo}] (${c.score.toFixed(2)})`);
    }
  }

  // Sessions
  if (data.sessions.length > 0) {
    lines.push(`\n## Sessions (${data.sessions.length} results)\n`);
    for (let i = 0; i < data.sessions.length; i++) {
      const s = data.sessions[i];
      const proj = s.project_handle ? `[${s.project_handle}]` : '';
      lines.push(`${i + 1}. ${proj} ${s.name || s.session_id} (${s.mode}, rank: ${typeof s.rank === 'number' ? s.rank.toFixed(2) : s.rank})`);
      if (s.excerpt) {
        lines.push(`   ${s.excerpt.slice(0, 200).replace(/\n/g, ' ')}`);
      }
    }
  }

  // Docs
  if (data.docs.length > 0) {
    lines.push(`\n## Docs (${data.docs.length} results)\n`);
    for (let i = 0; i < data.docs.length; i++) {
      const d = data.docs[i];
      lines.push(`${i + 1}. ${d.title || d.file_path} [${d.file_type || 'unknown'}] (${d.score.toFixed(2)})`);
      if (d.content) {
        lines.push(`   ${d.content.slice(0, 200).replace(/\n/g, ' ')}`);
      }
    }
  }

  // Slack
  if (data.slack.length > 0) {
    lines.push(`\n## Slack (${data.slack.length} results)\n`);
    for (let i = 0; i < data.slack.length; i++) {
      const sl = data.slack[i];
      const chan = sl.channel ? `#${sl.channel}` : sl.document_id;
      lines.push(`${i + 1}. ${chan} (${sl.score.toFixed(2)})`);
      if (sl.content) {
        lines.push(`   ${sl.content.slice(0, 200).replace(/\n/g, ' ')}`);
      }
    }
  }

  // Summary of empty backends
  const emptyBackends = [];
  if (data.memories.length === 0) emptyBackends.push('memories');
  if (data.source_code.length === 0) emptyBackends.push('source_code');
  if (data.commits.length === 0) emptyBackends.push('commits');
  if (data.sessions.length === 0) emptyBackends.push('sessions');
  if (data.docs.length === 0) emptyBackends.push('docs');
  if (data.slack.length === 0) emptyBackends.push('slack');

  if (emptyBackends.length > 0) {
    lines.push(`\nNo results from: ${emptyBackends.join(', ')}`);
  }

  return lines.join('\n');
}

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  if (name !== "unified_search") return null;

  const rawLimit = args.limit as number | undefined;
  const limit = rawLimit != null ? Math.max(rawLimit, 5) : undefined;

  const result = await client.unifiedSearch({
    q: args.q as string,
    project: args.project as string | undefined,
    repo: args.repo as string | undefined,
    limit,
    excludeSessionId: args.exclude_session_id as string | undefined,
  });

  return {
    content: [{ type: "text", text: formatUnifiedResults(result as UnifiedResult) }],
  };
}
