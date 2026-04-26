import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { setupTestDb, cleanupTestDb, TEST_DATABASE_URL } from '../setup';

// Set env before importing routes
process.env.DATABASE_URL = TEST_DATABASE_URL;

import projectRoutes from '../../src/routes/projects';
import projectMemoryRoutes from '../../src/routes/project-memories';
import memoryTypeRoutes from '../../src/routes/memory-types';

describe('Normalized Status System Integration Tests', () => {
  let app: FastifyInstance;
  let client: Client;
  let projectId: string;
  let memoryTypeIds: Record<string, string> = {};
  let statusIds: Record<string, Record<string, string>> = {};

  beforeAll(async () => {
    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(projectMemoryRoutes, { prefix: '/api/projects/:projectId/memories' });
    app.register(memoryTypeRoutes, { prefix: '/api/memory-types' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();

    // Cache memory type IDs for tests
    const types = await client.query('SELECT id, name FROM memory_types');
    types.rows.forEach(row => {
      memoryTypeIds[row.name] = row.id;
    });

    // Cache status IDs for each type
    const statuses = await client.query(`
      SELECT mts.id, mt.name as type_name, mts.status_value
      FROM memory_type_statuses mts
      JOIN memory_types mt ON mts.memory_type_id = mt.id
    `);
    statuses.rows.forEach(row => {
      if (!statusIds[row.type_name]) {
        statusIds[row.type_name] = {};
      }
      statusIds[row.type_name][row.status_value] = row.id;
    });
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE projects CASCADE');

    const result = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Test Project', description: 'A test project' }
    });

    projectId = JSON.parse(result.payload).project.id;
  });

  describe('Memory Type Discovery', () => {
    it('should list all memory types with their statuses', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/memory-types'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memory_types.length).toBeGreaterThanOrEqual(16);

      const todoType = body.memory_types.find((t: any) => t.type === 'user-todo');
      expect(todoType).toBeDefined();
      expect(todoType.statuses).toBeDefined();
      expect(todoType.statuses.some((s: any) => s.value === 'open')).toBe(true);
      expect(todoType.statuses.some((s: any) => s.value === 'in_progress')).toBe(true);
    });

    it('should get statuses for a specific memory type', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/memory-types/user-todo/statuses'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memory_type).toBe('user-todo');
      expect(body.statuses).toHaveLength(6); // open, in_progress, on_hold, blocked, done, canceled
      expect(body.statuses[0].value).toBe('open');
      expect(body.statuses[0].display_name).toBe('To Do');
      expect(body.statuses[0].sort_order).toBe(0);
    });

    it('should return 404 for unknown memory type', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/memory-types/invalid-type/statuses'
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Creating Memories with Type', () => {
    it('should create a todo memory without status', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories?compact=false`,
        payload: {
          handle: 'implement-feature-x',
          title: 'Implement feature X',
          content: 'Implement feature X',
          type: 'user-todo', // API accepts string, converts to memory_type_id internally
          tags: ['feature']
        }
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.memory.content).toBe('Implement feature X');
      expect(body.memory.memory_type_id).toBe(memoryTypeIds['user-todo']);
      // All memories now have default status (backlog for todo type)
      expect(body.memory.status_id).toBeDefined();
      expect(body.memory.status_id).not.toBeNull();
    });

    it('should create a decision memory with default status', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories?compact=false`,
        payload: {
          handle: 'postgresql-for-persistence',
          title: 'PostgreSQL for persistence',
          content: 'Use PostgreSQL for persistence',
          type: 'decision'
        }
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.memory.memory_type_id).toBe(memoryTypeIds.decision);
      // All memories now have default status (proposed for decision type)
      expect(body.memory.status_id).toBeDefined();
      expect(body.memory.status_id).not.toBeNull();
    });
  });

  describe('Setting Memory Status', () => {
    it('should set status on a todo memory', async () => {
      // Create todo
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'fix-bug', title: 'Fix bug', content: 'Fix bug', type: 'user-todo' }
      });
      const memoryId = JSON.parse(createRes.payload).memory.id;

      // Set status to in_progress
      const statusRes = await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/memories/${memoryId}/status`,
        payload: { status: 'in_progress' } // API accepts string, converts to status_id
      });

      expect(statusRes.statusCode).toBe(200);
      const body = JSON.parse(statusRes.payload);
      expect(body.memory_id).toBe(memoryId);
      expect(body.status).toBe('in_progress');
      expect(body.updated_at).toBeDefined();
    });

    it('should update existing status', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'task', title: 'Task', content: 'Task', type: 'user-todo' }
      });
      const memoryId = JSON.parse(createRes.payload).memory.id;

      // Set to in_progress
      await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/memories/${memoryId}/status`,
        payload: { status: 'in_progress' }
      });

      // Update to done
      const updateRes = await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/memories/${memoryId}/status`,
        payload: { status: 'done' }
      });

      expect(updateRes.statusCode).toBe(200);
      const body = JSON.parse(updateRes.payload);
      expect(body.status).toBe('done');
    });

  });

  describe('Status Validation', () => {
    it('should reject invalid status for memory type', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'invalid-status-task', title: 'Invalid status task', content: 'Task', type: 'user-todo' }
      });
      const memoryId = JSON.parse(createRes.payload).memory.id;

      // Try to set decision status on todo memory
      const statusRes = await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/memories/${memoryId}/status`,
        payload: { status: 'proposed' } // valid for decision, not todo
      });

      expect(statusRes.statusCode).toBe(400);
      expect(statusRes.payload).toContain('does not match memory type');
    });

    it('should reject unknown status value', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'unknown-status-task', title: 'Unknown status task', content: 'Task', type: 'user-todo' }
      });
      const memoryId = JSON.parse(createRes.payload).memory.id;

      const statusRes = await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/memories/${memoryId}/status`,
        payload: { status: 'invalid-status' }
      });

      expect(statusRes.statusCode).toBe(400);
    });
  });

  describe('Querying Memories with Status', () => {
    beforeEach(async () => {
      // Create multiple todos with different statuses
      const tasks = [
        { content: 'Task 1', status: 'open' }, // Explicitly set to default
        { content: 'Task 2', status: 'in_progress' },
        { content: 'Task 3', status: 'done' },
        { content: 'Task 4', status: 'blocked' }, // Different non-default status
      ];

      for (const [idx, task] of tasks.entries()) {
        const createRes = await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/memories`,
          payload: { handle: `task-${idx + 1}`, title: `Task ${idx + 1}`, content: task.content, type: 'user-todo' }
        });

        // All tasks get updated to their specified status
        const memoryId = JSON.parse(createRes.payload).memory.id;
        await app.inject({
          method: 'PUT',
          url: `/api/projects/${projectId}/memories/${memoryId}/status`,
          payload: { status: task.status }
        });
      }
    });

    it('should filter memories by status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?type=user-todo&status=in_progress`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0].content).toBe('Task 2');
      expect(body.memories[0].status).toBe('in_progress');
    });

    it('should include status in memory list response', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memories.length).toBeGreaterThan(0);

      // Memories with status should have it populated
      const withStatus = body.memories.find((m: any) => m.status === 'done');
      expect(withStatus).toBeDefined();
      expect(withStatus.status_updated_at).toBeDefined();

      // All memories now have a status (no null statuses)
      const task4 = body.memories.find((m: any) => m.content === 'Task 4');
      expect(task4.status).toBe('blocked');
      expect(task4.status_updated_at).toBeDefined();
    });

    it('should filter by type and status together', async () => {
      // Create a decision with status
      const decisionRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'redis-decision', title: 'Redis decision', content: 'Use Redis', type: 'decision' }
      });
      const decisionId = JSON.parse(decisionRes.payload).memory.id;
      await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/memories/${decisionId}/status`,
        payload: { status: 'accepted' }
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?type=decision&status=accepted`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0].content).toBe('Use Redis');
    });
  });

  describe('Semantic Status Queries (Replacing active column)', () => {
    it('should query active assistant rules using status', async () => {
      // Create assistant rules with different statuses
      const activeRule = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'no-claude-signatures', title: 'No Claude signatures', content: 'No Claude signatures', type: 'assistant-rule' }
      });
      const activeId = JSON.parse(activeRule.payload).memory.id;
      await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/memories/${activeId}/status`,
        payload: { status: 'active' }
      });

      const deprecatedRule = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'old-rule', title: 'Old rule', content: 'Old rule', type: 'assistant-rule' }
      });
      const deprecatedId = JSON.parse(deprecatedRule.payload).memory.id;
      await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/memories/${deprecatedId}/status`,
        payload: { status: 'deprecated' }
      });

      // Query for active assistant rules
      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?type=assistant-rule&status=active`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      // Multiple active rules may exist due to project seeding; ensure our created one is present
      expect(Array.isArray(body.memories)).toBe(true);
      const hasRule = body.memories.some((m: any) => m.content === 'No Claude signatures');
      expect(hasRule).toBe(true);
    });

    it('should query non-superseded decisions', async () => {
      const decisions = [
        { content: 'Use MySQL', status: 'superseded' },
        { content: 'Use PostgreSQL', status: 'accepted' },
        { content: 'Use MongoDB', status: 'rejected' },
      ];

      for (const dec of decisions) {
        const createRes = await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/memories`,
          payload: { handle: dec.content.toLowerCase().replace(/\s+/g, '-'), title: dec.content, content: dec.content, type: 'decision' }
        });
        const id = JSON.parse(createRes.payload).memory.id;
        await app.inject({
          method: 'PUT',
          url: `/api/projects/${projectId}/memories/${id}/status`,
          payload: { status: dec.status }
        });
      }

      // Query for accepted decisions (current)
      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?type=decision&status=accepted`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0].content).toBe('Use PostgreSQL');
    });

    it('should include memories with default status', async () => {
      // Create memory - gets default status automatically
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'current-note', title: 'Current note', content: 'Current note', type: 'user-note' }
      });

      // Query should include it
      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?type=user-note`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memories.length).toBeGreaterThan(0);
      const note = body.memories.find((m: any) => m.content === 'Current note');
      expect(note).toBeDefined();
      expect(note.status).toBe('transient'); // Default status for user-note type
    });
  });

  describe('Status in Memory Details', () => {
    it('should include status info when getting single memory', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'task-detail', title: 'Task detail', content: 'Task', type: 'user-todo' }
      });
      const memoryId = JSON.parse(createRes.payload).memory.id;

      await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/memories/${memoryId}/status`,
        payload: { status: 'in_progress' }
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories/${memoryId}`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memory.status).toBe('in_progress');
      expect(body.memory.status_updated_at).toBeDefined();
      expect(body.memory.memory_type_id).toBe(memoryTypeIds['user-todo']);
    });
  });
});
