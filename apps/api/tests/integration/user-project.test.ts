import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { setupTestDb, TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import projectRoutes from '../../src/routes/projects';
import projectMemoryRoutes from '../../src/routes/project-memories';
import relationRoutes from '../../src/routes/relations';

describe('User Project Integration Tests', () => {
  let app: FastifyInstance;
  let client: Client;
  let userProjectId: string;

  beforeAll(async () => {
    // Run migrations to ensure user project exists
    await setupTestDb();

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
    // Clean up memories but preserve the user project
    await client.query("DELETE FROM memories WHERE project_id != (SELECT id FROM projects WHERE handle = 'user')");
    await client.query("DELETE FROM projects WHERE handle != 'user'");
    const projRes = await app.inject({ method: 'GET', url: '/api/projects?handle=user' });
    const projects = JSON.parse(projRes.payload).projects;
    userProjectId = projects[0].id;
  });

  describe('User Project Existence', () => {
    it('should have a user project after migration', async () => {
      const result = await app.inject({ method: 'GET', url: '/api/projects?handle=USER' });
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.payload);
      expect(body.projects[0].handle).toBe('user');
      expect(body.projects[0].name).toBe('User');
    });
  });

  describe('User Project Protection', () => {
    it('should not allow deleting the user project', async () => {
      const result = await app.inject({ method: 'DELETE', url: `/api/projects/${userProjectId}` });

      expect(result.statusCode).toBe(403);
      const body = JSON.parse(result.payload);
      expect(body.error).toContain('Cannot delete');
      expect(body.error).toContain('user');
    });
  });

  describe('Memories in User Project', () => {
    it('should allow creating memories in user project', async () => {
      const result = await app.inject({
        method: 'POST',
        url: `/api/projects/${userProjectId}/memories?compact=false`,
        payload: {
          handle: 'personal-preference',
          title: 'Personal preference',
          content: 'I prefer tabs over spaces',
          type: 'user-note'
        }
      });

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.payload);
      expect(body.memory.title).toBe('Personal preference');
    });

    it('should allow searching memories in user project', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/projects/${userProjectId}/memories`,
        payload: {
          handle: 'git-preferences',
          title: 'Git preferences',
          content: 'Always rebase before merging',
          type: 'user-note'
        }
      });

      const result = await app.inject({
        method: 'GET',
        url: `/api/projects/${userProjectId}/memories?q=rebase`
      });

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.payload);
      expect(body.memories.length).toBe(1);
      expect(body.memories[0].title).toBe('Git preferences');
    });

    it('should get session context for user project', async () => {
      const result = await app.inject({
        method: 'GET',
        url: `/api/projects/${userProjectId}/session-context`
      });

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.payload);
      expect(body.project.handle).toBe('user');
      // agent_rules removed from session context response
      expect(body).toHaveProperty('todos');
    });
  });

  describe('Cross-Project Relations with User Project', () => {
    let regularProjectId: string;

    beforeEach(async () => {
      // Create a regular project
      const projectRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Regular Project' }
      });
      regularProjectId = JSON.parse(projectRes.payload).project.id;
    });

    it('should allow relation from user project to regular project', async () => {
      // Create memory in user project
      const userMemRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${userProjectId}/memories`,
        payload: {
          handle: 'general-coding-preference',
          title: 'General coding preference',
          content: 'Prefer functional patterns',
          type: 'user-note'
        }
      });
      const userMemId = JSON.parse(userMemRes.payload).memory.id;

      // Create memory in regular project
      const projectMemRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${regularProjectId}/memories`,
        payload: {
          handle: 'project-pattern',
          title: 'Project pattern',
          content: 'Using functional approach here',
          type: 'pattern'
        }
      });
      const projectMemId = JSON.parse(projectMemRes.payload).memory.id;

      // Create relation from user to project memory
      const relationRes = await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: userMemId,
          target_memory_id: projectMemId,
          relation_type: 'relates_to'
        }
      });

      expect(relationRes.statusCode).toBe(201);
      const body = JSON.parse(relationRes.payload);
      expect(body.relation.source_memory_id).toBe(userMemId);
      expect(body.relation.target_memory_id).toBe(projectMemId);
    });

    it('should allow relation from regular project to user project', async () => {
      // Create memory in regular project
      const projectMemRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${regularProjectId}/memories`,
        payload: {
          handle: 'project-decision',
          title: 'Project decision',
          content: 'Decided to use pattern X',
          type: 'decision'
        }
      });
      const projectMemId = JSON.parse(projectMemRes.payload).memory.id;

      // Create memory in user project
      const userMemRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${userProjectId}/memories`,
        payload: {
          handle: 'personal-pattern-reference',
          title: 'Personal pattern reference',
          content: 'Pattern X reference doc',
          type: 'reference'
        }
      });
      const userMemId = JSON.parse(userMemRes.payload).memory.id;

      // Create relation from project to user memory
      const relationRes = await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: projectMemId,
          target_memory_id: userMemId,
          relation_type: 'references'
        }
      });

      expect(relationRes.statusCode).toBe(201);
    });

    it('should still reject relations between two non-user projects', async () => {
      // Create another regular project
      const project2Res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Another Project' }
      });
      const project2Id = JSON.parse(project2Res.payload).project.id;

      // Create memories in each project
      const mem1Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${regularProjectId}/memories`,
        payload: { handle: 'memory-1', title: 'Memory 1', content: 'Content 1', type: 'user-note' }
      });
      const mem1Id = JSON.parse(mem1Res.payload).memory.id;

      const mem2Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project2Id}/memories`,
        payload: { handle: 'memory-2', title: 'Memory 2', content: 'Content 2', type: 'user-note' }
      });
      const mem2Id = JSON.parse(mem2Res.payload).memory.id;

      // Create relation between two non-user projects - now allowed
      const relationRes = await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: mem1Id,
          target_memory_id: mem2Id,
          relation_type: 'relates_to'
        }
      });
      expect(relationRes.statusCode).toBe(201);
      const body = JSON.parse(relationRes.payload);
      expect(body.relation.source_memory_id).toBe(mem1Id);
      expect(body.relation.target_memory_id).toBe(mem2Id);
      expect(body.relation.relation_type).toBe('relates_to');
    });

    it('should traverse graph across user project boundary', async () => {
      // Create memory in user project
      const userMemRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${userProjectId}/memories`,
        payload: {
          handle: 'root-preference',
          title: 'Root preference',
          content: 'Preference root',
          type: 'user-note'
        }
      });
      const userMemId = JSON.parse(userMemRes.payload).memory.id;

      // Create memory in regular project
      const projectMemRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${regularProjectId}/memories`,
        payload: {
          handle: 'linked-decision',
          title: 'Linked decision',
          content: 'Decision based on preference',
          type: 'decision'
        }
      });
      const projectMemId = JSON.parse(projectMemRes.payload).memory.id;

      // Create relation
      await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: userMemId,
          target_memory_id: projectMemId,
          relation_type: 'supports'
        }
      });

      // Get graph starting from user memory
      const graphRes = await app.inject({
        method: 'GET',
        url: `/api/relations/memory/${userMemId}/graph?depth=2`
      });

      expect(graphRes.statusCode).toBe(200);
      const body = JSON.parse(graphRes.payload);

      // Should include both memories in graph
      const nodeIds = body.nodes.map((n: any) => n.id);
      expect(nodeIds).toContain(userMemId);
      expect(nodeIds).toContain(projectMemId);
    });
  });
});
