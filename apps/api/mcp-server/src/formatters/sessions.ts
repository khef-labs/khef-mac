/**
 * Text formatter for session search results.
 * Converts verbose JSON into compact agent-readable text.
 */

function truncate(s: string, maxLen: number): string {
  if (!s) return '';
  const clean = s.replace(/\n/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen - 3) + '...';
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  return dateStr.substring(0, 10);
}

export function formatSessionSearchResults(data: any, args: Record<string, unknown>): string {
  const lines: string[] = [];
  const mode = (args.mode as string) || 'semantic';
  const query = args.q as string || '';

  // Handle different response shapes (fulltext vs vector modes)
  const results = data.results || data.sessions || [];
  const total = data.pagination?.total_count ?? data.total ?? results.length;

  lines.push(`# Session Search: "${query}" (mode: ${mode}, ${results.length} results, ${total} total)`);
  lines.push('');

  if (results.length === 0) {
    lines.push('No results found.');
    return lines.join('\n');
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const score = typeof r.score === 'number' ? ` (score: ${r.score.toFixed(2)})` : '';
    const project = r.project_handle || r.project_dir || r.project || '';
    const date = formatDate(r.date || r.session_date || r.created_at);
    const sessionId = r.session_id || r.id || '';

    const projectTag = project ? `[${project}]` : '';
    const datePart = date ? ` ${date}` : '';

    lines.push(`${i + 1}. ${projectTag}${datePart}${score}`);

    if (sessionId) {
      lines.push(`   Session: ${sessionId}`);
    }

    // Summary or content excerpt
    const excerpt = r.summary || r.content || r.text || r.excerpt || '';
    if (excerpt) {
      lines.push(`   ${truncate(excerpt, 150)}`);
    }

    if (i < results.length - 1) lines.push('');
  }

  // Pagination
  const pagination = data.pagination;
  if (pagination?.has_more) {
    const offset = pagination.offset || 0;
    const limit = pagination.limit || 10;
    lines.push('');
    lines.push(`Showing ${offset + 1}-${offset + results.length} of ${total}`);
  }

  lines.push('');
  lines.push('Tip: Use get_session_by_id(session_id) to get full session details.');

  return lines.join('\n').trimEnd();
}

export function formatSessionProjects(data: any): string {
  const lines: string[] = [];
  const projects = data.projects || [];

  lines.push(`# Session Projects (${projects.length})`);
  lines.push('');

  if (projects.length === 0) {
    lines.push('No session projects found.');
    return lines.join('\n');
  }

  for (const p of projects) {
    const khefProject = p.khef_project ? ` → ${p.khef_project}` : '';
    const count = p.session_count ?? p.count ?? '?';
    const size = p.total_size ? ` | ${formatSize(p.total_size)}` : '';
    const lastMod = p.last_modified ? ` | Last: ${formatDate(p.last_modified)}` : '';
    lines.push(`- **${p.directory || p.name}**${khefProject}`);
    lines.push(`  ${count} sessions${size}${lastMod}`);
  }

  return lines.join('\n').trimEnd();
}

export function formatSessionList(data: any): string {
  const lines: string[] = [];
  const sessions = data.sessions || [];
  const pagination = data.pagination;
  const total = pagination?.total_count ?? sessions.length;

  lines.push(`# Sessions (${sessions.length} of ${total})`);
  lines.push('');

  if (sessions.length === 0) {
    lines.push('No sessions found.');
    return lines.join('\n');
  }

  const offset = pagination?.offset ?? 0;
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const id = s.session_id || s.id || '';
    const size = s.size ? formatSize(s.size) : '';
    const date = formatDate(s.date || s.last_modified || s.created_at);
    const summary = s.summary ? truncate(s.summary, 100) : '';
    const companion = s.has_companion ? ' [+companion]' : '';

    lines.push(`${offset + i + 1}. ${id}${companion}`);
    const meta: string[] = [];
    if (date) meta.push(date);
    if (size) meta.push(size);
    if (meta.length) lines.push(`   ${meta.join(' | ')}`);
    if (summary) lines.push(`   ${summary}`);
    if (i < sessions.length - 1) lines.push('');
  }

  if (pagination?.has_more) {
    lines.push('');
    lines.push(`Showing ${offset + 1}-${offset + sessions.length} of ${total}`);
  }

  return lines.join('\n').trimEnd();
}

export function formatSyncedSessionList(data: any): string {
  const lines: string[] = [];
  const sessions = data.sessions || [];
  const pagination = data.pagination;
  const total = pagination?.total_count ?? sessions.length;

  lines.push(`# Sessions (${sessions.length} of ${total})`);
  lines.push('');

  if (sessions.length === 0) {
    lines.push('No sessions found.');
    return lines.join('\n');
  }

  const offset = pagination?.offset ?? 0;
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const sessionId = s.session_id || s.id || '';
    const project = s.project_handle || s.project_name || '';
    const assistant = s.assistant?.handle || s.assistant_handle || '';
    const messages = s.message_count != null ? `${s.message_count} msgs` : '';
    const date = formatDate(s.synced_at || s.created_at);
    const summary = s.summary ? truncate(s.summary, 100) : '';

    const projectTag = project ? `[${project}]` : '';
    lines.push(`${offset + i + 1}. ${projectTag} ${sessionId}`);

    const meta: string[] = [];
    if (assistant) meta.push(assistant);
    if (date) meta.push(date);
    if (messages) meta.push(messages);
    if (meta.length) lines.push(`   ${meta.join(' | ')}`);
    if (summary) lines.push(`   ${summary}`);
    if (i < sessions.length - 1) lines.push('');
  }

  if (pagination?.has_more) {
    lines.push('');
    lines.push(`Showing ${offset + 1}-${offset + sessions.length} of ${total}`);
  }

  return lines.join('\n').trimEnd();
}

export function formatSyncedSession(data: any): string {
  const lines: string[] = [];
  const s = data.session || data;

  const sessionId = s.session_id || s.id || '';
  const project = s.project_handle || s.project_name || '';
  const assistant = s.assistant?.handle || s.assistant_handle || '';
  const messages = s.message_count != null ? `${s.message_count} msgs` : '';
  const synced = formatDate(s.synced_at);
  const created = formatDate(s.created_at);

  lines.push(`# Session: ${sessionId}`);
  const meta: string[] = [];
  if (project) meta.push(`Project: ${project}`);
  if (assistant) meta.push(`Assistant: ${assistant}`);
  if (meta.length) lines.push(meta.join(' | '));

  const meta2: string[] = [];
  if (messages) meta2.push(messages);
  if (synced) meta2.push(`Synced: ${synced}`);
  if (created) meta2.push(`Created: ${created}`);
  if (meta2.length) lines.push(meta2.join(' | '));

  if (s.summary) {
    lines.push('');
    lines.push(`## Summary`);
    lines.push(s.summary);
  }

  if (s.file_path) {
    lines.push('');
    lines.push(`File: ${s.file_path}`);
  }

  const chunks = data.chunks || s.chunks || [];
  if (chunks.length > 0) {
    lines.push('');
    lines.push(`## Chunks (${chunks.length})`);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const preview = truncate(c.content || c.text || '', 120);
      lines.push(`${i + 1}. ${preview}`);
    }
  }

  return lines.join('\n').trimEnd();
}

export function formatSessionLineage(data: any): string {
  const lines: string[] = [];
  const sessions = data.sessions || [];
  const nickname = data.nickname || '';
  const liveCount = data.live_count || 0;

  lines.push(`# Session Lineage: ${nickname} (${sessions.length} session${sessions.length !== 1 ? 's' : ''}, ${liveCount} live)`);
  lines.push('');

  if (sessions.length === 0) {
    lines.push('No sessions found with this nickname.');
    return lines.join('\n');
  }

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const sessionId = s.session_id || '';
    const project = s.project?.handle || 'no project';
    const status = s.is_live ? `LIVE, pid: ${s.pid}` : 'inactive';
    const start = formatDate(s.started_at) || '?';
    const end = s.is_live ? 'present' : (formatDate(s.ended_at) || '?');
    const msgs = s.message_count != null ? `${s.message_count} messages` : '';

    lines.push(`${i + 1}. ${sessionId} [${project}] (${status})`);
    lines.push(`   ${start} – ${end}${msgs ? ' | ' + msgs : ''}`);

    const summaries = s.summaries || [];
    if (summaries.length > 0) {
      lines.push(`   Summaries: ${summaries.length} snapshot${summaries.length !== 1 ? 's' : ''}`);
      for (const snap of summaries) {
        lines.push(`   - ${snap.snapshot_id} (${formatDate(snap.created_at)}, ${snap.chunk_count || '?'} chunks)`);
      }
    }

    const compactions = s.compactions || [];
    if (compactions.length > 0) {
      lines.push(`   Compactions: ${compactions.length}`);
      for (const comp of compactions) {
        lines.push(`   - chunk ${comp.chunk_index} (${comp.chunk_id})`);
      }
    }

    if (summaries.length === 0 && compactions.length === 0) {
      lines.push('   (no summaries or compactions)');
    }

    if (i < sessions.length - 1) lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function formatSessionLineageTokenCount(data: any): string {
  const lines: string[] = [];
  const nickname = data.nickname || '';
  const tokens = data.estimated_tokens ?? 0;
  const bytes = data.total_bytes ?? 0;
  const sessions = data.session_count ?? 0;
  const summaries = data.summary_count ?? 0;
  const compactions = data.compaction_count ?? 0;

  lines.push(`# Rehydrate Cost: ${nickname}`);
  lines.push(`Estimated tokens: ~${tokens.toLocaleString()} (${bytes.toLocaleString()} bytes)`);
  lines.push(`Sessions: ${sessions} | Summaries: ${summaries} | Compactions: ${compactions}`);

  return lines.join('\n').trimEnd();
}

export function formatSessionLineageExport(data: any): string {
  const lines: string[] = [];
  const nickname = data.nickname || '';
  const fileList = data.file_list || [];

  lines.push(`# Lineage Export: ${nickname}`);
  lines.push(`Path: ${data.path || ''}`);
  const tokens = data.estimated_tokens ? ` | ~${data.estimated_tokens.toLocaleString()} tokens` : '';
  lines.push(`Sessions: ${data.sessions || 0} | Files: ${data.files || 0}${tokens}`);
  lines.push('');

  if (fileList.length === 0) {
    lines.push('No files exported.');
    return lines.join('\n');
  }

  lines.push('## Files');
  for (const f of fileList) {
    lines.push(`- ${f}`);
  }

  return lines.join('\n').trimEnd();
}

interface ReadSessionOptions {
  includeToolCalls?: boolean;
  includeThinking?: boolean;
}

export function formatReadSession(data: any, options: ReadSessionOptions = {}): string {
  const lines: string[] = [];
  const session = data.session || {};
  const pagination = data.pagination;
  const includeToolCalls = options.includeToolCalls ?? false;
  const includeThinking = options.includeThinking ?? false;

  const id = session.id || '';
  const entryCount = session.entry_count ?? 0;
  const size = session.size ? formatSize(session.size) : '';

  lines.push(`# Session Transcript: ${id}`);
  const meta: string[] = [];
  if (entryCount) meta.push(`${entryCount} entries`);
  if (size) meta.push(size);
  if (meta.length) lines.push(meta.join(' | '));
  lines.push('');

  const entries = session.entries || [];
  if (entries.length === 0) {
    lines.push('No entries in this range.');
    return lines.join('\n');
  }

  const skipTypes = new Set(['tool_use', 'tool_result', 'file-history-snapshot', 'progress', 'system']);
  const offset = pagination?.offset ?? 0;
  let shown = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const entryNum = offset + i + 1;
    const type = entry.type || 'unknown';
    const ts = entry.timestamp ? entry.timestamp.substring(11, 19) : '';

    // Skip noise entries (tool calls gated separately)
    if (type === 'file-history-snapshot' || type === 'progress' || type === 'system') continue;
    if (!includeToolCalls && (type === 'tool_use' || type === 'tool_result')) continue;

    shown++;

    switch (type) {
      case 'summary': {
        const summary = typeof entry.summary === 'string' ? entry.summary : (entry.summary?.content || '');
        lines.push(`--- [${entryNum}] SUMMARY ${ts ? `(${ts})` : ''} ---`);
        lines.push(truncate(summary, 500));
        lines.push('');
        break;
      }
      case 'user': {
        const content = extractTextContent(entry.message?.content || entry.content);
        if (!content.trim() || isSystemMarkup(content)) continue;
        lines.push(`--- [${entryNum}] USER ${ts ? `(${ts})` : ''} ---`);
        lines.push(truncate(content, 300));
        lines.push('');
        break;
      }
      case 'assistant': {
        const content = extractAssistantContent(entry.message?.content || entry.content, includeThinking, includeToolCalls);
        if (!content.trim()) continue;
        lines.push(`--- [${entryNum}] ASSISTANT ${ts ? `(${ts})` : ''} ---`);
        lines.push(truncate(content, 500));
        lines.push('');
        break;
      }
      case 'tool_use': {
        const toolName = entry.name || entry.tool_name || '?';
        lines.push(`--- [${entryNum}] TOOL_USE: ${toolName} ${ts ? `(${ts})` : ''} ---`);
        break;
      }
      case 'tool_result': {
        const toolId = entry.tool_use_id ? ` (${entry.tool_use_id.substring(0, 12)}...)` : '';
        const resultPreview = extractToolResultPreview(entry);
        lines.push(`--- [${entryNum}] TOOL_RESULT${toolId} ${ts ? `(${ts})` : ''} ---`);
        if (resultPreview) lines.push(resultPreview);
        break;
      }
      default: {
        lines.push(`--- [${entryNum}] ${type.toUpperCase()} ${ts ? `(${ts})` : ''} ---`);
        break;
      }
    }
  }

  if (pagination?.has_more) {
    const total = pagination.total_count;
    const end = offset + entries.length;
    lines.push('');
    lines.push(`Showing entries ${offset + 1}-${end} of ${total}. Use offset=${end} to see more.`);
  }

  return lines.join('\n').trimEnd();
}

function isSystemMarkup(content: string): boolean {
  const trimmed = content.trim();
  // Skill injections (e.g., "Base directory for this skill: ...")
  if (trimmed.startsWith('Base directory for this skill:')) return true;
  // XML/HTML system tags (hook caveats, command invocations, system reminders)
  return /^<[a-z-]+[\s>]/.test(trimmed) && /^(<[^>]+>[\s\S]*<\/[^>]+>\s*)+$/.test(trimmed);
}

function extractTextContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text || '')
      .join('\n');
  }
  return '';
}

function extractAssistantContent(content: any, includeThinking = false, includeToolCalls = false): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === 'text') {
        parts.push(block.text || '');
      } else if (block.type === 'thinking' && includeThinking) {
        parts.push(`[thinking] ${truncate(block.thinking || '', 200)}`);
      } else if (block.type === 'tool_use' && includeToolCalls) {
        parts.push(`[tool_use: ${block.name || '?'}]`);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function extractToolResultPreview(entry: any): string {
  const content = entry.content || entry.output;
  if (!content) return '';
  if (typeof content === 'string') return truncate(content, 200);
  if (Array.isArray(content)) {
    const text = content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text || '')
      .join('\n');
    return truncate(text, 200);
  }
  return '';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
