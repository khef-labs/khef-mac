import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import memoryTypeRoutes from '../../src/routes/memory-types';

describe('Memory Types CRUD', () => {
  let app: FastifyInstance;
  let client: Client;

  beforeAll(async () => {
    app = Fastify();
    app.register(memoryTypeRoutes, { prefix: '/api/memory-types' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    // Clean up custom types (keep built-in)
    await client.query("DELETE FROM memory_types WHERE built_in = FALSE");
  });

  describe('GET /api/memory-types', () => {
    it('lists all memory types with built_in flag', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/memory-types' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);

      expect(body.memory_types).toBeInstanceOf(Array);
      expect(body.memory_types.length).toBeGreaterThan(0);

      // Check built-in types have built_in=true
      const decisionType = body.memory_types.find((t: any) => t.type === 'decision');
      expect(decisionType).toBeDefined();
      expect(decisionType.built_in).toBe(true);
      expect(decisionType.memory_count).toBeDefined();
    });
  });

  describe('POST /api/memory-types', () => {
    it('creates a custom type with default status', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memory-types',
        payload: {
          name: 'incident',
          description: 'Production incidents'
        }
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);

      expect(body.memory_type.type).toBe('incident');
      expect(body.memory_type.description).toBe('Production incidents');
      expect(body.memory_type.built_in).toBe(false);
      expect(body.memory_type.memory_count).toBe(0);
      expect(body.memory_type.statuses).toHaveLength(1);
      expect(body.memory_type.statuses[0].value).toBe('active');
    });

    it('creates a custom type with custom statuses', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memory-types',
        payload: {
          name: 'pr-review',
          description: 'Pull request reviews',
          statuses: [
            { value: 'open', display_name: 'Open', sort_order: 0 },
            { value: 'approved', display_name: 'Approved', sort_order: 1 },
            { value: 'merged', display_name: 'Merged', sort_order: 2 }
          ]
        }
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);

      expect(body.memory_type.type).toBe('pr-review');
      expect(body.memory_type.statuses).toHaveLength(3);
      expect(body.memory_type.statuses.map((s: any) => s.value)).toEqual(['open', 'approved', 'merged']);
    });

    it('rejects invalid name format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memory-types',
        payload: { name: 'Invalid Name' }
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('kebab-case');
    });

    it('rejects duplicate name', async () => {
      // Create first
      await app.inject({
        method: 'POST',
        url: '/api/memory-types',
        payload: { name: 'my-type' }
      });

      // Try to create duplicate
      const res = await app.inject({
        method: 'POST',
        url: '/api/memory-types',
        payload: { name: 'my-type' }
      });

      expect(res.statusCode).toBe(409);
    });

    it('rejects existing built-in type name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memory-types',
        payload: { name: 'decision' }
      });

      expect(res.statusCode).toBe(409);
    });
  });

  describe('PATCH /api/memory-types/:type', () => {
    it('updates custom type name and description', async () => {
      // Create custom type
      await app.inject({
        method: 'POST',
        url: '/api/memory-types',
        payload: { name: 'old-name', description: 'Old description' }
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/memory-types/old-name',
        payload: { name: 'new-name', description: 'New description' }
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);

      expect(body.type).toBe('new-name');
      expect(body.description).toBe('New description');
    });

    it('updates built-in type description only', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/memory-types/decision',
        payload: { description: 'Updated description' }
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);

      expect(body.type).toBe('decision');
      expect(body.description).toBe('Updated description');
    });

    it('rejects renaming built-in type', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/memory-types/decision',
        payload: { name: 'my-decision' }
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('Cannot rename built-in');
    });

    it('returns 404 for non-existent type', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/memory-types/nonexistent',
        payload: { description: 'test' }
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/memory-types/:type', () => {
    it('deletes custom type without memories', async () => {
      // Create custom type
      await app.inject({
        method: 'POST',
        url: '/api/memory-types',
        payload: { name: 'to-delete' }
      });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/memory-types/to-delete'
      });

      expect(res.statusCode).toBe(204);

      // Verify deleted
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/memory-types/to-delete/statuses'
      });
      expect(getRes.statusCode).toBe(404);
    });

    it('rejects deleting built-in type', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/memory-types/decision'
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('Cannot delete built-in');
    });

    it('rejects deleting type with existing memories', async () => {
      // Create custom type
      await app.inject({
        method: 'POST',
        url: '/api/memory-types',
        payload: { name: 'type-with-memories' }
      });

      // Get the type ID
      const typeResult = await client.query(
        "SELECT id FROM memory_types WHERE name = 'type-with-memories'"
      );
      const typeId = typeResult.rows[0].id;

      // Get status ID
      const statusResult = await client.query(
        "SELECT id FROM memory_type_statuses WHERE memory_type_id = $1 LIMIT 1",
        [typeId]
      );
      const statusId = statusResult.rows[0].id;

      // Create a project
      const projectResult = await client.query(
        "INSERT INTO projects (name, handle, display_name) VALUES ('Test Project', 'test-project', 'Test Project') RETURNING id"
      );
      const projectId = projectResult.rows[0].id;

      // Create a memory with this type
      await client.query(
        `INSERT INTO memories (project_id, handle, title, content, memory_type_id, status_id, status_updated_at)
         VALUES ($1, 'test-mem', 'Test', 'Content', $2, $3, NOW())`,
        [projectId, typeId, statusId]
      );

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/memory-types/type-with-memories'
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('existing memories');
      expect(body.memory_count).toBe(1);

      // Cleanup
      await client.query("DELETE FROM memories WHERE handle = 'test-mem'");
      await client.query("DELETE FROM projects WHERE handle = 'test-project'");
    });

    it('returns 404 for non-existent type', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/memory-types/nonexistent'
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DB trigger protection', () => {
    it('prevents deleting built-in type via SQL', async () => {
      await expect(
        client.query("DELETE FROM memory_types WHERE name = 'decision'")
      ).rejects.toThrow(/Cannot delete built-in memory type/);
    });

    it('prevents renaming built-in type via SQL', async () => {
      await expect(
        client.query("UPDATE memory_types SET name = 'my-decision' WHERE name = 'decision'")
      ).rejects.toThrow(/Cannot rename built-in memory type/);
    });

    it('allows updating built-in type description via SQL', async () => {
      await client.query(
        "UPDATE memory_types SET description = 'Updated via SQL' WHERE name = 'decision'"
      );

      const result = await client.query(
        "SELECT description FROM memory_types WHERE name = 'decision'"
      );
      expect(result.rows[0].description).toBe('Updated via SQL');
    });
  });
});
