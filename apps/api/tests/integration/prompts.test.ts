import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setupTestDb, TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import promptsRoutes from '../../src/routes/prompts';

describe('Prompts API', () => {
  let app: FastifyInstance;
  let client: Client;
  let tempRoot: string;
  let claudeAgentsDir: string;
  let claudeCommandsDir: string;
  let codexPromptsDir: string;
  let claudeCodeAssistantId: string;
  let codexCliAssistantId: string;

  beforeAll(async () => {
    await setupTestDb();

    // Create temp directories for disk sync tests
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khef-prompts-'));
    claudeAgentsDir = path.join(tempRoot, 'claude-agents');
    claudeCommandsDir = path.join(tempRoot, 'claude-commands');
    codexPromptsDir = path.join(tempRoot, 'codex-prompts');

    fs.mkdirSync(claudeAgentsDir, { recursive: true });
    fs.mkdirSync(claudeCommandsDir, { recursive: true });
    fs.mkdirSync(codexPromptsDir, { recursive: true });

    app = Fastify();
    app.register(promptsRoutes, { prefix: '/api/prompts' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();

    // Get assistant IDs for use in tests
    const assistants = await client.query(`
      SELECT id, handle FROM assistants WHERE handle IN ('claude-code', 'codex-cli')
    `);
    for (const row of assistants.rows) {
      if (row.handle === 'claude-code') claudeCodeAssistantId = row.id;
      if (row.handle === 'codex-cli') codexCliAssistantId = row.id;
    }
  });

  afterAll(async () => {
    await client.end();
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clean up prompts and related tables
    await client.query('TRUNCATE prompts CASCADE');
  });

  describe('CRUD Operations', () => {
    it('creates a prompt', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/prompts?compact=false',
        payload: {
          handle: 'test-prompt',
          title: 'Test Prompt',
          content: 'This is test content',
          description: 'A test prompt'
        }
      });

      expect(res.statusCode).toBe(201);
      const { prompt } = JSON.parse(res.payload);
      expect(prompt.handle).toBe('test-prompt');
      expect(prompt.title).toBe('Test Prompt');
      expect(prompt.content).toBe('This is test content');
      expect(prompt.description).toBe('A test prompt');
    });

    it('rejects duplicate handle', async () => {
      // Create first prompt
      await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'unique-handle',
          title: 'First Prompt',
          content: 'Content'
        }
      });

      // Try to create with same handle
      const res = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'unique-handle',
          title: 'Second Prompt',
          content: 'Different content'
        }
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error).toContain('already exists');
    });

    it('gets a prompt by ID', async () => {
      // Create prompt
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'get-test',
          title: 'Get Test',
          content: 'Content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      // Get it
      const res = await app.inject({
        method: 'GET',
        url: `/api/prompts/${created.id}`
      });

      expect(res.statusCode).toBe(200);
      const { prompt } = JSON.parse(res.payload);
      expect(prompt.id).toBe(created.id);
      expect(prompt.handle).toBe('get-test');
      expect(prompt.current_snapshot).toBe(1);
      expect(prompt.assistants).toEqual([]);
    });

    it('returns 404 for non-existent prompt', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/prompts/00000000-0000-0000-0000-000000000000'
      });

      expect(res.statusCode).toBe(404);
    });

    it('lists prompts with pagination', async () => {
      // Create multiple prompts
      for (let i = 1; i <= 5; i++) {
        await app.inject({
          method: 'POST',
          url: '/api/prompts',
          payload: {
            handle: `prompt-${i}`,
            title: `Prompt ${i}`,
            content: `Content ${i}`
          }
        });
      }

      // List with limit
      const res = await app.inject({
        method: 'GET',
        url: '/api/prompts?limit=2&offset=0'
      });

      expect(res.statusCode).toBe(200);
      const { prompts, pagination } = JSON.parse(res.payload);
      expect(prompts.length).toBe(2);
      expect(pagination.total_count).toBe(5);
      expect(pagination.has_more).toBe(true);
    });

    it('updates a prompt', async () => {
      // Create prompt
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'update-test',
          title: 'Original Title',
          content: 'Original content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      // Update it
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/prompts/${created.id}?compact=false`,
        payload: {
          title: 'Updated Title',
          content: 'Updated content',
          description: 'New description'
        }
      });

      expect(res.statusCode).toBe(200);
      const { prompt } = JSON.parse(res.payload);
      expect(prompt.title).toBe('Updated Title');
      expect(prompt.content).toBe('Updated content');
      expect(prompt.description).toBe('New description');
    });

    it('deletes a prompt', async () => {
      // Create prompt
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'delete-test',
          title: 'Delete Test',
          content: 'Content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      // Delete it
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/prompts/${created.id}`
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).success).toBe(true);

      // Verify deleted
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/prompts/${created.id}`
      });
      expect(getRes.statusCode).toBe(404);
    });
  });

  describe('Manual Snapshots', () => {
    it('creates a manual snapshot', async () => {
      // Create prompt
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'snapshot-test',
          title: 'Snapshot Test',
          content: 'Initial content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      // Create snapshot
      const res = await app.inject({
        method: 'POST',
        url: `/api/prompts/${created.id}/snapshots`
      });

      expect(res.statusCode).toBe(201);
      const { snapshot } = JSON.parse(res.payload);
      expect(snapshot.snapshot_number).toBe(1);
      expect(snapshot.content).toBe('Initial content');
      expect(snapshot.source).toBe('manual');
    });

    it('increments snapshot number on multiple snapshots', async () => {
      // Create prompt
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'multi-snapshot',
          title: 'Multi Snapshot',
          content: 'Content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      // Create first snapshot
      await app.inject({
        method: 'POST',
        url: `/api/prompts/${created.id}/snapshots`
      });

      // Create second snapshot
      const res = await app.inject({
        method: 'POST',
        url: `/api/prompts/${created.id}/snapshots`
      });

      expect(res.statusCode).toBe(201);
      const { snapshot } = JSON.parse(res.payload);
      expect(snapshot.snapshot_number).toBe(2);
    });

    it('returns 404 for snapshot of non-existent prompt', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/prompts/00000000-0000-0000-0000-000000000000/snapshots'
      });

      expect(res.statusCode).toBe(404);
    });

    it('lists snapshots', async () => {
      // Create prompt
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'list-snapshots',
          title: 'List Snapshots',
          content: 'Content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      // Create two snapshots
      await app.inject({
        method: 'POST',
        url: `/api/prompts/${created.id}/snapshots`
      });
      await app.inject({
        method: 'POST',
        url: `/api/prompts/${created.id}/snapshots`
      });

      // List snapshots
      const res = await app.inject({
        method: 'GET',
        url: `/api/prompts/${created.id}/snapshots`
      });

      expect(res.statusCode).toBe(200);
      const { snapshots } = JSON.parse(res.payload);
      expect(snapshots.length).toBe(2);
      // Ordered by snapshot_number DESC
      expect(snapshots[0].snapshot_number).toBe(2);
      expect(snapshots[1].snapshot_number).toBe(1);
    });

    it('gets a specific snapshot', async () => {
      // Create prompt
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'get-snapshot',
          title: 'Get Snapshot',
          content: 'Snapshot content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      // Create snapshot
      await app.inject({
        method: 'POST',
        url: `/api/prompts/${created.id}/snapshots`
      });

      // Get snapshot
      const res = await app.inject({
        method: 'GET',
        url: `/api/prompts/${created.id}/snapshots/1`
      });

      expect(res.statusCode).toBe(200);
      const { snapshot } = JSON.parse(res.payload);
      expect(snapshot.snapshot_number).toBe(1);
      expect(snapshot.content).toBe('Snapshot content');
    });

    it('creates automatic snapshot on content update', async () => {
      // Create prompt
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'auto-snapshot',
          title: 'Auto Snapshot',
          content: 'Original content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      // Update content
      await app.inject({
        method: 'PATCH',
        url: `/api/prompts/${created.id}`,
        payload: { content: 'Updated content' }
      });

      // Check snapshots - should have one from the update
      const listRes = await app.inject({
        method: 'GET',
        url: `/api/prompts/${created.id}/snapshots`
      });

      expect(listRes.statusCode).toBe(200);
      const { snapshots } = JSON.parse(listRes.payload);
      expect(snapshots.length).toBe(1);
      expect(snapshots[0].source).toBe('manual');

      // Fetch specific snapshot to verify content
      const snapshotRes = await app.inject({
        method: 'GET',
        url: `/api/prompts/${created.id}/snapshots/${snapshots[0].snapshot_number}`
      });
      expect(snapshotRes.statusCode).toBe(200);
      const { snapshot } = JSON.parse(snapshotRes.payload);
      expect(snapshot.content).toBe('Original content');
    });

    it('diffs a historical prompt snapshot against current', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'prompt-diff-test',
          title: 'Prompt Diff Test',
          content: 'line 1\nline 2\n'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      await app.inject({
        method: 'POST',
        url: `/api/prompts/${created.id}/snapshots`
      });

      await app.inject({
        method: 'PATCH',
        url: `/api/prompts/${created.id}`,
        payload: { content: 'line 1\nline 2 changed\nline 3\n' }
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/prompts/${created.id}/snapshots/diff?from=1&to=current`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.prompt_id).toBe(created.id);
      expect(body.from.snapshot_number).toBe(1);
      expect(body.to.source).toBe('current');
      expect(body.changes.some((c: { type: string }) => c.type === 'add' || c.type === 'remove')).toBe(true);
    });

    it('validates prompt snapshot diff params', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'prompt-diff-validation',
          title: 'Prompt Diff Validation',
          content: 'content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      const res = await app.inject({
        method: 'GET',
        url: `/api/prompts/${created.id}/snapshots/diff?from=abc&to=current`
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('from');
    });

    it('deletes a prompt snapshot', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'delete-prompt-snapshot',
          title: 'Delete Prompt Snapshot',
          content: 'snapshot content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      await app.inject({
        method: 'POST',
        url: `/api/prompts/${created.id}/snapshots`
      });

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/prompts/${created.id}/snapshots/1`
      });

      expect(deleteRes.statusCode).toBe(204);

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/prompts/${created.id}/snapshots`
      });
      expect(listRes.statusCode).toBe(200);
      expect(JSON.parse(listRes.payload).snapshots).toHaveLength(0);
    });
  });

  describe('Assistant Associations', () => {
    it('adds an assistant association', async () => {
      // Create prompt
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'assoc-test',
          title: 'Association Test',
          content: 'Content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      // Add association
      const res = await app.inject({
        method: 'POST',
        url: `/api/prompts/${created.id}/assistants`,
        payload: {
          assistant_handle: 'claude-code',
          prompt_type: 'agent'
        }
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.payload).success).toBe(true);

      // Verify association
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/prompts/${created.id}`
      });
      const { prompt } = JSON.parse(getRes.payload);
      expect(prompt.assistants.length).toBe(1);
      expect(prompt.assistants[0].assistant_handle).toBe('claude-code');
      expect(prompt.assistants[0].prompt_type).toBe('agent');
    });

    it('removes an assistant association', async () => {
      // Create prompt with association
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'remove-assoc',
          title: 'Remove Association',
          content: 'Content',
          assistants: [{
            assistant_handle: 'claude-code',
            prompt_type: 'command'
          }]
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      // Remove association
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/prompts/${created.id}/assistants/claude-code`
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).success).toBe(true);

      // Verify removed
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/prompts/${created.id}`
      });
      const { prompt } = JSON.parse(getRes.payload);
      expect(prompt.assistants.length).toBe(0);
    });

    it('rejects duplicate association', async () => {
      // Create prompt
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'dup-assoc',
          title: 'Dup Association',
          content: 'Content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      // Add association
      await app.inject({
        method: 'POST',
        url: `/api/prompts/${created.id}/assistants`,
        payload: {
          assistant_handle: 'claude-code',
          prompt_type: 'agent'
        }
      });

      // Try to add again
      const res = await app.inject({
        method: 'POST',
        url: `/api/prompts/${created.id}/assistants`,
        payload: {
          assistant_handle: 'claude-code',
          prompt_type: 'agent'
        }
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error).toContain('already associated');
    });

    it('creates prompt with assistant associations', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'with-assistants',
          title: 'With Assistants',
          content: 'Content',
          assistants: [
            { assistant_handle: 'claude-code', prompt_type: 'agent' },
            { assistant_handle: 'codex-cli', prompt_type: 'prompt' }
          ]
        }
      });

      expect(res.statusCode).toBe(201);

      // Fetch and verify
      const created = JSON.parse(res.payload).prompt;
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/prompts/${created.id}`
      });
      const { prompt } = JSON.parse(getRes.payload);
      expect(prompt.assistants.length).toBe(2);
    });
  });

  describe('Filtering', () => {
    beforeEach(async () => {
      // Create prompts with different assistant associations
      const prompt1 = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'claude-only',
          title: 'Claude Only Prompt',
          content: 'Content'
        }
      });
      const p1 = JSON.parse(prompt1.payload).prompt;
      await app.inject({
        method: 'POST',
        url: `/api/prompts/${p1.id}/assistants`,
        payload: { assistant_handle: 'claude-code', prompt_type: 'agent' }
      });

      const prompt2 = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'codex-only',
          title: 'Codex Only Prompt',
          content: 'Content'
        }
      });
      const p2 = JSON.parse(prompt2.payload).prompt;
      await app.inject({
        method: 'POST',
        url: `/api/prompts/${p2.id}/assistants`,
        payload: { assistant_handle: 'codex-cli', prompt_type: 'prompt' }
      });

      const prompt3 = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'universal',
          title: 'Universal Prompt',
          content: 'Content'
        }
      });
      // No assistant - universal
    });

    it('filters by assistant', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/prompts?assistant=claude-code'
      });

      expect(res.statusCode).toBe(200);
      const { prompts } = JSON.parse(res.payload);
      expect(prompts.length).toBe(1);
      expect(prompts[0].handle).toBe('claude-only');
    });

    it('filters by assistant and type', async () => {
      // Add command type association
      const allRes = await app.inject({
        method: 'GET',
        url: '/api/prompts'
      });
      const claudePrompt = JSON.parse(allRes.payload).prompts.find(
        (p: any) => p.handle === 'claude-only'
      );

      // Add command type (already has agent type)
      // This test checks that type filter works
      const res = await app.inject({
        method: 'GET',
        url: '/api/prompts?assistant=claude-code&type=agent'
      });

      expect(res.statusCode).toBe(200);
      const { prompts } = JSON.parse(res.payload);
      expect(prompts.length).toBe(1);
    });

    it('returns all prompts without filter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/prompts'
      });

      expect(res.statusCode).toBe(200);
      const { prompts } = JSON.parse(res.payload);
      expect(prompts.length).toBe(3);
    });
  });

  describe('Disk Sync', () => {
    it('syncs to disk file', async () => {
      const filePath = path.join(claudeAgentsDir, 'sync-test.md');

      // Create prompt with source_path
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'sync-test',
          title: 'Sync Test',
          content: 'DB content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      // Add association with source_path
      await client.query(
        `INSERT INTO assistant_prompts (prompt_id, assistant_id, prompt_type, source_path)
         VALUES ($1, $2, $3, $4)`,
        [created.id, claudeCodeAssistantId, 'agent', filePath]
      );

      // Trigger sync
      const res = await app.inject({
        method: 'POST',
        url: `/api/prompts/${created.id}/sync`
      });

      expect(res.statusCode).toBe(200);
      const { synced } = JSON.parse(res.payload);
      expect(synced.length).toBe(1);
      expect(synced[0].assistant).toBe('claude-code');

      // Verify file was created
      expect(fs.existsSync(filePath)).toBe(true);
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      expect(fileContent.trim()).toBe('DB content');
    });

    it('detects conflict when file was modified externally', async () => {
      const filePath = path.join(claudeAgentsDir, 'conflict-test.md');
      fs.writeFileSync(filePath, 'Initial content', 'utf-8');

      // Create prompt
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'conflict-test',
          title: 'Conflict Test',
          content: 'DB content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      // Add association with source_path and a hash
      const { createHash } = await import('crypto');
      const initialHash = createHash('sha256').update('Initial content').digest('hex');
      await client.query(
        `INSERT INTO assistant_prompts (prompt_id, assistant_id, prompt_type, source_path, file_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [created.id, claudeCodeAssistantId, 'agent', filePath, initialHash]
      );

      // Modify file externally
      fs.writeFileSync(filePath, 'External modification', 'utf-8');

      // Try to sync - should detect conflict
      const res = await app.inject({
        method: 'POST',
        url: `/api/prompts/${created.id}/sync`
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('External file changes');
      expect(body.conflicts.length).toBe(1);
    });

    it('force syncs overwriting external changes', async () => {
      const filePath = path.join(claudeAgentsDir, 'force-sync-test.md');
      fs.writeFileSync(filePath, 'Initial content', 'utf-8');

      // Create prompt
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'force-sync-test',
          title: 'Force Sync Test',
          content: 'DB content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      // Add association with source_path and a hash
      const { createHash } = await import('crypto');
      const initialHash = createHash('sha256').update('Initial content').digest('hex');
      await client.query(
        `INSERT INTO assistant_prompts (prompt_id, assistant_id, prompt_type, source_path, file_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [created.id, claudeCodeAssistantId, 'agent', filePath, initialHash]
      );

      // Modify file externally
      fs.writeFileSync(filePath, 'External modification', 'utf-8');

      // Force sync
      const res = await app.inject({
        method: 'POST',
        url: `/api/prompts/${created.id}/sync?force=true`
      });

      expect(res.statusCode).toBe(200);
      const { synced } = JSON.parse(res.payload);
      expect(synced.length).toBe(1);

      // Verify file was overwritten
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      expect(fileContent.trim()).toBe('DB content');
    });

    it('gets sync status', async () => {
      const filePath = path.join(claudeAgentsDir, 'status-test.md');
      fs.writeFileSync(filePath, 'File content', 'utf-8');

      // Create prompt
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/prompts',
        payload: {
          handle: 'status-test',
          title: 'Status Test',
          content: 'DB content'
        }
      });
      const created = JSON.parse(createRes.payload).prompt;

      // Add association with source_path
      const { createHash } = await import('crypto');
      const fileHash = createHash('sha256').update('File content').digest('hex');
      await client.query(
        `INSERT INTO assistant_prompts (prompt_id, assistant_id, prompt_type, source_path, file_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [created.id, claudeCodeAssistantId, 'agent', filePath, fileHash]
      );

      // Get sync status - should be synced
      const res = await app.inject({
        method: 'GET',
        url: `/api/prompts/${created.id}/sync`
      });

      expect(res.statusCode).toBe(200);
      const { status } = JSON.parse(res.payload);
      expect(status.length).toBe(1);
      expect(status[0].status).toBe('synced');

      // Modify file
      fs.writeFileSync(filePath, 'Modified content', 'utf-8');

      // Get sync status - should be modified_externally
      const res2 = await app.inject({
        method: 'GET',
        url: `/api/prompts/${created.id}/sync`
      });

      const { status: status2 } = JSON.parse(res2.payload);
      expect(status2[0].status).toBe('modified_externally');

      // Delete file
      fs.unlinkSync(filePath);

      // Get sync status - should be missing
      const res3 = await app.inject({
        method: 'GET',
        url: `/api/prompts/${created.id}/sync`
      });

      const { status: status3 } = JSON.parse(res3.payload);
      expect(status3[0].status).toBe('missing');
    });
  });

  describe('Discovery', () => {
    it('discovers prompts from disk', async () => {
      // Create a file in the temp directory
      // Note: We need to override the discovery path for testing
      // For now, test that the endpoint returns without error
      const res = await app.inject({
        method: 'POST',
        url: '/api/prompts/discover'
      });

      expect(res.statusCode).toBe(200);
      const { results } = JSON.parse(res.payload);
      // May be empty if no files exist in default paths
      expect(Array.isArray(results)).toBe(true);
    });

    it('discovers prompts for specific assistant', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/prompts/discover/claude-code'
      });

      expect(res.statusCode).toBe(200);
      const { results } = JSON.parse(res.payload);
      expect(Array.isArray(results)).toBe(true);
    });

    it('returns 404 for unknown assistant in discovery', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/prompts/discover/unknown-assistant'
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
