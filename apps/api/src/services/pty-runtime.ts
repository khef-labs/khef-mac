import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workerLogger } from '../lib/logger';

const log = workerLogger.child({ component: 'pty-runtime' });

export const SHELL = process.env.SHELL || '/bin/bash';

function getNodePtySpawnHelperPath(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const pkgJsonPath = require.resolve('node-pty/package.json');
    return path.join(path.dirname(pkgJsonPath), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  } catch (err) {
    log.warn({ err }, 'failed to resolve node-pty spawn-helper path');
    return null;
  }
}

/**
 * On macOS, node-pty launches a bundled `spawn-helper` binary first. If the
 * execute bit gets stripped during install, every PTY spawn fails with the
 * opaque "posix_spawnp failed." message, even for /bin/bash.
 */
export function ensureNodePtySpawnHelperExecutable(): string | null {
  const helperPath = getNodePtySpawnHelperPath();
  if (!helperPath) return null;

  try {
    fs.accessSync(helperPath, fs.constants.X_OK);
    return helperPath;
  } catch {
    // Fall through and try to repair the execute bit.
  }

  try {
    const stat = fs.statSync(helperPath);
    fs.chmodSync(helperPath, stat.mode | 0o111);
    fs.accessSync(helperPath, fs.constants.X_OK);
    log.info({ helperPath }, 'made node-pty spawn-helper executable');
    return helperPath;
  } catch (err) {
    log.error({ err, helperPath }, 'node-pty spawn-helper is not executable');
    return helperPath;
  }
}

/**
 * Discover the user's full PATH by running a login shell once at module load.
 * The dev:api process inherits PATH from whatever started it, which often
 * misses entries added by `~/.bash_profile` / `~/.zshrc` (interactive-only
 * rc files). Without this, `claude` may not resolve even though it works
 * in the user's terminal.
 */
function discoverShellPath(): string {
  try {
    const out = execSync(`${SHELL} -l -c 'echo $PATH'`, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch (err) {
    log.warn({ err }, 'failed to probe shell PATH; falling back to process.env.PATH');
  }
  return process.env.PATH || '';
}

const COMMON_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  path.join(os.homedir(), '.bun', 'bin'),
  path.join(os.homedir(), '.claude', 'local'),
  path.join(os.homedir(), '.claude', 'bin'),
];

function buildAugmentedPath(): string {
  const discovered = discoverShellPath();
  const segments = [...discovered.split(':').filter(Boolean), ...COMMON_BIN_DIRS];
  const seen = new Set<string>();
  return segments.filter((s) => (seen.has(s) ? false : (seen.add(s), true))).join(':');
}

export const AUGMENTED_PATH = buildAugmentedPath();
export const NODE_PTY_SPAWN_HELPER = ensureNodePtySpawnHelperExecutable();

export function getSpawnFailureMessage(err: any): string {
  if (process.platform === 'darwin' && NODE_PTY_SPAWN_HELPER) {
    try {
      fs.accessSync(NODE_PTY_SPAWN_HELPER, fs.constants.X_OK);
    } catch {
      return `node-pty spawn-helper is not executable: ${NODE_PTY_SPAWN_HELPER}`;
    }
  }
  return err?.message || 'spawn failed';
}

/**
 * Resolve a binary against the augmented PATH using `which` (subject to the
 * augmented PATH). Returns the absolute path or null.
 */
function resolveBin(bin: string): string | null {
  if (path.isAbsolute(bin)) {
    try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch { return null; }
  }
  try {
    const out = execSync(`which ${bin}`, {
      encoding: 'utf8',
      env: { ...process.env, PATH: AUGMENTED_PATH },
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function getClaudeBin(): string | null {
  const explicit = process.env.CLAUDE_BIN;
  if (explicit) return resolveBin(explicit);
  return resolveBin('claude');
}

export function getCodexBin(): string | null {
  const explicit = process.env.CODEX_BIN;
  if (explicit) return resolveBin(explicit);
  return resolveBin('codex');
}

export type PtyCommand = 'claude' | 'codex';

export function getCliBin(cmd: PtyCommand): string | null {
  return cmd === 'codex' ? getCodexBin() : getClaudeBin();
}

export function sanitizeCwd(input: string | undefined | null): string {
  if (!input) return os.homedir();
  const expanded = input.startsWith('~') ? input.replace(/^~/, os.homedir()) : input;
  try {
    const stat = fs.statSync(expanded);
    if (stat.isDirectory()) return expanded;
  } catch {
    // fall through
  }
  return os.homedir();
}

/**
 * Locate a Claude Code session JSONL by session UUID without needing to
 * decode the lossy `-Users-roger-...` encoding. Walks `~/.claude/projects/*`
 * looking for `<sessionId>.jsonl`.
 */
export function findSessionFile(sessionId: string, preferredFilePath?: string): string | null {
  if (preferredFilePath) {
    try {
      const normalized = path.resolve(preferredFilePath);
      if (normalized.endsWith(`${path.sep}${sessionId}.jsonl`) && fs.existsSync(normalized)) {
        return normalized;
      }
      log.warn({ sessionId, preferredFilePath }, 'findSessionFile: preferred file path did not match session id or was missing');
    } catch (err) {
      log.warn({ err, sessionId, preferredFilePath }, 'findSessionFile: failed to validate preferred file path');
    }
  }
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  try {
    const dirs = fs.readdirSync(projectsDir);
    for (const dir of dirs) {
      const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Scan up to ~64KB of a session JSONL looking for the first record that
 * carries a `cwd` field. The first line is often a summary / metadata
 * record without cwd; user/assistant entries always include it.
 */
export function readCwdFromJsonl(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.slice(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.cwd === 'string' && parsed.cwd.length > 0) {
          return parsed.cwd;
        }
      } catch {
        // partial trailing line — ignore and keep scanning
      }
    }
    return null;
  } catch (err) {
    log.warn({ err, filePath }, 'readCwdFromJsonl failed');
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Resolve the best cwd for a PTY spawn:
 *  1. Decode whatever the client sent (best-effort, lossy on dashes)
 *  2. If we have a resume id, prefer the cwd recorded in the JSONL
 *  3. Validate via sanitizeCwd; fall back to $HOME
 */
export function resolveCwd(rawCwd: string | undefined, resume: string | null, preferredFilePath?: string): { cwd: string; source: string } {
  if (resume) {
    const jsonl = findSessionFile(resume, preferredFilePath);
    if (!jsonl) {
      log.warn({ resume, preferredFilePath }, 'resolveCwd: session JSONL not found for resume id');
    } else {
      const fromJsonl = readCwdFromJsonl(jsonl);
      if (!fromJsonl) {
        log.warn({ resume, jsonl }, 'resolveCwd: JSONL had no cwd in first 64KB');
      } else {
        const sanitized = sanitizeCwd(fromJsonl);
        if (sanitized === fromJsonl) {
          log.info({ resume, cwd: sanitized }, 'resolveCwd: using cwd from jsonl');
          return { cwd: sanitized, source: 'jsonl' };
        } else {
          log.warn({ resume, fromJsonl, sanitized }, 'resolveCwd: jsonl cwd does not exist on this host');
        }
      }
    }
  }
  if (rawCwd) {
    const fromQuery = sanitizeCwd(rawCwd);
    if (fromQuery === rawCwd) {
      log.info({ cwd: fromQuery }, 'resolveCwd: using cwd from query');
      return { cwd: fromQuery, source: 'query' };
    } else {
      log.warn({ rawCwd, sanitized: fromQuery }, 'resolveCwd: query cwd did not validate');
    }
  }
  log.warn('resolveCwd: falling back to $HOME');
  return { cwd: os.homedir(), source: 'fallback-home' };
}

export function makeTerminalKey(opts: { cmd: PtyCommand; resume: string | null; fresh: boolean; preferredFilePath?: string; cwd: string }): string {
  const base = opts.resume
    ? opts.resume
    : opts.preferredFilePath
      ? path.resolve(opts.preferredFilePath)
      : opts.cwd;
  return `${opts.cmd}:${opts.fresh ? 'fresh' : 'resume'}:${base}`;
}

export const ptyRuntimeLogger = log;
