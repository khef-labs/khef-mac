/**
 * Raw JSONL grep across Claude Code / Codex session transcripts.
 *
 * Bypasses the indexed session_chunks table (which strips most tool_result content)
 * by running ripgrep directly against session JSONL files on disk. Each match line is
 * parsed as JSON and enriched with role / tool / timestamp so callers see meaningful
 * context instead of raw JSON blobs.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { query, querySingle } from '../db/client';
import { SESSION_PATHS, findClaudeSessions, findCodexSessions } from './session-sync';
import { resolveProjectDir } from './sessions';
import { workerLogger } from '../lib/logger';

const log = workerLogger.child({ component: 'session-grep' });

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const DEFAULT_CONTEXT_LINES = 2;
const MAX_CONTEXT_LINES = 10;
const MAX_FILES_PER_SCAN = 500;
const MAX_PATTERN_LENGTH = 1000;
const RIPGREP_TIMEOUT_MS = 10_000;
const EXCERPT_RADIUS = 140; // chars around the match in the enriched excerpt

export interface GrepOptions {
  pattern: string;
  is_regex?: boolean;
  case_sensitive?: boolean;
  session_id?: string;
  nickname?: string;
  project_dir?: string;
  assistant_handle?: string;
  limit?: number;
  context_lines?: number;
}

export interface EnrichedMatch {
  file_path: string;
  line_number: number;
  match_text: string;
  role: 'user' | 'assistant' | null;
  entry_type: string | null;
  tool_name: string | null;
  timestamp: string | null;
  excerpt: string;
  context_before: string[];
  context_after: string[];
  raw_truncated?: boolean;
}

export interface GrepResult {
  matches: EnrichedMatch[];
  files_scanned: number;
  scope: string;
  truncated: boolean;
  text: string;
}

// ── Scope resolution ────────────────────────────────────────────────

async function resolveFiles(opts: GrepOptions): Promise<{ files: string[]; scope: string }> {
  if (opts.session_id) {
    const row = await querySingle<{ file_path: string }>(
      'SELECT file_path FROM sessions WHERE session_id = $1 AND file_path IS NOT NULL LIMIT 1',
      [opts.session_id]
    );
    if (!row) throw new Error(`Session not found: ${opts.session_id}`);
    if (!fs.existsSync(row.file_path)) throw new Error(`Session file missing on disk: ${row.file_path}`);
    return { files: [row.file_path], scope: `session_id=${opts.session_id}` };
  }

  if (opts.nickname) {
    const rows = await query<{ file_path: string }>(
      `SELECT file_path FROM sessions WHERE nickname = $1 AND file_path IS NOT NULL ORDER BY started_at ASC NULLS LAST`,
      [opts.nickname.toLowerCase().trim()]
    );
    const files = rows.map(r => r.file_path).filter(p => fs.existsSync(p));
    if (files.length === 0) throw new Error(`No on-disk session files for nickname: ${opts.nickname}`);
    return { files, scope: `nickname=${opts.nickname} (${files.length} files)` };
  }

  if (opts.project_dir) {
    const handle = opts.assistant_handle || 'claude-code';
    const config = SESSION_PATHS[handle];
    if (!config) throw new Error(`Unknown assistant_handle: ${handle}`);

    const resolved = await resolveProjectDir(opts.project_dir);
    const projectPath = path.join(config.basePath, resolved);
    if (!fs.existsSync(projectPath)) {
      throw new Error(`Project directory not found: ${projectPath}`);
    }

    const files = config.structure === 'project'
      ? findClaudeSessions(config.basePath).filter(f => f.startsWith(projectPath + path.sep) || f.startsWith(projectPath + '/'))
      : findCodexSessions(config.basePath);

    if (files.length === 0) {
      throw new Error(`No session files under ${projectPath}`);
    }
    return { files, scope: `project_dir=${opts.project_dir} assistant=${handle} (${files.length} files)` };
  }

  throw new Error('At least one scope filter required: session_id, nickname, or project_dir');
}

// ── Ripgrep runner ──────────────────────────────────────────────────

interface RgMatchEvent {
  type: 'match' | 'context' | 'begin' | 'end' | 'summary';
  data: any;
}

interface RawMatch {
  filePath: string;
  lineNumber: number;
  lineText: string;
  contextBefore: Array<{ lineNumber: number; text: string }>;
  contextAfter: Array<{ lineNumber: number; text: string }>;
}

async function runRipgrep(
  files: string[],
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean,
  contextLines: number,
  limit: number
): Promise<{ matches: RawMatch[]; truncated: boolean }> {
  const args: string[] = ['--json', '--no-heading', '--color=never'];
  args.push('-C', String(contextLines));
  args.push(`-m${limit}`); // max matches per file
  if (!caseSensitive) args.push('-i');
  if (isRegex) {
    args.push('-e', pattern);
  } else {
    args.push('-F', '-e', pattern);
  }
  args.push('--', ...files);

  return new Promise((resolve, reject) => {
    const matches: RawMatch[] = [];
    const byFile = new Map<string, RawMatch[]>();
    let currentFile: string | null = null;
    let buffer = '';
    let truncated = false;
    let stderr = '';

    const proc = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`ripgrep timed out after ${RIPGREP_TIMEOUT_MS}ms`));
    }, RIPGREP_TIMEOUT_MS);

    proc.stdout.setEncoding('utf-8');
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.trim()) continue;
        let evt: RgMatchEvent;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.type === 'begin') {
          currentFile = evt.data?.path?.text ?? null;
        } else if (evt.type === 'match' && currentFile) {
          if (matches.length >= limit) {
            truncated = true;
            continue;
          }
          const raw: RawMatch = {
            filePath: currentFile,
            lineNumber: evt.data.line_number,
            lineText: (evt.data.lines?.text ?? '').replace(/\n$/, ''),
            contextBefore: [],
            contextAfter: [],
          };
          matches.push(raw);
          const bucket = byFile.get(currentFile) ?? [];
          bucket.push(raw);
          byFile.set(currentFile, bucket);
        } else if (evt.type === 'context' && currentFile) {
          const ctxLine = {
            lineNumber: evt.data.line_number,
            text: (evt.data.lines?.text ?? '').replace(/\n$/, ''),
          };
          // Attach to nearest match in this file — ripgrep emits context adjacent to matches
          const bucket = byFile.get(currentFile);
          if (!bucket || bucket.length === 0) continue;
          const last = bucket[bucket.length - 1];
          if (ctxLine.lineNumber < last.lineNumber) {
            last.contextBefore.push(ctxLine);
          } else {
            last.contextAfter.push(ctxLine);
          }
        }
      }
    });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn rg: ${err.message}. Is ripgrep installed?`));
    });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && code !== 1) {
        // 0 = match, 1 = no match, >1 = error
        reject(new Error(`ripgrep exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve({ matches, truncated });
    });
  });
}

// ── Enricher ────────────────────────────────────────────────────────

interface EnrichedLine {
  role: 'user' | 'assistant' | null;
  entryType: string | null;
  toolName: string | null;
  timestamp: string | null;
  excerpt: string;
  rawTruncated: boolean;
}

function makeExcerpt(source: string, pattern: string, caseSensitive: boolean): string {
  const haystack = caseSensitive ? source : source.toLowerCase();
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const idx = haystack.indexOf(needle);
  if (idx === -1) {
    return source.length > EXCERPT_RADIUS * 2
      ? source.slice(0, EXCERPT_RADIUS * 2) + '…'
      : source;
  }
  const start = Math.max(0, idx - EXCERPT_RADIUS);
  const end = Math.min(source.length, idx + pattern.length + EXCERPT_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < source.length ? '…' : '';
  return prefix + source.slice(start, end) + suffix;
}

function findBlockContainingMatch(content: unknown, pattern: string, caseSensitive: boolean): { toolName: string | null; text: string } | null {
  if (!Array.isArray(content)) return null;
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const blockStr = JSON.stringify(block);
    const hay = caseSensitive ? blockStr : blockStr.toLowerCase();
    if (!hay.includes(needle)) continue;

    if (block.type === 'text' && typeof block.text === 'string') {
      return { toolName: null, text: block.text };
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      return { toolName: null, text: `[thinking] ${block.thinking}` };
    }
    if (block.type === 'tool_use') {
      const input = block.input ? JSON.stringify(block.input) : '';
      return { toolName: block.name ?? null, text: `[tool_use: ${block.name}] ${input}` };
    }
    if (block.type === 'tool_result') {
      let text = '';
      if (typeof block.content === 'string') {
        text = block.content;
      } else if (Array.isArray(block.content)) {
        text = block.content
          .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
          .map((c: any) => c.text)
          .join('\n');
      }
      return { toolName: null, text: `[tool_result] ${text}` };
    }
  }
  return null;
}

function enrichLine(lineText: string, pattern: string, caseSensitive: boolean): EnrichedLine {
  const fallback: EnrichedLine = {
    role: null,
    entryType: null,
    toolName: null,
    timestamp: null,
    excerpt: makeExcerpt(lineText, pattern, caseSensitive),
    rawTruncated: lineText.length > EXCERPT_RADIUS * 2,
  };

  let entry: any;
  try {
    entry = JSON.parse(lineText);
  } catch {
    return fallback;
  }

  const entryType: string | null = typeof entry.type === 'string' ? entry.type : null;
  const timestamp: string | null = typeof entry.timestamp === 'string' ? entry.timestamp : null;

  // Claude format: { type: "user"|"assistant", message: { content, role } }
  // Codex format: { type: "message", role, content }
  let role: 'user' | 'assistant' | null = null;
  if (entryType === 'user' || entryType === 'assistant') {
    role = entryType;
  } else if (entry.role === 'user' || entry.role === 'assistant') {
    role = entry.role;
  }

  const content = entry.message?.content ?? entry.content;

  // Try to find which block contains the match
  let toolName: string | null = null;
  let excerptSource = '';

  if (typeof content === 'string') {
    excerptSource = content;
  } else if (Array.isArray(content)) {
    const block = findBlockContainingMatch(content, pattern, caseSensitive);
    if (block) {
      toolName = block.toolName;
      excerptSource = block.text;
    } else {
      excerptSource = JSON.stringify(content);
    }
  } else {
    excerptSource = lineText;
  }

  // If the match isn't in the extracted text (could be in metadata), fall back to raw line
  const haystack = caseSensitive ? excerptSource : excerptSource.toLowerCase();
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  if (!haystack.includes(needle)) {
    excerptSource = lineText;
  }

  return {
    role,
    entryType,
    toolName,
    timestamp,
    excerpt: makeExcerpt(excerptSource, pattern, caseSensitive),
    rawTruncated: excerptSource.length > EXCERPT_RADIUS * 2,
  };
}

// ── Text formatter ──────────────────────────────────────────────────

function formatMatches(result: Omit<GrepResult, 'text'>, pattern: string): string {
  if (result.matches.length === 0) {
    return `No matches for "${pattern}" (scanned ${result.files_scanned} file(s), scope: ${result.scope})`;
  }

  const lines: string[] = [];
  lines.push(`Found ${result.matches.length} match(es)${result.truncated ? ' (truncated)' : ''} across ${result.files_scanned} file(s) for "${pattern}"`);
  lines.push(`Scope: ${result.scope}`);
  lines.push('');

  const byFile = new Map<string, EnrichedMatch[]>();
  for (const m of result.matches) {
    const bucket = byFile.get(m.file_path) ?? [];
    bucket.push(m);
    byFile.set(m.file_path, bucket);
  }

  for (const [file, matches] of byFile) {
    const basename = path.basename(file);
    lines.push(`## ${basename}`);
    lines.push(`  ${file}`);
    for (const m of matches) {
      const header: string[] = [`L${m.line_number}`];
      if (m.role) header.push(m.role);
      if (m.tool_name) header.push(`tool=${m.tool_name}`);
      if (m.timestamp) header.push(m.timestamp);
      lines.push(`  [${header.join(' | ')}]`);
      lines.push(`    ${m.excerpt.replace(/\n/g, ' ')}`);
      if (m.context_before.length || m.context_after.length) {
        // keep context subtle
        for (const c of m.context_before) lines.push(`    - L${c}: (context)`.trim());
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

// ── Public entry point ─────────────────────────────────────────────

export async function grepSessions(opts: GrepOptions): Promise<GrepResult> {
  if (!opts.pattern || !opts.pattern.trim()) {
    throw new Error('pattern is required');
  }
  if (opts.pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`pattern exceeds ${MAX_PATTERN_LENGTH} chars`);
  }

  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const contextLines = Math.min(Math.max(0, opts.context_lines ?? DEFAULT_CONTEXT_LINES), MAX_CONTEXT_LINES);
  const caseSensitive = opts.case_sensitive ?? false;
  const isRegex = opts.is_regex ?? false;

  const { files, scope } = await resolveFiles(opts);
  if (files.length > MAX_FILES_PER_SCAN) {
    throw new Error(`Scope resolves to ${files.length} files; max per scan is ${MAX_FILES_PER_SCAN}. Narrow with session_id, nickname, or project_dir.`);
  }

  const start = Date.now();
  const { matches: rawMatches, truncated } = await runRipgrep(
    files,
    opts.pattern,
    isRegex,
    caseSensitive,
    contextLines,
    limit
  );
  log.debug({ files: files.length, matches: rawMatches.length, ms: Date.now() - start }, 'ripgrep complete');

  const enriched: EnrichedMatch[] = rawMatches.map(r => {
    const enrichment = enrichLine(
      r.lineText,
      opts.pattern,
      caseSensitive
    );
    return {
      file_path: r.filePath,
      line_number: r.lineNumber,
      match_text: r.lineText.length > 500 ? r.lineText.slice(0, 500) + '…' : r.lineText,
      role: enrichment.role,
      entry_type: enrichment.entryType,
      tool_name: enrichment.toolName,
      timestamp: enrichment.timestamp,
      excerpt: enrichment.excerpt,
      context_before: r.contextBefore.map(c => `L${c.lineNumber}`),
      context_after: r.contextAfter.map(c => `L${c.lineNumber}`),
      raw_truncated: enrichment.rawTruncated,
    };
  });

  const partial: Omit<GrepResult, 'text'> = {
    matches: enriched,
    files_scanned: files.length,
    scope,
    truncated,
  };

  return { ...partial, text: formatMatches(partial, opts.pattern) };
}
