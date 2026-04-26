import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { setupTestDb, cleanupTestDb, TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import projectRoutes from '../../src/routes/projects';

describe('Project Integration Tests', () => {
  let app: FastifyInstance;
  let client: Client;

  beforeAll(async () => {
    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });

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

  describe('List Projects', () => {
    it('should list all projects', async () => {
      // Create test projects
      await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Project A', description: 'First project' }
      });

      await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Project B', description: 'Second project' }
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/projects'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.projects).toHaveLength(2);
    });

    it('should filter projects by name', async () => {
      // Create test projects
      await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'khef', description: 'Main project' }
      });

      await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'other-project', description: 'Other project' }
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/projects?name=khef'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.projects).toHaveLength(1);
      expect(body.projects[0].name).toBe('khef');
    });

    it('should return empty array when name filter matches no projects', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'existing-project' }
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/projects?name=nonexistent'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.projects).toHaveLength(0);
    });
  });

  describe('Get Project by ID', () => {
    it('should get a project by id', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Test Project', description: 'A test' }
      });

      const projectId = JSON.parse(createRes.payload).project.id;

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.project.name).toBe('Test Project');
    });

    it('should return 404 for nonexistent project', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/projects/00000000-0000-0000-0000-000000000000'
      });

      expect(response.statusCode).toBe(404);
    });

    it('should find project by handle via query param', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'My Test Project', description: 'A test' }
      });

      const project = JSON.parse(createRes.payload).project;
      expect(project.handle).toBe('my-test-project');

      const res = await app.inject({
        method: 'GET',
        url: '/api/projects?handle=MY-TEST-PROJECT'
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.projects).toHaveLength(1);
      expect(body.projects[0].id).toBe(project.id);
    });

    it('should return 400 when path id is not a UUID', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/khef' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('Filter by Name Case-Insensitive', () => {
    it('should filter projects by name case-insensitively', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Khef Project', description: 'Main project' }
      });

      // Test uppercase search
      const upperRes = await app.inject({
        method: 'GET',
        url: '/api/projects?name=KHEF PROJECT'
      });
      expect(upperRes.statusCode).toBe(200);
      const upperBody = JSON.parse(upperRes.payload);
      expect(upperBody.projects).toHaveLength(1);
      expect(upperBody.projects[0].name).toBe('Khef Project');

      // Test lowercase search
      const lowerRes = await app.inject({
        method: 'GET',
        url: '/api/projects?name=khef project'
      });
      expect(lowerRes.statusCode).toBe(200);
      const lowerBody = JSON.parse(lowerRes.payload);
      expect(lowerBody.projects).toHaveLength(1);
      expect(lowerBody.projects[0].name).toBe('Khef Project');
    });

    it('should support partial q search across handle/name/display_name', async () => {
      await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Khef Core' } });
      await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Other Project' } });

      const res = await app.inject({ method: 'GET', url: '/api/projects?q=khef' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.projects.length).toBe(1);
      expect(body.projects[0].handle).toBe('khef-core');
    });
  });

  describe('Project Memory Types', () => {
    it('should list memory types with usage counts for a project', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Memory Types Project' }
      });
      const projectId = JSON.parse(createRes.payload).project.id as string;

      const typeRes = await client.query('SELECT id FROM memory_types WHERE name = $1', ['decision']);
      const memoryTypeId = typeRes.rows[0].id as string;
      const statusRes = await client.query(
        'SELECT id FROM memory_type_statuses WHERE memory_type_id = $1 AND status_value = $2',
        [memoryTypeId, 'proposed']
      );
      const statusId = statusRes.rows[0].id as string;

      await client.query(
        `INSERT INTO memories (project_id, content, memory_type_id, status_id, status_updated_at, handle, title)
         VALUES ($1, $2, $3, $4, NOW(), $5, $6)`,
        [projectId, 'Decision content', memoryTypeId, statusId, 'mem-1', 'Test decision']
      );

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memory-types`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.project_id).toBe(projectId);
      const decisionType = body.memory_types.find((t: any) => t.type === 'decision');
      expect(decisionType).toBeDefined();
      expect(decisionType.usage_count).toBe(1);
      expect(decisionType.statuses.length).toBeGreaterThan(0);
    });

    it('should list status usage counts for a project memory type', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Status Usage Project' }
      });
      const project = JSON.parse(createRes.payload).project as { id: string; handle: string };

      const typeRes = await client.query('SELECT id FROM memory_types WHERE name = $1', ['decision']);
      const memoryTypeId = typeRes.rows[0].id as string;
      const statusRes = await client.query(
        'SELECT id, status_value FROM memory_type_statuses WHERE memory_type_id = $1',
        [memoryTypeId]
      );
      const statusIds = statusRes.rows.reduce<Record<string, string>>((acc, row) => {
        acc[row.status_value] = row.id;
        return acc;
      }, {});

      await client.query(
        `INSERT INTO memories (project_id, content, memory_type_id, status_id, status_updated_at, handle, title)
         VALUES ($1, $2, $3, $4, NOW(), $5, $6)`,
        [project.id, 'Decision content 1', memoryTypeId, statusIds.proposed, 'mem-1', 'Test decision 1']
      );
      await client.query(
        `INSERT INTO memories (project_id, content, memory_type_id, status_id, status_updated_at, handle, title)
         VALUES ($1, $2, $3, $4, NOW(), $5, $6)`,
        [project.id, 'Decision content 2', memoryTypeId, statusIds.accepted, 'mem-2', 'Test decision 2']
      );

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/memory-types/decision/statuses`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.project_id).toBe(project.id);
      expect(body.project_handle).toBe(project.handle);
      expect(body.type).toBe('decision');

      const proposed = body.statuses.find((s: any) => s.value === 'proposed');
      const accepted = body.statuses.find((s: any) => s.value === 'accepted');
      expect(proposed).toBeDefined();
      expect(accepted).toBeDefined();
      expect(proposed.usage_count).toBe(1);
      expect(accepted.usage_count).toBe(1);
    });

    it('should return 404 for unknown memory type in project', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Unknown Type Project' }
      });
      const projectId = JSON.parse(createRes.payload).project.id as string;

      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/memory-types/unknown/statuses`
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for unknown project', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/projects/non-existent-project/memory-types'
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
