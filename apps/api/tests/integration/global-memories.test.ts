import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { setupTestDb, cleanupTestDb, TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import memoryRoutes from '../../src/routes/memories';
import projectRoutes from '../../src/routes/projects';
import projectMemoryRoutes from '../../src/routes/project-memories';

describe('Global Memories Search', () => {
  let app: FastifyInstance;
  let client: Client;

  beforeAll(async () => {
    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(projectMemoryRoutes, { prefix: '/api/projects/:projectId/memories' });
    app.register(memoryRoutes, { prefix: '/api/memories' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE projects CASCADE');
  });

  describe('Cross-Project Search', () => {
    it('should search across all projects when project_id is not provided', async () => {
      // Create two projects
      const project1Res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Project Alpha', description: 'First project' }
      });
      const project1 = JSON.parse(project1Res.payload).project;

      const project2Res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Project Beta', description: 'Second project' }
      });
      const project2 = JSON.parse(project2Res.payload).project;

      // Create memories in each project
      await app.inject({
        method: 'POST',
        url: `/api/projects/${project1.id}/memories`,
        payload: {
          handle: 'alpha-decision',
          title: 'Alpha Decision',
          content: 'This is a database decision for alpha',
          type: 'decision'
        }
      });

      await app.inject({
        method: 'POST',
        url: `/api/projects/${project2.id}/memories`,
        payload: {
          handle: 'beta-decision',
          title: 'Beta Decision',
          content: 'This is a database decision for beta',
          type: 'decision'
        }
      });

      // Search across all projects
      const response = await app.inject({
        method: 'GET',
        url: '/api/memories?q=database'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memories).toHaveLength(2);
      expect(body.pagination.total_count).toBe(2);

      // Verify results include project info
      const projectIds = body.memories.map((m: any) => m.project.id);
      expect(projectIds).toContain(project1.id);
      expect(projectIds).toContain(project2.id);
    });

    it('should filter to single project when project_id is provided', async () => {
      // Create two projects
      const project1Res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Project One' }
      });
      const project1 = JSON.parse(project1Res.payload).project;

      const project2Res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Project Two' }
      });
      const project2 = JSON.parse(project2Res.payload).project;

      // Create memories in each project with same content
      await app.inject({
        method: 'POST',
        url: `/api/projects/${project1.id}/memories`,
        payload: {
          handle: 'first-pattern',
          title: 'First Pattern',
          content: 'Reusable pattern content',
          type: 'pattern'
        }
      });

      await app.inject({
        method: 'POST',
        url: `/api/projects/${project2.id}/memories`,
        payload: {
          handle: 'second-pattern',
          title: 'Second Pattern',
          content: 'Reusable pattern content',
          type: 'pattern'
        }
      });

      // Search with project filter using handle
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories?q=reusable&project_handle=${project1.handle}`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0].project.id).toBe(project1.id);
    });

    it('should support type filter without project_id', async () => {
      // Create project and memories of different types
      const projectRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Test Project' }
      });
      const project = JSON.parse(projectRes.payload).project;

      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/memories`,
        payload: {
          handle: 'a-decision',
          title: 'A Decision',
          content: 'Decision content',
          type: 'decision'
        }
      });

      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/memories`,
        payload: {
          handle: 'a-pattern',
          title: 'A Pattern',
          content: 'Pattern content',
          type: 'pattern'
        }
      });

      // Filter by type
      const response = await app.inject({
        method: 'GET',
        url: '/api/memories?type=decision'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0].type).toBe('decision');
    });

    it('should include project handle and name in results', async () => {
      const projectRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'My Cool Project' }
      });
      const project = JSON.parse(projectRes.payload).project;

      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/memories`,
        payload: {
          handle: 'test-memory',
          title: 'Test Memory',
          content: 'Some content here',
          type: 'context'
        }
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/memories'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0].project).toEqual({
        id: project.id,
        handle: 'my-cool-project',
        name: 'My Cool Project'
      });
    });

    it('should return 404 when invalid project_id is provided', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/memories?project_id=nonexistent-project'
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('project_id must be a UUID');
    });

    it('should support pagination', async () => {
      const projectRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Pagination Test' }
      });
      const project = JSON.parse(projectRes.payload).project;

      // Create 5 memories
      for (let i = 0; i < 5; i++) {
        await app.inject({
          method: 'POST',
          url: `/api/projects/${project.id}/memories`,
          payload: {
            handle: `memory-${i}`,
            title: `Memory ${i}`,
            content: `Content for memory ${i}`,
            type: 'context'
          }
        });
      }

      // Get first page
      const page1 = await app.inject({
        method: 'GET',
        url: '/api/memories?limit=2&offset=0'
      });

      expect(page1.statusCode).toBe(200);
      const body1 = JSON.parse(page1.payload);
      expect(body1.memories).toHaveLength(2);
      expect(body1.pagination.total_count).toBe(5);
      expect(body1.pagination.has_more).toBe(true);

      // Get second page
      const page2 = await app.inject({
        method: 'GET',
        url: '/api/memories?limit=2&offset=2'
      });

      expect(page2.statusCode).toBe(200);
      const body2 = JSON.parse(page2.payload);
      expect(body2.memories).toHaveLength(2);
      expect(body2.pagination.has_more).toBe(true);
    });
  });

  describe('Compact Search', () => {
    it('should return compact format when compact=true', async () => {
      const projectRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Compact Test' }
      });
      const project = JSON.parse(projectRes.payload).project;

      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/memories`,
        payload: {
          handle: 'test-decision',
          title: 'Test Decision',
          content: 'This is a longer piece of content that explains the decision in detail. It contains multiple sentences and should be truncated in compact mode.',
          type: 'decision',
          tags: ['architecture', 'database']
        }
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/memories?compact=true'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memories).toHaveLength(1);

      const memory = body.memories[0];
      // Compact format should have these fields
      expect(memory).toHaveProperty('id');
      expect(memory).toHaveProperty('project_id');
      expect(memory).toHaveProperty('handle', 'test-decision');
      expect(memory).toHaveProperty('title', 'Test Decision');
      expect(memory).toHaveProperty('type', 'decision');
      expect(memory).toHaveProperty('status');
      expect(memory).toHaveProperty('tags');
      expect(memory).toHaveProperty('updated_at');
      expect(memory).toHaveProperty('content_excerpt');

      // Should have memory_type_id for type disambiguation
      expect(memory).toHaveProperty('memory_type_id');

      // Should NOT have full content
      expect(memory).not.toHaveProperty('content');
      expect(memory).not.toHaveProperty('status_id');

      // Tags should be included as objects with id and name
      const tagNames = memory.tags.map((t: { id: string; name: string }) => t.name);
      expect(tagNames).toContain('architecture');
      expect(tagNames).toContain('database');

      // Excerpt should be present and shorter than full content
      expect(memory.content_excerpt).toBeDefined();
      expect(memory.content_excerpt.length).toBeLessThanOrEqual(250);
    });

    it('should include score when searching with compact=true', async () => {
      const projectRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Score Test' }
      });
      const project = JSON.parse(projectRes.payload).project;

      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/memories`,
        payload: {
          handle: 'auth-decision',
          title: 'Authentication Decision',
          content: 'We decided to use JWT for authentication because it is stateless.',
          type: 'decision'
        }
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/memories?q=authentication&compact=true'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0]).toHaveProperty('score');
      expect(typeof body.memories[0].score).toBe('number');
    });

    it('should not include score when not searching with compact=true', async () => {
      const projectRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'No Score Test' }
      });
      const project = JSON.parse(projectRes.payload).project;

      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/memories`,
        payload: {
          handle: 'simple-note',
          title: 'Simple Note',
          content: 'Just a simple note without search.',
          type: 'context'
        }
      });

      // No search query, just compact list
      const response = await app.inject({
        method: 'GET',
        url: '/api/memories?compact=true'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0]).not.toHaveProperty('score');
    });

    it('should return full format when compact is not set', async () => {
      const projectRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Full Format Test' }
      });
      const project = JSON.parse(projectRes.payload).project;

      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/memories`,
        payload: {
          handle: 'full-memory',
          title: 'Full Memory',
          content: 'This should return full content in the response.',
          type: 'pattern'
        }
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/memories'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memories).toHaveLength(1);

      const memory = body.memories[0];
      // Full format should have content
      expect(memory).toHaveProperty('content', 'This should return full content in the response.');
      // Should NOT have content_excerpt
      expect(memory).not.toHaveProperty('content_excerpt');
    });

    it('should strip markdown in content_excerpt', async () => {
      const projectRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Markdown Test' }
      });
      const project = JSON.parse(projectRes.payload).project;

      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/memories`,
        payload: {
          handle: 'markdown-memory',
          title: 'Markdown Memory',
          content: '# Header\n\nThis is **bold** and _italic_ text.\n\n```js\nconst code = true;\n```\n\n[Link](https://example.com)',
          type: 'context'
        }
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/memories?compact=true'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      const excerpt = body.memories[0].content_excerpt;

      // Should not contain markdown syntax
      expect(excerpt).not.toContain('**');
      expect(excerpt).not.toContain('```');
      expect(excerpt).not.toContain('[Link]');
      expect(excerpt).not.toContain('# Header');

      // Should contain the actual text
      expect(excerpt).toContain('bold');
      expect(excerpt).toContain('italic');
      expect(excerpt).toContain('Link');
    });
  });

  describe('Relevance Fallback', () => {
    it('should return results for multi-term queries via fallback when strict yields none', async () => {
      // Create project and a couple of memories with partial term coverage
      const projectRes = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Fallback Test' } });
      const project = JSON.parse(projectRes.payload).project;

      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/memories`,
        payload: { handle: 't-alpha', title: 'Alpha Note', content: 'alpha content only', type: 'user-note' }
      });

      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/memories`,
        payload: { handle: 't-bravo', title: 'Misc', content: 'contains bravo and nothing else', type: 'user-note' }
      });

      // Query includes many terms; strict websearch likely returns 0, fallback should match alpha/bravo tokens
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories?q=alpha bravo charlie delta echo&project_handle=${project.handle}`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      // Should return at least one result due to fallback any-of matching
      expect(body.memories.length).toBeGreaterThan(0);
      const titles = body.memories.map((m: any) => m.title.toLowerCase());
      expect(titles.some((t: string) => t.includes('alpha') || t.includes('misc'))).toBe(true);
    });
  });

  describe('Sorting and Ordering', () => {
    it('should default to updated_at DESC when not searching', async () => {
      const projectRes = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Sort Default' } });
      const project = JSON.parse(projectRes.payload).project;

      // Create A then B
      const createA = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/memories`,
        payload: { handle: 'a', title: 'A', content: 'first', type: 'user-note' }
      });
      const aId = JSON.parse(createA.payload).memory.id;

      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/memories`,
        payload: { handle: 'b', title: 'B', content: 'second', type: 'user-note' }
      });

      // Bump updated_at on A
      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/memories/${aId}/append`,
        payload: { content: 'append' }
      });

      const res = await app.inject({ method: 'GET', url: '/api/memories?compact=true' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.memories[0].handle).toBe('a');
    });

    it('should sort by title ASC when specified', async () => {
      const projectRes = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Sort Title' } });
      const project = JSON.parse(projectRes.payload).project;

      await app.inject({ method: 'POST', url: `/api/projects/${project.id}/memories`, payload: { handle: 'c', title: 'Charlie', content: 'c', type: 'user-note' } });
      await app.inject({ method: 'POST', url: `/api/projects/${project.id}/memories`, payload: { handle: 'a', title: 'Alpha', content: 'a', type: 'user-note' } });
      await app.inject({ method: 'POST', url: `/api/projects/${project.id}/memories`, payload: { handle: 'b', title: 'Bravo', content: 'b', type: 'user-note' } });

      const res = await app.inject({ method: 'GET', url: '/api/memories?compact=true&sort=title&order=asc' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      const titles = body.memories.map((m: any) => m.title);
      expect(titles).toEqual(['Alpha', 'Bravo', 'Charlie']);
    });

    it('should default search sort to relevance and ignore order', async () => {
      const projectRes = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Sort Relevance' } });
      const project = JSON.parse(projectRes.payload).project;

      await app.inject({ method: 'POST', url: `/api/projects/${project.id}/memories`, payload: { handle: 'low', title: 'Low', content: 'searchterm', type: 'user-note' } });
      await app.inject({ method: 'POST', url: `/api/projects/${project.id}/memories`, payload: { handle: 'high', title: 'High', content: 'searchterm searchterm searchterm', type: 'user-note' } });

      const res = await app.inject({ method: 'GET', url: '/api/memories?q=searchterm&sort=relevance&order=asc' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      const handles = body.memories.map((m: any) => m.handle);
      expect(handles[0]).toBe('high');
    });
  });
});
