import { readFile, readdir } from 'fs/promises';
import { join, basename, resolve, isAbsolute } from 'path';
import { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client';
import { getOrCreateSlackCollection } from '../services/kvec-service';

const slackRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /ingest — ingest Slack markdown content into the slack-messages collection
  // Accepts either `content` (raw markdown) or `path` (file to read), not both.
  // Set `mode: "append"` to add content after existing document content.
  fastify.post<{
    Body: {
      content?: string;
      path?: string;
      document_id: string;
      channel: string;
      mode?: 'replace' | 'append';
      metadata?: {
        workspace?: string;
        team?: string;
        topic?: string;
        date_range?: string;
      };
    };
  }>('/ingest', async (request, reply) => {
    const { content: rawContent, path, document_id, channel, mode, metadata } = request.body ?? {} as any;

    if (!document_id || typeof document_id !== 'string') {
      return reply.status(400).send({ error: 'document_id is required' });
    }
    if (!channel || typeof channel !== 'string') {
      return reply.status(400).send({ error: 'channel is required' });
    }
    if (rawContent && path) {
      return reply.status(400).send({ error: 'Provide either content or path, not both' });
    }

    let newContent: string;
    if (path && typeof path === 'string') {
      try {
        newContent = await readFile(path, 'utf-8');
      } catch (err: any) {
        const msg = err.code === 'ENOENT' ? `File not found: ${path}`
          : err.code === 'EISDIR' ? `Path is a directory, not a file: ${path}`
          : `Failed to read file: ${err.message}`;
        return reply.status(400).send({ error: msg });
      }
    } else if (rawContent && typeof rawContent === 'string') {
      newContent = rawContent;
    } else {
      return reply.status(400).send({ error: 'Either content or path is required' });
    }

    const collection = await getOrCreateSlackCollection();

    // Build metadata — channel is always present
    const effectiveMetadata: Record<string, string> = { channel };
    if (path) effectiveMetadata.source_file = path;
    if (metadata?.workspace) effectiveMetadata.workspace = metadata.workspace;
    if (metadata?.team) effectiveMetadata.team = metadata.team;
    if (metadata?.topic) effectiveMetadata.topic = metadata.topic;
    if (metadata?.date_range) effectiveMetadata.date_range = metadata.date_range;

    // Append mode: prepend existing chunk content before new content
    let content = newContent;
    if (mode === 'append') {
      const existingRows = await query<{ content: string }>(
        `SELECT c.content FROM kvec.chunks c
         JOIN kvec.tracked_files tf ON tf.id = c.file_id
         WHERE tf.collection_id = $1 AND tf.file_path = $2 AND tf.repo_id IS NULL
         ORDER BY c.chunk_index ASC`,
        [collection.id, document_id]
      );
      if (existingRows.length > 0) {
        const existingContent = existingRows.map((r) => r.content).join('\n\n');
        content = existingContent + '\n\n' + newContent;
      }
    }

    const chunkCount = await collection.ingestContent(document_id, content, {
      language: 'markdown',
      metadata: effectiveMetadata,
    });

    return reply.status(201).send({
      document_id,
      chunks_created: chunkCount,
      collection: collection.name,
    });
  });

  // POST /ingest-dir — ingest all .md files in a directory
  // Derives document_id from filename (sans extension), channel from filename
  // (strips -messages suffix and -YYYY-MM date suffix).
  fastify.post<{
    Body: {
      path: string;
      channel?: string;
      workspace?: string;
      channel_id?: string;
      workspace_id?: string;
      team?: string;
      topic?: string;
      date_range?: string;
    };
  }>('/ingest-dir', async (request, reply) => {
    const { path: dirPath, channel: channelOverride, ...metaOverrides } = request.body ?? {} as any;

    if (!dirPath || typeof dirPath !== 'string') {
      return reply.status(400).send({ error: 'path (directory) is required' });
    }

    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch (err: any) {
      const msg = err.code === 'ENOENT' ? `Directory not found: ${dirPath}`
        : err.code === 'ENOTDIR' ? `Path is not a directory: ${dirPath}`
        : `Failed to read directory: ${err.message}`;
      return reply.status(400).send({ error: msg });
    }

    const mdFiles = entries.filter(f => f.endsWith('.md')).sort();
    if (mdFiles.length === 0) {
      return reply.status(400).send({ error: `No .md files found in ${dirPath}` });
    }

    // Fire and forget — ingest runs in background
    (async () => {
      try {
        const collection = await getOrCreateSlackCollection();
        for (const file of mdFiles) {
          const documentId = basename(file, '.md');
          const channel = channelOverride
            ?? documentId.replace(/-\d{4}-\d{2}$/, '').replace(/-messages$/, '');

          const metadata: Record<string, string> = {
            channel,
            source_file: join(dirPath, file),
          };
          if (metaOverrides.workspace) metadata.workspace = metaOverrides.workspace;
          if (metaOverrides.channel_id) metadata.channel_id = metaOverrides.channel_id;
          if (metaOverrides.workspace_id) metadata.workspace_id = metaOverrides.workspace_id;
          if (metaOverrides.team) metadata.team = metaOverrides.team;
          if (metaOverrides.topic) metadata.topic = metaOverrides.topic;
          if (metaOverrides.date_range) metadata.date_range = metaOverrides.date_range;

          try {
            const content = await readFile(join(dirPath, file), 'utf-8');
            await collection.ingestContent(documentId, content, {
              language: 'markdown',
              metadata,
            });
          } catch (err: any) {
            fastify.log.error(err, `Failed to ingest slack file: ${file}`);
          }
        }
      } catch (err) {
        fastify.log.error(err, 'Slack directory ingest failed');
      }
    })();

    return reply.status(202).send({
      status: 'started',
      path: dirPath,
      files: mdFiles.length,
    });
  });

  // GET /search — semantic search across ingested Slack content
  fastify.get<{
    Querystring: {
      q: string;
      mode?: string;
      channel?: string;
      workspace?: string;
      limit?: string;
      since?: string;
      until?: string;
    };
  }>('/search', async (request, reply) => {
    const { q, mode, channel, workspace, limit: limitStr, since, until } = request.query;

    if (!q || q.trim().length < 2) {
      return reply.status(400).send({ error: 'q is required (minimum 2 characters)' });
    }

    const searchMode = mode === 'keyword' ? 'keyword' : 'semantic';
    const trimmedQuery = q.trim();
    const limit = Math.min(parseInt(limitStr || '10', 10), 50);
    const collection = await getOrCreateSlackCollection();

    if (searchMode === 'semantic') {
      const filter: Record<string, unknown> = {};
      if (channel) filter.channel = channel;
      if (workspace) filter.workspace = workspace;

      const results = await collection.query(trimmedQuery, {
        limit,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        since: since || undefined,
        until: until || undefined,
      });

      return {
        results: results.map((r) => ({
          content: r.content,
          score: r.score,
          document_id: r.filePath,
          chunk_index: r.chunkIndex,
          metadata: r.metadata,
        })),
        total_count: results.length,
      };
    }

    const conditions = [
      'tf.collection_id = $1',
      'tf.repo_id IS NULL',
      `to_tsvector('english', c.content) @@ plainto_tsquery('english', $2)`,
    ];
    const params: unknown[] = [collection.id, trimmedQuery];
    let paramIndex = 3;

    if (channel) {
      conditions.push(`coalesce(tf.metadata->>'channel', '') = $${paramIndex++}`);
      params.push(channel);
    }
    if (workspace) {
      conditions.push(`coalesce(tf.metadata->>'workspace', '') = $${paramIndex++}`);
      params.push(workspace);
    }

    if (since) {
      conditions.push(`tf.updated_at >= $${paramIndex++}::timestamptz`);
      params.push(since);
    }

    if (until) {
      conditions.push(`tf.updated_at <= $${paramIndex++}::timestamptz`);
      params.push(until);
    }

    params.push(limit);

    const rows = await query<{
      content: string;
      rank: number | string;
      document_id: string;
      chunk_index: number;
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT
         c.content,
         ts_rank_cd(to_tsvector('english', c.content), plainto_tsquery('english', $2)) AS rank,
         tf.file_path AS document_id,
         c.chunk_index,
         tf.metadata
       FROM kvec.chunks c
       JOIN kvec.tracked_files tf ON tf.id = c.file_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY rank DESC, tf.updated_at DESC, c.chunk_index ASC
       LIMIT $${paramIndex}`,
      params
    );

    return {
      results: rows.map((r) => ({
        content: r.content,
        // Keep UI/API shape stable: normalize rank into a 0..1-ish score bucket.
        score: Math.max(0, Math.min(1, Number(r.rank) || 0)),
        document_id: r.document_id,
        chunk_index: r.chunk_index,
        metadata: r.metadata ?? {},
      })),
      total_count: rows.length,
    };
  });

  // GET /channels — list distinct channels from ingested Slack documents
  fastify.get<{
    Querystring: { channel?: string };
  }>('/channels', async (request) => {
    const collection = await getOrCreateSlackCollection();
    const channelFilter = request.query.channel?.trim();

    const conditions = [
      'tf.collection_id = $1',
      'tf.repo_id IS NULL',
      "tf.metadata->>'channel' IS NOT NULL",
    ];
    const params: unknown[] = [collection.id];

    if (channelFilter) {
      params.push(`%${channelFilter}%`);
      conditions.push(`tf.metadata->>'channel' ILIKE $${params.length}`);
    }

    const rows = await query<{ channel: string; document_count: number; chunk_count: number; last_updated: string }>(
      `SELECT
         tf.metadata->>'channel' AS channel,
         COUNT(DISTINCT tf.id)::int AS document_count,
         SUM((SELECT COUNT(*)::int FROM kvec.chunks WHERE file_id = tf.id))::int AS chunk_count,
         MAX(tf.updated_at)::text AS last_updated
       FROM kvec.tracked_files tf
       WHERE ${conditions.join(' AND ')}
       GROUP BY tf.metadata->>'channel'
       ORDER BY tf.metadata->>'channel'`,
      params
    );

    return {
      channels: rows,
      total_count: rows.length,
    };
  });

  // GET /documents — list all ingested Slack documents
  fastify.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      channel?: string;
    };
  }>('/documents', async (request) => {
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 200);
    const offset = parseInt(request.query.offset || '0', 10);
    const channelFilter = request.query.channel?.trim();

    const collection = await getOrCreateSlackCollection();

    const conditions = ['collection_id = $1'];
    const params: unknown[] = [collection.id];

    if (channelFilter) {
      params.push(channelFilter);
      conditions.push(`metadata->>'channel' = $${params.length}`);
    }

    const where = conditions.join(' AND ');

    const countResult = await query(
      `SELECT COUNT(*)::int AS count FROM kvec.tracked_files WHERE ${where}`,
      params
    );
    const totalCount = countResult[0]?.count ?? 0;

    const rows = await query(
      `SELECT id, file_path AS document_id, content_hash, file_size, language,
              status, metadata, uploaded_at, updated_at,
              (SELECT COUNT(*)::int FROM kvec.chunks WHERE file_id = tf.id) AS chunk_count
       FROM kvec.tracked_files tf
       WHERE ${where}
       ORDER BY updated_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return {
      documents: rows,
      pagination: {
        total_count: totalCount,
        limit,
        offset,
        has_more: offset + limit < totalCount,
      },
    };
  });

  // GET /documents/:documentId — check if a document exists and get its metadata
  fastify.get<{
    Params: { documentId: string };
  }>('/documents/:documentId', async (request, reply) => {
    const { documentId } = request.params;

    const collection = await getOrCreateSlackCollection();
    const rows = await query(
      `SELECT tf.id, tf.file_path AS document_id, tf.file_size, tf.metadata, tf.uploaded_at, tf.updated_at,
              (SELECT COUNT(*)::int FROM kvec.chunks WHERE file_id = tf.id) AS chunk_count
       FROM kvec.tracked_files tf
       WHERE tf.collection_id = $1 AND tf.file_path = $2 AND tf.repo_id IS NULL
       LIMIT 1`,
      [collection.id, documentId]
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Document not found' });
    }

    return { document: rows[0] };
  });

  // DELETE /documents/:documentId — remove an ingested document
  fastify.delete<{
    Params: { documentId: string };
  }>('/documents/:documentId', async (request, reply) => {
    const { documentId } = request.params;

    const collection = await getOrCreateSlackCollection();
    const deleted = await collection.deleteDocument(documentId);

    if (!deleted) {
      return reply.status(404).send({ error: 'Document not found' });
    }

    return reply.status(204).send();
  });

  // ============ Registered Channel Management ============

  // GET /channels/registered — list channels tracked for export
  fastify.get<{
    Querystring: { workspace?: string };
  }>('/channels/registered', async (request) => {
    const { workspace } = request.query;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (workspace) {
      params.push(workspace);
      conditions.push(`(workspace_id = $${params.length} OR workspace_name = $${params.length})`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await query(
      `SELECT * FROM slack_channels ${where} ORDER BY workspace_name, channel_name`,
      params
    );

    return { channels: rows, total_count: rows.length };
  });

  // POST /channels/register — register a channel for tracking
  fastify.post<{
    Body: {
      channel_id: string;
      workspace_id: string;
      workspace_name?: string;
      channel_name: string;
      channel_type?: string;
      export_path?: string;
    };
  }>('/channels/register', async (request, reply) => {
    const { channel_id, workspace_id, workspace_name, channel_name, channel_type, export_path } = request.body ?? {} as any;

    if (!channel_id || !workspace_id || !channel_name) {
      return reply.status(400).send({ error: 'channel_id, workspace_id, and channel_name are required' });
    }

    const rows = await query(
      `INSERT INTO slack_channels (channel_id, workspace_id, workspace_name, channel_name, channel_type, export_path)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, channel_id) DO UPDATE SET
         workspace_name = COALESCE(EXCLUDED.workspace_name, slack_channels.workspace_name),
         channel_name = EXCLUDED.channel_name,
         channel_type = COALESCE(EXCLUDED.channel_type, slack_channels.channel_type),
         export_path = COALESCE(EXCLUDED.export_path, slack_channels.export_path),
         updated_at = NOW()
       RETURNING *`,
      [channel_id, workspace_id, workspace_name || null, channel_name, channel_type || 'dm', export_path || null]
    );

    return reply.status(201).send({ channel: rows[0] });
  });

  // PATCH /channels/registered/:id — update channel metadata
  fastify.patch<{
    Params: { id: string };
    Body: {
      channel_name?: string;
      workspace_name?: string;
      channel_type?: string;
      export_path?: string;
      last_message_ts?: string;
      last_exported_at?: string;
      message_count?: number;
    };
  }>('/channels/registered/:id', async (request, reply) => {
    const { id } = request.params;
    const updates = request.body ?? {};

    const setClauses: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];

    const fields = ['channel_name', 'workspace_name', 'channel_type', 'export_path', 'last_message_ts', 'last_exported_at', 'message_count'] as const;
    for (const field of fields) {
      if (updates[field] !== undefined) {
        params.push(updates[field]);
        setClauses.push(`${field} = $${params.length}`);
      }
    }

    if (params.length === 0) {
      return reply.status(400).send({ error: 'No fields to update' });
    }

    params.push(id);
    const rows = await query(
      `UPDATE slack_channels SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Channel not found' });
    }

    return { channel: rows[0] };
  });

  // DELETE /channels/registered/:id — unregister a channel
  fastify.delete<{
    Params: { id: string };
  }>('/channels/registered/:id', async (request, reply) => {
    const { id } = request.params;

    const rows = await query('DELETE FROM slack_channels WHERE id = $1 RETURNING id', [id]);
    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Channel not found' });
    }

    return reply.status(204).send();
  });

  // POST /channels/registered/:id/sync — trigger kdag sync job for a channel
  // Delegates to the kdag job API endpoints for proper job creation and execution.
  fastify.post<{
    Params: { id: string };
  }>('/channels/registered/:id/sync', async (request, reply) => {
    const { id } = request.params;

    const rows = await query('SELECT * FROM slack_channels WHERE id = $1', [id]);
    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Channel not found' });
    }

    const channel = rows[0] as any;

    // Resolve monorepo root (API runs from apps/api)
    const repoRoot = join(process.cwd(), '..', '..');

    // Read default export dir from settings, fall back to 'chats'
    const settingRows = await query("SELECT value FROM settings WHERE key = 'slack.exportDir'");
    const defaultExportDir = (settingRows[0] as any)?.value || 'chats';
    const relExportPath = channel.export_path || `${defaultExportDir}/${channel.channel_name}`;

    // Always pass an absolute export_path so the script works regardless of cwd
    const exportPath = isAbsolute(relExportPath) ? relExportPath : resolve(repoRoot, relExportPath);

    // Create job via kdag API (self-call via localhost)
    const apiBase = `http://localhost:${process.env.PORT || 3100}`;
    const createRes = await fetch(`${apiBase}/api/kdag/job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        definition_key: 'slack-channel-sync',
        project_id: 'khef',
        inputs: {
          channel_id: channel.channel_id,
          workspace_id: channel.workspace_id,
          workspace_name: channel.workspace_name || channel.workspace_id,
          channel_name: channel.channel_name,
          last_message_ts: channel.last_message_ts || '',
          export_path: exportPath,
          slack_channel_db_id: channel.id,
        },
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({ error: 'Failed to create job' }));
      return reply.status(createRes.status).send(err);
    }

    const jobData = await createRes.json() as any;
    const jobId = jobData.job?.id || jobData.id;

    // Run the job via kdag API
    const runRes = await fetch(`${apiBase}/api/kdag/job/${jobId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    if (!runRes.ok) {
      const err = await runRes.json().catch(() => ({ error: 'Failed to run job' }));
      return reply.status(runRes.status).send(err);
    }

    const run = await runRes.json() as any;

    return reply.status(201).send({
      job_id: jobId,
      run_id: run.run_id,
      channel: channel.channel_name,
      status: run.status || 'running',
    });
  });
};

export default slackRoutes;
