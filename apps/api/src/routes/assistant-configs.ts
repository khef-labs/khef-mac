import { FastifyPluginAsync } from 'fastify';
import * as os from 'os';
import { query, querySingle } from '../db/client';
import { AssistantConfig, ConfigScope, ConfigType, ConfigFormat, UpdateConfigInput, SyncStatusResponse, ConfigImport } from '../types';
import { hashFile, hashContent, syncToSystem, importFromSystem, fileExists, SyncResult } from '../services/assistant-sync';
import { getConfigImports, discoverImports, importConfigImports } from '../services/assistant-discovery';
import {
  createConfigSnapshot,
  getConfigSnapshots,
  getConfigSnapshot,
  getConfigCurrentSnapshot,
  deleteConfigSnapshot,
  restoreConfigSnapshot,
} from '../services/config-snapshots';

interface ConfigRow {
  id: string;
  scope: string;
  type: string;
  path: string;
  format: string;
  content: string;
  file_hash: string | null;
  version: number;
  auto_sync: boolean;
  readonly: boolean;
  parent_config_id: string | null;
  is_import: boolean;
  notes: string | null;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
  assistant_id: string;
  assistant_handle: string;
  assistant_name: string;
}

function toAssistantConfig(row: ConfigRow, imports?: ConfigImport[]): AssistantConfig {
  return {
    id: row.id,
    scope: row.scope as ConfigScope,
    type: row.type as ConfigType,
    path: row.path,
    format: row.format as ConfigFormat,
    content: row.content,
    file_hash: row.file_hash ?? undefined,
    version: row.version,
    auto_sync: row.auto_sync,
    readonly: row.readonly,
    parent_config_id: row.parent_config_id ?? undefined,
    is_import: row.is_import ?? false,
    notes: row.notes ?? undefined,
    last_synced_at: row.last_synced_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    assistant: {
      id: row.assistant_id,
      handle: row.assistant_handle,
      name: row.assistant_name,
    },
    imports,
  };
}

// Query that joins config with assistant info (via either assistant_configs or project_assistant_configs)
const configQuery = `
  SELECT c.id, c.scope, c.type, c.path, c.format, c.content, c.file_hash,
         c.version, c.auto_sync, c.readonly, c.parent_config_id, c.is_import,
         c.notes, c.last_synced_at, c.created_at, c.updated_at,
         COALESCE(a1.id, a2.id) AS assistant_id,
         COALESCE(a1.handle, a2.handle) AS assistant_handle,
         COALESCE(a1.name, a2.name) AS assistant_name
  FROM configs c
  LEFT JOIN assistant_configs ac ON ac.config_id = c.id
  LEFT JOIN assistants a1 ON a1.id = ac.assistant_id
  LEFT JOIN project_assistant_configs pac ON pac.config_id = c.id
  LEFT JOIN assistants a2 ON a2.id = pac.assistant_id
`;

const configRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/configs/:id - Get config with imports
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;

    const rows = await query<ConfigRow>(configQuery + ' WHERE c.id = $1', [id]);
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Config not found' });
    }

    // Fetch imports for this config
    const imports = await getConfigImports(id);

    return { config: toAssistantConfig(rows[0], imports) };
  });

  // PATCH /api/configs/:id - Update config
  fastify.patch<{ Params: { id: string }; Body: UpdateConfigInput }>(
    '/:id',
    async (request, reply) => {
      const { id } = request.params;
      const { content, auto_sync, notes } = request.body;

      // Get existing config
      const existing = await query<ConfigRow>(configQuery + ' WHERE c.id = $1', [id]);
      if (existing.length === 0) {
        return reply.code(404).send({ error: 'Config not found' });
      }

      // Reject edits on readonly configs
      if (existing[0].readonly) {
        return reply.code(403).send({ error: 'Config is read-only and cannot be modified' });
      }

      const updates: string[] = [];
      const params: (string | boolean | number)[] = [];
      let paramIndex = 1;

      if (content !== undefined) {
        // Write to disk first using force-with-lease
        const config = existing[0];
        const syncResult = syncToSystem(config.path, content, config.file_hash, false);

        if ('type' in syncResult && syncResult.type === 'conflict') {
          return reply.code(409).send({
            error: 'External changes detected. Refresh to see current file content.',
            status: 'conflict',
            db_hash: syncResult.dbHash,
            file_hash: syncResult.fileHash,
          });
        }

        // Type narrowing: at this point syncResult is SyncResult
        const result = syncResult as import('../services/assistant-sync').SyncResult;
        if (!result.success) {
          return reply.code(500).send({ error: result.error || 'Failed to write to disk' });
        }

        // Create snapshot of the new content (creates pre-sync snapshot of old content first if changed)
        const newSnapshot = await createConfigSnapshot(id, content, 'manual', false, config.format as 'json' | 'markdown' | 'toml');

        updates.push(`content = $${paramIndex++}`);
        params.push(content);

        // Update hash from sync result
        updates.push(`file_hash = $${paramIndex++}`);
        params.push(result.hash);

        // Update last_synced_at
        updates.push(`last_synced_at = NOW()`);

        // Increment version
        updates.push(`version = version + 1`);
      }

      if (auto_sync !== undefined) {
        updates.push(`auto_sync = $${paramIndex++}`);
        params.push(auto_sync);
      }

      if (notes !== undefined) {
        updates.push(`notes = $${paramIndex++}`);
        params.push(notes);
      }

      if (updates.length === 0) {
        return reply.code(400).send({ error: 'No updates provided' });
      }

      updates.push('updated_at = NOW()');
      params.push(id);

      await query(
        `UPDATE configs SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
        params
      );

      // Return updated config
      const rows = await query<ConfigRow>(configQuery + ' WHERE c.id = $1', [id]);
      return { config: toAssistantConfig(rows[0]) };
    }
  );

  // DELETE /api/configs/:id - Delete config
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;

    // Check if config exists and is not a core system config
    const existing = await query<{ is_import: boolean; path: string }>(
      'SELECT is_import, path FROM configs WHERE id = $1', [id]
    );
    if (existing.length === 0) {
      return reply.code(404).send({ error: 'Config not found' });
    }

    // Core configs (discovered from assistant_config_paths) can't be deleted — they'd just get re-discovered
    if (!existing[0].is_import) {
      const isCore = await query(
        `SELECT 1 FROM assistant_config_paths WHERE path_template = $1 LIMIT 1`,
        [existing[0].path.replace(os.homedir(), '~')]
      );
      if (isCore.length > 0) {
        return reply.code(403).send({ error: 'System configs cannot be deleted' });
      }
    }

    // Delete from join tables first (cascade should handle this, but be explicit)
    await query('DELETE FROM assistant_configs WHERE config_id = $1', [id]);
    await query('DELETE FROM project_assistant_configs WHERE config_id = $1', [id]);

    await query('DELETE FROM configs WHERE id = $1', [id]);

    return { deleted: true };
  });

  // GET /api/configs/:id/sync - Check sync status
  fastify.get<{ Params: { id: string } }>('/:id/sync', async (request, reply) => {
    const { id } = request.params;

    const rows = await query<ConfigRow>(configQuery + ' WHERE c.id = $1', [id]);
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Config not found' });
    }

    const config = rows[0];

    if (!fileExists(config.path)) {
      const response: SyncStatusResponse = {
        status: 'file_missing',
        db_hash: config.file_hash || undefined,
        message: 'System file does not exist',
      };
      return response;
    }

    const currentFileHash = hashFile(config.path);
    const dbHash = config.file_hash;

    if (!dbHash) {
      const response: SyncStatusResponse = {
        status: 'not_synced',
        file_hash: currentFileHash || undefined,
        message: 'Config has never been synced',
      };
      return response;
    }

    if (currentFileHash === dbHash) {
      const response: SyncStatusResponse = {
        status: 'in_sync',
        db_hash: dbHash,
        file_hash: currentFileHash || undefined,
      };
      return response;
    }

    const response: SyncStatusResponse = {
      status: 'external_changes',
      db_hash: dbHash,
      file_hash: currentFileHash || undefined,
      message: 'System file was modified externally',
    };
    return response;
  });

  // POST /api/configs/:id/sync - Sync to system file
  fastify.post<{ Params: { id: string }; Querystring: { force?: string } }>(
    '/:id/sync',
    async (request, reply) => {
      const { id } = request.params;
      const force = request.query.force === 'true';

      const rows = await query<ConfigRow>(configQuery + ' WHERE c.id = $1', [id]);
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Config not found' });
      }

      const config = rows[0];
      const result = syncToSystem(config.path, config.content, config.file_hash, force);

      if ('type' in result && result.type === 'conflict') {
        return reply.code(409).send({
          error: 'External changes detected',
          status: 'conflict',
          db_hash: result.dbHash,
          file_hash: result.fileHash,
          options: result.options,
        });
      }

      const syncResult = result as SyncResult;

      if (!syncResult.success) {
        return reply.code(500).send({ error: syncResult.error || 'Sync failed' });
      }

      // Update hash and last_synced_at
      await query(
        'UPDATE configs SET file_hash = $1, last_synced_at = NOW() WHERE id = $2',
        [syncResult.hash, id]
      );

      return {
        status: 'synced',
        path: config.path,
        hash: syncResult.hash,
      };
    }
  );

  // POST /api/configs/:id/import - Import from system file
  fastify.post<{ Params: { id: string } }>('/:id/import', async (request, reply) => {
    const { id } = request.params;

    const rows = await query<ConfigRow>(configQuery + ' WHERE c.id = $1', [id]);
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Config not found' });
    }

    const config = rows[0];
    const imported = importFromSystem(config.path);

    if (!imported) {
      return reply.code(404).send({ error: 'System file not found', path: config.path });
    }

    // Create snapshot of imported content (skip if content is invalid JSON — file may be temporarily malformed)
    try {
      await createConfigSnapshot(id, imported.content, 'import', false, config.format as 'json' | 'markdown' | 'toml');
    } catch (snapshotErr: any) {
      request.log.warn({ err: snapshotErr, configId: id, path: config.path }, 'Snapshot creation failed during import — skipping snapshot');
    }

    // Update config with imported content (increment version)
    await query(
      `UPDATE configs SET content = $1, file_hash = $2, version = version + 1, last_synced_at = NOW(), updated_at = NOW() WHERE id = $3`,
      [imported.content, imported.hash, id]
    );

    // Return updated config
    const updatedRows = await query<ConfigRow>(configQuery + ' WHERE c.id = $1', [id]);

    // Also discover and import any @references
    const imports = await getConfigImports(id);

    return {
      status: 'imported',
      path: config.path,
      config: toAssistantConfig(updatedRows[0], imports),
    };
  });

  // POST /api/configs/:id/discover-imports - Discover and import @references
  fastify.post<{ Params: { id: string } }>('/:id/discover-imports', async (request, reply) => {
    const { id } = request.params;

    const rows = await query<ConfigRow>(configQuery + ' WHERE c.id = $1', [id]);
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Config not found' });
    }

    const config = rows[0];

    // Parse @references from content
    const discoveredImports = discoverImports(config.path, config.content);

    if (discoveredImports.length === 0) {
      return {
        discovered: 0,
        imported: 0,
        updated: 0,
        unchanged: 0,
        imports: [],
      };
    }

    // Import them as linked configs
    const result = await importConfigImports(
      id,
      config.scope as ConfigScope,
      config.assistant_id,
      discoveredImports,
      // For project-scoped configs, we'd need the project ID
      // For now, just handle global configs
      undefined
    );

    // Fetch the imports
    const imports = await getConfigImports(id);

    return {
      discovered: discoveredImports.length,
      ...result,
      imports,
    };
  });

  // GET /api/configs/:id/imports - Get imports for a config
  fastify.get<{ Params: { id: string } }>('/:id/imports', async (request, reply) => {
    const { id } = request.params;

    // Verify config exists
    const rows = await query<{ id: string }>('SELECT id FROM configs WHERE id = $1', [id]);
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Config not found' });
    }

    const imports = await getConfigImports(id);
    return { imports };
  });

  // ── Snapshot Endpoints ────────────────────────────────────────────────

  // GET /api/configs/:id/snapshots - List all snapshots
  fastify.get<{ Params: { id: string } }>('/:id/snapshots', async (request, reply) => {
    const { id } = request.params;

    // Verify config exists
    const rows = await query<{ id: string }>(
      'SELECT id FROM configs WHERE id = $1',
      [id]
    );
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Config not found' });
    }

    // Compute current_snapshot from MAX(snapshot_number)
    const currentSnapshot = await getConfigCurrentSnapshot(id);
    const snapshots = await getConfigSnapshots(id);
    return {
      current_snapshot: currentSnapshot,
      snapshots,
    };
  });

  // POST /api/configs/:id/snapshots - Create a new snapshot of current content
  fastify.post<{ Params: { id: string } }>('/:id/snapshots', async (request, reply) => {
    const { id } = request.params;

    // Get config with content and format (readonly configs can still be snapshotted)
    const rows = await query<{ id: string; content: string; format: string }>(
      'SELECT id, content, format FROM configs WHERE id = $1',
      [id]
    );
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Config not found' });
    }

    const config = rows[0];

    // Create snapshot of current content (force=true to always create)
    const newSnapshot = await createConfigSnapshot(id, config.content, 'manual', true, config.format as 'json' | 'markdown' | 'toml');

    return {
      snapshot_number: newSnapshot,
    };
  });

  // GET /api/configs/:id/snapshots/:snapshot - Get specific snapshot
  fastify.get<{ Params: { id: string; snapshot: string } }>(
    '/:id/snapshots/:snapshot',
    async (request, reply) => {
      const { id, snapshot: snapshotStr } = request.params;

      const snapshotNumber = parseInt(snapshotStr, 10);
      if (isNaN(snapshotNumber) || snapshotNumber < 1) {
        return reply.code(400).send({ error: 'Invalid snapshot number' });
      }

      // Verify config exists
      const rows = await query<{ id: string }>('SELECT id FROM configs WHERE id = $1', [id]);
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Config not found' });
      }

      const snapshot = await getConfigSnapshot(id, snapshotNumber);
      if (!snapshot) {
        return reply.code(404).send({ error: 'Snapshot not found' });
      }

      return { snapshot };
    }
  );

  // DELETE /api/configs/:id/snapshots/:snapshot - Delete specific snapshot
  fastify.delete<{ Params: { id: string; snapshot: string } }>(
    '/:id/snapshots/:snapshot',
    async (request, reply) => {
      const { id, snapshot: snapshotStr } = request.params;

      const snapshotNumber = parseInt(snapshotStr, 10);
      if (isNaN(snapshotNumber) || snapshotNumber < 1) {
        return reply.code(400).send({ error: 'Invalid snapshot number' });
      }

      // Verify config exists
      const rows = await query<{ id: string }>('SELECT id FROM configs WHERE id = $1', [id]);
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Config not found' });
      }

      const result = await deleteConfigSnapshot(id, snapshotNumber);
      if (!result.deleted) {
        const status = result.error === 'Snapshot not found' ? 404 : 400;
        return reply.code(status).send({ error: result.error });
      }

      return reply.code(204).send();
    }
  );

  // POST /api/configs/:id/snapshots/:snapshot/restore - Restore specific snapshot
  fastify.post<{ Params: { id: string; snapshot: string } }>(
    '/:id/snapshots/:snapshot/restore',
    async (request, reply) => {
      const { id, snapshot: snapshotStr } = request.params;

      const snapshotNumber = parseInt(snapshotStr, 10);
      if (isNaN(snapshotNumber) || snapshotNumber < 1) {
        return reply.code(400).send({ error: 'Invalid snapshot number' });
      }

      // Verify config exists and is not readonly
      const rows = await query<ConfigRow>(configQuery + ' WHERE c.id = $1', [id]);
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Config not found' });
      }
      if (rows[0].readonly) {
        return reply.code(403).send({ error: 'Config is read-only and cannot be modified' });
      }

      const config = rows[0];

      // Fetch snapshot content first to validate
      const snapshotToRestore = await getConfigSnapshot(id, snapshotNumber);
      if (!snapshotToRestore) {
        return reply.code(404).send({ error: 'Snapshot not found' });
      }

      // For JSON configs, validate the snapshot content is valid JSON
      if (config.format === 'json') {
        try {
          JSON.parse(snapshotToRestore.content);
        } catch (e: any) {
          return reply.code(400).send({
            error: 'Cannot restore: snapshot contains invalid JSON',
            details: e.message,
          });
        }
      }

      const result = await restoreConfigSnapshot(id, snapshotNumber);
      if (!result.restored) {
        return reply.code(404).send({ error: result.error });
      }

      // Sync restored content to disk
      const updatedRows = await query<ConfigRow>(configQuery + ' WHERE c.id = $1', [id]);
      const updatedConfig = updatedRows[0];
      const syncResult = syncToSystem(updatedConfig.path, updatedConfig.content, null, true); // force sync

      if ('type' in syncResult && syncResult.type === 'conflict') {
        return reply.code(500).send({ error: 'Failed to sync restored content to disk' });
      }

      const sync = syncResult as SyncResult;
      if (sync.success) {
        await query(
          'UPDATE configs SET file_hash = $1, last_synced_at = NOW() WHERE id = $2',
          [sync.hash, id]
        );
      }

      return {
        status: 'restored',
        new_snapshot: result.newSnapshot,
        synced_to_disk: sync.success,
      };
    }
  );
  // ── MCP Server Management (for claude.json) ──────────────────────────

  interface McpServerInput {
    type?: 'stdio' | 'sse';
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  }

  // PUT /api/configs/:id/mcp-servers/:name - Add or update an MCP server
  fastify.put<{ Params: { id: string; name: string }; Body: McpServerInput }>(
    '/:id/mcp-servers/:name',
    async (request, reply) => {
      const { id, name } = request.params;
      const serverConfig = request.body;

      // Validate server name
      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        return reply.code(400).send({ error: 'Invalid server name. Use alphanumeric, underscore, or hyphen.' });
      }

      // Validate server config
      if (!serverConfig.type) {
        return reply.code(400).send({ error: 'Server type is required (stdio or sse)' });
      }
      if (serverConfig.type === 'stdio' && !serverConfig.command) {
        return reply.code(400).send({ error: 'Command is required for stdio servers' });
      }
      if (serverConfig.type === 'sse' && !serverConfig.url) {
        return reply.code(400).send({ error: 'URL is required for sse servers' });
      }

      // Get config
      const rows = await query<{ id: string; content: string; format: string; path: string }>(
        'SELECT id, content, format, path FROM configs WHERE id = $1',
        [id]
      );
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Config not found' });
      }

      const config = rows[0];
      if (config.format !== 'json') {
        return reply.code(400).send({ error: 'MCP servers can only be added to JSON configs' });
      }

      // Parse current content
      let parsed: any;
      try {
        parsed = JSON.parse(config.content);
      } catch {
        return reply.code(400).send({ error: 'Config content is not valid JSON' });
      }

      // Create pre-modification snapshot
      await createConfigSnapshot(id, config.content, 'pre-sync', false, 'json');

      // Ensure mcpServers object exists
      if (!parsed.mcpServers) {
        parsed.mcpServers = {};
      }

      // Build the server entry (only include non-empty fields)
      const serverEntry: Record<string, any> = { type: serverConfig.type };
      if (serverConfig.command) serverEntry.command = serverConfig.command;
      if (serverConfig.args && serverConfig.args.length > 0) serverEntry.args = serverConfig.args;
      if (serverConfig.url) serverEntry.url = serverConfig.url;
      if (serverConfig.env && Object.keys(serverConfig.env).length > 0) serverEntry.env = serverConfig.env;

      // Add/update the server
      const isNew = !parsed.mcpServers[name];
      parsed.mcpServers[name] = serverEntry;

      // Format with 2-space indentation
      const newContent = JSON.stringify(parsed, null, 2);

      // Write to disk
      const syncResult = syncToSystem(config.path, newContent, null, true);
      if ('type' in syncResult && syncResult.type === 'conflict') {
        return reply.code(500).send({ error: 'Failed to write config to disk' });
      }

      const sync = syncResult as SyncResult;
      if (!sync.success) {
        return reply.code(500).send({ error: sync.error || 'Failed to write config' });
      }

      // Update database
      await query(
        `UPDATE configs SET content = $1, file_hash = $2, version = version + 1, last_synced_at = NOW(), updated_at = NOW() WHERE id = $3`,
        [newContent, sync.hash, id]
      );

      // Create post-modification snapshot
      await createConfigSnapshot(id, newContent, 'manual', false, 'json');

      return {
        status: isNew ? 'created' : 'updated',
        server: name,
        config: serverEntry,
      };
    }
  );

  // DELETE /api/configs/:id/mcp-servers/:name - Remove an MCP server
  fastify.delete<{ Params: { id: string; name: string } }>(
    '/:id/mcp-servers/:name',
    async (request, reply) => {
      const { id, name } = request.params;

      // Get config
      const rows = await query<{ id: string; content: string; format: string; path: string }>(
        'SELECT id, content, format, path FROM configs WHERE id = $1',
        [id]
      );
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Config not found' });
      }

      const config = rows[0];
      if (config.format !== 'json') {
        return reply.code(400).send({ error: 'MCP servers can only be managed in JSON configs' });
      }

      // Parse current content
      let parsed: any;
      try {
        parsed = JSON.parse(config.content);
      } catch {
        return reply.code(400).send({ error: 'Config content is not valid JSON' });
      }

      // Check if server exists
      if (!parsed.mcpServers || !parsed.mcpServers[name]) {
        return reply.code(404).send({ error: `MCP server '${name}' not found` });
      }

      // Create pre-modification snapshot
      await createConfigSnapshot(id, config.content, 'pre-sync', false, 'json');

      // Remove the server
      delete parsed.mcpServers[name];

      // Format with 2-space indentation
      const newContent = JSON.stringify(parsed, null, 2);

      // Write to disk
      const syncResult = syncToSystem(config.path, newContent, null, true);
      if ('type' in syncResult && syncResult.type === 'conflict') {
        return reply.code(500).send({ error: 'Failed to write config to disk' });
      }

      const sync = syncResult as SyncResult;
      if (!sync.success) {
        return reply.code(500).send({ error: sync.error || 'Failed to write config' });
      }

      // Update database
      await query(
        `UPDATE configs SET content = $1, file_hash = $2, version = version + 1, last_synced_at = NOW(), updated_at = NOW() WHERE id = $3`,
        [newContent, sync.hash, id]
      );

      // Create post-modification snapshot
      await createConfigSnapshot(id, newContent, 'manual', false, 'json');

      return {
        status: 'deleted',
        server: name,
      };
    }
  );

  // GET /api/configs/:id/mcp-servers - List all MCP servers in a config
  fastify.get<{ Params: { id: string } }>(
    '/:id/mcp-servers',
    async (request, reply) => {
      const { id } = request.params;

      // Get config
      const rows = await query<{ id: string; content: string; format: string }>(
        'SELECT id, content, format FROM configs WHERE id = $1',
        [id]
      );
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Config not found' });
      }

      const config = rows[0];
      if (config.format !== 'json') {
        return reply.code(400).send({ error: 'MCP servers can only be read from JSON configs' });
      }

      // Parse content
      let parsed: any;
      try {
        parsed = JSON.parse(config.content);
      } catch {
        return reply.code(400).send({ error: 'Config content is not valid JSON' });
      }

      const servers = parsed.mcpServers || {};

      return {
        servers: Object.entries(servers).map(([name, config]) => ({
          name,
          ...(config as object),
        })),
      };
    }
  );
};

export default configRoutes;
