import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { setupTestDb, cleanupTestDb, TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import projectRoutes from '../../src/routes/projects';
import projectMemoryRoutes from '../../src/routes/project-memories';
import relationRoutes from '../../src/routes/relations';

describe('Memory Integration Tests', () => {
  let app: FastifyInstance;
  let client: Client;
  let projectId: string;

  beforeAll(async () => {
    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(projectMemoryRoutes, { prefix: '/api/projects/:projectId/memories' });
    app.register(relationRoutes, { prefix: '/api/relations' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
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
      payload: {
        name: 'Test Project',
        description: 'A test project'
      }
    });

    if (result.statusCode !== 201) {
      console.error('Failed to create project:', result.statusCode, result.payload);
      throw new Error(`Failed to create project: ${result.payload}`);
    }

    projectId = JSON.parse(result.payload).project.id;
  });

  describe('Create Memory', () => {
    it('should create a memory with tags', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories?compact=false`,
        payload: {
          handle: 'use-redis-for-caching',
          title: 'Use Redis for caching',
          content: 'Use Redis for caching',
          type: 'decision',
          tags: ['redis', 'caching']
        }
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.memory.content).toBe('Use Redis for caching');
      expect(body.memory.type).toBe('decision');
      expect(body.memory.status).toBe('proposed'); // Default status for decision type
    });

    it('should handle duplicate tags gracefully', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'duplicate-tags-test',
          title: 'Duplicate tags test',
          content: 'Testing duplicate tag handling',
          type: 'user-note',
          tags: ['redis', 'caching', 'redis', 'caching'] // Duplicate tags
        }
      });

      expect(createRes.statusCode).toBe(201);
      const memoryId = JSON.parse(createRes.payload).memory.id;

      // Fetch the memory to verify tags
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories/${memoryId}`
      });

      expect(getRes.statusCode).toBe(200);
      const body = JSON.parse(getRes.payload);
      // Should only have 2 unique tags, not 4
      expect(body.memory.tags).toHaveLength(2);
      expect(body.memory.tags.map((t: { name: string }) => t.name).sort()).toEqual(['caching', 'redis']);
    });

    it('should return compact response by default', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'compact-test',
          title: 'Compact test',
          content: 'This content should not appear',
          type: 'user-note'
        }
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.memory.id).toBeDefined();
      expect(body.memory.handle).toBe('compact-test');
      expect(body.memory.status).toBe('transient');
      expect(body.memory.created_at).toBeDefined();
      expect(body.memory.updated_at).toBeDefined();
      expect(body.memory.content).toBeUndefined();
      expect(body.memory.type).toBeUndefined();
      expect(body.memory.title).toBeUndefined();
    });

    it('should chunk large memories', async () => {
      const largeContent = 'x'.repeat(5000);

      const response = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'large-user-note',
          title: 'Large user note',
          content: largeContent,
          type: 'user-note'
        }
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      const memoryId = body.memory.id;

      const chunks = await client.query(
        'SELECT * FROM memory_chunks WHERE memory_id = $1 ORDER BY chunk_index',
        [memoryId]
      );

      expect(chunks.rows.length).toBeGreaterThan(1);
      expect(chunks.rows[0].chunk_index).toBe(0);
      expect(chunks.rows[1].chunk_index).toBe(1);
    });
  });

  describe('Update Memory', () => {
    it('should update memory content and rechunk', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'initial-content',
          title: 'Initial content',
          content: 'Initial content',
          type: 'user-note'
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;
      const largeContent = 'y'.repeat(5000);

      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}`,
        payload: {
          content: largeContent
        }
      });

      expect(updateRes.statusCode).toBe(200);

      const chunks = await client.query(
        'SELECT * FROM memory_chunks WHERE memory_id = $1',
        [memoryId]
      );

      expect(chunks.rows.length).toBeGreaterThan(1);
    });

    it('should update tags', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'test-content',
          title: 'Test content',
          content: 'Test content',
          type: 'user-note',
          tags: ['old-tag']
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;

      await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}`,
        payload: {
          tags: ['new-tag', 'another-tag']
        }
      });

      const getRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories/${memoryId}`
      });

      const body = JSON.parse(getRes.payload);
      const tagNames = body.memory.tags.map((t: { id: string; name: string }) => t.name);
      expect(tagNames.sort()).toEqual(['another-tag', 'new-tag']);
    });

    it('should update memory status', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'memory-to-update',
          title: 'Memory to update',
          content: 'Memory to update',
          type: 'user-note'
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;

      // Update status to a valid note status
      const statusRes = await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/memories/${memoryId}/status`,
        payload: {
          status: 'persistent'
        }
      });

      expect(statusRes.statusCode).toBe(200);
      const body = JSON.parse(statusRes.payload);
      expect(body.status).toBe('persistent');
    });

    it('should update type and status together', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'note-type-update',
          title: 'Note type update',
          content: 'Note type update',
          type: 'user-note'
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;

      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}`,
        payload: {
          type: 'assistant-note',
          status: 'persistent'
        }
      });

      expect(updateRes.statusCode).toBe(200);

      const statusRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories/${memoryId}/status`
      });

      expect(statusRes.statusCode).toBe(200);
      const body = JSON.parse(statusRes.payload);
      expect(body.status).toBe('persistent');
    });

    it('should return compact response by default on update', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'update-compact-test',
          title: 'Update compact test',
          content: 'Original content',
          type: 'user-note'
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;

      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}`,
        payload: {
          content: 'Updated content'
        }
      });

      expect(updateRes.statusCode).toBe(200);
      const body = JSON.parse(updateRes.payload);
      expect(body.memory.id).toBe(memoryId);
      expect(body.memory.handle).toBe('update-compact-test');
      expect(body.memory.status).toBe('transient');
      expect(body.memory.updated_at).toBeDefined();
      expect(body.memory.content).toBeUndefined();
      expect(body.memory.type).toBeUndefined();
    });

    it('should return full response with compact=false on update', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'update-full-test',
          title: 'Update full test',
          content: 'Original content',
          type: 'user-note'
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;

      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}?compact=false`,
        payload: {
          content: 'Updated content'
        }
      });

      expect(updateRes.statusCode).toBe(200);
      const body = JSON.parse(updateRes.payload);
      expect(body.memory.id).toBe(memoryId);
      expect(body.memory.content).toBe('Updated content');
      expect(body.memory.type).toBe('user-note');
      expect(body.memory.status).toBe('transient');
    });
  });

  describe('Append Memory', () => {
    it('should append content to existing memory', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'incremental-notes',
          title: 'Incremental notes',
          content: 'First observation',
          type: 'user-note'
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;

      const appendRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories/${memoryId}/append?compact=false`,
        payload: {
          content: 'Second observation'
        }
      });

      expect(appendRes.statusCode).toBe(200);
      const body = JSON.parse(appendRes.payload);
      expect(body.memory.content).toBe('First observation\n\nSecond observation');
    });

    it('should use custom separator', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'list-items',
          title: 'List items',
          content: '- Item 1',
          type: 'user-note'
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;

      const appendRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories/${memoryId}/append?compact=false`,
        payload: {
          content: '- Item 2',
          separator: '\n'
        }
      });

      expect(appendRes.statusCode).toBe(200);
      const body = JSON.parse(appendRes.payload);
      expect(body.memory.content).toBe('- Item 1\n- Item 2');
    });

    it('should return compact response by default on append', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'append-compact-test',
          title: 'Append compact test',
          content: 'Original',
          type: 'user-note'
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;

      const appendRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories/${memoryId}/append`,
        payload: {
          content: 'Appended'
        }
      });

      expect(appendRes.statusCode).toBe(200);
      const body = JSON.parse(appendRes.payload);
      expect(body.memory.id).toBe(memoryId);
      expect(body.memory.handle).toBe('append-compact-test');
      expect(body.memory.status).toBe('transient');
      expect(body.memory.updated_at).toBeDefined();
      expect(body.memory.content).toBeUndefined();
      expect(body.memory.type).toBeUndefined();
    });

    it('should rechunk when content exceeds threshold', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'growing-memory',
          title: 'Growing memory',
          content: 'Initial content',
          type: 'user-note'
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;

      // Append enough content to trigger chunking
      const largeContent = 'x'.repeat(3000);
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories/${memoryId}/append`,
        payload: {
          content: largeContent
        }
      });

      const chunks = await client.query(
        'SELECT * FROM memory_chunks WHERE memory_id = $1 ORDER BY chunk_index',
        [memoryId]
      );

      expect(chunks.rows.length).toBeGreaterThan(1);
    });

    it('should return 404 for non-existent memory', async () => {
      const appendRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories/00000000-0000-0000-0000-000000000000/append`,
        payload: {
          content: 'New content'
        }
      });

      expect(appendRes.statusCode).toBe(404);
    });

    it('should return 400 when content is missing', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'test-memory',
          title: 'Test memory',
          content: 'Test content',
          type: 'user-note'
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;

      const appendRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories/${memoryId}/append`,
        payload: {}
      });

      expect(appendRes.statusCode).toBe(400);
    });

    it('should not append to memory in different project', async () => {
      // Create second project
      const project2Res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Project 2' }
      });
      const project2Id = JSON.parse(project2Res.payload).project.id;

      // Create memory in first project
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'memory-in-project-1',
          title: 'Memory in project 1',
          content: 'Original content',
          type: 'user-note'
        }
      });
      const memoryId = JSON.parse(createRes.payload).memory.id;

      // Try to append via second project
      const appendRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${project2Id}/memories/${memoryId}/append`,
        payload: {
          content: 'Should not work'
        }
      });

      expect(appendRes.statusCode).toBe(404);
    });
  });

  describe('Suggest Relations', () => {
    it('should suggest related memories and exclude existing relations', async () => {
      const sourceRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'use-redis',
          title: 'Use Redis',
          content: 'Use Redis for caching',
          type: 'decision',
          tags: ['redis', 'cache']
        }
      });
      const sourceId = JSON.parse(sourceRes.payload).memory.id as string;

      const contextRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'redis-context',
          title: 'Redis availability',
          content: 'Redis is available in the infrastructure for caching.',
          type: 'context',
          tags: ['cache', 'redis']
        }
      });
      const contextId = JSON.parse(contextRes.payload).memory.id as string;

      const unrelatedRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'unrelated-note',
          title: 'Unrelated note',
          content: 'This is about logging.',
          type: 'user-note',
          tags: ['logging']
        }
      });
      const unrelatedId = JSON.parse(unrelatedRes.payload).memory.id as string;

      const suggestionsRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories/${sourceId}/suggestions`
      });

      expect(suggestionsRes.statusCode).toBe(200);
      const suggestionsBody = JSON.parse(suggestionsRes.payload);
      const suggestions = suggestionsBody.suggestions as Array<{ memory: { id: string }; suggested_relation_type?: string }>;

      expect(suggestions.some(s => s.memory.id === contextId)).toBe(true);
      expect(suggestions.some(s => s.memory.id === unrelatedId)).toBe(false);
      const contextSuggestion = suggestions.find(s => s.memory.id === contextId);
      expect(contextSuggestion?.suggested_relation_type).toBe('depends_on');

      await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: sourceId,
          target_memory_id: contextId,
          relation_type: 'depends_on'
        }
      });

      const afterRelRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories/${sourceId}/suggestions`
      });
      const afterRelBody = JSON.parse(afterRelRes.payload);
      const afterRelSuggestions = afterRelBody.suggestions as Array<{ memory: { id: string } }>;
      expect(afterRelSuggestions.some(s => s.memory.id === contextId)).toBe(false);
    });

    it('should respect limit for suggestions', async () => {
      const sourceRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'limit-source',
          title: 'Limit source',
          content: 'Limit source content',
          type: 'user-note',
          tags: ['limit']
        }
      });
      const sourceId = JSON.parse(sourceRes.payload).memory.id as string;

      for (const suffix of ['one', 'two', 'three']) {
        await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/memories`,
          payload: {
            handle: `limit-${suffix}`,
            title: `Limit ${suffix}`,
            content: `Limit content ${suffix}`,
            type: 'user-note',
            tags: ['limit']
          }
        });
      }

      const suggestionsRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories/${sourceId}/suggestions?limit=1`
      });

      expect(suggestionsRes.statusCode).toBe(200);
      const suggestionsBody = JSON.parse(suggestionsRes.payload);
      expect(suggestionsBody.suggestions.length).toBe(1);
    });
  });

  describe('Forget Memory', () => {
    it('should delete memory and cascading relations', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'memory-to-delete',
          title: 'Memory to delete',
          content: 'Memory to delete',
          type: 'user-note',
          tags: ['test']
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/projects/${projectId}/memories/${memoryId}`
      });

      expect(deleteRes.statusCode).toBe(204);

      const getRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories/${memoryId}`
      });

      expect(getRes.statusCode).toBe(404);

      const chunks = await client.query(
        'SELECT * FROM memory_chunks WHERE memory_id = $1',
        [memoryId]
      );
      expect(chunks.rows.length).toBe(0);

      const tags = await client.query(
        'SELECT * FROM memory_tags WHERE memory_id = $1',
        [memoryId]
      );
      expect(tags.rows.length).toBe(0);
    });
  });

  describe('Project Scoping', () => {
    it('should not find memory from different project', async () => {
      // Create second project
      const project2Res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Project 2' }
      });
      const project2Id = JSON.parse(project2Res.payload).project.id;

      // Create memory in first project
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'memory-in-project-1', title: 'Memory in project 1', content: 'Memory in project 1', type: 'user-note' }
      });
      const memoryId = JSON.parse(createRes.payload).memory.id;

      // Try to get memory from second project
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${project2Id}/memories/${memoryId}`
      });

      expect(getRes.statusCode).toBe(404);
    });
  });

  describe('Pagination', () => {
    it('should paginate results with default limit', async () => {
      // Create 25 memories
      for (let i = 0; i < 25; i++) {
        await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/memories`,
          payload: { handle: `title-${i}`, title: `Title ${i}`, content: `Memory ${i}`, type: 'user-note' }
        });
      }

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?type=user-note`
      });

      const body = JSON.parse(response.payload);
      expect(body.memories.length).toBe(20);
      expect(body.pagination.total_count).toBe(25);
      expect(body.pagination.limit).toBe(20);
      expect(body.pagination.offset).toBe(0);
      expect(body.pagination.has_more).toBe(true);
    });

    it('should respect custom limit and offset', async () => {
      // Create 30 memories
      for (let i = 0; i < 30; i++) {
        await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/memories`,
          payload: { handle: `page-title-${i}`, title: `Page Title ${i}`, content: `Memory ${i}`, type: 'user-note' }
        });
      }

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?type=user-note&limit=10&offset=10`
      });

      const body = JSON.parse(response.payload);
      expect(body.memories.length).toBe(10);
      expect(body.pagination.total_count).toBe(30);
      expect(body.pagination.limit).toBe(10);
      expect(body.pagination.offset).toBe(10);
      expect(body.pagination.has_more).toBe(true);
    });

    it('should calculate has_more correctly', async () => {
      // Create 15 memories
      for (let i = 0; i < 15; i++) {
        await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/memories`,
          payload: { handle: `short-title-${i}`, title: `Short Title ${i}`, content: `Memory ${i}`, type: 'user-note' }
        });
      }

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?type=user-note&limit=20`
      });

      const body = JSON.parse(response.payload);
      expect(body.memories.length).toBe(15);
      expect(body.pagination.has_more).toBe(false);
    });

    it('should handle pagination beyond total results', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'only-memory', title: 'Only memory', content: 'Only memory', type: 'user-note' }
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?type=user-note&offset=100`
      });

      const body = JSON.parse(response.payload);
      expect(body.memories.length).toBe(0);
      expect(body.pagination.total_count).toBe(1);
      expect(body.pagination.has_more).toBe(false);
    });
  });

  describe('Full-Text Search', () => {
    it('should search in memory content', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'redis-caching', title: 'redis-caching', content: 'Redis is great for caching', type: 'decision' }
      });

      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'postgres-relations', title: 'postgres-relations', content: 'PostgreSQL is perfect for relations', type: 'decision' }
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?q=redis`
      });

      const body = JSON.parse(response.payload);
      expect(body.memories.length).toBe(1);
      expect(body.memories[0].content).toContain('Redis');
    });

    it('should search in chunked content', async () => {
      const largeContent = 'Start of content. ' + 'x'.repeat(3000) + ' Important searchterm in chunk.';

      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'chunked-content', title: 'Chunked content', content: largeContent, type: 'user-note' }
      });

      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'other-memory', title: 'Other memory', content: 'Other memory without that term', type: 'user-note' }
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?q=searchterm`
      });

      const body = JSON.parse(response.payload);
      expect(body.memories.length).toBe(1);
      expect(body.memories[0].content).toContain('searchterm');
    });

    it('should rank results by relevance', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'caching-1', title: 'caching-1', content: 'caching', type: 'user-note' }
      });

      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'caching-3', title: 'caching-3', content: 'caching caching caching', type: 'user-note' }
      });

      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'other', title: 'other', content: 'other content', type: 'user-note' }
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?q=caching`
      });

      const body = JSON.parse(response.payload);
      expect(body.memories.length).toBe(2);
      // First result should have more instances of "caching"
      expect(body.memories[0].content).toBe('caching caching caching');
    });

    it('should weight title matches higher than content', async () => {
      // Title match vs content-only match
      await app.inject({ method: 'POST', url: `/api/projects/${projectId}/memories`, payload: { handle: 'title-hit', title: 'Searchterm overview', content: 'irrelevant', type: 'user-note' } });
      await app.inject({ method: 'POST', url: `/api/projects/${projectId}/memories`, payload: { handle: 'content-hit', title: 'No hit', content: 'this has searchterm in content', type: 'user-note' } });

      const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/memories?q=searchterm` });
      const body = JSON.parse(res.payload);
      expect(body.memories.length).toBeGreaterThanOrEqual(2);
      expect(body.memories[0].title.toLowerCase()).toContain('searchterm');
    });

    it('should rank title-prefixed memories above body mentions for a single-word query', async () => {
      // Simulates the "Decision: X" lookup case: a memory whose title starts with
      // the query term should rank above several memories that mention the word
      // scattered in longer content bodies.
      await app.inject({ method: 'POST', url: `/api/projects/${projectId}/memories`, payload: { handle: 'decision-prefixed', title: 'Decision: adopt postgres pgvector', content: 'short body', type: 'decision' } });
      for (let i = 0; i < 8; i++) {
        await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/memories`,
          payload: {
            handle: `bodymention-${i}`,
            title: `Note ${i}`,
            content: `we made a decision earlier. another decision. yet another decision reference ${i}.`,
            type: 'user-note',
          },
        });
      }

      const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/memories?q=decision` });
      const body = JSON.parse(res.payload);
      expect(body.memories.length).toBeGreaterThan(0);
      expect(body.memories[0].handle).toBe('decision-prefixed');
    });

    it('should rank content matches above tag-only matches', async () => {
      // Create one with tag-only match, and one with content match
      await app.inject({ method: 'POST', url: `/api/projects/${projectId}/memories`, payload: { handle: 'tag-only', title: 'Tag', content: 'no keyword', type: 'user-note', tags: ['topic-xyz'] } });
      await app.inject({ method: 'POST', url: `/api/projects/${projectId}/memories`, payload: { handle: 'content-only', title: 'Content', content: 'xyz keyword appears here', type: 'user-note' } });

      const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/memories?q=xyz` });
      const body = JSON.parse(res.payload);
      expect(body.memories.length).toBeGreaterThanOrEqual(1);
      // Expect content match (content-only) appears before tag-only
      const handles = body.memories.map((m: any) => m.handle);
      expect(handles.indexOf('content-only')).toBeGreaterThanOrEqual(0);
      if (handles.includes('tag-only')) {
        expect(handles.indexOf('content-only')).toBeLessThan(handles.indexOf('tag-only'));
      }
    });

    it('should combine search with filters', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'caching-decision', title: 'caching-decision', content: 'caching decision', type: 'decision', tags: ['redis'] }
      });

      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'caching-note', title: 'caching-note', content: 'caching note', type: 'user-note' }
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?q=caching&type=decision`
      });

      const body = JSON.parse(response.payload);
      expect(body.memories.length).toBe(1);
      expect(body.memories[0].type).toBe('decision');

      const tagResponse = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?q=caching&tag=redis`
      });

      const tagBody = JSON.parse(tagResponse.payload);
      expect(tagBody.memories.length).toBe(1);
      expect(tagBody.memories[0].content).toContain('decision');
    });

    it('should handle search with no results', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'some-content', title: 'Some content', content: 'Some content', type: 'user-note' }
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?q=nonexistent`
      });

      const body = JSON.parse(response.payload);
      expect(body.memories.length).toBe(0);
      expect(body.pagination.total_count).toBe(0);
    });

    it('should paginate search results', async () => {
      // Create 25 memories with "test" in content
      for (let i = 0; i < 25; i++) {
        await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/memories`,
          payload: { handle: `test-${i}`, title: `test ${i}`, content: `test memory ${i}`, type: 'user-note' }
        });
      }

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories?q=test&type=user-note&limit=10`
      });

      const body = JSON.parse(response.payload);
      expect(body.memories.length).toBe(10);
      expect(body.pagination.total_count).toBe(25);
      expect(body.pagination.has_more).toBe(true);
    });
  });

  describe('Move Memory Between Projects', () => {
    let secondProjectId: string;

    beforeEach(async () => {
      // Create a second project for move tests
      const result = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: {
          name: 'Second Project',
          description: 'Target project for move tests'
        }
      });
      secondProjectId = JSON.parse(result.payload).project.id;
    });

    it('should move a memory to another project', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'moveable-memory',
          title: 'Moveable memory',
          content: 'This memory will be moved',
          type: 'user-note',
          tags: ['test']
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;

      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}`,
        payload: {
          project_id: secondProjectId
        }
      });

      expect(updateRes.statusCode).toBe(200);

      // Verify memory is no longer in original project
      const originalRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memories/${memoryId}`
      });
      expect(originalRes.statusCode).toBe(404);

      // Verify memory is in new project
      const newRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${secondProjectId}/memories/${memoryId}`
      });
      expect(newRes.statusCode).toBe(200);
      const body = JSON.parse(newRes.payload);
      expect(body.memory.content).toBe('This memory will be moved');
    });

    it('should reject move when target project does not exist', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'no-target-memory',
          title: 'No target memory',
          content: 'This memory cannot be moved',
          type: 'user-note'
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;
      const fakeProjectId = '00000000-0000-0000-0000-000000000000';

      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}`,
        payload: {
          project_id: fakeProjectId
        }
      });

      expect(updateRes.statusCode).toBe(404);
      expect(JSON.parse(updateRes.payload).error).toBe('Target project not found');
    });

    it('should reject move when title conflicts in target project', async () => {
      // Create memory in second project with same title
      await app.inject({
        method: 'POST',
        url: `/api/projects/${secondProjectId}/memories`,
        payload: {
          handle: 'existing-title',
          title: 'Duplicate Title',
          content: 'Already exists in target',
          type: 'user-note'
        }
      });

      // Create memory in first project with same title
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'conflict-title',
          title: 'Duplicate Title',
          content: 'Will conflict on move',
          type: 'user-note'
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;

      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}`,
        payload: {
          project_id: secondProjectId
        }
      });

      expect(updateRes.statusCode).toBe(409);
      expect(JSON.parse(updateRes.payload).error).toBe('A memory with this title already exists in the target project');
    });

    it('should reject move when handle conflicts in target project', async () => {
      // Create memory in second project with same handle
      await app.inject({
        method: 'POST',
        url: `/api/projects/${secondProjectId}/memories`,
        payload: {
          handle: 'same-handle',
          title: 'Different Title',
          content: 'Already exists in target',
          type: 'user-note'
        }
      });

      // Create memory in first project with same handle
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'same-handle',
          title: 'Another Title',
          content: 'Will conflict on handle',
          type: 'user-note'
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;

      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}`,
        payload: {
          project_id: secondProjectId
        }
      });

      expect(updateRes.statusCode).toBe(409);
      expect(JSON.parse(updateRes.payload).error).toBe('A memory with this handle already exists in the target project');
    });

    it('should allow move with new title that resolves conflict', async () => {
      // Create memory in second project
      await app.inject({
        method: 'POST',
        url: `/api/projects/${secondProjectId}/memories`,
        payload: {
          handle: 'existing-in-target',
          title: 'Existing Title',
          content: 'Already exists in target',
          type: 'user-note'
        }
      });

      // Create memory in first project with same title
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'to-be-moved',
          title: 'Existing Title',
          content: 'Will be moved with new title',
          type: 'user-note'
        }
      });

      const memoryId = JSON.parse(createRes.payload).memory.id;

      // Move with a new title to avoid conflict
      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}`,
        payload: {
          project_id: secondProjectId,
          title: 'New Unique Title'
        }
      });

      expect(updateRes.statusCode).toBe(200);

      // Verify memory is in new project with new title
      const newRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${secondProjectId}/memories/${memoryId}`
      });
      expect(newRes.statusCode).toBe(200);
      const body = JSON.parse(newRes.payload);
      expect(body.memory.title).toBe('New Unique Title');
    });
  });
});
