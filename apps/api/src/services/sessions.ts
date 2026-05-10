import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { query } from '../db/client';
import { SessionProject, SessionFile, SessionEntry } from '../types';
import { getHiddenProjectHandles } from '../utils/hidden-projects';

// Base paths where each assistant stores session files
const SESSION_BASE_PATHS: Record<string, string> = {
  'claude-code': path.join(os.homedir(), '.claude', 'projects'),
};


/**
 * Get the base path for an assistant's session storage.
 * Returns null if the assistant doesn't support sessions.
 */
export function getSessionsBasePath(handle: string, overrideBasePath?: string): string | null {
  if (overrideBasePath) return overrideBasePath;
  return SESSION_BASE_PATHS[handle] ?? null;
}

/**
 * Decode a session directory name back to a filesystem path.
 * "-Users-alice-projects-khef" → "/Users/alice/projects/khef"
 *
 * Note: This is a best-effort decode. Directory names with hyphens in
 * actual path components are ambiguous. Use matched_project for reliable mapping.
 */
export function decodeDirName(dirName: string): string {
  // The dir name is the absolute path with all "/" replaced by "-"
  // Leading "-" corresponds to the leading "/" on Unix paths
  if (!dirName.startsWith('-')) return dirName;
  return dirName.replace(/-/g, '/');
}

// ── Validation ──────────────────────────────────────────────────────

/**
 * Validate a project directory name to prevent path traversal.
 * Must not contain ".." or "/" characters.
 */
export function validateProjectDir(dir: string): void {
  if (dir.includes('..') || dir.includes('/') || dir.includes('\\')) {
    throw new ValidationError('Invalid project directory name');
  }
}

/**
 * Validate a session ID. Must be a UUID or agent-hex pattern.
 */
export function validateSessionId(id: string): void {
  // UUID pattern: 8-4-4-4-12 hex with hyphens
  const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  // Agent pattern: agent-<hex>
  const agentPattern = /^agent-[a-f0-9]+$/;

  if (!uuidPattern.test(id) && !agentPattern.test(id)) {
    throw new ValidationError('Invalid session ID format');
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ── Resolution ──────────────────────────────────────────────────────

/**
 * Resolve a project identifier to the actual session directory name.
 *
 * Accepts:
 *   1. A khef project handle or name → looks up project path in DB, converts to dir name
 *   2. A raw directory name (e.g., "-Users-roger-projects-khef") → used as-is
 *
 * Returns the filesystem directory name, or the original input if no DB match is found.
 */
export async function resolveProjectDir(identifier: string): Promise<string> {
  // If it starts with "-", it's already a raw dir name
  if (identifier.startsWith('-')) return identifier;

  // Try to resolve via DB: lookup by UUID, handle, or name
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
  const projects = await query<{ path: string }>(
    isUuid
      ? `SELECT path FROM projects WHERE id = $1 AND path IS NOT NULL AND path != '' LIMIT 1`
      : `SELECT path FROM projects WHERE (handle = $1 OR LOWER(name) = LOWER($1)) AND path IS NOT NULL AND path != '' LIMIT 1`,
    [identifier]
  );

  if (projects.length > 0) {
    const projectPath = projects[0].path.startsWith('~')
      ? path.join(os.homedir(), projects[0].path.slice(1))
      : projects[0].path;
    return projectPath.replace(/\//g, '-');
  }

  // No DB match — return as-is (may be a raw dir name without leading "-")
  return identifier;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Recursively calculate the total size of a directory.
 */
function getDirSize(dirPath: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += getDirSize(fullPath);
      } else if (entry.isFile()) {
        total += fs.statSync(fullPath).size;
      }
    }
  } catch {
    // Directory may have been deleted or is inaccessible
  }
  return total;
}

/**
 * Extract summary info from the first few lines of a session JSONL file.
 * Looks for a "summary" type entry to get the session title.
 */
export function extractSummary(filePath: string): { summary?: string; leaf_uuid?: string } {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8192); // Read first 8KB — enough for summary entries
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    fs.closeSync(fd);

    const content = buffer.toString('utf-8', 0, bytesRead);
    const lines = content.split('\n');

    for (const line of lines.slice(0, 10)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'summary') {
          return {
            summary: entry.summary,
            leaf_uuid: entry.leafUuid,
          };
        }
      } catch {
        // Skip unparseable lines
      }
    }
  } catch {
    // File may be inaccessible
  }
  return {};
}

/**
 * Find a session by ID using the session_embeddings database.
 * Returns session metadata including project_dir for further lookups.
 */
export async function getSessionById(
  sessionId: string,
  assistantHandle?: string
): Promise<{
  session_id: string;
  project_dir: string;
  assistant_handle: string;
  file_size: number;
  chunk_count: number;
  embedded_at: string;
} | null> {
  validateSessionId(sessionId);

  let sql = `
    SELECT session_id, project_dir, assistant_handle, file_size, chunk_count, embedded_at
    FROM session_embeddings
    WHERE session_id = $1
  `;
  const params: (string)[] = [sessionId];

  if (assistantHandle) {
    sql += ` AND assistant_handle = $2`;
    params.push(assistantHandle);
  }

  sql += ` LIMIT 1`;

  const result = await query<{
    session_id: string;
    project_dir: string;
    assistant_handle: string;
    file_size: string;
    chunk_count: number;
    embedded_at: Date;
  }>(sql, params);

  if (result.length === 0) return null;

  const row = result[0];
  return {
    session_id: row.session_id,
    project_dir: row.project_dir,
    assistant_handle: row.assistant_handle,
    file_size: parseInt(row.file_size, 10),
    chunk_count: row.chunk_count,
    embedded_at: row.embedded_at.toISOString(),
  };
}

// ── Core Operations ─────────────────────────────────────────────────

/**
 * List all session project directories with stats.
 * Optionally matches directories to khef projects via path comparison.
 * Directories matched to hidden khef projects are excluded unless includeHidden is true.
 */
export async function listSessionProjects(
  handle: string,
  overrideBasePath?: string,
  options?: { includeHidden?: boolean }
): Promise<{ projects: SessionProject[]; total_size: number; total_sessions: number }> {
  const basePath = getSessionsBasePath(handle, overrideBasePath);
  if (!basePath || !fs.existsSync(basePath)) {
    return { projects: [], total_size: 0, total_sessions: 0 };
  }

  // Resolve hidden project handles (only when filtering)
  const hiddenHandles = options?.includeHidden
    ? new Set<string>()
    : new Set(await getHiddenProjectHandles());

  // Get known projects from DB for matching
  const dbProjects = await query<{ id: string; handle: string; name: string; path: string }>(
    `SELECT id, handle, name, path FROM projects WHERE path IS NOT NULL AND path != ''`
  );

  // Build maps: dir name → project info, dir name → actual path
  const pathToProject = new Map<string, { id: string; handle: string; name: string }>();
  const dirToActualPath = new Map<string, string>();
  for (const p of dbProjects) {
    // Expand ~ in project path for comparison
    const expandedPath = p.path.startsWith('~')
      ? path.join(os.homedir(), p.path.slice(1))
      : p.path;
    const expectedDir = expandedPath.replace(/\//g, '-');
    pathToProject.set(expectedDir, { id: p.id, handle: p.handle, name: p.name });
    dirToActualPath.set(expectedDir, expandedPath);
  }

  const entries = fs.readdirSync(basePath, { withFileTypes: true });
  const projects: SessionProject[] = [];
  let totalSize = 0;
  let totalSessions = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirPath = path.join(basePath, entry.name);
    const jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    const sessionCount = jsonlFiles.length;

    if (sessionCount === 0) continue;

    // Calculate total size of all files in the directory
    const dirSize = getDirSize(dirPath);

    // Find most recent modification time among .jsonl files
    let lastModified = new Date(0);
    for (const f of jsonlFiles) {
      const stat = fs.statSync(path.join(dirPath, f));
      if (stat.mtime > lastModified) {
        lastModified = stat.mtime;
      }
    }

    // Use actual project path if matched, fall back to best-effort decode
    const matchedPath = dirToActualPath.get(entry.name);
    const project: SessionProject = {
      dir_name: entry.name,
      decoded_path: matchedPath ?? decodeDirName(entry.name),
      session_count: sessionCount,
      total_size: dirSize,
      last_modified: lastModified.toISOString(),
    };

    // Try to match to a khef project
    const matched = pathToProject.get(entry.name);
    if (matched) {
      // Skip directories matched to hidden projects
      if (hiddenHandles.has(matched.handle)) continue;
      project.matched_project = matched;
    }

    projects.push(project);
    totalSize += dirSize;
    totalSessions += sessionCount;
  }

  // Sort by last_modified descending
  projects.sort((a, b) => new Date(b.last_modified).getTime() - new Date(a.last_modified).getTime());

  return { projects, total_size: totalSize, total_sessions: totalSessions };
}

/**
 * List session files in a specific project directory.
 */
export function listSessions(
  handle: string,
  projectDir: string,
  options?: {
    sort?: 'date' | 'size';
    order?: 'asc' | 'desc';
    limit?: number;
    offset?: number;
    overrideBasePath?: string;
    idsOnly?: boolean;
  }
): { sessions: SessionFile[]; pagination: { total_count: number; limit: number; offset: number; has_more: boolean }; ids?: string[] } {
  validateProjectDir(projectDir);

  const basePath = getSessionsBasePath(handle, options?.overrideBasePath);
  if (!basePath) {
    return { sessions: [], pagination: { total_count: 0, limit: 50, offset: 0, has_more: false } };
  }

  const dirPath = path.join(basePath, projectDir);
  if (!fs.existsSync(dirPath)) {
    return { sessions: [], pagination: { total_count: 0, limit: 50, offset: 0, has_more: false } };
  }

  const jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
  const allSessions: SessionFile[] = [];

  for (const file of jsonlFiles) {
    const filePath = path.join(dirPath, file);
    const sessionId = file.replace('.jsonl', '');
    const stat = fs.statSync(filePath);

    // Check for companion directory
    const companionDir = path.join(dirPath, sessionId);
    const hasCompanion = fs.existsSync(companionDir) && fs.statSync(companionDir).isDirectory();

    const session: SessionFile = {
      id: sessionId,
      size: stat.size,
      last_modified: stat.mtime.toISOString(),
      has_companion: hasCompanion,
    };

    if (hasCompanion) {
      session.companion_size = getDirSize(companionDir);
    }

    // Extract summary from first few lines
    const summaryInfo = extractSummary(filePath);
    if (summaryInfo.summary) session.summary = summaryInfo.summary;
    if (summaryInfo.leaf_uuid) session.leaf_uuid = summaryInfo.leaf_uuid;

    allSessions.push(session);
  }

  // Sort
  const sortField = options?.sort ?? 'date';
  const sortOrder = options?.order ?? 'desc';

  allSessions.sort((a, b) => {
    let cmp: number;
    if (sortField === 'size') {
      cmp = a.size - b.size;
    } else {
      cmp = new Date(a.last_modified).getTime() - new Date(b.last_modified).getTime();
    }
    return sortOrder === 'desc' ? -cmp : cmp;
  });

  // If ids_only requested, return just the sorted IDs (no pagination)
  if (options?.idsOnly) {
    return {
      sessions: [],
      pagination: { total_count: allSessions.length, limit: 0, offset: 0, has_more: false },
      ids: allSessions.map(s => s.id),
    };
  }

  // Paginate
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const totalCount = allSessions.length;
  const paginated = allSessions.slice(offset, offset + limit);

  return {
    sessions: paginated,
    pagination: {
      total_count: totalCount,
      limit,
      offset,
      has_more: offset + limit < totalCount,
    },
  };
}

/**
 * Search session file content for a query string.
 * Reads each JSONL file line-by-line, stops at first match per file.
 * Returns matching sessions with a ~200 char excerpt around the match.
 */
export async function searchSessionContent(
  handle: string,
  projectDir: string,
  searchQuery: string,
  options?: {
    sort?: 'date' | 'size';
    order?: 'asc' | 'desc';
    limit?: number;
    offset?: number;
    overrideBasePath?: string;
  }
): Promise<{ sessions: SessionFile[]; pagination: { total_count: number; limit: number; offset: number; has_more: boolean } }> {
  validateProjectDir(projectDir);

  const basePath = getSessionsBasePath(handle, options?.overrideBasePath);
  if (!basePath) {
    return { sessions: [], pagination: { total_count: 0, limit: 50, offset: 0, has_more: false } };
  }

  const dirPath = path.join(basePath, projectDir);
  if (!fs.existsSync(dirPath)) {
    return { sessions: [], pagination: { total_count: 0, limit: 50, offset: 0, has_more: false } };
  }

  const jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
  const queryLower = searchQuery.toLowerCase();
  const matchingSessions: SessionFile[] = [];

  for (const file of jsonlFiles) {
    const filePath = path.join(dirPath, file);
    const sessionId = file.replace('.jsonl', '');
    const stat = fs.statSync(filePath);

    // Search file content line by line
    let excerpt: string | undefined;
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      const lineLower = line.toLowerCase();
      const matchIdx = lineLower.indexOf(queryLower);
      if (matchIdx !== -1) {
        // Extract ~200 char window around the match
        const start = Math.max(0, matchIdx - 80);
        const end = Math.min(line.length, matchIdx + searchQuery.length + 120);
        excerpt = (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '');
        rl.close();
        stream.destroy();
        break;
      }
    }

    if (!excerpt) continue;

    const companionDir = path.join(dirPath, sessionId);
    const hasCompanion = fs.existsSync(companionDir) && fs.statSync(companionDir).isDirectory();

    const session: SessionFile = {
      id: sessionId,
      size: stat.size,
      last_modified: stat.mtime.toISOString(),
      has_companion: hasCompanion,
      search_excerpt: excerpt,
    };

    if (hasCompanion) {
      session.companion_size = getDirSize(companionDir);
    }

    const summaryInfo = extractSummary(filePath);
    if (summaryInfo.summary) session.summary = summaryInfo.summary;
    if (summaryInfo.leaf_uuid) session.leaf_uuid = summaryInfo.leaf_uuid;

    matchingSessions.push(session);
  }

  // Sort
  const sortField = options?.sort ?? 'date';
  const sortOrder = options?.order ?? 'desc';

  matchingSessions.sort((a, b) => {
    let cmp: number;
    if (sortField === 'size') {
      cmp = a.size - b.size;
    } else {
      cmp = new Date(a.last_modified).getTime() - new Date(b.last_modified).getTime();
    }
    return sortOrder === 'desc' ? -cmp : cmp;
  });

  // Paginate
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const totalCount = matchingSessions.length;
  const paginated = matchingSessions.slice(offset, offset + limit);

  return {
    sessions: paginated,
    pagination: {
      total_count: totalCount,
      limit,
      offset,
      has_more: offset + limit < totalCount,
    },
  };
}

/**
 * Expand a leading "~" to the user's home directory.
 */
function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return filepath.replace('~', os.homedir());
  }
  return filepath;
}

/**
 * Resolve the archived session file path when the original is pruned.
 * Returns null when backup is disabled, path is unset, or the archive file is missing.
 */
async function resolveBackupPath(
  handle: string,
  projectDir: string,
  sessionId: string
): Promise<string | null> {
  try {
    const rows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM settings WHERE key IN ('sessions.backupPath', 'sessions.backupEnabled')`
    );
    const map: Record<string, string> = {};
    for (const row of rows) map[row.key] = row.value;
    if (map['sessions.backupEnabled'] !== 'true') return null;
    const backupPath = (map['sessions.backupPath'] ?? '').trim();
    if (!backupPath) return null;

    const resolvedRoot = path.resolve(expandTilde(backupPath));
    const candidate = path.join(resolvedRoot, handle, projectDir, `${sessionId}.jsonl`);
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Read a session transcript with paginated entries from an absolute file path.
 * Used directly by the synced-session raw endpoint (assistant-agnostic — works
 * for both Claude `<projectDir>/<id>.jsonl` and Codex `YYYY/MM/DD/<id>.jsonl`).
 */
export async function readSessionByFilePath(
  filePath: string,
  sessionId: string,
  options?: { limit?: number; offset?: number; source?: 'original' | 'backup' }
): Promise<{
  session: {
    id: string;
    size: number;
    entry_count: number;
    entries: SessionEntry[];
    source: 'original' | 'backup';
    file_path: string;
  };
  pagination: { total_count: number; limit: number; offset: number; has_more: boolean };
} | null> {
  if (!fs.existsSync(filePath)) return null;

  const stat = fs.statSync(filePath);
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  // Read and parse all lines (needed for accurate count and pagination)
  const entries: SessionEntry[] = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineIndex = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as SessionEntry;
      if (lineIndex >= offset && lineIndex < offset + limit) {
        entries.push(entry);
      }
      lineIndex++;
    } catch {
      // Skip unparseable lines
      lineIndex++;
    }
  }

  const totalCount = lineIndex;

  return {
    session: {
      id: sessionId,
      size: stat.size,
      entry_count: totalCount,
      entries,
      source: options?.source ?? 'original',
      file_path: filePath,
    },
    pagination: {
      total_count: totalCount,
      limit,
      offset,
      has_more: offset + limit < totalCount,
    },
  };
}

/**
 * Read a session transcript with paginated entries.
 * Falls back to the configured backup location when the original file is missing.
 */
export async function readSession(
  handle: string,
  projectDir: string,
  sessionId: string,
  options?: { limit?: number; offset?: number; overrideBasePath?: string }
): Promise<{
  session: {
    id: string;
    size: number;
    entry_count: number;
    entries: SessionEntry[];
    source: 'original' | 'backup';
    file_path: string;
  };
  pagination: { total_count: number; limit: number; offset: number; has_more: boolean };
} | null> {
  validateProjectDir(projectDir);
  validateSessionId(sessionId);

  const basePath = getSessionsBasePath(handle, options?.overrideBasePath);
  if (!basePath) return null;

  let filePath = path.join(basePath, projectDir, `${sessionId}.jsonl`);
  let source: 'original' | 'backup' = 'original';

  if (!fs.existsSync(filePath)) {
    // Fallback to archived copy if the original has been pruned upstream.
    // Only honored when no basePath override is set — overrides are for callers
    // deliberately pointing at a specific location (e.g., tests).
    if (options?.overrideBasePath) return null;
    const backupFile = await resolveBackupPath(handle, projectDir, sessionId);
    if (!backupFile) return null;
    filePath = backupFile;
    source = 'backup';
  }

  return readSessionByFilePath(filePath, sessionId, {
    limit: options?.limit,
    offset: options?.offset,
    source,
  });
}

/**
 * Summarize the working context a session has touched: file paths read/edited/written,
 * search patterns, top bash commands, and MCP tools used. Built from streaming the JSONL
 * tool_use blocks. Useful for deciding whether to re-resume an inactive session (high
 * relevant file count = high cache value) versus re-deriving context from scratch.
 */
export interface LoadedContextSummary {
  session_id: string;
  source: 'original' | 'backup';
  file_path: string;
  total_messages: number;
  total_tool_calls: number;
  first_at: string | null;
  last_at: string | null;
  files: Array<{ path: string; reads: number; edits: number; writes: number }>;
  searches: Array<{ pattern: string; count: number }>;
  bash_commands: Array<{ command: string; count: number }>;
  mcp_tools: Array<{ tool: string; count: number }>;
}

interface FileBucket { reads: number; edits: number; writes: number }

function bumpFile(map: Map<string, FileBucket>, p: string, kind: keyof FileBucket): void {
  if (!p) return;
  let bucket = map.get(p);
  if (!bucket) {
    bucket = { reads: 0, edits: 0, writes: 0 };
    map.set(p, bucket);
  }
  bucket[kind] += 1;
}

function bumpCount(map: Map<string, number>, key: string): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topN(map: Map<string, number>, n: number): Array<{ key: string; count: number }> {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

export async function summarizeLoadedContext(
  handle: string,
  projectDir: string,
  sessionId: string,
  options?: { overrideBasePath?: string }
): Promise<LoadedContextSummary | null> {
  validateProjectDir(projectDir);
  validateSessionId(sessionId);

  const basePath = getSessionsBasePath(handle, options?.overrideBasePath);
  if (!basePath) return null;

  let filePath = path.join(basePath, projectDir, `${sessionId}.jsonl`);
  let source: 'original' | 'backup' = 'original';
  if (!fs.existsSync(filePath)) {
    if (options?.overrideBasePath) return null;
    const backupFile = await resolveBackupPath(handle, projectDir, sessionId);
    if (!backupFile) return null;
    filePath = backupFile;
    source = 'backup';
  }

  const files = new Map<string, FileBucket>();
  const searches = new Map<string, number>();
  const commands = new Map<string, number>();
  const mcpTools = new Map<string, number>();

  let totalMessages = 0;
  let totalToolCalls = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: SessionEntry;
    try {
      entry = JSON.parse(line) as SessionEntry;
    } catch {
      continue;
    }
    totalMessages += 1;
    if (entry.timestamp) {
      if (!firstAt) firstAt = entry.timestamp;
      lastAt = entry.timestamp;
    }
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type !== 'tool_use') continue;
      totalToolCalls += 1;
      const name = String(block.name || '');
      const input = (block.input ?? {}) as Record<string, unknown>;

      switch (name) {
        case 'Read':
          bumpFile(files, String(input.file_path ?? ''), 'reads');
          break;
        case 'Write':
          bumpFile(files, String(input.file_path ?? ''), 'writes');
          break;
        case 'Edit':
        case 'MultiEdit':
        case 'NotebookEdit':
          bumpFile(files, String(input.file_path ?? input.notebook_path ?? ''), 'edits');
          break;
        case 'Grep':
          bumpCount(searches, String(input.pattern ?? ''));
          break;
        case 'Glob':
          bumpCount(searches, String(input.pattern ?? ''));
          break;
        case 'Bash': {
          const cmd = String(input.command ?? '').trim();
          if (cmd) {
            // Use the first word as the canonical command for grouping
            const first = cmd.split(/\s+/)[0] ?? cmd;
            bumpCount(commands, first);
          }
          break;
        }
        default:
          if (name.startsWith('mcp__')) {
            bumpCount(mcpTools, name);
          }
      }
    }
  }

  return {
    session_id: sessionId,
    source,
    file_path: filePath,
    total_messages: totalMessages,
    total_tool_calls: totalToolCalls,
    first_at: firstAt,
    last_at: lastAt,
    files: [...files.entries()]
      .map(([p, b]) => ({ path: p, ...b }))
      .sort((a, b) => (b.reads + b.edits + b.writes) - (a.reads + a.edits + a.writes))
      .slice(0, 50),
    searches: topN(searches, 20).map(({ key, count }) => ({ pattern: key, count })),
    bash_commands: topN(commands, 20).map(({ key, count }) => ({ command: key, count })),
    mcp_tools: topN(mcpTools, 20).map(({ key, count }) => ({ tool: key, count })),
  };
}

/**
 * Delete a session file and its companion directory.
 * Returns the number of bytes freed.
 */
export function deleteSession(
  handle: string,
  projectDir: string,
  sessionId: string,
  overrideBasePath?: string
): { freed_bytes: number } | null {
  validateProjectDir(projectDir);
  validateSessionId(sessionId);

  const basePath = getSessionsBasePath(handle, overrideBasePath);
  if (!basePath) return null;

  const filePath = path.join(basePath, projectDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) return null;

  let freedBytes = 0;

  // Get file size before deleting
  freedBytes += fs.statSync(filePath).size;
  fs.unlinkSync(filePath);

  // Delete companion directory if it exists
  const companionDir = path.join(basePath, projectDir, sessionId);
  if (fs.existsSync(companionDir) && fs.statSync(companionDir).isDirectory()) {
    freedBytes += getDirSize(companionDir);
    fs.rmSync(companionDir, { recursive: true, force: true });
  }

  return { freed_bytes: freedBytes };
}

/**
 * Bulk delete sessions matching criteria.
 */
export function bulkDeleteSessions(
  handle: string,
  options: {
    projectDir?: string;
    before?: string; // ISO date string
    sessionIds?: string[];
    overrideBasePath?: string;
  }
): { deleted: number; freed_bytes: number } {
  const basePath = getSessionsBasePath(handle, options.overrideBasePath);
  if (!basePath) return { deleted: 0, freed_bytes: 0 };

  let deleted = 0;
  let freedBytes = 0;

  // Determine which project directories to scan
  let projectDirs: string[];
  if (options.projectDir) {
    validateProjectDir(options.projectDir);
    projectDirs = [options.projectDir];
  } else {
    // Scan all project directories
    try {
      projectDirs = fs.readdirSync(basePath, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      return { deleted: 0, freed_bytes: 0 };
    }
  }

  const beforeDate = options.before ? new Date(options.before) : null;
  const sessionIdSet = options.sessionIds ? new Set(options.sessionIds) : null;

  for (const dir of projectDirs) {
    const dirPath = path.join(basePath, dir);
    let jsonlFiles: string[];
    try {
      jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of jsonlFiles) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(dirPath, file);

      // Filter by session IDs if specified
      if (sessionIdSet && !sessionIdSet.has(sessionId)) continue;

      // Filter by date if specified
      if (beforeDate) {
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtime >= beforeDate) continue;
        } catch {
          continue;
        }
      }

      // Delete the session
      try {
        const result = deleteSession(handle, dir, sessionId, options.overrideBasePath);
        if (result) {
          deleted++;
          freedBytes += result.freed_bytes;
        }
      } catch {
        // Skip files that fail to delete
      }
    }
  }

  return { deleted, freed_bytes: freedBytes };
}
