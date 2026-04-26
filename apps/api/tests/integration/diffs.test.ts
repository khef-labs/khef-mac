import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { TEST_DATABASE_URL } from '../setup';

process.env.DATABASE_URL = TEST_DATABASE_URL;

import projectRoutes from '../../src/routes/projects';
import { projectDiffRoutes, globalDiffRoutes, diffCommentRoutes } from '../../src/routes/diffs';

// Full 40-character SHAs for test data (constraint requires NULL or exactly 40 chars)
const SHA1 = 'abc1234567890abcdef1234567890abcdef12340';
const SHA2 = 'commit1000000000000000000000000000000001';
const SHA3 = 'commit2000000000000000000000000000000002';

describe('Diffs Integration Tests', () => {
  let app: FastifyInstance;
  let client: Client;
  let projectId: string;

  beforeAll(async () => {
    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(projectDiffRoutes, { prefix: '/api/projects/:projectId/diffs' });
    app.register(globalDiffRoutes, { prefix: '/api/diffs/:diffId' });
    app.register(diffCommentRoutes, { prefix: '/api/diffs/:diffId/comments' });

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
      payload: { name: 'Diff Test Project' }
    });
    projectId = JSON.parse(projRes.payload).project.id;
  });

  describe('Create Comment (and diff record lazily)', () => {
    it('should create diff record and comment for working tree', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/diffs/by-ref/working/comments`,
        payload: {
          branch: 'main',
          content: 'Great change!'
        }
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.comment.content).toBe('Great change!');
      expect(body.comment.entity_type).toBe('diff');
      expect(body.diff).toBeDefined();
      expect(body.diff.commit_sha).toBeNull();
      expect(body.diff.branch).toBe('main');
    });

    it('should create diff record and comment for commit', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/diffs/by-ref/${SHA1}/comments`,
        payload: {
          branch: 'main',
          content: 'Comment on commit'
        }
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.comment.content).toBe('Comment on commit');
      expect(body.diff.commit_sha).toBe(SHA1);
    });

    it('should reuse existing diff record for subsequent comments', async () => {
      // First comment creates the diff
      const res1 = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/diffs/by-ref/working/comments`,
        payload: { branch: 'main', content: 'First comment' }
      });
      const diff1 = JSON.parse(res1.payload).diff;

      // Second comment reuses the diff
      const res2 = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/diffs/by-ref/working/comments`,
        payload: { branch: 'main', content: 'Second comment' }
      });
      const diff2 = JSON.parse(res2.payload).diff;

      expect(diff1.id).toBe(diff2.id);
    });

    it('should require branch when creating new diff record', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/diffs/by-ref/working/comments`,
        payload: { content: 'Missing branch' }
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('branch');
    });

    it('should reject short SHAs for commit comments', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/diffs/by-ref/abc1234/comments`,
        payload: { branch: 'main', content: 'Short SHA' }
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('40-character');
    });

    it('should support anchor fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/diffs/by-ref/working/comments`,
        payload: {
          branch: 'main',
          content: 'Inline comment',
          anchor_path: 'src/index.ts',
          anchor_line: 42
        }
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.comment.anchor_path).toBe('src/index.ts');
      expect(body.comment.anchor_line).toBe(42);
    });
  });

  describe('List Diff Records', () => {
    beforeEach(async () => {
      // Create diffs via comments
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/diffs/by-ref/working/comments`,
        payload: { branch: 'main', content: 'Working comment' }
      });
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/diffs/by-ref/${SHA2}/comments`,
        payload: { branch: 'main', content: 'Commit 1 comment' }
      });
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/diffs/by-ref/${SHA3}/comments`,
        payload: { branch: 'feature', content: 'Commit 2 comment' }
      });
    });

    it('should list all diff records for project', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/diffs`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.diffs).toHaveLength(3);
      expect(body.pagination.total_count).toBe(3);
    });

    it('should filter by branch', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/diffs?branch=main`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.diffs).toHaveLength(2);
    });
  });

  describe('Find Diff by Ref', () => {
    it('should find working tree diff with comments', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/diffs/by-ref/working/comments`,
        payload: { branch: 'main', content: 'A comment' }
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/diffs/by-ref/working`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.diff.commit_sha).toBeNull();
      expect(body.comments).toHaveLength(1);
      expect(body.comments[0].content).toBe('A comment');
    });

    it('should return 404 for non-existent diff', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/diffs/by-ref/working`
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('Diff Comments via diffId', () => {
    let diffId: string;

    beforeEach(async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/diffs/by-ref/working/comments`,
        payload: { branch: 'main', content: 'Initial comment' }
      });
      diffId = JSON.parse(createRes.payload).diff.id;
    });

    it('should list comments for a diff', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/diffs/${diffId}/comments`,
        payload: { content: 'Another comment' }
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/diffs/${diffId}/comments`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.comments).toHaveLength(2);
    });

    it('should update a comment', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: `/api/diffs/${diffId}/comments`
      });
      const commentId = JSON.parse(listRes.payload).comments[0].id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/diffs/${diffId}/comments/${commentId}`,
        payload: { content: 'Updated', status: 'resolved' }
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.comment.content).toBe('Updated');
      expect(body.comment.status).toBe('resolved');
    });

    it('should delete a comment', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: `/api/diffs/${diffId}/comments`
      });
      const commentId = JSON.parse(listRes.payload).comments[0].id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/diffs/${diffId}/comments/${commentId}`
      });

      expect(res.statusCode).toBe(204);
    });
  });

  describe('Comments are isolated per diff', () => {
    it('should isolate comments between different commits', async () => {
      const res1 = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/diffs/by-ref/${SHA2}/comments`,
        payload: { branch: 'main', content: 'Comment on commit 1' }
      });
      const diff1Id = JSON.parse(res1.payload).diff.id;

      const res2 = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/diffs/by-ref/${SHA3}/comments`,
        payload: { branch: 'main', content: 'Comment on commit 2' }
      });
      const diff2Id = JSON.parse(res2.payload).diff.id;

      const list1 = await app.inject({
        method: 'GET',
        url: `/api/diffs/${diff1Id}/comments`
      });
      expect(JSON.parse(list1.payload).comments).toHaveLength(1);

      const list2 = await app.inject({
        method: 'GET',
        url: `/api/diffs/${diff2Id}/comments`
      });
      expect(JSON.parse(list2.payload).comments).toHaveLength(1);
    });
  });
});
