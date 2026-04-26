import { randomUUID } from 'crypto';
import { getRedis, getRedisSubscriber } from './redis';
import { deliverLiveMessage } from './live-messages';
import { resolveSessionIds } from './active-sessions';
import { publishToRoom } from './session-events';
import { logger } from '../lib/logger';

const SYSTEM_SENDER_ID = 'system:agent-questions';

export type QuestionStatus = 'pending' | 'answered' | 'canceled' | 'expired';

export type FieldType =
  | 'single-choice'
  | 'multi-choice'
  | 'text'
  | 'textarea'
  | 'number'
  | 'toggle';

export interface FieldOption {
  value: string;
  label: string;
  hint?: string;
}

export interface QuestionField {
  key: string;
  type: FieldType;
  label: string;
  description?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  options?: FieldOption[];
  default?: unknown;
  min?: number;
  max?: number;
}

export interface AgentDescriptor {
  session_id?: string;
  nickname?: string;
  assistant_handle?: string;
}

export interface AgentQuestion {
  id: string;
  agent: AgentDescriptor;
  title: string;
  description?: string;
  fields: QuestionField[];
  created_at: string;
  expires_at: string;
  status: QuestionStatus;
}

export interface AgentAnswer {
  question_id: string;
  answered_at: string;
  values: Record<string, unknown>;
}

export interface QuestionEvent {
  type: 'question.created' | 'question.answered' | 'question.canceled' | 'question.expired';
  question_id: string;
  question?: AgentQuestion;
  answer?: AgentAnswer;
  at: string;
}

export const DEFAULT_TTL_SECONDS = 600; // 10 minutes
export const MAX_TTL_SECONDS = 86400; // 24 hours
export const MAX_PENDING_PER_NICKNAME = 5;
export const EVENT_CHANNEL = 'aq:events';

const KEY_QUESTION = (id: string) => `aq:question:${id}`;
const KEY_ANSWER = (id: string) => `aq:answer:${id}`;
const KEY_PENDING_ALL = 'aq:pending:all';
const KEY_PENDING_BY_NICK = (nick: string) => `aq:pending:by-nickname:${nick.toLowerCase()}`;

const VALID_FIELD_TYPES: FieldType[] = [
  'single-choice',
  'multi-choice',
  'text',
  'textarea',
  'number',
  'toggle',
];

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function validateFields(fields: unknown): QuestionField[] {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new ValidationError('fields must be a non-empty array');
  }
  if (fields.length > 50) {
    throw new ValidationError('fields cannot exceed 50 entries');
  }

  const keys = new Set<string>();
  const validated: QuestionField[] = [];

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] as Record<string, unknown>;
    if (!f || typeof f !== 'object') {
      throw new ValidationError(`fields[${i}] must be an object`);
    }
    const key = typeof f.key === 'string' ? f.key.trim() : '';
    const type = f.type as FieldType;
    const label = typeof f.label === 'string' ? f.label.trim() : '';

    if (!key) throw new ValidationError(`fields[${i}].key is required`);
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) {
      throw new ValidationError(
        `fields[${i}].key "${key}" must start with a letter and contain only letters, digits, and underscores`,
      );
    }
    if (keys.has(key)) throw new ValidationError(`fields[${i}].key "${key}" is duplicated`);
    keys.add(key);

    if (!VALID_FIELD_TYPES.includes(type)) {
      throw new ValidationError(
        `fields[${i}].type "${String(type)}" must be one of: ${VALID_FIELD_TYPES.join(', ')}`,
      );
    }
    if (!label) throw new ValidationError(`fields[${i}].label is required`);

    const out: QuestionField = { key, type, label };
    if (typeof f.description === 'string') out.description = f.description;
    if (typeof f.placeholder === 'string') out.placeholder = f.placeholder;
    if (typeof f.hint === 'string') out.hint = f.hint;
    if (f.required === true) out.required = true;
    if (f.default !== undefined) out.default = f.default;
    if (typeof f.min === 'number') out.min = f.min;
    if (typeof f.max === 'number') out.max = f.max;

    if (type === 'single-choice' || type === 'multi-choice') {
      if (!Array.isArray(f.options) || f.options.length === 0) {
        throw new ValidationError(`fields[${i}].options is required for ${type}`);
      }
      const opts: FieldOption[] = [];
      const seen = new Set<string>();
      for (let j = 0; j < f.options.length; j++) {
        const o = f.options[j] as Record<string, unknown>;
        if (!o || typeof o !== 'object') {
          throw new ValidationError(`fields[${i}].options[${j}] must be an object`);
        }
        const v = typeof o.value === 'string' ? o.value : '';
        const l = typeof o.label === 'string' ? o.label : '';
        if (!v) throw new ValidationError(`fields[${i}].options[${j}].value is required`);
        if (!l) throw new ValidationError(`fields[${i}].options[${j}].label is required`);
        if (seen.has(v)) {
          throw new ValidationError(`fields[${i}].options has duplicate value "${v}"`);
        }
        seen.add(v);
        const opt: FieldOption = { value: v, label: l };
        if (typeof o.hint === 'string') opt.hint = o.hint;
        opts.push(opt);
      }
      out.options = opts;
    }

    validated.push(out);
  }

  return validated;
}

/**
 * Auto-append a free-text "Anything else?" field to the end of every form so
 * the user always has a place to add context the structured fields didn't
 * cover. Skipped when the agent already ended the form with a textarea (to
 * avoid duplicating an existing notes/feedback field) or when a field with
 * key `something_else` is already present.
 */
function appendSomethingElseField(fields: QuestionField[]): void {
  if (fields.length === 0) return;
  if (fields.some((f) => f.key === 'something_else')) return;
  if (fields[fields.length - 1].type === 'textarea') return;
  fields.push({
    key: 'something_else',
    type: 'textarea',
    label: 'Anything else?',
    placeholder: 'Optional — anything I missed in the questions above',
  });
}

function validateAgent(agent: unknown): AgentDescriptor {
  if (agent == null) return {};
  if (typeof agent !== 'object') {
    throw new ValidationError('agent must be an object');
  }
  const a = agent as Record<string, unknown>;
  const out: AgentDescriptor = {};
  if (typeof a.session_id === 'string' && a.session_id) out.session_id = a.session_id;
  if (typeof a.nickname === 'string' && a.nickname) out.nickname = a.nickname.toLowerCase();
  if (typeof a.assistant_handle === 'string' && a.assistant_handle) {
    out.assistant_handle = a.assistant_handle;
  }
  return out;
}

export function validateAnswerValues(
  fields: QuestionField[],
  values: unknown,
): Record<string, unknown> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new ValidationError('values must be an object');
  }
  const input = values as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = input[field.key];
    const present = raw !== undefined && raw !== null && raw !== '';
    if (!present) {
      if (field.required) {
        throw new ValidationError(`field "${field.key}" is required`);
      }
      continue;
    }

    switch (field.type) {
      case 'text':
      case 'textarea': {
        if (typeof raw !== 'string') {
          throw new ValidationError(`field "${field.key}" must be a string`);
        }
        out[field.key] = raw;
        break;
      }
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(n)) {
          throw new ValidationError(`field "${field.key}" must be a number`);
        }
        if (field.min !== undefined && n < field.min) {
          throw new ValidationError(`field "${field.key}" must be >= ${field.min}`);
        }
        if (field.max !== undefined && n > field.max) {
          throw new ValidationError(`field "${field.key}" must be <= ${field.max}`);
        }
        out[field.key] = n;
        break;
      }
      case 'toggle': {
        if (typeof raw === 'boolean') {
          out[field.key] = raw;
        } else if (raw === 'true' || raw === 'false') {
          out[field.key] = raw === 'true';
        } else {
          throw new ValidationError(`field "${field.key}" must be a boolean`);
        }
        break;
      }
      case 'single-choice': {
        if (typeof raw !== 'string') {
          throw new ValidationError(`field "${field.key}" must be a string`);
        }
        const allowed = new Set((field.options ?? []).map((o) => o.value));
        if (!allowed.has(raw)) {
          throw new ValidationError(
            `field "${field.key}" value "${raw}" is not a valid option`,
          );
        }
        out[field.key] = raw;
        break;
      }
      case 'multi-choice': {
        if (!Array.isArray(raw)) {
          throw new ValidationError(`field "${field.key}" must be an array`);
        }
        const allowed = new Set((field.options ?? []).map((o) => o.value));
        for (const v of raw) {
          if (typeof v !== 'string' || !allowed.has(v)) {
            throw new ValidationError(
              `field "${field.key}" contains invalid option "${String(v)}"`,
            );
          }
        }
        out[field.key] = [...raw];
        break;
      }
    }
  }

  return out;
}

export interface CreateQuestionInput {
  title: string;
  description?: string;
  fields: unknown;
  agent?: unknown;
  ttl_seconds?: number;
}

export async function createQuestion(input: CreateQuestionInput): Promise<AgentQuestion> {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new ValidationError('title is required');
  if (title.length > 200) throw new ValidationError('title must be <= 200 characters');

  const description =
    typeof input.description === 'string' ? input.description : undefined;
  if (description && description.length > 5000) {
    throw new ValidationError('description must be <= 5000 characters');
  }

  const fields = validateFields(input.fields);
  appendSomethingElseField(fields);
  const agent = validateAgent(input.agent);

  let ttlSeconds = input.ttl_seconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) ttlSeconds = DEFAULT_TTL_SECONDS;
  if (ttlSeconds > MAX_TTL_SECONDS) ttlSeconds = MAX_TTL_SECONDS;

  if (agent.nickname) {
    const redis = getRedis();
    const pendingCount = await redis.zcard(KEY_PENDING_BY_NICK(agent.nickname));
    if (pendingCount >= MAX_PENDING_PER_NICKNAME) {
      throw new ValidationError(
        `nickname "${agent.nickname}" already has ${pendingCount} pending questions (max ${MAX_PENDING_PER_NICKNAME})`,
      );
    }
  }

  const id = randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + ttlSeconds * 1000);

  const question: AgentQuestion = {
    id,
    agent,
    title,
    description,
    fields,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    status: 'pending',
  };

  const redis = getRedis();
  const pipeline = redis.multi();
  pipeline.set(KEY_QUESTION(id), JSON.stringify(question), 'EX', ttlSeconds);
  pipeline.zadd(KEY_PENDING_ALL, now.getTime(), id);
  pipeline.expire(KEY_PENDING_ALL, MAX_TTL_SECONDS);
  if (agent.nickname) {
    pipeline.zadd(KEY_PENDING_BY_NICK(agent.nickname), now.getTime(), id);
    pipeline.expire(KEY_PENDING_BY_NICK(agent.nickname), MAX_TTL_SECONDS);
  }
  await pipeline.exec();

  await publishEvent({
    type: 'question.created',
    question_id: id,
    question,
    at: now.toISOString(),
  });

  return question;
}

export async function getQuestion(id: string): Promise<AgentQuestion | null> {
  const redis = getRedis();
  const raw = await redis.get(KEY_QUESTION(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentQuestion;
  } catch (err) {
    logger.warn({ err, id }, 'Failed to parse stored agent question');
    return null;
  }
}

export async function getAnswer(id: string): Promise<AgentAnswer | null> {
  const redis = getRedis();
  const raw = await redis.get(KEY_ANSWER(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentAnswer;
  } catch (err) {
    logger.warn({ err, id }, 'Failed to parse stored agent answer');
    return null;
  }
}

export interface QuestionWithAnswer {
  question: AgentQuestion;
  answer: AgentAnswer | null;
}

export async function getQuestionWithAnswer(id: string): Promise<QuestionWithAnswer | null> {
  const question = await getQuestion(id);
  if (!question) return null;
  const answer = await getAnswer(id);
  return { question, answer };
}

export async function answerQuestion(
  id: string,
  values: unknown,
): Promise<AgentAnswer> {
  const question = await getQuestion(id);
  if (!question) {
    throw new ValidationError('question not found or expired');
  }
  if (question.status !== 'pending') {
    throw new ValidationError(`question is already ${question.status}`);
  }

  const validated = validateAnswerValues(question.fields, values);
  const now = new Date();
  const answer: AgentAnswer = {
    question_id: id,
    answered_at: now.toISOString(),
    values: validated,
  };

  const updated: AgentQuestion = { ...question, status: 'answered' };
  const redis = getRedis();
  const ttl = await redis.ttl(KEY_QUESTION(id));
  const writeTtl = ttl > 0 ? ttl : 60;

  const pipeline = redis.multi();
  pipeline.set(KEY_QUESTION(id), JSON.stringify(updated), 'EX', writeTtl);
  pipeline.set(KEY_ANSWER(id), JSON.stringify(answer), 'EX', writeTtl);
  pipeline.zrem(KEY_PENDING_ALL, id);
  if (question.agent.nickname) {
    pipeline.zrem(KEY_PENDING_BY_NICK(question.agent.nickname), id);
  }
  await pipeline.exec();

  await publishEvent({
    type: 'question.answered',
    question_id: id,
    question: updated,
    answer,
    at: now.toISOString(),
  });

  // Push the answer back to the agent session as a live message so the agent
  // gets it even if its synchronous wait was interrupted.
  await deliverEventToAgent(updated, { type: 'answered', answer });

  return answer;
}

export async function cancelQuestion(id: string): Promise<boolean> {
  const question = await getQuestion(id);
  if (!question) return false;
  if (question.status !== 'pending') return false;

  const redis = getRedis();
  const ttl = await redis.ttl(KEY_QUESTION(id));
  const writeTtl = ttl > 0 ? ttl : 60;
  const updated: AgentQuestion = { ...question, status: 'canceled' };

  const pipeline = redis.multi();
  pipeline.set(KEY_QUESTION(id), JSON.stringify(updated), 'EX', writeTtl);
  pipeline.zrem(KEY_PENDING_ALL, id);
  if (question.agent.nickname) {
    pipeline.zrem(KEY_PENDING_BY_NICK(question.agent.nickname), id);
  }
  await pipeline.exec();

  await publishEvent({
    type: 'question.canceled',
    question_id: id,
    question: updated,
    at: new Date().toISOString(),
  });

  // Notify the agent session that the user canceled before answering.
  await deliverEventToAgent(updated, { type: 'canceled' });

  return true;
}

export interface ListOptions {
  nickname?: string;
  limit?: number;
}

/**
 * List pending questions, newest first. Lazily prunes stale entries from the
 * pending sorted set when their question key has expired in Redis.
 */
export async function listPendingQuestions(opts: ListOptions = {}): Promise<AgentQuestion[]> {
  const redis = getRedis();
  const key = opts.nickname ? KEY_PENDING_BY_NICK(opts.nickname) : KEY_PENDING_ALL;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const ids = await redis.zrevrange(key, 0, limit - 1);
  if (ids.length === 0) return [];

  const pipeline = redis.multi();
  for (const id of ids) pipeline.get(KEY_QUESTION(id));
  const results = (await pipeline.exec()) ?? [];

  const out: AgentQuestion[] = [];
  const stale: string[] = [];

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const entry = results[i];
    if (!entry || entry[0]) {
      stale.push(id);
      continue;
    }
    const raw = entry[1] as string | null;
    if (!raw) {
      stale.push(id);
      continue;
    }
    try {
      const q = JSON.parse(raw) as AgentQuestion;
      if (q.status === 'pending') {
        out.push(q);
      } else {
        stale.push(id);
      }
    } catch {
      stale.push(id);
    }
  }

  if (stale.length > 0) {
    await redis.zrem(key, ...stale).catch(() => {});
    if (!opts.nickname) {
      // Also publish expired events for the truly-vanished ones (best-effort).
      for (const id of stale) {
        const exists = await redis.exists(KEY_QUESTION(id));
        if (!exists) {
          await publishEvent({
            type: 'question.expired',
            question_id: id,
            at: new Date().toISOString(),
          }).catch(() => {});
        }
      }
    }
  }

  return out;
}

export async function countPendingQuestions(nickname?: string): Promise<number> {
  const redis = getRedis();
  const key = nickname ? KEY_PENDING_BY_NICK(nickname) : KEY_PENDING_ALL;
  return redis.zcard(key);
}

/**
 * Resolve the recipient session ids for a question's agent metadata. Prefers
 * an explicit session_id; falls back to nickname (which may broadcast to
 * multiple active sessions sharing the name). Returns an empty array when no
 * recipient is identifiable.
 */
async function resolveAgentRecipients(agent: AgentDescriptor): Promise<string[]> {
  if (agent.session_id) return [agent.session_id];
  if (agent.nickname) {
    try {
      return await resolveSessionIds(agent.nickname);
    } catch (err) {
      logger.warn({ err, nickname: agent.nickname }, 'Failed to resolve nickname for live message');
      return [];
    }
  }
  return [];
}

function formatAnswerForLiveMessage(question: AgentQuestion, answer: AgentAnswer): string {
  const lines: string[] = [];
  lines.push(`Answer received for "${question.title}" (${question.id}):`);
  for (const field of question.fields) {
    const v = answer.values[field.key];
    if (v === undefined || v === null || v === '') continue;
    const display = Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    lines.push(`- ${field.label} (${field.key}): ${display}`);
  }
  return lines.join('\n');
}

/**
 * Deliver a question event to the originating agent session via live message.
 * Best-effort — failures are logged and swallowed. This guarantees the agent
 * gets the answer even if its synchronous `ask_user_question` wait was
 * interrupted.
 */
async function deliverEventToAgent(
  question: AgentQuestion,
  payload: { type: 'answered'; answer: AgentAnswer } | { type: 'canceled' },
): Promise<void> {
  try {
    const recipients = await resolveAgentRecipients(question.agent);
    if (recipients.length === 0) return;
    const content =
      payload.type === 'answered'
        ? formatAnswerForLiveMessage(question, payload.answer)
        : `Question "${question.title}" (${question.id}) was canceled by the user before they answered.`;
    await Promise.all(
      recipients.map((to) =>
        deliverLiveMessage(SYSTEM_SENDER_ID, to, content, {
          senderLabel: 'agent-questions',
        }).catch((err) => {
          logger.warn({ err, to, question_id: question.id }, 'Failed to deliver agent-question live message');
        }),
      ),
    );
  } catch (err) {
    logger.warn({ err, question_id: question.id }, 'deliverEventToAgent failed');
  }
}

export async function publishEvent(event: QuestionEvent): Promise<void> {
  try {
    const redis = getRedis();
    await redis.publish(EVENT_CHANNEL, JSON.stringify(event));
  } catch (err) {
    logger.warn({ err, event_type: event.type }, 'Failed to publish agent question event');
  }

  // Also fan out onto the unified SSE bus so the client's single SSE connection
  // can deliver these events without a separate /agent-questions/stream socket.
  await publishToRoom('agent-questions', event);
  const nick = event.question?.agent.nickname;
  if (nick) {
    await publishToRoom(`agent-questions:${nick.toLowerCase()}`, event);
  }
}

/**
 * Subscribe to question events. Returns an unsubscribe function.
 * The caller handles filtering (e.g., by question_id or nickname).
 */
export function subscribeToEvents(handler: (event: QuestionEvent) => void): () => void {
  const sub = getRedisSubscriber();
  let active = true;

  const onMessage = (channel: string, message: string) => {
    if (!active) return;
    if (channel !== EVENT_CHANNEL) return;
    try {
      handler(JSON.parse(message) as QuestionEvent);
    } catch (err) {
      logger.warn({ err }, 'Failed to parse agent question event');
    }
  };

  sub.on('message', onMessage);
  sub.subscribe(EVENT_CHANNEL).catch((err) => {
    logger.warn({ err }, 'Failed to subscribe to agent question events');
  });

  return () => {
    active = false;
    sub.off('message', onMessage);
  };
}

/**
 * Wait for a terminal event (answered, canceled, or expired) for a specific
 * question id. Resolves with the event when it arrives, or with a synthesized
 * "expired" event after timeoutMs. Resolves immediately if the question is
 * already in a terminal state.
 */
export async function waitForResolution(
  id: string,
  timeoutMs: number,
): Promise<QuestionEvent> {
  const existing = await getQuestion(id);
  if (existing && existing.status !== 'pending') {
    const answer = existing.status === 'answered' ? await getAnswer(id) : null;
    return {
      type: existing.status === 'answered'
        ? 'question.answered'
        : existing.status === 'canceled'
          ? 'question.canceled'
          : 'question.expired',
      question_id: id,
      question: existing,
      answer: answer ?? undefined,
      at: new Date().toISOString(),
    };
  }
  if (!existing) {
    return {
      type: 'question.expired',
      question_id: id,
      at: new Date().toISOString(),
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (event: QuestionEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    };

    const unsubscribe = subscribeToEvents((event) => {
      if (event.question_id !== id) return;
      if (
        event.type === 'question.answered' ||
        event.type === 'question.canceled' ||
        event.type === 'question.expired'
      ) {
        finish(event);
      }
    });

    const timer = setTimeout(() => {
      finish({
        type: 'question.expired',
        question_id: id,
        at: new Date().toISOString(),
      });
    }, Math.max(timeoutMs, 100));
  });
}
