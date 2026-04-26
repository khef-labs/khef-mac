import { query } from '../db/client';
import { logger } from '../lib/logger';
import { hashContent } from './assistant-sync';

const log = logger.child({ component: 'assistant-discovery' });
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigImport, ConfigScope, ConfigFormat, ConfigType } from '../types';

interface ConfigPath {
  id: string;
  assistant_id: string;
  scope: string;
  type: string;
  path_template: string;
  format: string;
  description: string | null;
  readonly: boolean;
}

interface DiscoveredConfig {
  scope: string;
  type: string;
  path: string;
  format: string;
  content: string;
  file_hash: string;
  readonly: boolean;
}

/**
 * Expand path template placeholders:
 * - ~ -> user home directory
 * - {project} -> project path (if provided)
 */
export function expandPath(template: string, projectPath?: string): string {
  let expanded = template;

  // Expand ~
  if (expanded.startsWith('~')) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }

  // Expand {project}
  if (projectPath && expanded.includes('{project}')) {
    expanded = expanded.replace('{project}', projectPath);
  }

  return expanded;
}

/**
 * Check if an assistant is installed by verifying any of its global config paths exist.
 */
export async function isAssistantInstalled(assistantHandle: string): Promise<boolean> {
  const templates = await query<ConfigPath>(
    `SELECT acp.*
     FROM assistant_config_paths acp
     JOIN assistants a ON a.id = acp.assistant_id
     WHERE a.handle = $1 AND acp.scope = 'global'`,
    [assistantHandle]
  );

  for (const template of templates) {
    const expandedPath = expandPath(template.path_template);
    if (fs.existsSync(expandedPath)) {
      return true;
    }
  }

  return false;
}

/**
 * Discover configs for an assistant from known paths.
 * For global scope, scans user-wide paths.
 * For project/local scope, requires a project path.
 */
export async function discoverConfigs(
  assistantHandle: string,
  options?: { projectPath?: string; scope?: 'global' | 'project' | 'local' }
): Promise<DiscoveredConfig[]> {
  // Get path templates for this assistant
  let sql = `
    SELECT acp.*, a.handle as assistant_handle
    FROM assistant_config_paths acp
    JOIN assistants a ON a.id = acp.assistant_id
    WHERE a.handle = $1
  `;
  const params: string[] = [assistantHandle];

  if (options?.scope) {
    sql += ` AND acp.scope = $2`;
    params.push(options.scope);
  }

  const templates = await query<ConfigPath & { assistant_handle: string }>(sql, params);

  const discovered: DiscoveredConfig[] = [];

  for (const template of templates) {
    // Skip project/local scope if no project path provided
    if ((template.scope === 'project' || template.scope === 'local') && !options?.projectPath) {
      continue;
    }

    const expandedPath = expandPath(template.path_template, options?.projectPath);

    // Check if file exists
    if (!fs.existsSync(expandedPath)) {
      continue;
    }

    try {
      const content = fs.readFileSync(expandedPath, 'utf-8');
      const fileHash = hashContent(content);

      discovered.push({
        scope: template.scope,
        type: template.type,
        path: expandedPath,
        format: template.format,
        content,
        file_hash: fileHash,
        readonly: template.readonly ?? false,
      });
    } catch (err) {
      // Skip files we can't read
      log.warn({ err, path: expandedPath }, 'Failed to read config file');
    }
  }

  return discovered;
}

/**
 * Import discovered configs into the database.
 * Upserts based on path - updates existing configs if content changed.
 */
export async function importDiscoveredConfigs(
  assistantHandle: string,
  configs: DiscoveredConfig[],
  projectId?: string,
  projectPath?: string
): Promise<{ imported: number; updated: number; unchanged: number }> {
  // Get assistant ID
  const assistants = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [assistantHandle]);
  if (assistants.length === 0) {
    throw new Error(`Assistant not found: ${assistantHandle}`);
  }
  const assistantId = assistants[0].id;

  let imported = 0;
  let updated = 0;
  let unchanged = 0;

  for (const config of configs) {
    // Check if config already exists for this path
    const existing = await query<{ id: string; file_hash: string | null; readonly: boolean; is_import: boolean; type: string }>(
      'SELECT id, file_hash, readonly, is_import, type FROM configs WHERE path = $1',
      [config.path]
    );

    let resolvedConfigId: string;

    if (existing.length > 0) {
      resolvedConfigId = existing[0].id;

      // Config exists - check if content changed
      if (existing[0].file_hash === config.file_hash) {
        unchanged++;
        // Don't continue — still need to check @ imports below
      } else {
        // Update existing config
        await query(
          `UPDATE configs SET content = $1, file_hash = $2, version = version + 1,
           last_synced_at = NOW(), updated_at = NOW() WHERE id = $3`,
          [config.content, config.file_hash, existing[0].id]
        );
        updated++;
      }

      // If this config was previously created as an @-import but is now discovered
      // as a primary config (via config_paths), promote it: update readonly, is_import, type
      if (existing[0].is_import || existing[0].readonly !== config.readonly || existing[0].type !== config.type) {
        await query(
          `UPDATE configs SET readonly = $1, is_import = false, parent_config_id = NULL, type = $2, updated_at = NOW() WHERE id = $3`,
          [config.readonly, config.type, existing[0].id]
        );
      }
    } else {
      // Create new config
      const result = await query<{ id: string }>(
        `INSERT INTO configs (scope, type, path, format, content, file_hash, readonly, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING id`,
        [config.scope, config.type, config.path, config.format, config.content, config.file_hash, config.readonly]
      );
      resolvedConfigId = result[0].id;

      // Link to assistant (and project if project-scoped)
      if (config.scope === 'project' || config.scope === 'local') {
        if (!projectId) {
          throw new Error('Project ID required for project/local scope configs');
        }
        await query(
          `INSERT INTO project_assistant_configs (project_id, assistant_id, config_id) VALUES ($1, $2, $3)`,
          [projectId, assistantId, resolvedConfigId]
        );
      } else {
        await query(
          `INSERT INTO assistant_configs (assistant_id, config_id) VALUES ($1, $2)`,
          [assistantId, resolvedConfigId]
        );
      }

      imported++;
    }

    // Discover and import @ references for markdown configs
    if (config.format === 'markdown') {
      const imports = discoverImports(config.path, config.content);
      if (imports.length > 0) {
        await importConfigImports(
          resolvedConfigId,
          config.scope as ConfigScope,
          assistantId,
          imports,
          projectId,
          projectPath
        );
      }
    }
  }

  return { imported, updated, unchanged };
}

/**
 * Discover and import global configs for an assistant.
 * Call this on first access to auto-populate configs.
 */
export async function discoverAndImportGlobalConfigs(
  assistantHandle: string
): Promise<{ imported: number; updated: number; unchanged: number }> {
  const discovered = await discoverConfigs(assistantHandle, { scope: 'global' });
  return importDiscoveredConfigs(assistantHandle, discovered);
}

/**
 * Discover and import project configs for an assistant.
 */
export async function discoverAndImportProjectConfigs(
  assistantHandle: string,
  projectId: string,
  projectPath: string
): Promise<{ imported: number; updated: number; unchanged: number }> {
  const projectConfigs = await discoverConfigs(assistantHandle, { projectPath, scope: 'project' });
  const localConfigs = await discoverConfigs(assistantHandle, { projectPath, scope: 'local' });

  const allConfigs = [...projectConfigs, ...localConfigs];
  return importDiscoveredConfigs(assistantHandle, allConfigs, projectId, projectPath);
}

/**
 * Parse @import references from markdown config content.
 * Matches patterns like @~/.claude/KF-RULES.md or @./local-rules.md
 */
export function parseImportReferences(content: string): string[] {
  // Match @~/... or @./... at start of line or after whitespace
  // The path continues until whitespace or end of line
  const pattern = /(?:^|\s)@(~\/[^\s]+|\.\/[^\s]+)/gm;
  const matches: string[] = [];
  let match;

  while ((match = pattern.exec(content)) !== null) {
    matches.push(match[1]);
  }

  return [...new Set(matches)]; // Dedupe
}

/**
 * Infer config type from filename convention.
 * Files containing 'RULES' → rules, 'KNOWLEDGE' → knowledge, else → instructions.
 */
function detectImportType(filePath: string): ConfigType {
  const basename = path.basename(filePath).toUpperCase();
  if (basename.includes('RULES')) return 'rules';
  if (basename.includes('KNOWLEDGE')) return 'knowledge';
  if (basename.includes('GLOSSARY')) return 'glossary';
  return 'instructions';
}

/**
 * Detect format from file extension
 */
function detectFormat(filePath: string): ConfigFormat {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.json':
      return 'json';
    case '.toml':
      return 'toml';
    case '.md':
    case '.markdown':
    default:
      return 'markdown';
  }
}

/**
 * Discover imports referenced in a config's content.
 * Returns info about each import file that exists.
 */
export function discoverImports(
  configPath: string,
  content: string
): Array<{ path: string; content: string; hash: string; format: ConfigFormat }> {
  const refs = parseImportReferences(content);
  const imports: Array<{ path: string; content: string; hash: string; format: ConfigFormat }> = [];

  for (const ref of refs) {
    let expandedPath = expandPath(ref);

    // Resolve ./ paths relative to the parent config's directory
    if (ref.startsWith('./')) {
      const configDir = path.dirname(configPath);
      expandedPath = path.resolve(configDir, ref);
    }

    if (!fs.existsSync(expandedPath)) {
      continue;
    }

    try {
      const importContent = fs.readFileSync(expandedPath, 'utf-8');
      const hash = hashContent(importContent);
      const format = detectFormat(expandedPath);

      imports.push({
        path: expandedPath,
        content: importContent,
        hash,
        format,
      });
    } catch (err) {
      log.warn({ err, path: expandedPath }, 'Failed to read import file');
    }
  }

  return imports;
}

/**
 * Import discovered files and link them to their parent config.
 * Creates config entries with is_import=true and parent_config_id set.
 */
export async function importConfigImports(
  parentConfigId: string,
  parentScope: ConfigScope,
  assistantId: string,
  imports: Array<{ path: string; content: string; hash: string; format: ConfigFormat }>,
  projectId?: string,
  projectPath?: string
): Promise<{ imported: number; updated: number; unchanged: number }> {
  let imported = 0;
  let updated = 0;
  let unchanged = 0;

  for (const imp of imports) {
    // Determine scope from file location rather than blindly inheriting parent scope.
    // If we know the project path, files outside it are global (e.g. ~/.claude/KF-RULES.md).
    let importScope: ConfigScope = parentScope;
    if (projectPath && !imp.path.startsWith(projectPath + '/') && imp.path !== projectPath) {
      importScope = 'global';
    }
    // Check if import already exists (by path only - same file imported by multiple parents shares one entry)
    const existing = await query<{ id: string; file_hash: string | null; parent_config_id: string | null }>(
      'SELECT id, file_hash, parent_config_id FROM configs WHERE path = $1',
      [imp.path]
    );

    if (existing.length > 0) {
      if (existing[0].file_hash === imp.hash) {
        unchanged++;
        continue;
      }

      // Update existing import
      await query(
        `UPDATE configs SET content = $1, file_hash = $2, version = version + 1,
         last_synced_at = NOW(), updated_at = NOW() WHERE id = $3`,
        [imp.content, imp.hash, existing[0].id]
      );
      updated++;
    } else {
      // Create new import config
      const importType = detectImportType(imp.path);
      const result = await query<{ id: string }>(
        `INSERT INTO configs (scope, type, path, format, content, file_hash, readonly, is_import, parent_config_id, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, true, $7, NOW())
         RETURNING id`,
        [importScope, importType, imp.path, imp.format, imp.content, imp.hash, parentConfigId]
      );
      const configId = result[0].id;

      // Link to parent's context: if parent is project-scoped, link import to project too
      // (even if the import file itself is global, e.g. ~/.claude/KF-RULES.md imported by a project CLAUDE.md)
      if ((parentScope === 'project' || parentScope === 'local') && projectId) {
        await query(
          `INSERT INTO project_assistant_configs (project_id, assistant_id, config_id) VALUES ($1, $2, $3)`,
          [projectId, assistantId, configId]
        );
      } else {
        await query(
          `INSERT INTO assistant_configs (assistant_id, config_id) VALUES ($1, $2)`,
          [assistantId, configId]
        );
      }

      imported++;
    }
  }

  return { imported, updated, unchanged };
}

/**
 * Get imports for a config from the database.
 */
export async function getConfigImports(configId: string): Promise<ConfigImport[]> {
  const rows = await query<{
    id: string;
    path: string;
    scope: string;
    format: string;
    is_import: boolean;
  }>(
    `SELECT id, path, scope, format, is_import FROM configs WHERE parent_config_id = $1`,
    [configId]
  );

  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    scope: row.scope as ConfigScope,
    format: row.format as ConfigFormat,
    is_import: row.is_import,
  }));
}
