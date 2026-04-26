/**
 * Gemini conversation routes.
 * Stateless calls to Vertex AI Gemini with conversation/message tracking.
 */
import { FastifyPluginAsync } from 'fastify';
import { query, querySingle } from '../db/client';
import { resolveProject } from './projects';
import { checkGeminiStatus, generateContent, getGeminiSettings, type ResponsePart } from '../services/gemini';
import { PaginationMetadata } from '../types';
import * as fs from 'fs';
import * as path from 'path';

interface Conversation {
  id: string;
  title: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

interface GroundingData {
  searchQueries: string[];
  sources: Array<{ uri: string; title: string }>;
}

interface ThinkingData {
  text: string;
  tokenCount: number;
}

interface StoredResponsePart {
  type: 'text' | 'file';
  text?: string;
  fileId?: string;
  mimeType?: string;
}

interface Message {
  id: string;
  conversation_id: string;
  prompt_id: string | null;
  prompt_text: string;
  response: string | null;
  response_parts: StoredResponsePart[] | null;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  error: string | null;
  grounding: GroundingData | null;
  thinking: ThinkingData | null;
  created_at: string;
}

interface ConversationWithMessages extends Conversation {
  messages: Message[];
  project_handle?: string;
  project_name?: string;
}

interface Setting {
  key: string;
  value: string;
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/l16': 'wav',
};

async function getStoragePath(): Promise<string> {
  const rows = await query<Setting>(
    "SELECT value FROM settings WHERE key = 'files.storagePath'"
  );
  return rows.length > 0 ? rows[0].value : './uploads';
}

/**
 * Save base64-encoded inline data to disk and create a files table record.
 * Returns the file ID for referencing in response_parts.
 */
async function saveInlineData(
  data: string,
  mimeType: string,
  conversationId: string,
  projectId: string | null,
): Promise<string> {
  const storagePath = await getStoragePath();
  const dir = path.join(storagePath, 'gemini', conversationId);
  await fs.promises.mkdir(dir, { recursive: true });

  const fileId = crypto.randomUUID();
  const ext = MIME_EXTENSIONS[mimeType] || 'bin';
  const filename = `${fileId}.${ext}`;
  const filePath = path.join(dir, filename);

  const buffer = Buffer.from(data, 'base64');
  await fs.promises.writeFile(filePath, buffer);

  await query(
    `INSERT INTO files (id, project_id, filename, original_filename, mime_type, size, path)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [fileId, projectId, filename, `gemini-${filename}`, mimeType, buffer.length, filePath]
  );

  return fileId;
}

const geminiRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/gemini/status - Check Gemini availability and configuration
  fastify.get('/status', async () => {
    return checkGeminiStatus();
  });

  // GET /api/gemini/settings - Get current Gemini settings
  fastify.get('/settings', async () => {
    const settings = await getGeminiSettings();
    return { settings };
  });

  // GET /api/gemini/conversations - List conversations
  fastify.get('/conversations', async (request) => {
    const { project_id, limit = '20', offset = '0' } = request.query as {
      project_id?: string;
      limit?: string;
      offset?: string;
    };

    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offsetNum = parseInt(offset, 10) || 0;

    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (project_id) {
      // Resolve project (accepts handle, name, or UUID)
      const project = await resolveProject(project_id);
      if (project) {
        conditions.push(`c.project_id = $${idx}`);
        params.push(project.id);
        idx++;
      } else {
        // Invalid project filter - return empty
        return {
          conversations: [],
          pagination: { total_count: 0, limit: limitNum, offset: offsetNum, has_more: false },
        };
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await querySingle<{ count: string }>(
      `SELECT COUNT(*) as count FROM gemini_conversations c ${where}`,
      params
    );
    const totalCount = parseInt(countResult?.count || '0', 10);

    const conversations = await query<Conversation & { message_count: string; project_handle?: string; project_name?: string }>(
      `SELECT c.*,
              p.handle as project_handle,
              p.name as project_name,
              COALESCE(mc.cnt, 0) as message_count
       FROM gemini_conversations c
       LEFT JOIN projects p ON c.project_id = p.id
       LEFT JOIN (
         SELECT conversation_id, COUNT(*) as cnt
         FROM gemini_messages
         GROUP BY conversation_id
       ) mc ON mc.conversation_id = c.id
       ${where}
       ORDER BY c.updated_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limitNum, offsetNum]
    );

    const pagination: PaginationMetadata = {
      total_count: totalCount,
      limit: limitNum,
      offset: offsetNum,
      has_more: offsetNum + limitNum < totalCount,
    };

    return {
      conversations: conversations.map(c => ({
        ...c,
        message_count: parseInt(c.message_count, 10),
      })),
      pagination,
    };
  });

  // POST /api/gemini/conversations - Create conversation
  fastify.post('/conversations', async (request, reply) => {
    const { title, project_id } = request.body as {
      title?: string;
      project_id?: string;
    };

    let resolvedProjectId: string | null = null;

    if (project_id) {
      const project = await resolveProject(project_id);
      if (!project) {
        return reply.code(400).send({ error: 'Project not found' });
      }
      resolvedProjectId = project.id;
    }

    const result = await querySingle<Conversation>(
      `INSERT INTO gemini_conversations (title, project_id)
       VALUES ($1, $2)
       RETURNING *`,
      [title || null, resolvedProjectId]
    );

    return reply.code(201).send({ conversation: result });
  });

  // GET /api/gemini/conversations/:id - Get conversation with messages
  fastify.get('/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const conversation = await querySingle<Conversation & { project_handle?: string; project_name?: string }>(
      `SELECT c.*,
              p.handle as project_handle,
              p.name as project_name
       FROM gemini_conversations c
       LEFT JOIN projects p ON c.project_id = p.id
       WHERE c.id = $1`,
      [id]
    );

    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    const messages = await query<Message>(
      `SELECT * FROM gemini_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [id]
    );

    return {
      conversation: {
        ...conversation,
        messages,
      },
    };
  });

  // PATCH /api/gemini/conversations/:id - Update conversation
  fastify.patch('/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { title, project_id } = request.body as {
      title?: string;
      project_id?: string | null;
    };

    const existing = await querySingle<Conversation>(
      'SELECT * FROM gemini_conversations WHERE id = $1',
      [id]
    );

    if (!existing) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    const updates: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (title !== undefined) {
      updates.push(`title = $${idx}`);
      params.push(title || null);
      idx++;
    }

    if (project_id !== undefined) {
      if (project_id === null) {
        updates.push(`project_id = NULL`);
      } else {
        const project = await resolveProject(project_id);
        if (!project) {
          return reply.code(400).send({ error: 'Project not found' });
        }
        updates.push(`project_id = $${idx}`);
        params.push(project.id);
        idx++;
      }
    }

    if (updates.length === 0) {
      return { conversation: existing };
    }

    params.push(id);
    const result = await querySingle<Conversation>(
      `UPDATE gemini_conversations
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${idx}
       RETURNING *`,
      params
    );

    return { conversation: result };
  });

  // DELETE /api/gemini/conversations/:id - Delete conversation
  fastify.delete('/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const existing = await querySingle<Conversation>(
      'SELECT * FROM gemini_conversations WHERE id = $1',
      [id]
    );

    if (!existing) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    await query('DELETE FROM gemini_conversations WHERE id = $1', [id]);

    return reply.code(204).send();
  });

  // POST /api/gemini/conversations/:id/messages - Send message and get response
  fastify.post('/conversations/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { prompt_text, prompt_id, model, temperature, max_output_tokens, use_google_search, use_url_context, use_thinking, thinking_budget, contents } = request.body as {
      prompt_text: string;
      prompt_id?: string;
      model?: string;
      temperature?: number;
      max_output_tokens?: number;
      use_google_search?: boolean;
      use_url_context?: boolean;
      use_thinking?: boolean;
      thinking_budget?: number;
      contents?: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
    };

    if (!prompt_text) {
      return reply.code(400).send({ error: 'prompt_text is required' });
    }

    const conversation = await querySingle<Conversation>(
      'SELECT * FROM gemini_conversations WHERE id = $1',
      [id]
    );

    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    // If prompt_id provided, verify it exists
    if (prompt_id) {
      const prompt = await querySingle<{ id: string }>(
        'SELECT id FROM prompts WHERE id = $1',
        [prompt_id]
      );
      if (!prompt) {
        return reply.code(400).send({ error: 'Prompt not found' });
      }
    }

    // Call Gemini
    let response: string | null = null;
    let responseParts: ResponsePart[] | undefined;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let error: string | null = null;
    let grounding: GroundingData | null = null;
    let thinking: ThinkingData | null = null;
    let usedModel: string;

    try {
      const settings = await getGeminiSettings();
      usedModel = model || settings.defaultModel;

      const result = await generateContent(prompt_text, {
        model: usedModel,
        temperature,
        maxOutputTokens: max_output_tokens,
        useGoogleSearch: use_google_search,
        useUrlContext: use_url_context,
        useThinking: use_thinking,
        thinkingBudget: thinking_budget,
        contents,
      });

      response = result.response;
      responseParts = result.responseParts;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      usedModel = result.model;
      if (result.grounding) {
        grounding = result.grounding;
      }
      if (result.thinking) {
        thinking = result.thinking;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      const settings = await getGeminiSettings();
      usedModel = model || settings.defaultModel;
    }

    // Process multimodal parts: save inline_data to disk, replace with file references
    let storedParts: StoredResponsePart[] | null = null;
    if (responseParts) {
      storedParts = [];
      for (const part of responseParts) {
        if (part.type === 'inline_data' && part.data && part.mimeType) {
          const fileId = await saveInlineData(
            part.data,
            part.mimeType,
            id,
            conversation.project_id,
          );
          storedParts.push({ type: 'file', fileId, mimeType: part.mimeType });
        } else if (part.type === 'text') {
          storedParts.push({ type: 'text', text: part.text });
        }
      }
    }

    // Store message
    const message = await querySingle<Message>(
      `INSERT INTO gemini_messages (conversation_id, prompt_id, prompt_text, response, response_parts, model, input_tokens, output_tokens, error, grounding, thinking)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [id, prompt_id || null, prompt_text, response, storedParts ? JSON.stringify(storedParts) : null, usedModel, inputTokens, outputTokens, error, grounding ? JSON.stringify(grounding) : null, thinking ? JSON.stringify(thinking) : null]
    );

    // Update conversation updated_at
    await query(
      'UPDATE gemini_conversations SET updated_at = NOW() WHERE id = $1',
      [id]
    );

    if (error) {
      return reply.code(500).send({ message, error });
    }

    return reply.code(201).send({ message });
  });

  // DELETE /api/gemini/conversations/:id/messages/:messageId - Delete a message
  fastify.delete('/conversations/:id/messages/:messageId', async (request, reply) => {
    const { id, messageId } = request.params as { id: string; messageId: string };

    const conversation = await querySingle<Conversation>(
      'SELECT id FROM gemini_conversations WHERE id = $1',
      [id]
    );

    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    const message = await querySingle<{ id: string }>(
      'SELECT id FROM gemini_messages WHERE id = $1 AND conversation_id = $2',
      [messageId, id]
    );

    if (!message) {
      return reply.code(404).send({ error: 'Message not found' });
    }

    await query('DELETE FROM gemini_messages WHERE id = $1', [messageId]);
    await query('UPDATE gemini_conversations SET updated_at = NOW() WHERE id = $1', [id]);

    return reply.code(204).send();
  });

  // POST /api/gemini/generate - One-shot generation (no conversation)
  fastify.post('/generate', async (request, reply) => {
    const { prompt_text, model, temperature, max_output_tokens, use_google_search, use_url_context, use_thinking, thinking_budget } = request.body as {
      prompt_text: string;
      model?: string;
      temperature?: number;
      max_output_tokens?: number;
      use_google_search?: boolean;
      use_url_context?: boolean;
      use_thinking?: boolean;
      thinking_budget?: number;
    };

    if (!prompt_text) {
      return reply.code(400).send({ error: 'prompt_text is required' });
    }

    try {
      const result = await generateContent(prompt_text, {
        model,
        temperature,
        maxOutputTokens: max_output_tokens,
        useGoogleSearch: use_google_search,
        useUrlContext: use_url_context,
        useThinking: use_thinking,
        thinkingBudget: thinking_budget,
      });

      return {
        response: result.response,
        model: result.model,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        grounding: result.grounding,
        thinking: result.thinking,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error });
    }
  });
};

export default geminiRoutes;
