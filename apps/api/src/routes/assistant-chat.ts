/**
 * Assistant chat routes.
 *
 * Unified chat endpoint for all backends (Claude, Codex, Gemini).
 * Persists conversations and messages in assistant_chats / assistant_chat_messages.
 */
import { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { query, querySingle } from '../db/client';
import { resolveProject } from './projects';
import { chatWithAssistant, checkAvailability, hasCapacity, getConcurrencyInfo, checkRateLimit, type ChatMessage } from '../services/assistant-chat';
import type { ResponsePart } from '../services/gemini';
import { PaginationMetadata } from '../types';

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg)$/i;

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
  const rows = await query<{ value: string }>(
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
  chatId: string,
  projectId: string | null,
): Promise<string> {
  const storagePath = await getStoragePath();
  const dir = path.join(storagePath, 'chat', chatId);
  await fs.promises.mkdir(dir, { recursive: true });

  const fileId = randomUUID();
  const ext = MIME_EXTENSIONS[mimeType] || 'bin';
  const filename = `${fileId}.${ext}`;
  const filePath = path.join(dir, filename);

  const buffer = Buffer.from(data, 'base64');
  await fs.promises.writeFile(filePath, buffer);

  await query(
    `INSERT INTO files (id, project_id, filename, original_filename, mime_type, size, path)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [fileId, projectId, filename, `chat-${filename}`, mimeType, buffer.length, filePath]
  );

  return fileId;
}

interface StoredPart {
  type: 'text' | 'file';
  text?: string;
  fileId?: string;
  mimeType?: string;
}

/**
 * Process responseParts from Gemini: save inline data as files, build stored parts and response text.
 */
async function processResponseParts(
  responseParts: ResponsePart[],
  chatId: string,
  projectId: string | null,
): Promise<{ storedParts: StoredPart[]; responseText: string }> {
  const storedParts: StoredPart[] = [];
  const textParts: string[] = [];

  for (const part of responseParts) {
    if (part.type === 'inline_data' && part.data && part.mimeType) {
      const fileId = await saveInlineData(part.data, part.mimeType, chatId, projectId);
      storedParts.push({ type: 'file', fileId, mimeType: part.mimeType });
      // Add markdown image/audio tag to response text
      if (part.mimeType.startsWith('image/')) {
        textParts.push(`![Generated image](/api/files/${fileId})`);
      } else if (part.mimeType.startsWith('audio/')) {
        textParts.push(`[Audio file](/api/files/${fileId})`);
      }
    } else if (part.type === 'text' && part.text) {
      storedParts.push({ type: 'text', text: part.text });
      textParts.push(part.text);
    }
  }

  return { storedParts, responseText: textParts.join('\n\n') };
}

/**
 * Post-process a chat response to convert image file paths into markdown image tags.
 * Matches absolute paths ending in image extensions that aren't already inside markdown image syntax.
 */
function injectImageTags(text: string): string {
  return text.replace(
    /(^|[\s,;:])(\/([\w .+\-@/]+)\.(png|jpe?g|gif|webp|svg))\b/gim,
    (match, prefix, fullPath) => {
      // Skip if this path is already inside a markdown image/link
      const idx = text.indexOf(match);
      const before = text.slice(Math.max(0, idx - 4), idx);
      if (before.includes('](') || before.includes('![')) return match;

      const encoded = encodeURIComponent(fullPath);
      return `${prefix}\n\n![${fullPath}](/api/files/local?path=${encoded})\n\n`;
    }
  );
}

interface Chat {
  id: string;
  assistant_handle: string;
  title: string | null;
  project_id: string | null;
  parent_chat_id: string | null;
  session_id: string | null;
  source: string;
  caller_handle: string | null;
  created_at: string;
  updated_at: string;
}

interface ChatMessageRow {
  id: string;
  chat_id: string;
  prompt_text: string;
  response: string | null;
  response_parts: StoredPart[] | null;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  error: string | null;
  status: string;
  grounding: Record<string, unknown> | null;
  thinking: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** Valid assistant handles for chat. */
const VALID_HANDLES = new Set(['claude-code', 'codex-cli', 'gemini']);

/** Input size limits. */
const MAX_PROMPT_LENGTH = 100_000;      // 100KB per prompt
const MAX_MESSAGE_CONTENT = 100_000;    // 100KB per history message
const MAX_MESSAGES = 100;               // Max conversation turns in request
const MAX_TITLE_LENGTH = 200;           // Matches DB VARCHAR(200)
const MAX_MESSAGES_PER_CHAT = 100;      // Max stored messages per chat
const MAX_RESPONSE_LENGTH = 500_000;    // Truncate responses before storing

function validateHandle(handle: string, reply: any): boolean {
  if (!VALID_HANDLES.has(handle)) {
    reply.code(400).send({ error: `Invalid assistant handle: ${handle}. Must be one of: ${[...VALID_HANDLES].join(', ')}` });
    return false;
  }
  return true;
}

interface DelegationRow {
  parent_turn_id: string;
  child_chat_id: string;
  delegated_handle: string;
}

interface DelegatedChatEntry {
  chat: Chat & { project_handle?: string; project_name?: string };
  messages: ChatMessageRow[];
  delegated_handle: string;
}

/**
 * Build delegations map from parent turn IDs to child chat details.
 * Returns a record keyed by parent_turn_id, each containing an array of delegated chats.
 */
async function buildDelegations(
  parentMessages: ChatMessageRow[]
): Promise<Record<string, DelegatedChatEntry[]>> {
  if (parentMessages.length === 0) return {};

  const messageIds = parentMessages.map(m => m.id);

  const delegationRows = await query<DelegationRow>(
    `SELECT d.parent_turn_id, d.child_chat_id, d.delegated_handle
     FROM assistant_chat_delegations d
     WHERE d.parent_turn_id = ANY($1::uuid[])
     ORDER BY d.created_at ASC`,
    [messageIds]
  );

  if (delegationRows.length === 0) return {};

  const childChatIds = delegationRows.map(d => d.child_chat_id);

  const childChats = await query<Chat & { project_handle?: string; project_name?: string }>(
    `SELECT c.*, p.handle as project_handle, p.name as project_name
     FROM assistant_chats c
     LEFT JOIN projects p ON c.project_id = p.id
     WHERE c.id = ANY($1::uuid[])`,
    [childChatIds]
  );

  const childMessages = await query<ChatMessageRow>(
    'SELECT * FROM assistant_chat_messages WHERE chat_id = ANY($1::uuid[]) ORDER BY created_at ASC',
    [childChatIds]
  );

  const chatMap = new Map(childChats.map(c => [c.id, c]));
  const msgMap = new Map<string, ChatMessageRow[]>();
  for (const msg of childMessages) {
    const list = msgMap.get(msg.chat_id);
    if (list) list.push(msg);
    else msgMap.set(msg.chat_id, [msg]);
  }

  const result: Record<string, DelegatedChatEntry[]> = {};
  for (const row of delegationRows) {
    const chat = chatMap.get(row.child_chat_id);
    if (!chat) continue;
    const entry: DelegatedChatEntry = {
      chat,
      messages: msgMap.get(row.child_chat_id) || [],
      delegated_handle: row.delegated_handle,
    };
    if (!result[row.parent_turn_id]) {
      result[row.parent_turn_id] = [entry];
    } else {
      result[row.parent_turn_id].push(entry);
    }
  }

  return result;
}

const assistantChatRoutes: FastifyPluginAsync = async (fastify) => {

  // POST /api/assistants/:handle/chat — Send a message (auto-creates chat if no chat_id)
  fastify.post('/:handle/chat', async (request, reply) => {
    const { handle } = request.params as { handle: string };
    if (!validateHandle(handle, reply)) return;
    const {
      chat_id,
      parent_chat_id,
      parent_turn_id,
      prompt_text,
      messages,
      model,
      project_id,
      title,
      session_id,
      system_prompt,
      voice_mode,
      source,
      caller_handle,
      use_google_search,
      use_thinking,
      thinking_budget,
    } = request.body as {
      chat_id?: string;
      parent_chat_id?: string;
      parent_turn_id?: string;
      prompt_text: string;
      messages?: ChatMessage[];
      model?: string;
      project_id?: string;
      title?: string;
      session_id?: string;
      system_prompt?: string;
      voice_mode?: boolean;
      source?: string;
      caller_handle?: string;
      use_google_search?: boolean;
      use_thinking?: boolean;
      thinking_budget?: number;
    };

    if (!prompt_text) {
      return reply.code(400).send({ error: 'prompt_text is required' });
    }

    if (prompt_text.length > MAX_PROMPT_LENGTH) {
      return reply.code(400).send({ error: `prompt_text exceeds maximum length of ${MAX_PROMPT_LENGTH} characters` });
    }

    if (title && title.length > MAX_TITLE_LENGTH) {
      return reply.code(400).send({ error: `title exceeds maximum length of ${MAX_TITLE_LENGTH} characters` });
    }

    if (messages) {
      if (!Array.isArray(messages)) {
        return reply.code(400).send({ error: 'messages must be an array' });
      }
      if (messages.length > MAX_MESSAGES) {
        return reply.code(400).send({ error: `messages exceeds maximum of ${MAX_MESSAGES} turns` });
      }
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg.role || !['user', 'assistant'].includes(msg.role)) {
          return reply.code(400).send({ error: `messages[${i}].role must be 'user' or 'assistant'` });
        }
        if (!msg.content || typeof msg.content !== 'string') {
          return reply.code(400).send({ error: `messages[${i}].content must be a non-empty string` });
        }
        if (msg.content.length > MAX_MESSAGE_CONTENT) {
          return reply.code(400).send({ error: `messages[${i}].content exceeds maximum length of ${MAX_MESSAGE_CONTENT} characters` });
        }
      }
    }

    // Rate limit (global, 30 req/min for chat POST)
    const rateCheck = checkRateLimit();
    if (!rateCheck.allowed) {
      reply.header('Retry-After', Math.ceil(rateCheck.resetMs / 1000));
      return reply.code(429).send({
        error: 'Rate limit exceeded (30 requests per minute)',
        remaining: 0,
        retry_after_ms: rateCheck.resetMs,
      });
    }

    // Check backend availability
    const availability = await checkAvailability(handle);
    if (!availability.available) {
      return reply.code(503).send({
        error: `Backend unavailable: ${handle}`,
        reason: availability.reason,
      });
    }

    // Check concurrency limit
    if (!hasCapacity(handle)) {
      const info = getConcurrencyInfo(handle);
      return reply.code(429).send({
        error: `Too many concurrent requests for ${handle}`,
        active: info.active,
        limit: info.limit,
      });
    }

    // Resolve or create chat
    let chatId: string;
    if (chat_id) {
      const existing = await querySingle<Chat>(
        'SELECT * FROM assistant_chats WHERE id = $1 AND assistant_handle = $2',
        [chat_id, handle]
      );
      if (!existing) {
        return reply.code(404).send({ error: 'Chat not found' });
      }
      chatId = existing.id;
    } else {
      // Auto-create chat
      let resolvedProjectId: string | null = null;
      let resolvedParentChatId: string | null = null;

      // parent_turn_id takes precedence over parent_chat_id
      if (parent_turn_id) {
        const parentTurn = await querySingle<{ chat_id: string }>(
          'SELECT chat_id FROM assistant_chat_messages WHERE id = $1',
          [parent_turn_id]
        );
        if (!parentTurn) {
          return reply.code(400).send({ error: 'parent_turn_id not found' });
        }
        const parentChat = await querySingle<Pick<Chat, 'id' | 'project_id'>>(
          'SELECT id, project_id FROM assistant_chats WHERE id = $1',
          [parentTurn.chat_id]
        );
        if (parentChat) {
          resolvedParentChatId = parentChat.id;
          resolvedProjectId = parentChat.project_id;
        }
      } else if (parent_chat_id) {
        const parentChat = await querySingle<Pick<Chat, 'id' | 'project_id'>>(
          'SELECT id, project_id FROM assistant_chats WHERE id = $1',
          [parent_chat_id]
        );
        if (!parentChat) {
          return reply.code(400).send({ error: 'parent_chat_id not found' });
        }
        resolvedParentChatId = parentChat.id;
        resolvedProjectId = parentChat.project_id;
      }

      if (project_id) {
        const project = await resolveProject(project_id);
        if (!project) {
          return reply.code(400).send({ error: 'Project not found' });
        }
        resolvedProjectId = project.id;
      }

      const autoTitle = title || (prompt_text.length > 60
        ? prompt_text.slice(0, 57) + '...'
        : prompt_text);

      const chatSource = source || 'api';
      const newChat = await querySingle<Chat>(
        `INSERT INTO assistant_chats (assistant_handle, title, project_id, parent_chat_id, source, caller_handle)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [handle, autoTitle, resolvedProjectId, resolvedParentChatId, chatSource, caller_handle || null]
      );
      chatId = newChat!.id;
    }

    // Check message count per chat
    const msgCount = await querySingle<{ count: string }>(
      'SELECT COUNT(*) as count FROM assistant_chat_messages WHERE chat_id = $1',
      [chatId]
    );
    if (parseInt(msgCount?.count || '0', 10) >= MAX_MESSAGES_PER_CHAT) {
      return reply.code(400).send({
        error: `Chat has reached the maximum of ${MAX_MESSAGES_PER_CHAT} messages. Start a new chat to continue.`,
      });
    }

    // Phase 1: Insert pending turn before dispatching to backend
    const pendingTurn = await querySingle<ChatMessageRow>(
      `INSERT INTO assistant_chat_messages (chat_id, prompt_text, model, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [chatId, prompt_text, model || 'unknown']
    );
    const turnId = pendingTurn!.id;

    // Build session and backend-specific options
    let backendSessionId: string | undefined;
    let resumeSession = false;
    let backendSystemPrompt = system_prompt;
    let claudeAllowedTools: string[] | undefined;
    let claudePermissionMode: string | undefined;

    // Session management for CLI backends (Claude and Codex both support --resume)
    if (handle === 'claude-code' || handle === 'codex-cli') {
      const chatRecord = await querySingle<{ session_id: string | null }>(
        'SELECT session_id FROM assistant_chats WHERE id = $1',
        [chatId]
      );

      if (chatRecord?.session_id) {
        // Existing session — resume it
        backendSessionId = chatRecord.session_id;
        resumeSession = true;
      } else if (session_id) {
        // Client provided a session_id (e.g., from MCP tool) — use and persist it
        backendSessionId = session_id;
        await query('UPDATE assistant_chats SET session_id = $1 WHERE id = $2', [backendSessionId, chatId]);
      } else {
        // New chat, no session yet — generate and persist
        backendSessionId = randomUUID();
        await query('UPDATE assistant_chats SET session_id = $1 WHERE id = $2', [backendSessionId, chatId]);
      }
    }

    // Gemini: fetch prior conversation history from DB for multi-turn context
    let resolvedMessages = messages;
    if (handle === 'gemini' && !messages && chat_id) {
      const priorTurns = await query<{ prompt_text: string; response: string | null }>(
        `SELECT prompt_text, response FROM assistant_chat_messages
         WHERE chat_id = $1 AND id != $2 AND status = 'completed'
         ORDER BY created_at ASC`,
        [chatId, turnId]
      );
      if (priorTurns.length > 0) {
        resolvedMessages = [];
        for (const turn of priorTurns) {
          resolvedMessages.push({ role: 'user', content: turn.prompt_text });
          if (turn.response) {
            resolvedMessages.push({ role: 'assistant', content: turn.response });
          }
        }
      }
    }

    if (handle === 'claude-code') {
      // Read allowed tools from settings (applies to both text and voice chat)
      const toolsSetting = await querySingle<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'chat.claudeAllowedTools'"
      );
      if (toolsSetting?.value) {
        try {
          const parsed = JSON.parse(toolsSetting.value);
          if (Array.isArray(parsed) && parsed.length > 0) {
            claudeAllowedTools = parsed;
          }
        } catch { /* keep undefined if malformed */ }
      }

      // Browser chat doesn't need initialize_session — context comes from the system prompt
      let chatPreamble = 'You are in a browser chat session. Do not call initialize_session. When referencing image files, include the absolute file path in your response — the chat UI will render it inline automatically.';
      chatPreamble += `\n\nYour current chat_id is "${chatId}" and turn_id is "${turnId}". When you use the assistant_chat MCP tool to delegate to another backend (for example gemini), include parent_turn_id: "${turnId}" so the delegated exchange is linked to this exact turn.`;

      // Add Gemini image model hints so Claude knows which model to use
      const modelsSetting = await querySingle<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'gemini.models'"
      );
      if (modelsSetting?.value) {
        try {
          const models = JSON.parse(modelsSetting.value) as Array<{ id: string; label: string; group?: string }>;
          const imageModels = models.filter(m =>
            /image/i.test(m.id) || /image/i.test(m.label) || m.group === 'Image'
          );
          if (imageModels.length > 0) {
            const modelList = imageModels.map(m => `${m.id} (${m.label})`).join(', ');
            chatPreamble += `\n\nFor image generation, use the assistant_chat MCP tool with handle "gemini" and one of these models: ${modelList}. Do NOT use imagen models — use the gemini image models listed here.`;
          }
        } catch { /* ignore malformed setting */ }
      }

      backendSystemPrompt = backendSystemPrompt
        ? `${chatPreamble}\n\n${backendSystemPrompt}`
        : chatPreamble;
    }

    if (handle === 'claude-code') {
      // All Claude chats get bypassPermissions so tools work in non-interactive -p mode
      claudePermissionMode = 'bypassPermissions';
    }

    if (voice_mode && handle === 'claude-code') {
      // Prepend voice instructions to system prompt
      const voiceInstructions = 'You are a voice assistant for Roger. Respond in plain text only — no markdown, no code blocks, no bullet points. Keep responses conversational and concise (2-3 sentences unless more detail is requested). Use WebSearch for real-time info (weather, news, locations). Use khef MCP tools to search memories, run pipelines, and manage knowledge. This is a multi-turn conversation — the session preserves full context between messages. Just answer naturally based on the ongoing conversation.';
      backendSystemPrompt = backendSystemPrompt
        ? `${voiceInstructions}\n\n${backendSystemPrompt}`
        : voiceInstructions;
    }

    // Dispatch to backend
    const result = await chatWithAssistant({
      handle,
      promptText: prompt_text,
      messages: resolvedMessages,
      model,
      sessionId: backendSessionId,
      resumeSession,
      systemPrompt: backendSystemPrompt,
      allowedTools: claudeAllowedTools,
      permissionMode: claudePermissionMode,
      useGoogleSearch: use_google_search,
      useThinking: use_thinking,
      thinkingBudget: thinking_budget,
    });

    // Process multimodal response parts (save inline data as files)
    let storedParts: StoredPart[] | null = null;
    let finalResponse = result.response;

    if (result.responseParts && result.responseParts.length > 0) {
      // Get project_id from the chat for file association
      const chatRecord = await querySingle<{ project_id: string | null }>(
        'SELECT project_id FROM assistant_chats WHERE id = $1',
        [chatId]
      );
      const processed = await processResponseParts(result.responseParts, chatId, chatRecord?.project_id || null);
      storedParts = processed.storedParts;
      finalResponse = processed.responseText;
    }

    // Post-process: inject image tags for any image file paths in the response
    const processedResponse = finalResponse && handle === 'claude-code'
      ? injectImageTags(finalResponse)
      : finalResponse;

    // Truncate response if needed
    const truncatedResponse = processedResponse && processedResponse.length > MAX_RESPONSE_LENGTH
      ? processedResponse.slice(0, MAX_RESPONSE_LENGTH)
      : processedResponse;

    // Phase 2: Update turn with response
    const turnStatus = result.error ? 'failed' : 'completed';
    const message = await querySingle<ChatMessageRow>(
      `UPDATE assistant_chat_messages
       SET response = $1, response_parts = $2, model = $3, input_tokens = $4,
           output_tokens = $5, error = $6, status = $7, grounding = $8,
           thinking = $9, updated_at = NOW()
       WHERE id = $10
       RETURNING *`,
      [
        truncatedResponse || null,
        storedParts ? JSON.stringify(storedParts) : null,
        result.model,
        result.input_tokens,
        result.output_tokens,
        result.error,
        turnStatus,
        result.grounding ? JSON.stringify(result.grounding) : null,
        result.thinking ? JSON.stringify(result.thinking) : null,
        turnId,
      ]
    );

    // Create delegation row if this is a delegated call
    if (parent_turn_id) {
      await query(
        `INSERT INTO assistant_chat_delegations (parent_turn_id, child_chat_id, delegated_handle)
         VALUES ($1, $2, $3)`,
        [parent_turn_id, chatId, handle]
      );
    }

    // Update chat updated_at
    await query('UPDATE assistant_chats SET updated_at = NOW() WHERE id = $1', [chatId]);

    if (result.error) {
      return reply.code(500).send({ chat_id: chatId, turn_id: turnId, message, error: result.error, session_id: backendSessionId });
    }

    return reply.code(201).send({ chat_id: chatId, turn_id: turnId, message, session_id: backendSessionId });
  });

  // GET /api/assistants/:handle/chats — List chats for a backend
  fastify.get('/:handle/chats', async (request, reply) => {
    const { handle } = request.params as { handle: string };
    if (!validateHandle(handle, reply)) return;
    const { project_id, source: sourceFilter, limit = '20', offset = '0' } = request.query as {
      project_id?: string;
      source?: string;
      limit?: string;
      offset?: string;
    };

    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offsetNum = parseInt(offset, 10) || 0;

    const conditions: string[] = [
      'c.assistant_handle = $1',
      'NOT EXISTS (SELECT 1 FROM assistant_chat_delegations d WHERE d.child_chat_id = c.id)',
    ];
    const params: any[] = [handle];
    let idx = 2;

    if (project_id) {
      const project = await resolveProject(project_id);
      if (project) {
        conditions.push(`c.project_id = $${idx}`);
        params.push(project.id);
        idx++;
      } else {
        return {
          chats: [],
          pagination: { total_count: 0, limit: limitNum, offset: offsetNum, has_more: false },
        };
      }
    }

    if (sourceFilter) {
      conditions.push(`c.source = $${idx}`);
      params.push(sourceFilter);
      idx++;
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await querySingle<{ count: string }>(
      `SELECT COUNT(*) as count FROM assistant_chats c ${where}`,
      params
    );
    const totalCount = parseInt(countResult?.count || '0', 10);

    const chats = await query<Chat & { message_count: string; project_handle?: string; project_name?: string }>(
      `SELECT c.*,
              p.handle as project_handle,
              p.name as project_name,
              COALESCE(mc.cnt, 0) as message_count
       FROM assistant_chats c
       LEFT JOIN projects p ON c.project_id = p.id
       LEFT JOIN (
         SELECT chat_id, COUNT(*) as cnt
         FROM assistant_chat_messages
         GROUP BY chat_id
       ) mc ON mc.chat_id = c.id
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
      chats: chats.map(c => ({
        ...c,
        message_count: parseInt(c.message_count, 10),
      })),
      pagination,
    };
  });

  // GET /api/assistants/:handle/chats/:id — Get chat (optionally with messages)
  fastify.get('/:handle/chats/:id', async (request, reply) => {
    const { handle, id } = request.params as { handle: string; id: string };
    if (!validateHandle(handle, reply)) return;
    const { include_messages } = request.query as { include_messages?: string };

    const chat = await querySingle<Chat & { project_handle?: string; project_name?: string }>(
      `SELECT c.*,
              p.handle as project_handle,
              p.name as project_name
       FROM assistant_chats c
       LEFT JOIN projects p ON c.project_id = p.id
       WHERE c.id = $1 AND c.assistant_handle = $2`,
      [id, handle]
    );

    if (!chat) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    if (include_messages === 'true') {
      const chatMessages = await query<ChatMessageRow>(
        'SELECT * FROM assistant_chat_messages WHERE chat_id = $1 ORDER BY created_at ASC',
        [id]
      );

      const delegations = await buildDelegations(chatMessages);

      return {
        chat: {
          ...chat,
          messages: chatMessages,
          delegations,
        },
      };
    }

    return { chat };
  });

  // GET /api/assistants/:handle/chats/:id/messages — List messages (paginated)
  fastify.get('/:handle/chats/:id/messages', async (request, reply) => {
    const { handle, id } = request.params as { handle: string; id: string };
    if (!validateHandle(handle, reply)) return;
    const { limit = '20', offset = '0', order = 'asc' } = request.query as {
      limit?: string;
      offset?: string;
      order?: string;
    };

    const chat = await querySingle<{ id: string }>(
      'SELECT id FROM assistant_chats WHERE id = $1 AND assistant_handle = $2',
      [id, handle]
    );

    if (!chat) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offsetNum = parseInt(offset, 10) || 0;
    const sortDir = order === 'desc' ? 'DESC' : 'ASC';

    const countResult = await querySingle<{ count: string }>(
      'SELECT COUNT(*) as count FROM assistant_chat_messages WHERE chat_id = $1',
      [id]
    );
    const totalCount = parseInt(countResult?.count || '0', 10);

    const messages = await query<ChatMessageRow>(
      `SELECT * FROM assistant_chat_messages
       WHERE chat_id = $1
       ORDER BY created_at ${sortDir}
       LIMIT $2 OFFSET $3`,
      [id, limitNum, offsetNum]
    );

    const pagination: PaginationMetadata = {
      total_count: totalCount,
      limit: limitNum,
      offset: offsetNum,
      has_more: offsetNum + limitNum < totalCount,
    };

    return { messages, pagination };
  });

  // DELETE /api/assistants/:handle/chats/:id — Delete chat (cascades messages)
  fastify.delete('/:handle/chats/:id', async (request, reply) => {
    const { handle, id } = request.params as { handle: string; id: string };
    if (!validateHandle(handle, reply)) return;

    const chat = await querySingle<{ id: string }>(
      'SELECT id FROM assistant_chats WHERE id = $1 AND assistant_handle = $2',
      [id, handle]
    );

    if (!chat) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    await query('DELETE FROM assistant_chats WHERE id = $1', [id]);
    return reply.code(204).send();
  });

  // DELETE /api/assistants/:handle/chats/:id/messages/:messageId — Delete single message
  fastify.delete('/:handle/chats/:id/messages/:messageId', async (request, reply) => {
    const { handle, id, messageId } = request.params as { handle: string; id: string; messageId: string };
    if (!validateHandle(handle, reply)) return;

    const chat = await querySingle<{ id: string }>(
      'SELECT id FROM assistant_chats WHERE id = $1 AND assistant_handle = $2',
      [id, handle]
    );

    if (!chat) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    const message = await querySingle<{ id: string }>(
      'SELECT id FROM assistant_chat_messages WHERE id = $1 AND chat_id = $2',
      [messageId, id]
    );

    if (!message) {
      return reply.code(404).send({ error: 'Message not found' });
    }

    await query('DELETE FROM assistant_chat_messages WHERE id = $1', [messageId]);
    await query('UPDATE assistant_chats SET updated_at = NOW() WHERE id = $1', [id]);

    return reply.code(204).send();
  });
};

export default assistantChatRoutes;

/**
 * Handle-less chat routes.
 *
 * These let callers access chats by UUID alone — no assistant_handle needed.
 * Registered at /api/chats.
 */
export const chatByIdRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /api/chats — List all chats across backends
  fastify.get('/', async (request, reply) => {
    const { project_id, source: sourceFilter, assistant_handle, limit = '50', offset = '0' } = request.query as {
      project_id?: string;
      source?: string;
      assistant_handle?: string;
      limit?: string;
      offset?: string;
    };

    const limitNum = Math.min(parseInt(limit, 10) || 50, 100);
    const offsetNum = parseInt(offset, 10) || 0;

    const conditions: string[] = [
      'NOT EXISTS (SELECT 1 FROM assistant_chat_delegations d WHERE d.child_chat_id = c.id)',
    ];
    const params: any[] = [];
    let idx = 1;

    if (project_id) {
      const project = await resolveProject(project_id);
      if (project) {
        conditions.push(`c.project_id = $${idx}`);
        params.push(project.id);
        idx++;
      } else {
        return {
          chats: [],
          pagination: { total_count: 0, limit: limitNum, offset: offsetNum, has_more: false },
        };
      }
    }

    if (sourceFilter) {
      conditions.push(`c.source = $${idx}`);
      params.push(sourceFilter);
      idx++;
    }

    if (assistant_handle) {
      conditions.push(`c.assistant_handle = $${idx}`);
      params.push(assistant_handle);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await querySingle<{ count: string }>(
      `SELECT COUNT(*) as count FROM assistant_chats c ${where}`,
      params
    );
    const totalCount = parseInt(countResult?.count || '0', 10);

    const chats = await query<Chat & { message_count: string; project_handle?: string; project_name?: string }>(
      `SELECT c.*,
              p.handle as project_handle,
              p.name as project_name,
              COALESCE(mc.cnt, 0) as message_count
       FROM assistant_chats c
       LEFT JOIN projects p ON c.project_id = p.id
       LEFT JOIN (
         SELECT chat_id, COUNT(*) as cnt
         FROM assistant_chat_messages
         GROUP BY chat_id
       ) mc ON mc.chat_id = c.id
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
      chats: chats.map(c => ({
        ...c,
        message_count: parseInt(c.message_count, 10),
      })),
      pagination,
    };
  });

  // GET /api/chats/:id — Get chat by UUID (no handle required)
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { include_messages } = request.query as { include_messages?: string };

    const chat = await querySingle<Chat & { project_handle?: string; project_name?: string }>(
      `SELECT c.*,
              p.handle as project_handle,
              p.name as project_name
       FROM assistant_chats c
       LEFT JOIN projects p ON c.project_id = p.id
       WHERE c.id = $1`,
      [id]
    );

    if (!chat) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    if (include_messages === 'true') {
      const chatMessages = await query<ChatMessageRow>(
        'SELECT * FROM assistant_chat_messages WHERE chat_id = $1 ORDER BY created_at ASC',
        [id]
      );

      const delegations = await buildDelegations(chatMessages);

      return {
        chat: {
          ...chat,
          messages: chatMessages,
          delegations,
        },
      };
    }

    return { chat };
  });

  // PATCH /api/chats/:id — Update chat title (no handle required)
  fastify.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { title } = request.body as { title?: string };

    if (!title || !title.trim()) {
      return reply.code(400).send({ error: 'title is required' });
    }

    if (title.length > MAX_TITLE_LENGTH) {
      return reply.code(400).send({ error: `title exceeds maximum length of ${MAX_TITLE_LENGTH} characters` });
    }

    const chat = await querySingle<Chat>(
      `UPDATE assistant_chats SET title = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [title.trim(), id]
    );

    if (!chat) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    return { chat };
  });

  // DELETE /api/chats/:id — Delete chat by UUID (no handle required)
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const chat = await querySingle<{ id: string }>(
      'SELECT id FROM assistant_chats WHERE id = $1',
      [id]
    );

    if (!chat) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    await query('DELETE FROM assistant_chats WHERE id = $1', [id]);
    return reply.code(204).send();
  });

  // DELETE /api/chats/:id/messages/:messageId — Delete single message (no handle required)
  fastify.delete('/:id/messages/:messageId', async (request, reply) => {
    const { id, messageId } = request.params as { id: string; messageId: string };

    const chat = await querySingle<{ id: string }>(
      'SELECT id FROM assistant_chats WHERE id = $1',
      [id]
    );

    if (!chat) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    const message = await querySingle<{ id: string }>(
      'SELECT id FROM assistant_chat_messages WHERE id = $1 AND chat_id = $2',
      [messageId, id]
    );

    if (!message) {
      return reply.code(404).send({ error: 'Message not found' });
    }

    await query('DELETE FROM assistant_chat_messages WHERE id = $1', [messageId]);
    await query('UPDATE assistant_chats SET updated_at = NOW() WHERE id = $1', [id]);

    return reply.code(204).send();
  });

  // DELETE /api/chats/all — Delete all chats
  fastify.delete('/all', async (_request, reply) => {
    await query('DELETE FROM assistant_chats');
    return reply.code(204).send();
  });
};
