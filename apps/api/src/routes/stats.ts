import { FastifyPluginAsync } from 'fastify';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { query, querySingle } from '../db/client';

const execFileAsync = promisify(execFile);

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${parseFloat(value.toFixed(1))} ${units[i]}`;
}

interface ProcessInstance {
  pid: number;
  name?: string;
  rss: number;
  rss_human: string;
  cpu: number;
  session_nickname?: string;
  session_id?: string;
}

interface SessionPidInfo {
  nickname: string;
  session_id: string;
}

// Map active-session PIDs → nickname/session_id so drill-down rows can show
// which running Claude Code session a process belongs to.
async function getActiveSessionPidMap(): Promise<Map<number, SessionPidInfo>> {
  try {
    const rows = await query<{ pid: number; nickname: string | null; session_id: string }>(
      "SELECT pid, nickname, session_id FROM sessions WHERE pid IS NOT NULL AND status = 'active'"
    );
    const map = new Map<number, SessionPidInfo>();
    for (const r of rows) {
      if (r.nickname) map.set(r.pid, { nickname: r.nickname, session_id: r.session_id });
    }
    return map;
  } catch {
    return new Map();
  }
}

interface ProcessGroup {
  name: string;
  count: number;
  rss: number;
  rss_human: string;
  cpu: number;
  instances: ProcessInstance[];
}

// Back-compat aliases — the response shape kept these names.
type KhefProcessInstance = ProcessInstance;
type KhefProcessGroup = ProcessGroup;
type AppInstance = ProcessInstance;
type AppGroup = ProcessGroup;

export interface ProcessRow {
  pid: number;
  ppid: number;
  mem: number;    // resident bytes
  cmprs: number;  // compressed bytes
  cpu: number;
  args: string;
}

// Single top+ps snapshot shared by both getKhefProcesses and getSystemProcesses.
export async function gatherProcessRows(): Promise<ProcessRow[]> {
  const [topOut, psOut] = await Promise.all([
    execFileAsync('top', ['-l', '1', '-stats', 'pid,mem,cmprs,cpu', '-o', 'mem']),
    execFileAsync('ps', ['-Ao', 'pid,ppid,args']),
  ]);

  const psInfo = new Map<number, { ppid: number; args: string }>();
  for (const line of psOut.stdout.trim().split('\n').slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (m) psInfo.set(parseInt(m[1], 10), { ppid: parseInt(m[2], 10), args: m[3] });
  }

  const topLines = topOut.stdout.split('\n');
  let dataStart = -1;
  for (let i = 0; i < topLines.length; i++) {
    if (/^\s*PID\b/.test(topLines[i])) {
      dataStart = i + 1;
      break;
    }
  }
  if (dataStart === -1) return [];

  const rows: ProcessRow[] = [];
  for (let i = dataStart; i < topLines.length; i++) {
    const parts = topLines[i].trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = parseInt(parts[0], 10);
    if (isNaN(pid)) continue;
    const info = psInfo.get(pid);
    rows.push({
      pid,
      ppid: info?.ppid ?? 0,
      mem: parseTopMem(parts[1]),
      cmprs: parseTopMem(parts[2]),
      cpu: parseFloat(parts[3]),
      args: info?.args ?? '',
    });
  }
  return rows;
}

// Walk the PPID chain to find the outermost `.app/` bundle ancestor — used so
// all descendants of iTerm2 (iTermServer → login → bash → claude → …) roll up
// under "iTerm" the same way Chrome helpers roll up under "Google Chrome".
export function findRootAppName(pid: number, byPid: Map<number, ProcessRow>): string | null {
  let cur = pid;
  let outermost: string | null = null;
  for (let i = 0; i < 30; i++) {
    const row = byPid.get(cur);
    if (!row) break;
    const m = row.args.match(/\/([^/]+)\.app\//);
    if (m) outermost = m[1];
    if (row.ppid <= 1 || row.ppid === cur) break;
    cur = row.ppid;
  }
  return outermost;
}

// Walk the PPID chain to find the nearest ancestor PID registered as an active
// Claude Code session. Lets node workers (children of the claude CLI) inherit
// the session nickname of their parent.
function findSessionAncestor(
  pid: number,
  byPid: Map<number, ProcessRow>,
  sessionPids: Map<number, SessionPidInfo>
): SessionPidInfo | undefined {
  let cur = pid;
  for (let i = 0; i < 10; i++) {
    const hit = sessionPids.get(cur);
    if (hit) return hit;
    const row = byPid.get(cur);
    if (!row || row.ppid <= 1 || row.ppid === cur) break;
    cur = row.ppid;
  }
  return undefined;
}

async function getKhefProcesses(
  rows: ProcessRow[],
  sessionPids: Map<number, SessionPidInfo>
): Promise<{ processes: ProcessGroup[]; total_rss: number; total_rss_human: string }> {
  const byPid = new Map<number, ProcessRow>();
  for (const row of rows) byPid.set(row.pid, row);
  const patterns: { name: string; match: RegExp }[] = [
    { name: 'API server', match: /khef\/apps\/api\/node_modules\/tsx.*src\/index\.ts/ },
    { name: 'API tsx watch', match: /tsx watch.*src\/index\.ts/ },
    { name: 'API esbuild', match: /khef\/apps\/api\/node_modules\/@esbuild/ },
    { name: 'UI dev server (Vite)', match: /khef\/apps\/ui\/node_modules\/.bin\/vite/ },
    { name: 'UI esbuild', match: /khef\/apps\/ui\/node_modules\/@esbuild/ },
    { name: 'Embed server', match: /embed_server\.py/ },
    { name: 'MCP server', match: /khef\/apps\/api\/mcp-server\/build\/index\.js/ },
  ];

  const groups = new Map<string, { count: number; rss: number; cpu: number; instances: ProcessInstance[] }>();
  const seen = new Set<number>();

  for (const row of rows) {
    if (seen.has(row.pid) || !row.args) continue;
    for (const pattern of patterns) {
      if (pattern.match.test(row.args)) {
        seen.add(row.pid);
        const rss = row.mem + row.cmprs;
        const sess = findSessionAncestor(row.pid, byPid, sessionPids);
        const procName = extractAppName(row.args);
        const inst: ProcessInstance = {
          pid: row.pid, rss, rss_human: formatBytes(rss), cpu: row.cpu,
          ...(procName && procName !== pattern.name ? { name: procName } : {}),
          ...(sess ? { session_nickname: sess.nickname, session_id: sess.session_id } : {}),
        };
        const existing = groups.get(pattern.name);
        if (existing) {
          existing.count++;
          existing.rss += rss;
          existing.cpu += row.cpu;
          existing.instances.push(inst);
        } else {
          groups.set(pattern.name, { count: 1, rss, cpu: row.cpu, instances: [inst] });
        }
        break;
      }
    }
  }

  const rough: ProcessGroup[] = Array.from(groups.entries())
    .map(([name, g]) => ({
      name, count: g.count, rss: g.rss, rss_human: formatBytes(g.rss),
      cpu: Math.round(g.cpu * 10) / 10,
      instances: g.instances.sort((a, b) => b.rss - a.rss),
    }))
    .sort((a, b) => b.rss - a.rss);
  const processes = await refineWithPhysFootprint(rough, 20);
  const total_rss = processes.reduce((sum, p) => sum + p.rss, 0);
  return { processes, total_rss, total_rss_human: formatBytes(total_rss) };
}

function extractAppName(comm: string): string {
  // macOS .app bundle: /Applications/Google Chrome.app/... → "Google Chrome"
  const appMatch = comm.match(/\/([^/]+)\.app\//);
  if (appMatch) return appMatch[1];

  // Binary name from path: /opt/homebrew/.../node → "node"
  const parts = comm.split('/');
  return parts[parts.length - 1] || comm;
}

// Parse a top memory value like "234M", "1.2G", "832K", "45B", "500M+" into bytes.
function parseTopMem(value: string): number {
  const m = value.match(/^([\d.]+)([BKMGT]?)[+-]?$/i);
  if (!m) return 0;
  const mult: Record<string, number> = {
    '': 1, B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4,
  };
  return Math.round(parseFloat(m[1]) * (mult[m[2].toUpperCase()] || 1));
}

// Module-level cache of phys_footprint bytes per PID. `vmmap` runs 0.5-2s per PID,
// so caching avoids re-paying that cost on back-to-back stats requests.
const footprintCache = new Map<number, { bytes: number; ts: number }>();
const FOOTPRINT_CACHE_TTL_MS = 30_000;

function pruneFootprintCache(aliveRows: ProcessRow[]): void {
  const alive = new Set(aliveRows.map((r) => r.pid));
  for (const pid of footprintCache.keys()) {
    if (!alive.has(pid)) footprintCache.delete(pid);
  }
}

// Return phys_footprint bytes for a single PID, hitting the shared TTL cache
// first. Exported so other routes (e.g., session detail) can show live memory
// for a specific process without duplicating the vmmap + cache logic.
export async function getPhysFootprint(pid: number): Promise<number | null> {
  const cached = footprintCache.get(pid);
  if (cached && Date.now() - cached.ts < FOOTPRINT_CACHE_TTL_MS) return cached.bytes;
  const bytes = await fetchFootprint(pid);
  if (bytes != null) footprintCache.set(pid, { bytes, ts: Date.now() });
  return bytes;
}

async function fetchFootprint(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('vmmap', ['--summary', String(pid)], { timeout: 3000 });
    const m = stdout.match(/^\s*Physical footprint:\s+([\d.]+[BKMGT]?)\s*$/m);
    return m ? parseTopMem(m[1]) : null;
  } catch {
    return null;
  }
}

// Run `vmmap --summary` on the top N PIDs (with caching) and replace their rough
// mem+cmprs estimate with the actual phys_footprint. Phys_footprint is what macOS
// jetsam/memory-pressure uses (and what the "Force Quit Applications" dialog
// reflects) — it includes resident, compressed, AND swapped-out dirty pages that
// top's MEM+CMPRS misses. Limited to top N because each vmmap call is expensive.
async function refineWithPhysFootprint<T extends ProcessGroup>(apps: T[], topN: number): Promise<T[]> {
  const allInstances = apps.flatMap((a) => a.instances.map((i) => ({ pid: i.pid, rss: i.rss })));
  const topPids = allInstances.sort((a, b) => b.rss - a.rss).slice(0, topN).map((i) => i.pid);

  const now = Date.now();
  const refined = new Map<number, number>();
  const toFetch: number[] = [];
  for (const pid of topPids) {
    const cached = footprintCache.get(pid);
    if (cached && now - cached.ts < FOOTPRINT_CACHE_TTL_MS) {
      refined.set(pid, cached.bytes);
    } else {
      toFetch.push(pid);
    }
  }

  await Promise.all(
    toFetch.map(async (pid) => {
      const bytes = await fetchFootprint(pid);
      if (bytes != null) {
        refined.set(pid, bytes);
        footprintCache.set(pid, { bytes, ts: now });
      }
    })
  );

  if (refined.size === 0) return apps;

  return apps
    .map((app) => {
      const instances = app.instances.map((inst) => {
        const r = refined.get(inst.pid);
        return r != null ? { ...inst, rss: r, rss_human: formatBytes(r) } : inst;
      });
      const rss = instances.reduce((sum, i) => sum + i.rss, 0);
      return {
        ...app,
        rss,
        rss_human: formatBytes(rss),
        cpu: app.cpu,
        instances: instances.sort((a, b) => b.rss - a.rss),
      };
    })
    .sort((a, b) => b.rss - a.rss);
}

async function getSystemProcesses(
  rows: ProcessRow[],
  sessionPids: Map<number, SessionPidInfo>
): Promise<{ apps: ProcessGroup[]; total_rss: number; total_rss_human: string }> {
  const byPid = new Map<number, ProcessRow>();
  for (const row of rows) byPid.set(row.pid, row);

  const groups = new Map<string, { count: number; rss: number; cpu: number; instances: ProcessInstance[] }>();

  for (const row of rows) {
    const rss = row.mem + row.cmprs;
    if (rss === 0) continue;

    // Attribute the process to its outermost GUI app ancestor so iTerm tabs
    // (login → bash → claude/node) roll up under "iTerm", same as Chrome
    // helpers roll up under "Google Chrome". No .app ancestor → standalone.
    const rootApp = findRootAppName(row.pid, byPid);
    const procName = extractAppName(row.args);
    const name = rootApp || procName || `pid ${row.pid}`;

    const sess = findSessionAncestor(row.pid, byPid, sessionPids);
    const inst: ProcessInstance = {
      pid: row.pid, rss, rss_human: formatBytes(rss), cpu: row.cpu,
      ...(procName && procName !== name ? { name: procName } : {}),
      ...(sess ? { session_nickname: sess.nickname, session_id: sess.session_id } : {}),
    };

    const existing = groups.get(name);
    if (existing) {
      existing.count++;
      existing.rss += rss;
      existing.cpu += row.cpu;
      existing.instances.push(inst);
    } else {
      groups.set(name, { count: 1, rss, cpu: row.cpu, instances: [inst] });
    }
  }

  const rough: ProcessGroup[] = Array.from(groups.entries())
    .map(([name, g]) => ({
      name,
      count: g.count,
      rss: g.rss,
      rss_human: formatBytes(g.rss),
      cpu: Math.round(g.cpu * 10) / 10,
      instances: g.instances.sort((a, b) => b.rss - a.rss),
    }))
    .sort((a, b) => b.rss - a.rss)
    .slice(0, 25); // top 25

  // Refine the top 12 PIDs with vmmap to pick up swapped-out pages.
  const apps = await refineWithPhysFootprint(rough, 12);
  const total_rss = apps.reduce((sum, a) => sum + a.rss, 0);
  return { apps, total_rss, total_rss_human: formatBytes(total_rss) };
}

interface StatsQuery {
  project?: string;
  since?: string;
  until?: string;
}

async function resolveProjectId(identifier: string): Promise<string | null> {
  // Try UUID first
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier)) {
    const row = await querySingle<{ id: string }>('SELECT id FROM projects WHERE id = $1', [identifier]);
    return row?.id || null;
  }
  // Try handle
  const row = await querySingle<{ id: string }>('SELECT id FROM projects WHERE handle = $1', [identifier.toLowerCase()]);
  if (row) return row.id;
  // Try name
  const byName = await querySingle<{ id: string }>('SELECT id FROM projects WHERE LOWER(name) = LOWER($1)', [identifier]);
  return byName?.id || null;
}

interface ResolvedFilters {
  projectId: string | null;
  since?: string;
  until?: string;
  memoryWhere: string;
  memoryAnd: string;
  memoryParams: (string | Date)[];
}

async function buildFilters(query: StatsQuery): Promise<ResolvedFilters> {
  const { project, since, until } = query;
  let projectId: string | null = null;
  if (project) {
    projectId = await resolveProjectId(project);
  }

  const memoryFilters: string[] = [];
  const memoryParams: (string | Date)[] = [];
  let paramIdx = 1;

  if (projectId) {
    memoryFilters.push(`m.project_id = $${paramIdx}`);
    memoryParams.push(projectId);
    paramIdx++;
  }
  if (since) {
    memoryFilters.push(`m.created_at >= $${paramIdx}`);
    memoryParams.push(since);
    paramIdx++;
  }
  if (until) {
    memoryFilters.push(`m.created_at <= $${paramIdx}`);
    memoryParams.push(until);
    paramIdx++;
  }

  return {
    projectId,
    since,
    until,
    memoryWhere: memoryFilters.length > 0 ? `WHERE ${memoryFilters.join(' AND ')}` : '',
    memoryAnd: memoryFilters.length > 0 ? `AND ${memoryFilters.join(' AND ')}` : '',
    memoryParams,
  };
}

async function gatherOverview(f: ResolvedFilters) {
  const { projectId, since, until, memoryWhere, memoryAnd, memoryParams } = f;

  const [
    memoryCounts,
    byType,
    projectTotal,
    byProject,
    tagTotal,
    topTags,
    relationTotal,
    byRelationType,
    fileStats,
    dbSize,
    timeRange,
    staleTodos,
    orphanCount,
    connectedCount,
    pendingDecisions,
  ] = await Promise.all([
    querySingle<{ count: string }>(
      `SELECT COUNT(*) AS count FROM memories m ${memoryWhere}`,
      memoryParams
    ),
    query<{ type: string; count: string }>(
      `SELECT mt.name AS type, COUNT(m.id)::text AS count
       FROM memory_types mt
       LEFT JOIN memories m ON m.memory_type_id = mt.id ${memoryAnd}
       GROUP BY mt.name
       ORDER BY COUNT(m.id) DESC`,
      memoryParams
    ),
    querySingle<{ count: string }>('SELECT COUNT(*) AS count FROM projects'),
    query<{ id: string; handle: string; name: string; count: string }>(
      `SELECT p.id::text, p.handle, p.display_name AS name, COUNT(m.id)::text AS count
       FROM projects p
       LEFT JOIN memories m ON m.project_id = p.id ${memoryAnd}
       GROUP BY p.id, p.handle, p.display_name
       ORDER BY COUNT(m.id) DESC`,
      memoryParams
    ),
    querySingle<{ count: string }>(
      projectId
        ? `SELECT COUNT(DISTINCT t.id)::text AS count FROM tags t JOIN memory_tags mt ON mt.tag_id = t.id JOIN memories m ON m.id = mt.memory_id ${memoryWhere}`
        : 'SELECT COUNT(*) AS count FROM tags',
      projectId ? memoryParams : []
    ),
    query<{ name: string; count: string }>(
      `SELECT t.name, COUNT(mt.memory_id)::text AS count
       FROM tags t
       JOIN memory_tags mt ON mt.tag_id = t.id
       ${projectId || since || until ? 'JOIN memories m ON m.id = mt.memory_id' : ''}
       ${projectId || since || until ? memoryWhere.replace(/\bm\./g, 'm.') : ''}
       GROUP BY t.id, t.name
       ORDER BY COUNT(mt.memory_id) DESC
       LIMIT 10`,
      projectId || since || until ? memoryParams : []
    ),
    querySingle<{ count: string }>(
      projectId || since || until
        ? `SELECT COUNT(*)::text AS count FROM memory_relations mr
           JOIN memories m ON m.id = mr.source_memory_id ${memoryAnd}`
        : 'SELECT COUNT(*) AS count FROM memory_relations',
      projectId || since || until ? memoryParams : []
    ),
    query<{ type: string; count: string }>(
      projectId || since || until
        ? `SELECT mr.relation_type AS type, COUNT(*)::text AS count
           FROM memory_relations mr
           JOIN memories m ON m.id = mr.source_memory_id ${memoryAnd}
           GROUP BY mr.relation_type
           ORDER BY COUNT(*) DESC`
        : `SELECT relation_type AS type, COUNT(*)::text AS count
           FROM memory_relations
           GROUP BY relation_type
           ORDER BY COUNT(*) DESC`,
      projectId || since || until ? memoryParams : []
    ),
    querySingle<{ count: string; total_size: string }>(
      projectId
        ? `SELECT COUNT(*)::text AS count, COALESCE(SUM(size), 0)::text AS total_size FROM files WHERE project_id = $1`
        : 'SELECT COUNT(*)::text AS count, COALESCE(SUM(size), 0)::text AS total_size FROM files',
      projectId ? [projectId] : []
    ),
    querySingle<{ size: string }>(
      'SELECT pg_database_size(current_database())::text AS size'
    ),
    querySingle<{ oldest: string | null; newest: string | null }>(
      `SELECT MIN(m.created_at) AS oldest, MAX(m.created_at) AS newest FROM memories m ${memoryWhere}`,
      memoryParams
    ),
    // Health: stale assistant-todos (open > 30 days)
    querySingle<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memories m
       JOIN memory_types mt ON m.memory_type_id = mt.id
       JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE mt.name = 'assistant-todo'
         AND mts.status_value = 'open'
         AND m.created_at < NOW() - INTERVAL '30 days'
         ${projectId ? `AND m.project_id = $${1}` : ''}`,
      projectId ? [projectId] : []
    ),
    // Health: orphan memories (no relations)
    querySingle<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memories m
       WHERE NOT EXISTS (
         SELECT 1 FROM memory_relations mr
         WHERE mr.source_memory_id = m.id OR mr.target_memory_id = m.id
       ) ${projectId ? `AND m.project_id = $1` : ''}`,
      projectId ? [projectId] : []
    ),
    // Health: memories with at least one relation
    querySingle<{ count: string }>(
      `SELECT COUNT(DISTINCT m.id)::text AS count FROM memories m
       JOIN memory_relations mr ON mr.source_memory_id = m.id OR mr.target_memory_id = m.id
       ${projectId ? `WHERE m.project_id = $1` : ''}`,
      projectId ? [projectId] : []
    ),
    // Health: pending decisions (proposed status)
    querySingle<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memories m
       JOIN memory_types mt ON m.memory_type_id = mt.id
       JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE mt.name = 'decision'
         AND mts.status_value = 'proposed'
         ${projectId ? `AND m.project_id = $1` : ''}`,
      projectId ? [projectId] : []
    ),
  ]);

  const dbSizeBytes = parseInt(dbSize?.size || '0', 10);
  const totalMemories = parseInt(memoryCounts?.count || '0', 10);

  return {
    memories: {
      total: totalMemories,
      by_type: byType.map((r) => ({ type: r.type, count: parseInt(r.count, 10) })),
      by_project: byProject.map((r) => ({
        id: r.id,
        handle: r.handle,
        name: r.name,
        count: parseInt(r.count, 10),
      })),
      oldest: timeRange?.oldest || null,
      newest: timeRange?.newest || null,
    },
    projects: {
      total: parseInt(projectTotal?.count || '0', 10),
    },
    tags: {
      total: parseInt(tagTotal?.count || '0', 10),
      top: topTags.map((r) => ({ name: r.name, count: parseInt(r.count, 10) })),
    },
    relations: {
      total: parseInt(relationTotal?.count || '0', 10),
      by_type: byRelationType.map((r) => ({ type: r.type, count: parseInt(r.count, 10) })),
    },
    files: {
      total: parseInt(fileStats?.count || '0', 10),
      total_size: parseInt(fileStats?.total_size || '0', 10),
    },
    database: {
      size: dbSizeBytes,
      size_human: formatBytes(dbSizeBytes),
    },
    health: {
      stale_todos: parseInt(staleTodos?.count || '0', 10),
      orphan_count: parseInt(orphanCount?.count || '0', 10),
      connected_count: parseInt(connectedCount?.count || '0', 10),
      pending_decisions: parseInt(pendingDecisions?.count || '0', 10),
      total_memories: totalMemories,
    },
  };
}

async function gatherMemoryAnalysis(f: ResolvedFilters) {
  const { projectId } = f;

  const [dailyCounts, statusBreakdownRows] = await Promise.all([
    // Memory Analysis: daily creation counts (last 270 days for ~38 weeks)
    query<{ date: string; count: string }>(
      `SELECT m.created_at::date::text AS date, COUNT(*)::text AS count
       FROM memories m
       WHERE m.created_at >= NOW() - INTERVAL '270 days'
         ${projectId ? `AND m.project_id = $1` : ''}
       GROUP BY m.created_at::date
       ORDER BY m.created_at::date`,
      projectId ? [projectId] : []
    ),
    // Memory Analysis: status breakdown for key types
    query<{ type: string; status: string; count: string }>(
      `SELECT mt.name AS type, mts.status_value AS status, COUNT(m.id)::text AS count
       FROM memories m
       JOIN memory_types mt ON m.memory_type_id = mt.id
       JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE mt.name IN ('assistant-todo', 'user-todo', 'decision', 'pattern', 'context', 'assistant-rule')
         ${projectId ? `AND m.project_id = $1` : ''}
       GROUP BY mt.name, mts.status_value, mts.sort_order
       ORDER BY mt.name, mts.sort_order`,
      projectId ? [projectId] : []
    ),
  ]);

  const grouped: Record<string, { status: string; count: number }[]> = {};
  for (const row of statusBreakdownRows) {
    if (!grouped[row.type]) grouped[row.type] = [];
    grouped[row.type].push({ status: row.status, count: parseInt(row.count, 10) });
  }

  return {
    daily_counts: dailyCounts.map((r) => ({ date: r.date, count: parseInt(r.count, 10) })),
    status_breakdown: Object.entries(grouped).map(([type, statuses]) => ({
      type,
      total: statuses.reduce((s, r) => s + r.count, 0),
      statuses,
    })),
  };
}

async function gatherSystem() {
  const [rows, sessionPids] = await Promise.all([
    gatherProcessRows().catch(() => [] as ProcessRow[]),
    getActiveSessionPidMap(),
  ]);
  pruneFootprintCache(rows);
  const [processes, system_processes] = await Promise.all([
    getKhefProcesses(rows, sessionPids).catch(() => ({ processes: [] as ProcessGroup[], total_rss: 0, total_rss_human: '0 B' })),
    getSystemProcesses(rows, sessionPids).catch(() => ({ apps: [] as ProcessGroup[], total_rss: 0, total_rss_human: '0 B' })),
  ]);
  return { processes, system_processes };
}

const statsRoutes: FastifyPluginAsync = async (fastify) => {
  // Aggregate: everything in one response. Kept for MCP (`get_stats`) and
  // stats.test.ts. New UI code uses the per-tab sub-routes below.
  fastify.get<{ Querystring: StatsQuery }>('/', async (request) => {
    const filters = await buildFilters(request.query);
    const [overview, memory_analysis, claude_usage, system] = await Promise.all([
      gatherOverview(filters),
      gatherMemoryAnalysis(filters),
      gatherUsage(filters),
      gatherSystem(),
    ]);
    return {
      ...overview,
      memory_analysis,
      claude_usage,
      ...system,
    };
  });

  fastify.get<{ Querystring: StatsQuery }>('/overview', async (request) => {
    const filters = await buildFilters(request.query);
    return gatherOverview(filters);
  });

  fastify.get<{ Querystring: StatsQuery }>('/memory', async (request) => {
    const filters = await buildFilters(request.query);
    return gatherMemoryAnalysis(filters);
  });

  fastify.get<{ Querystring: StatsQuery }>('/usage', async (request) => {
    const filters = await buildFilters(request.query);
    return gatherUsage(filters);
  });

  fastify.get('/system', async () => {
    return gatherSystem();
  });
};

// ── Claude Usage ─────────────────────────────────────────────────────

// Model pricing per million tokens
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
  'claude-opus-4-7': { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
  'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
  'claude-opus-4-0-20250514': { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
  'claude-sonnet-4-5-20250514': { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
  'claude-sonnet-4-0-20250514': { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4, cacheRead: 0.08, cacheCreate: 1 },
};

function estimateCost(model: string | null, input: number, output: number, cacheRead: number, cacheCreate: number): number {
  // Find matching pricing (prefix match for model variants)
  let pricing = model ? MODEL_PRICING[model] : null;
  if (!pricing && model) {
    // Try prefix match: claude-opus-4 → first opus entry
    for (const [key, val] of Object.entries(MODEL_PRICING)) {
      if (model.startsWith(key.split('-').slice(0, 3).join('-'))) {
        pricing = val;
        break;
      }
    }
  }
  if (!pricing) {
    // Default to Sonnet pricing as a reasonable middle ground
    pricing = { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 };
  }
  const perM = 1_000_000;
  return (input / perM) * pricing.input
    + (output / perM) * pricing.output
    + (cacheRead / perM) * pricing.cacheRead
    + (cacheCreate / perM) * pricing.cacheCreate;
}

async function gatherUsage(f: ResolvedFilters) {
  const { projectId, since, until } = f;
  const filters: string[] = [];
  const params: (string | Date)[] = [];
  let idx = 1;

  if (projectId) {
    filters.push(`s.project_id = $${idx}`);
    params.push(projectId);
    idx++;
  }
  if (since) {
    filters.push(`s.started_at >= $${idx}`);
    params.push(since);
    idx++;
  }
  if (until) {
    filters.push(`s.started_at <= $${idx}`);
    params.push(until);
    idx++;
  }

  // Only count sessions that have usage data
  const usageFilter = filters.length > 0
    ? `WHERE (s.total_input_tokens > 0 OR s.total_output_tokens > 0) AND ${filters.join(' AND ')}`
    : 'WHERE (s.total_input_tokens > 0 OR s.total_output_tokens > 0)';

  const [totals, byModel, byProject, weeklyUsage, recentSessions] = await Promise.all([
    // Totals
    querySingle<{
      total_sessions: string;
      total_input: string;
      total_output: string;
      total_cache_creation: string;
      total_cache_read: string;
    }>(`SELECT
        COUNT(*)::text AS total_sessions,
        COALESCE(SUM(total_input_tokens), 0)::text AS total_input,
        COALESCE(SUM(total_output_tokens), 0)::text AS total_output,
        COALESCE(SUM(total_cache_creation_tokens), 0)::text AS total_cache_creation,
        COALESCE(SUM(total_cache_read_tokens), 0)::text AS total_cache_read
      FROM sessions s
      ${usageFilter}`, params),

    // By model (only sessions with usage data)
    query<{ model: string; session_count: string; total_tokens: string;
      total_input: string; total_output: string; total_cache_read: string; total_cache_creation: string }>(`
      SELECT
        COALESCE(s.model, 'unknown') AS model,
        COUNT(*)::text AS session_count,
        (COALESCE(SUM(s.total_input_tokens), 0) + COALESCE(SUM(s.total_output_tokens), 0))::text AS total_tokens,
        COALESCE(SUM(s.total_input_tokens), 0)::text AS total_input,
        COALESCE(SUM(s.total_output_tokens), 0)::text AS total_output,
        COALESCE(SUM(s.total_cache_read_tokens), 0)::text AS total_cache_read,
        COALESCE(SUM(s.total_cache_creation_tokens), 0)::text AS total_cache_creation
      FROM sessions s
      ${usageFilter}
      GROUP BY s.model
      ORDER BY SUM(s.total_input_tokens) + SUM(s.total_output_tokens) DESC`, params),

    // By project
    query<{ project_id: string | null; project_handle: string; project_name: string; session_count: string; total_tokens: string;
      total_input: string; total_output: string; total_cache_read: string; total_cache_creation: string }>(`
      SELECT
        p.id::text AS project_id,
        COALESCE(p.handle, 'unlinked') AS project_handle,
        COALESCE(p.display_name, p.name, 'Unlinked') AS project_name,
        COUNT(*)::text AS session_count,
        (COALESCE(SUM(s.total_input_tokens), 0) + COALESCE(SUM(s.total_output_tokens), 0))::text AS total_tokens,
        COALESCE(SUM(s.total_input_tokens), 0)::text AS total_input,
        COALESCE(SUM(s.total_output_tokens), 0)::text AS total_output,
        COALESCE(SUM(s.total_cache_read_tokens), 0)::text AS total_cache_read,
        COALESCE(SUM(s.total_cache_creation_tokens), 0)::text AS total_cache_creation
      FROM sessions s
      LEFT JOIN projects p ON s.project_id = p.id
      ${usageFilter}
      GROUP BY p.id, p.handle, p.display_name, p.name
      ORDER BY SUM(s.total_input_tokens) + SUM(s.total_output_tokens) DESC
      LIMIT 10`, params),

    // Weekly usage (last 12 weeks)
    query<{ week: string; input_tokens: string; output_tokens: string; cache_read_tokens: string }>(`
      SELECT
        date_trunc('week', s.started_at)::date::text AS week,
        COALESCE(SUM(s.total_input_tokens), 0)::text AS input_tokens,
        COALESCE(SUM(s.total_output_tokens), 0)::text AS output_tokens,
        COALESCE(SUM(s.total_cache_read_tokens), 0)::text AS cache_read_tokens
      FROM sessions s
      ${usageFilter}
        AND s.started_at >= NOW() - INTERVAL '12 weeks'
      GROUP BY date_trunc('week', s.started_at)
      ORDER BY week`, params),

    // Recent sessions
    query<{
      nickname: string | null; project_handle: string | null; project_name: string | null;
      model: string | null; message_count: string; total_input: string; total_output: string;
      context_window_tokens: string | null;
      started_at: string | null; ended_at: string | null;
    }>(`
      SELECT
        s.nickname,
        p.handle AS project_handle,
        COALESCE(p.display_name, p.name) AS project_name,
        s.model,
        COALESCE(s.message_count, 0)::text AS message_count,
        COALESCE(s.total_input_tokens, 0)::text AS total_input,
        COALESCE(s.total_output_tokens, 0)::text AS total_output,
        s.context_window_tokens::text AS context_window_tokens,
        s.started_at::text,
        s.ended_at::text
      FROM sessions s
      LEFT JOIN projects p ON s.project_id = p.id
      ${usageFilter}
      ORDER BY s.started_at DESC
      LIMIT 10`, params),
  ]);

  const totalInput = parseInt(totals?.total_input || '0', 10);
  const totalOutput = parseInt(totals?.total_output || '0', 10);
  const totalCacheCreation = parseInt(totals?.total_cache_creation || '0', 10);
  const totalCacheRead = parseInt(totals?.total_cache_read || '0', 10);

  const cacheHitRate = (totalCacheRead + totalCacheCreation) > 0
    ? totalCacheRead / (totalCacheRead + totalCacheCreation)
    : 0;

  return {
    total_sessions: parseInt(totals?.total_sessions || '0', 10),
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cache_creation_tokens: totalCacheCreation,
    total_cache_read_tokens: totalCacheRead,
    cache_hit_rate: Math.round(cacheHitRate * 100) / 100,
    estimated_cost: Math.round(byModel.reduce((sum, r) => {
      return sum + estimateCost(r.model, parseInt(r.total_input, 10), parseInt(r.total_output, 10),
        parseInt(r.total_cache_read, 10), parseInt(r.total_cache_creation, 10));
    }, 0) * 100) / 100,
    by_model: byModel.map((r) => ({
      model: r.model,
      session_count: parseInt(r.session_count, 10),
      total_tokens: parseInt(r.total_tokens, 10),
    })),
    by_project: byProject.map((r) => {
      const inp = parseInt(r.total_input, 10);
      const out = parseInt(r.total_output, 10);
      const cr = parseInt(r.total_cache_read, 10);
      const cc = parseInt(r.total_cache_creation, 10);
      return {
        id: r.project_id,
        project: r.project_handle,
        name: r.project_name,
        session_count: parseInt(r.session_count, 10),
        total_tokens: parseInt(r.total_tokens, 10),
        estimated_cost: Math.round(estimateCost(null, inp, out, cr, cc) * 100) / 100,
      };
    }),
    weekly_usage: weeklyUsage.map((r) => ({
      week: r.week,
      input_tokens: parseInt(r.input_tokens, 10),
      output_tokens: parseInt(r.output_tokens, 10),
      cache_read_tokens: parseInt(r.cache_read_tokens, 10),
    })),
    recent_sessions: recentSessions.map((r) => ({
      nickname: r.nickname,
      project: r.project_handle,
      project_name: r.project_name,
      model: r.model,
      messages: parseInt(r.message_count, 10),
      total_input: parseInt(r.total_input, 10),
      total_output: parseInt(r.total_output, 10),
      context_window_tokens: r.context_window_tokens ? parseInt(r.context_window_tokens, 10) : null,
      started_at: r.started_at,
      ended_at: r.ended_at,
    })),
  };
}

export default statsRoutes;
