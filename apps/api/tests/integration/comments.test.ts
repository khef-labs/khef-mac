import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { TEST_DATABASE_URL } from '../setup';

process.env.DATABASE_URL = TEST_DATABASE_URL;

import projectRoutes from '../../src/routes/projects';
import projectMemoryRoutes from '../../src/routes/project-memories';
import memoryRoutes from '../../src/routes/memories';
import commentRoutes from '../../src/routes/comments';

describe('Comments Integration Tests', () => {
  let app: FastifyInstance;
  let client: Client;
  let projectId: string;
  let memoryId: string;

  beforeAll(async () => {
    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(projectMemoryRoutes, { prefix: '/api/projects/:projectId/memories' });
    app.register(memoryRoutes, { prefix: '/api/memories' });
    app.register(commentRoutes, { prefix: '/api/memories/:memoryId/comments' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE projects CASCADE');

    const projRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Comment Test Project' }
    });
    projectId = JSON.parse(projRes.payload).project.id;

    const memRes = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories?compact=false`,
      payload: {
        handle: 'test-memory',
        title: 'Test Memory',
        content: 'The quick brown fox jumps over the lazy dog. The quick brown fox runs fast.',
        type: 'user-note'
      }
    });
    memoryId = JSON.parse(memRes.payload).memory.id;
  });

  describe('Create Comment', () => {
    it('should create an unanchored comment', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: 'This is a general comment' }
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.comment.id).toBeDefined();
      expect(body.comment.entity_type).toBe('memory');
      expect(body.comment.entity_id).toBe(memoryId);
      expect(body.comment.content).toBe('This is a general comment');
      expect(body.comment.anchor_text).toBeNull();
      expect(body.comment.anchor_prefix).toBeNull();
      expect(body.comment.anchor_suffix).toBeNull();
      expect(body.comment.status).toBe('active');
      expect(body.comment.created_at).toBeDefined();
      expect(body.comment.updated_at).toBeDefined();
    });

    it('should create an anchored comment with prefix/suffix', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: {
          content: 'Nice phrase!',
          anchor_text: 'quick brown fox',
          anchor_prefix: 'The ',
          anchor_suffix: ' jumps over'
        }
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.comment.anchor_text).toBe('quick brown fox');
      expect(body.comment.anchor_prefix).toBe('The ');
      expect(body.comment.anchor_suffix).toBe(' jumps over');
    });

    it('should reject empty content', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: '' }
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject missing content', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: {}
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject content over 5000 characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: 'x'.repeat(5001) }
      });
      expect(res.statusCode).toBe(400);
    });

    it('should return 404 for non-existent memory', async () => {
      const fakeId = '019c0000-0000-7000-8000-000000000000';
      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${fakeId}/comments`,
        payload: { content: 'orphan comment' }
      });
      expect(res.statusCode).toBe(404);
    });

    it('should trim whitespace from content', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: '  trimmed  ' }
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.comment.content).toBe('trimmed');
    });
  });

  describe('List Comments', () => {
    it('should list comments in chronological order by default', async () => {
      await app.inject({ method: 'POST', url: `/api/memories/${memoryId}/comments`, payload: { content: 'first' } });
      await app.inject({ method: 'POST', url: `/api/memories/${memoryId}/comments`, payload: { content: 'second' } });
      await app.inject({ method: 'POST', url: `/api/memories/${memoryId}/comments`, payload: { content: 'third' } });

      const res = await app.inject({ method: 'GET', url: `/api/memories/${memoryId}/comments` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.comments).toHaveLength(3);
      expect(body.comments[0].content).toBe('first');
      expect(body.comments[2].content).toBe('third');
    });

    it('should support descending order', async () => {
      await app.inject({ method: 'POST', url: `/api/memories/${memoryId}/comments`, payload: { content: 'first' } });
      await app.inject({ method: 'POST', url: `/api/memories/${memoryId}/comments`, payload: { content: 'second' } });

      const res = await app.inject({ method: 'GET', url: `/api/memories/${memoryId}/comments?order=desc` });
      const body = JSON.parse(res.payload);
      expect(body.comments[0].content).toBe('second');
      expect(body.comments[1].content).toBe('first');
    });

    it('should paginate comments', async () => {
      for (let i = 1; i <= 5; i++) {
        await app.inject({ method: 'POST', url: `/api/memories/${memoryId}/comments`, payload: { content: `comment ${i}` } });
      }

      const res = await app.inject({ method: 'GET', url: `/api/memories/${memoryId}/comments?limit=2&offset=0` });
      const body = JSON.parse(res.payload);
      expect(body.comments).toHaveLength(2);
      expect(body.pagination.total_count).toBe(5);
      expect(body.pagination.has_more).toBe(true);
      expect(body.pagination.limit).toBe(2);
      expect(body.pagination.offset).toBe(0);

      const res2 = await app.inject({ method: 'GET', url: `/api/memories/${memoryId}/comments?limit=2&offset=4` });
      const body2 = JSON.parse(res2.payload);
      expect(body2.comments).toHaveLength(1);
      expect(body2.pagination.has_more).toBe(false);
    });

    it('should return empty list for memory with no comments', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/memories/${memoryId}/comments` });
      const body = JSON.parse(res.payload);
      expect(body.comments).toHaveLength(0);
      expect(body.pagination.total_count).toBe(0);
    });

    it('should return 404 for non-existent memory', async () => {
      const fakeId = '019c0000-0000-7000-8000-000000000000';
      const res = await app.inject({ method: 'GET', url: `/api/memories/${fakeId}/comments` });
      expect(res.statusCode).toBe(404);
    });

    it('should filter by status', async () => {
      const res1 = await app.inject({ method: 'POST', url: `/api/memories/${memoryId}/comments`, payload: { content: 'active one' } });
      const activeId = JSON.parse(res1.payload).comment.id;

      const res2 = await app.inject({ method: 'POST', url: `/api/memories/${memoryId}/comments`, payload: { content: 'will be orphaned' } });
      const orphanId = JSON.parse(res2.payload).comment.id;

      // Mark one as orphaned
      await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/comments/${orphanId}`,
        payload: { status: 'orphaned' }
      });

      const activeRes = await app.inject({ method: 'GET', url: `/api/memories/${memoryId}/comments?status=active` });
      const activeBody = JSON.parse(activeRes.payload);
      expect(activeBody.comments).toHaveLength(1);
      expect(activeBody.comments[0].id).toBe(activeId);

      const orphanRes = await app.inject({ method: 'GET', url: `/api/memories/${memoryId}/comments?status=orphaned` });
      const orphanBody = JSON.parse(orphanRes.payload);
      expect(orphanBody.comments).toHaveLength(1);
      expect(orphanBody.comments[0].id).toBe(orphanId);
    });
  });

  describe('Update Comment', () => {
    it('should update comment content', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: 'original' }
      });
      const commentId = JSON.parse(createRes.payload).comment.id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/comments/${commentId}`,
        payload: { content: 'updated' }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.comment.content).toBe('updated');
    });

    it('should update anchor fields', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: 'anchored', anchor_text: 'old text' }
      });
      const commentId = JSON.parse(createRes.payload).comment.id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/comments/${commentId}`,
        payload: { anchor_text: 'new text', anchor_prefix: 'pre', anchor_suffix: 'suf' }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.comment.anchor_text).toBe('new text');
      expect(body.comment.anchor_prefix).toBe('pre');
      expect(body.comment.anchor_suffix).toBe('suf');
    });

    it('should update status', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: 'will resolve' }
      });
      const commentId = JSON.parse(createRes.payload).comment.id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/comments/${commentId}`,
        payload: { status: 'resolved' }
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).comment.status).toBe('resolved');
    });

    it('should reject invalid status', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: 'test' }
      });
      const commentId = JSON.parse(createRes.payload).comment.id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/comments/${commentId}`,
        payload: { status: 'invalid' }
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject empty update', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: 'test' }
      });
      const commentId = JSON.parse(createRes.payload).comment.id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/comments/${commentId}`,
        payload: {}
      });
      expect(res.statusCode).toBe(400);
    });

    it('should return 404 for non-existent comment', async () => {
      const fakeId = '019c0000-0000-7000-8000-000000000000';
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/comments/${fakeId}`,
        payload: { content: 'nope' }
      });
      expect(res.statusCode).toBe(404);
    });

    it('should not update comment scoped to different memory', async () => {
      // Create a second memory
      const mem2Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories?compact=false`,
        payload: { handle: 'other-memory', title: 'Other Memory', content: 'other content', type: 'user-note' }
      });
      const memory2Id = JSON.parse(mem2Res.payload).memory.id;

      // Create comment on first memory
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: 'belongs to memory 1' }
      });
      const commentId = JSON.parse(createRes.payload).comment.id;

      // Try to update via second memory's scope
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memory2Id}/comments/${commentId}`,
        payload: { content: 'hijack attempt' }
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('Delete Comment', () => {
    it('should delete a comment', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: 'to be deleted' }
      });
      const commentId = JSON.parse(createRes.payload).comment.id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/memories/${memoryId}/comments/${commentId}`
      });
      expect(res.statusCode).toBe(204);

      // Verify it's gone
      const listRes = await app.inject({ method: 'GET', url: `/api/memories/${memoryId}/comments` });
      expect(JSON.parse(listRes.payload).comments).toHaveLength(0);
    });

    it('should return 404 for non-existent comment', async () => {
      const fakeId = '019c0000-0000-7000-8000-000000000000';
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/memories/${memoryId}/comments/${fakeId}`
      });
      expect(res.statusCode).toBe(404);
    });

    it('should delete resolved comments for a memory', async () => {
      const activeRes = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: 'active' }
      });
      const resolvedRes = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: 'resolved' }
      });
      const resolvedId = JSON.parse(resolvedRes.payload).comment.id;

      await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/comments/${resolvedId}`,
        payload: { status: 'resolved' }
      });

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/memories/${memoryId}/comments?status=resolved`
      });
      expect(delRes.statusCode).toBe(200);
      expect(JSON.parse(delRes.payload).deleted_count).toBe(1);

      const listRes = await app.inject({ method: 'GET', url: `/api/memories/${memoryId}/comments` });
      const listBody = JSON.parse(listRes.payload);
      expect(listBody.comments).toHaveLength(1);
      expect(listBody.comments[0].content).toBe('active');
    });

    it('should delete all comments when confirm=true', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: 'comment 1' }
      });
      await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: 'comment 2' }
      });

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/memories/${memoryId}/comments?confirm=true`
      });
      expect(delRes.statusCode).toBe(200);
      expect(JSON.parse(delRes.payload).deleted_count).toBe(2);

      const listRes = await app.inject({ method: 'GET', url: `/api/memories/${memoryId}/comments` });
      expect(JSON.parse(listRes.payload).comments).toHaveLength(0);
    });

    it('should reject delete without status or confirm', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/memories/${memoryId}/comments`
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject invalid status on bulk delete', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/memories/${memoryId}/comments?status=invalid`
      });
      expect(res.statusCode).toBe(400);
    });

    it('should return 404 for non-existent memory on bulk delete', async () => {
      const fakeId = '019c0000-0000-7000-8000-000000000000';
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/memories/${fakeId}/comments?status=resolved`
      });
      expect(res.statusCode).toBe(404);
    });

    it('should cascade delete when memory is deleted', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/comments`,
        payload: { content: 'will cascade' }
      });
      const commentId = JSON.parse(createRes.payload).comment.id;

      // Delete the memory
      await app.inject({
        method: 'DELETE',
        url: `/api/projects/${projectId}/memories/${memoryId}`
      });

      // Verify comment is gone from DB
      const result = await client.query('SELECT id FROM comments WHERE id = $1', [commentId]);
      expect(result.rows).toHaveLength(0);
    });
  });

  describe('Include comments on memory GET', () => {
    it('should not include comments by default (global)', async () => {
      await app.inject({ method: 'POST', url: `/api/memories/${memoryId}/comments`, payload: { content: 'a comment' } });

      const res = await app.inject({ method: 'GET', url: `/api/memories/${memoryId}` });
      const body = JSON.parse(res.payload);
      expect(body.memory.comments).toBeUndefined();
    });

    it('should include comments when comments=true (global)', async () => {
      await app.inject({ method: 'POST', url: `/api/memories/${memoryId}/comments`, payload: { content: 'first' } });
      await app.inject({ method: 'POST', url: `/api/memories/${memoryId}/comments`, payload: { content: 'second' } });

      const res = await app.inject({ method: 'GET', url: `/api/memories/${memoryId}?comments=true` });
      const body = JSON.parse(res.payload);
      expect(body.memory.comments).toHaveLength(2);
      expect(body.memory.comments[0].content).toBe('first');
      expect(body.memory.comments[1].content).toBe('second');
    });

    it('should not include comments by default (project-scoped)', async () => {
      await app.inject({ method: 'POST', url: `/api/memories/${memoryId}/comments`, payload: { content: 'a comment' } });

      const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/memories/${memoryId}` });
      const body = JSON.parse(res.payload);
      expect(body.memory.comments).toBeUndefined();
    });

    it('should include comments when comments=true (project-scoped)', async () => {
      await app.inject({ method: 'POST', url: `/api/memories/${memoryId}/comments`, payload: { content: 'anchored', anchor_text: 'quick brown fox' } });

      const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/memories/${memoryId}?comments=true` });
      const body = JSON.parse(res.payload);
      expect(body.memory.comments).toHaveLength(1);
      expect(body.memory.comments[0].anchor_text).toBe('quick brown fox');
    });
  });
});
