import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { setupTestDb, TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import geminiRoutes from '../../src/routes/gemini';

describe('Gemini API', () => {
  let app: FastifyInstance;
  let client: Client;

  beforeAll(async () => {
    await setupTestDb();

    app = Fastify();
    app.register(geminiRoutes, { prefix: '/api/gemini' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    // Clean up gemini tables
    await client.query('TRUNCATE gemini_conversations CASCADE');
  });

  describe('GET /api/gemini/status', () => {
    it('returns availability status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/gemini/status',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('available');
      // Without proper gcloud setup, will return false or error reason
      if (!body.available) {
        expect(body).toHaveProperty('reason');
      }
    });
  });

  describe('GET /api/gemini/settings', () => {
    it('returns gemini settings', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/gemini/settings',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.settings).toHaveProperty('project');
      expect(body.settings).toHaveProperty('location');
      expect(body.settings).toHaveProperty('defaultModel');
    });
  });

  describe('Conversations CRUD', () => {
    let conversationId: string;

    it('creates a conversation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/gemini/conversations',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ title: 'Test Conversation' }),
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.conversation.title).toBe('Test Conversation');
      expect(body.conversation.project_id).toBeNull();
      conversationId = body.conversation.id;
    });

    it('lists conversations', async () => {
      // Create a conversation first
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/gemini/conversations',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ title: 'List Test' }),
      });
      conversationId = JSON.parse(createRes.payload).conversation.id;

      const res = await app.inject({
        method: 'GET',
        url: '/api/gemini/conversations',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.conversations).toBeInstanceOf(Array);
      expect(body.pagination).toHaveProperty('total_count');
      expect(body.conversations.some((c: any) => c.id === conversationId)).toBe(true);
    });

    it('gets a conversation by id', async () => {
      // Create a conversation first
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/gemini/conversations',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ title: 'Get Test' }),
      });
      conversationId = JSON.parse(createRes.payload).conversation.id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/gemini/conversations/${conversationId}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.conversation.id).toBe(conversationId);
      expect(body.conversation.title).toBe('Get Test');
      expect(body.conversation.messages).toBeInstanceOf(Array);
    });

    it('updates a conversation', async () => {
      // Create a conversation first
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/gemini/conversations',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ title: 'Update Test' }),
      });
      conversationId = JSON.parse(createRes.payload).conversation.id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/gemini/conversations/${conversationId}`,
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ title: 'Updated Title' }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.conversation.title).toBe('Updated Title');
    });

    it('deletes a conversation', async () => {
      // Create a conversation first
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/gemini/conversations',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ title: 'Delete Test' }),
      });
      conversationId = JSON.parse(createRes.payload).conversation.id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/gemini/conversations/${conversationId}`,
      });

      expect(res.statusCode).toBe(204);

      // Verify deleted
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/gemini/conversations/${conversationId}`,
      });
      expect(getRes.statusCode).toBe(404);
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/gemini/conversations/00000000-0000-0000-0000-000000000000',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('Conversations with project', () => {
    let conversationId: string;
    let projectId: string;

    beforeAll(async () => {
      // Get a project to associate
      const result = await client.query('SELECT id FROM projects LIMIT 1');
      if (result.rows.length > 0) {
        projectId = result.rows[0].id;
      }
    });

    it('creates a conversation with project', async () => {
      if (!projectId) return; // Skip if no projects

      const res = await app.inject({
        method: 'POST',
        url: '/api/gemini/conversations',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({
          title: 'Project Conversation',
          project_id: projectId,
        }),
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.conversation.project_id).toBe(projectId);
      conversationId = body.conversation.id;
    });

    it('filters conversations by project', async () => {
      if (!projectId) return;

      // Create a conversation with project
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/gemini/conversations',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({
          title: 'Filtered Conversation',
          project_id: projectId,
        }),
      });
      conversationId = JSON.parse(createRes.payload).conversation.id;

      // Filter by project
      const res = await app.inject({
        method: 'GET',
        url: `/api/gemini/conversations?project_id=${projectId}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.conversations.length).toBeGreaterThan(0);
      expect(body.conversations.every((c: any) => c.project_id === projectId)).toBe(true);
    });
  });

  describe('Messages', () => {
    let conversationId: string;

    beforeEach(async () => {
      // Create a conversation for message tests
      const res = await app.inject({
        method: 'POST',
        url: '/api/gemini/conversations',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ title: 'Message Test' }),
      });
      conversationId = JSON.parse(res.payload).conversation.id;
    });

    it('requires prompt_text to send a message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/gemini/conversations/${conversationId}/messages`,
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({}),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('prompt_text');
    });

    it('stores message even if API call fails', async () => {
      // Without valid GCP setup, this will fail but should still store
      const res = await app.inject({
        method: 'POST',
        url: `/api/gemini/conversations/${conversationId}/messages`,
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ prompt_text: 'Test prompt' }),
      });

      // May be 201 or 500 depending on error handling
      const body = JSON.parse(res.payload);
      expect(body.message).toBeDefined();
      expect(body.message.prompt_text).toBe('Test prompt');
      expect(body.message.model).toBeDefined();
      // Will have error since API isn't configured
      if (body.message.error) {
        expect(typeof body.message.error).toBe('string');
      }
    });

    it('accepts contents array in message body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/gemini/conversations/${conversationId}/messages`,
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({
          prompt_text: 'Follow-up question',
          contents: [
            { role: 'user', parts: [{ text: 'Hello' }] },
            { role: 'model', parts: [{ text: 'Hi there!' }] },
            { role: 'user', parts: [{ text: 'Follow-up question' }] },
          ],
        }),
      });

      // Will be 500 because Gemini API isn't configured, but message is stored
      const body = JSON.parse(res.payload);
      expect(body.message).toBeDefined();
      expect(body.message.prompt_text).toBe('Follow-up question');
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/gemini/conversations/00000000-0000-0000-0000-000000000000/messages',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ prompt_text: 'Test' }),
      });

      expect(res.statusCode).toBe(404);
    });

    it('deletes a message', async () => {
      // Create a message first (will fail API call but stores the message)
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/gemini/conversations/${conversationId}/messages`,
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ prompt_text: 'To be deleted' }),
      });

      const messageId = JSON.parse(createRes.payload).message.id;

      // Record conversation updated_at before delete
      const beforeRes = await app.inject({
        method: 'GET',
        url: `/api/gemini/conversations/${conversationId}`,
      });
      const beforeUpdatedAt = JSON.parse(beforeRes.payload).conversation.updated_at;

      // Small delay to ensure timestamp differs
      await new Promise(resolve => setTimeout(resolve, 10));

      // Delete the message
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/gemini/conversations/${conversationId}/messages/${messageId}`,
      });

      expect(deleteRes.statusCode).toBe(204);

      // Verify message is gone from conversation
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/gemini/conversations/${conversationId}`,
      });
      const conv = JSON.parse(getRes.payload).conversation;
      expect(conv.messages.some((m: any) => m.id === messageId)).toBe(false);

      // Verify conversation updated_at changed
      expect(conv.updated_at).not.toBe(beforeUpdatedAt);
    });

    it('returns 404 when deleting message from wrong conversation', async () => {
      // Create a message in the existing conversation
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/gemini/conversations/${conversationId}/messages`,
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ prompt_text: 'Wrong conv test' }),
      });
      const messageId = JSON.parse(createRes.payload).message.id;

      // Create a different conversation
      const otherConvRes = await app.inject({
        method: 'POST',
        url: '/api/gemini/conversations',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ title: 'Other Conversation' }),
      });
      const otherConvId = JSON.parse(otherConvRes.payload).conversation.id;

      // Try to delete message using the wrong conversation
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/gemini/conversations/${otherConvId}/messages/${messageId}`,
      });

      expect(deleteRes.statusCode).toBe(404);
      const body = JSON.parse(deleteRes.payload);
      expect(body.error).toContain('Message not found');
    });

    it('returns 404 when conversation does not exist for delete', async () => {
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: '/api/gemini/conversations/00000000-0000-0000-0000-000000000000/messages/00000000-0000-0000-0000-000000000001',
      });

      expect(deleteRes.statusCode).toBe(404);
      const body = JSON.parse(deleteRes.payload);
      expect(body.error).toContain('Conversation not found');
    });

    it('stores and returns response_parts JSONB', async () => {
      // Insert a message with response_parts directly via SQL
      const responseParts = [
        { type: 'text', text: 'Here is an image:' },
        { type: 'file', fileId: '00000000-0000-0000-0000-000000000099', mimeType: 'image/png' },
      ];
      await client.query(
        `INSERT INTO gemini_messages (conversation_id, prompt_text, response, response_parts, model)
         VALUES ($1, $2, $3, $4, $5)`,
        [conversationId, 'Generate an image', 'Here is an image:', JSON.stringify(responseParts), 'gemini-2.5-flash']
      );

      // Fetch conversation and check response_parts on the message
      const res = await app.inject({
        method: 'GET',
        url: `/api/gemini/conversations/${conversationId}`,
      });

      expect(res.statusCode).toBe(200);
      const conv = JSON.parse(res.payload).conversation;
      const msg = conv.messages.find((m: any) => m.prompt_text === 'Generate an image');
      expect(msg).toBeDefined();
      expect(msg.response_parts).toEqual(responseParts);
    });

    it('response_parts defaults to null for text-only messages', async () => {
      // Create a message (will fail API but stores the message)
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/gemini/conversations/${conversationId}/messages`,
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ prompt_text: 'Just text' }),
      });

      const body = JSON.parse(createRes.payload);
      expect(body.message.response_parts).toBeNull();
    });
  });

  describe('One-shot generate', () => {
    it('requires prompt_text', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/gemini/generate',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({}),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('prompt_text');
    });

    it('returns error without valid GCP setup', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/gemini/generate',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ prompt_text: 'Test prompt' }),
      });

      // Will fail without proper GCP setup
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.payload);
      expect(body.error).toBeDefined();
    });
  });
});
