import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';

/**
 * Expand path template with home directory and project path
 */
export function expandPath(pathTemplate: string, projectPath?: string): string {
  let path = pathTemplate;

  // Expand ~ to home directory
  if (path.startsWith('~')) {
    path = path.replace('~', homedir());
  }

  // Expand {project_path} placeholder
  if (path.includes('{project_path}') && projectPath) {
    path = path.replace('{project_path}', projectPath);
  }

  return path;
}

/**
 * Compute SHA256 hash of file content
 */
export function hashContent(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Read file and compute its hash
 */
export function hashFile(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf8');
    return hashContent(content);
  } catch {
    return null;
  }
}

/**
 * Read file content
 */
export function readFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write file content
 */
export function writeFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf8');
}

/**
 * Check if file exists
 */
export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

export interface SyncResult {
  success: boolean;
  path: string;
  hash: string;
  error?: string;
}

export interface ConflictError {
  type: 'conflict';
  message: string;
  dbHash: string;
  fileHash: string;
  options: ('force' | 'import' | 'diff')[];
}

/**
 * Sync config content to system file with force-with-lease semantics
 * Returns the new hash on success, or throws ConflictError if external changes detected
 */
export function syncToSystem(
  filePath: string,
  content: string,
  expectedHash: string | null,
  force: boolean = false
): SyncResult | ConflictError {
  const currentHash = hashFile(filePath);

  // If file exists and we have an expected hash, check for conflicts
  if (!force && expectedHash && currentHash && currentHash !== expectedHash) {
    return {
      type: 'conflict',
      message: 'External changes detected',
      dbHash: expectedHash,
      fileHash: currentHash,
      options: ['force', 'import', 'diff'],
    };
  }

  try {
    writeFile(filePath, content);
    const newHash = hashContent(content);
    return {
      success: true,
      path: filePath,
      hash: newHash,
    };
  } catch (err) {
    return {
      success: false,
      path: filePath,
      hash: '',
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Import content from system file
 */
export function importFromSystem(filePath: string): { content: string; hash: string } | null {
  const content = readFile(filePath);
  if (content === null) {
    return null;
  }
  return {
    content,
    hash: hashContent(content),
  };
}
