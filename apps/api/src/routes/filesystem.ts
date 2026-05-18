import { FastifyPluginAsync } from 'fastify';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'os';
import { execFile } from 'node:child_process';
import { computeLineDiff, applyContext } from '../services/diff';

// Extension → language mapping
const EXT_LANG_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.css': 'css',
  '.scss': 'css',
  '.html': 'html',
  '.htm': 'html',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'cpp',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.xml': 'xml',
  '.svg': 'xml',
  '.vue': 'html',
  '.svelte': 'html',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.env': 'shell',
  '.dockerfile': 'dockerfile',
  '.tf': 'hcl',
  '.lua': 'lua',
  '.r': 'r',
  '.csv': 'csv',
};

const IMAGE_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (EXT_LANG_MAP[ext]) return EXT_LANG_MAP[ext];
  const base = path.basename(filePath).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  if (base === 'cmakelists.txt') return 'cmake';
  return 'plain';
}

// Directories to skip when listing
const IGNORED_DIRS = new Set([
  'node_modules', '.hg', '.svn', '__pycache__',
  '.DS_Store', '.next', '.nuxt', 'dist', '.cache',
  '.turbo', '.parcel-cache', 'coverage',
]);

// Quick-open should avoid generated/output directories that create noisy matches.
const QUICK_OPEN_IGNORED_DIRS = new Set([
  ...IGNORED_DIRS,
  'build',
  'target',
  'out',
  '.vite',
  '.svelte-kit',
]);

// Additional directories to skip when the quick-open root is the user's home directory.
const HOME_QUICK_OPEN_IGNORED_DIRS = new Set([
  'Library',
  'Applications',
  'Movies',
  'Music',
  'Pictures',
  'Public',
]);

function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return filepath.replace('~', os.homedir());
  }
  return filepath;
}

/**
 * Validate an absolute path — reject relative traversal.
 */
function validatePath(rawPath: string): string {
  const expanded = expandTilde(rawPath);
  const resolved = path.resolve(expanded);

  // After resolving, the path must not differ from what we expect
  // (prevents ../ traversal after normalization)
  if (!path.isAbsolute(expanded) && !rawPath.startsWith('~')) {
    throw new Error('Path must be absolute');
  }

  return resolved;
}

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB default for text-ish files
const MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024; // 20MB for image preview payloads

const filesystemRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /completions — directory autocomplete for path input
  fastify.get<{
    Querystring: { prefix: string };
  }>('/completions', async (request, reply) => {
    const rawPrefix = request.query.prefix;
    if (!rawPrefix) {
      return reply.status(400).send({ error: 'prefix query parameter is required' });
    }

    let expanded: string;
    try {
      expanded = validatePath(rawPrefix);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    // If prefix ends with /, list directories inside it
    // Otherwise, list directories in parent that match the partial name
    let dirPath: string;
    let partial: string;

    if (rawPrefix.endsWith('/')) {
      dirPath = expanded;
      partial = '';
    } else {
      dirPath = path.dirname(expanded);
      partial = path.basename(expanded).toLowerCase();
    }

    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) {
        return { completions: [] };
      }
    } catch {
      return { completions: [] };
    }

    let items;
    try {
      items = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return { completions: [] };
    }

    const completions: { name: string; path: string }[] = [];
    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (item.name.startsWith('.') && !partial.startsWith('.')) continue;
      if (IGNORED_DIRS.has(item.name)) continue;
      if (partial && !item.name.toLowerCase().startsWith(partial)) continue;

      completions.push({
        name: item.name,
        path: path.join(dirPath, item.name),
      });

      if (completions.length >= 20) break;
    }

    completions.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return { completions };
  });

  // GET /tree — list directory contents
  fastify.get<{
    Querystring: { path: string; depth?: string; showHidden?: string; includeIgnored?: string };
  }>('/tree', async (request, reply) => {
    const rawPath = request.query.path;
    if (!rawPath) {
      return reply.status(400).send({ error: 'path query parameter is required' });
    }

    const depth = Math.min(Math.max(parseInt(request.query.depth || '1', 10), 1), 3);
    const showHidden = request.query.showHidden === 'true';
    const includeIgnored = request.query.includeIgnored === 'true';

    let dirPath: string;
    try {
      dirPath = validatePath(rawPath);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) {
        return reply.status(400).send({ error: 'Path is not a directory' });
      }
    } catch {
      return reply.status(404).send({ error: 'Directory not found' });
    }

    const entries = await readDir(dirPath, depth, showHidden, includeIgnored);
    return { path: dirPath, entries };
  });

  // GET /find — recursively list files under a root for quick-open
  fastify.get<{
    Querystring: { path: string; limit?: string; q?: string; showHidden?: string };
  }>('/find', async (request, reply) => {
    const rawPath = request.query.path;
    if (!rawPath) {
      return reply.status(400).send({ error: 'path query parameter is required' });
    }

    const parsedLimit = parseInt(request.query.limit || '5000', 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 10000)
      : 5000;

    let dirPath: string;
    try {
      dirPath = validatePath(rawPath);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) {
        return reply.status(400).send({ error: 'Path is not a directory' });
      }
    } catch {
      return reply.status(404).send({ error: 'Directory not found' });
    }

    const showHidden = request.query.showHidden === 'true';
    const files = await findFiles(dirPath, limit, request.query.q, showHidden);
    return { root: dirPath, files };
  });

  // GET /search — cross-file search via ripgrep
  fastify.get<{
    Querystring: { path: string; q: string; regex?: string; caseSensitive?: string; include?: string; limit?: string };
  }>('/search', async (request, reply) => {
    const rawPath = request.query.path;
    const query = request.query.q;
    if (!rawPath) return reply.status(400).send({ error: 'path query parameter is required' });
    if (!query) return reply.status(400).send({ error: 'q query parameter is required' });

    const useRegex = request.query.regex === 'true';
    const caseSensitive = request.query.caseSensitive === 'true';
    const include = request.query.include;
    const limit = Math.min(Math.max(parseInt(request.query.limit || '200', 10), 1), 1000);

    let searchPath: string;
    try {
      searchPath = validatePath(rawPath);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    try {
      const stat = await fs.stat(searchPath);
      if (!stat.isDirectory()) {
        return reply.status(400).send({ error: 'Path is not a directory' });
      }
    } catch {
      return reply.status(404).send({ error: 'Directory not found' });
    }

    const args: string[] = [
      '--json',
      '--max-count', '50', // max matches per file
      '--max-filesize', '1M',
    ];

    if (!caseSensitive) args.push('--ignore-case');
    if (!useRegex) args.push('--fixed-strings');
    if (include) {
      for (const glob of include.split(',')) {
        args.push('--glob', glob.trim());
      }
    }

    // Exclude common noise directories
    for (const dir of IGNORED_DIRS) {
      args.push('--glob', `!${dir}`);
    }
    args.push('--glob', '!.git');

    args.push('--', query, searchPath);

    try {
      const results = await runRipgrep(args, searchPath, limit);
      return results;
    } catch (err: any) {
      // rg exits with code 1 when no matches found — that's normal
      if (err.code === 1) {
        return { results: [], truncated: false };
      }
      return reply.status(500).send({ error: 'Search failed: ' + (err.message || 'unknown error') });
    }
  });

  // GET /read — read file contents
  fastify.get<{
    Querystring: { path: string; maxSize?: string };
  }>('/read', async (request, reply) => {
    const rawPath = request.query.path;
    if (!rawPath) {
      return reply.status(400).send({ error: 'path query parameter is required' });
    }

    const maxSize = parseInt(request.query.maxSize || String(MAX_FILE_SIZE), 10);

    let filePath: string;
    try {
      filePath = validatePath(rawPath);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return reply.status(404).send({ error: 'File not found' });
    }

    if (!stat.isFile()) {
      return reply.status(400).send({ error: 'Path is not a file' });
    }

    const ext = path.extname(filePath).toLowerCase();
    const imageMimeType = IMAGE_MIME_MAP[ext];
    const effectiveMaxSize = imageMimeType ? Math.max(maxSize, MAX_IMAGE_FILE_SIZE) : maxSize;

    if (stat.size > effectiveMaxSize) {
      return reply.status(413).send({
        error: `File too large (${stat.size} bytes). Max: ${effectiveMaxSize} bytes`,
      });
    }

    const language = detectLanguage(filePath);

    if (imageMimeType) {
      const buffer = await fs.readFile(filePath);
      return {
        path: filePath,
        content: '',
        size: stat.size,
        language,
        modified: stat.mtime.toISOString(),
        isImage: true,
        mimeType: imageMimeType,
        base64Content: buffer.toString('base64'),
      };
    }

    const content = await fs.readFile(filePath, 'utf-8');

    return {
      path: filePath,
      content,
      size: stat.size,
      language,
      modified: stat.mtime.toISOString(),
      isImage: false,
    };
  });

  // GET /diff — line-level diff between two files
  fastify.get<{
    Querystring: { a: string; b: string; context?: string; maxSize?: string };
  }>('/diff', async (request, reply) => {
    const { a: rawA, b: rawB } = request.query;
    if (!rawA || !rawB) {
      return reply.status(400).send({ error: 'Both "a" and "b" query parameters are required' });
    }

    const maxSize = parseInt(request.query.maxSize || String(MAX_FILE_SIZE), 10);
    const contextLines = parseInt(request.query.context || '3', 10);
    if (isNaN(contextLines) || contextLines < 0) {
      return reply.status(400).send({ error: '"context" must be a non-negative integer' });
    }

    let pathA: string;
    let pathB: string;
    try {
      pathA = validatePath(rawA);
      pathB = validatePath(rawB);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    const sides: Array<{ label: 'a' | 'b'; path: string }> = [
      { label: 'a', path: pathA },
      { label: 'b', path: pathB },
    ];

    const results: Array<{ path: string; content: string; size: number; modified: string }> = [];

    for (const side of sides) {
      let stat;
      try {
        stat = await fs.stat(side.path);
      } catch {
        return reply.status(404).send({ error: `File not found: ${side.label}` });
      }
      if (!stat.isFile()) {
        return reply.status(400).send({ error: `Path is not a file: ${side.label}` });
      }
      if (stat.size > maxSize) {
        return reply.status(413).send({
          error: `File too large for "${side.label}" (${stat.size} bytes). Max: ${maxSize} bytes`,
        });
      }
      const content = await fs.readFile(side.path, 'utf-8');
      results.push({
        path: side.path,
        content,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }

    const [aFile, bFile] = results;
    const { changes: rawChanges, stats } = computeLineDiff(aFile.content, bFile.content);
    const changes = applyContext(rawChanges, contextLines);

    return {
      a: { path: aFile.path, size: aFile.size, modified: aFile.modified },
      b: { path: bFile.path, size: bFile.size, modified: bFile.modified },
      changes,
      stats,
    };
  });

  // PUT /write — write file contents
  fastify.put<{
    Body: { path: string; content: string; expectedModified?: string };
  }>('/write', async (request, reply) => {
    const { path: rawPath, content, expectedModified } = request.body || {};
    if (!rawPath || content === undefined) {
      return reply.status(400).send({ error: 'path and content are required' });
    }

    let filePath: string;
    try {
      filePath = validatePath(rawPath);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    // Conflict detection: if expectedModified is provided, check it
    if (expectedModified) {
      try {
        const currentStat = await fs.stat(filePath);
        const currentMtime = currentStat.mtime.toISOString();
        if (currentMtime !== expectedModified) {
          return reply.status(409).send({
            error: 'File has been modified externally',
            currentModified: currentMtime,
            expectedModified,
          });
        }
      } catch {
        // File doesn't exist yet — that's fine for new files
      }
    }

    // Create parent directories if needed
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');

    const stat = await fs.stat(filePath);
    return {
      path: filePath,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    };
  });

  // POST /new — create a new file or directory
  fastify.post<{
    Body: { path: string; type: 'file' | 'directory' };
  }>('/new', async (request, reply) => {
    const { path: rawPath, type: entryType } = request.body || {};
    if (!rawPath || !entryType) {
      return reply.status(400).send({ error: 'path and type are required' });
    }

    let targetPath: string;
    try {
      targetPath = validatePath(rawPath);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    // Check if already exists
    try {
      await fs.stat(targetPath);
      return reply.status(409).send({ error: 'Path already exists' });
    } catch {
      // Good — doesn't exist
    }

    if (entryType === 'directory') {
      await fs.mkdir(targetPath, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, '', 'utf-8');
    }

    const stat = await fs.stat(targetPath);
    return {
      path: targetPath,
      type: entryType,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    };
  });

  // DELETE /delete — delete a file or empty directory
  fastify.delete<{
    Body: { path: string };
  }>('/delete', async (request, reply) => {
    const { path: rawPath } = request.body || {};
    if (!rawPath) {
      return reply.status(400).send({ error: 'path is required' });
    }

    let targetPath: string;
    try {
      targetPath = validatePath(rawPath);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    let stat;
    try {
      stat = await fs.stat(targetPath);
    } catch {
      return reply.status(404).send({ error: 'Path not found' });
    }

    if (stat.isDirectory()) {
      await fs.rm(targetPath, { recursive: true });
    } else {
      await fs.unlink(targetPath);
    }

    return { path: targetPath, deleted: true };
  });

  // GET /stat — file/dir metadata
  fastify.get<{
    Querystring: { path: string };
  }>('/stat', async (request, reply) => {
    const rawPath = request.query.path;
    if (!rawPath) {
      return reply.status(400).send({ error: 'path query parameter is required' });
    }

    let targetPath: string;
    try {
      targetPath = validatePath(rawPath);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    try {
      const stat = await fs.stat(targetPath);
      return {
        path: targetPath,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        modified: stat.mtime.toISOString(),
        exists: true,
      };
    } catch {
      return {
        path: targetPath,
        type: 'unknown',
        size: 0,
        modified: '',
        exists: false,
      };
    }
  });

  // POST /reveal — reveal a file or directory in macOS Finder
  fastify.post<{
    Body: { path: string };
  }>('/reveal', async (request, reply) => {
    const { path: rawPath } = request.body || {};
    if (!rawPath) {
      return reply.status(400).send({ error: 'path is required' });
    }

    let targetPath: string;
    try {
      targetPath = validatePath(rawPath);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    try {
      await fs.stat(targetPath);
    } catch {
      return reply.status(404).send({ error: 'Path not found' });
    }

    return new Promise((resolve) => {
      execFile('open', ['-R', targetPath], (error) => {
        if (error) {
          resolve(reply.status(500).send({ error: 'Failed to reveal in Finder' }));
        } else {
          resolve(reply.status(204).send());
        }
      });
    });
  });
};

interface DirEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
  children?: DirEntry[];
}

interface FsFindEntry {
  name: string;
  path: string;
  relativePath: string;
}

async function readDir(dirPath: string, depth: number, showHidden = false, includeIgnored = false): Promise<DirEntry[]> {
  let items;
  try {
    items = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const entries: DirEntry[] = [];

  for (const item of items) {
    // Skip hidden files/dirs and ignored dirs (unless showHidden is on)
    if (!showHidden && item.name.startsWith('.') && item.name !== '.env' && item.name !== '.env.example' && item.name !== '.git' && item.name !== '.claude') {
      if (item.isDirectory()) continue;
      // Allow hidden files but skip .DS_Store
      if (item.name === '.DS_Store') continue;
    }
    if (item.name === '.DS_Store') continue;
    if (!includeIgnored && item.isDirectory() && IGNORED_DIRS.has(item.name)) continue;

    const fullPath = path.join(dirPath, item.name);
    const entry: DirEntry = {
      name: item.name,
      path: fullPath,
      type: item.isDirectory() ? 'directory' : 'file',
    };

    try {
      const stat = await fs.stat(fullPath);
      if (item.isFile()) {
        entry.size = stat.size;
      }
      entry.modified = stat.mtime.toISOString();
    } catch {
      // Skip files we can't stat
    }

    if (item.isDirectory() && depth > 1) {
      entry.children = await readDir(fullPath, depth - 1, showHidden, includeIgnored);
    }

    entries.push(entry);
  }

  // Sort: directories first, then alphabetical
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return entries;
}

async function findFiles(rootPath: string, limit: number, query?: string, showHidden = false): Promise<FsFindEntry[]> {
  const results: FsFindEntry[] = [];
  const queue: string[] = [rootPath];
  const normalizedQuery = query?.trim().toLowerCase() || '';
  const homeRoot = path.resolve(os.homedir());
  const normalizedRoot = path.resolve(rootPath);
  const isHomeRoot = normalizedRoot === homeRoot;

  while (queue.length > 0 && results.length < limit) {
    const currentDir = queue.shift()!;
    let items;
    try {
      items = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    for (const item of items) {
      if (!showHidden && item.name.startsWith('.') && item.name !== '.env' && item.name !== '.env.example' && item.name !== '.claude') {
        if (item.isDirectory()) continue;
        if (item.name === '.DS_Store') continue;
      }
      if (item.name === '.DS_Store') continue;
      if (item.isDirectory() && QUICK_OPEN_IGNORED_DIRS.has(item.name)) continue;
      if (item.isDirectory() && isHomeRoot && currentDir === normalizedRoot && HOME_QUICK_OPEN_IGNORED_DIRS.has(item.name)) continue;

      const fullPath = path.join(currentDir, item.name);
      if (item.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!item.isFile()) continue;
      const relativePath = path.relative(rootPath, fullPath) || item.name;
      if (normalizedQuery) {
        const nameMatch = item.name.toLowerCase().includes(normalizedQuery);
        const relativeMatch = relativePath.toLowerCase().includes(normalizedQuery);
        if (!nameMatch && !relativeMatch) continue;
      }

      results.push({
        name: item.name,
        path: fullPath,
        relativePath,
      });

      if (results.length >= limit) break;
    }
  }

  return results;
}

interface FsSearchMatch {
  lineNumber: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

interface FsSearchFileResult {
  path: string;
  relativePath: string;
  matches: FsSearchMatch[];
}

interface FsSearchResponse {
  results: FsSearchFileResult[];
  truncated: boolean;
}

function runRipgrep(args: string[], rootPath: string, limit: number): Promise<FsSearchResponse> {
  return new Promise((resolve, reject) => {
    const proc = execFile('rg', args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error && (error as any).code !== 1) {
        reject(error);
        return;
      }

      const fileMap = new Map<string, FsSearchFileResult>();
      let totalMatches = 0;
      let truncated = false;

      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        if (totalMatches >= limit) {
          truncated = true;
          break;
        }

        try {
          const parsed = JSON.parse(line);
          if (parsed.type !== 'match') continue;

          const data = parsed.data;
          const filePath: string = data.path?.text || '';
          if (!filePath) continue;

          if (!fileMap.has(filePath)) {
            fileMap.set(filePath, {
              path: filePath,
              relativePath: path.relative(rootPath, filePath) || path.basename(filePath),
              matches: [],
            });
          }

          const fileResult = fileMap.get(filePath)!;
          const lineText: string = data.lines?.text?.replace(/\n$/, '') || '';
          const lineNumber: number = data.line_number || 0;

          // Each rg match line can have multiple submatches
          const submatches = data.submatches || [];
          for (const sub of submatches) {
            if (totalMatches >= limit) {
              truncated = true;
              break;
            }
            fileResult.matches.push({
              lineNumber,
              lineText,
              matchStart: sub.start ?? 0,
              matchEnd: sub.end ?? 0,
            });
            totalMatches++;
          }
        } catch {
          // Skip unparseable lines
        }
      }

      resolve({
        results: Array.from(fileMap.values()),
        truncated,
      });
    });

    // Kill if it takes too long
    setTimeout(() => {
      proc.kill();
    }, 10000);
  });
}

export default filesystemRoutes;
