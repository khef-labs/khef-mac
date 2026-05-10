// Map Codex JSONL entries (response_item / event_msg / session_meta) into
// the Claude SessionEntry shape so the existing Raw view renderer can reuse
// the same filter/render/search code paths for both assistants.

import type { SessionEntry, SessionContentBlock } from '../types'

interface CodexEntry {
  timestamp?: string
  type?: string
  payload?: any
  [key: string]: any
}

function blocksFromCodexMessageContent(content: any[]): SessionContentBlock[] {
  if (!Array.isArray(content)) return []
  const out: SessionContentBlock[] = []
  for (const c of content) {
    const text = c?.text ?? ''
    if (typeof text === 'string' && text.length > 0) {
      out.push({ type: 'text', text })
    }
  }
  return out
}

function reasoningTextFromCodex(payload: any): string {
  if (typeof payload?.text === 'string' && payload.text.trim()) return payload.text
  if (Array.isArray(payload?.summary)) {
    return payload.summary
      .map((s: any) => (typeof s?.text === 'string' ? s.text : ''))
      .filter(Boolean)
      .join('\n\n')
  }
  if (Array.isArray(payload?.content)) {
    return payload.content
      .map((s: any) => (typeof s?.text === 'string' ? s.text : ''))
      .filter(Boolean)
      .join('\n\n')
  }
  return ''
}

function normalizeCodexEntry(entry: CodexEntry): SessionEntry | null {
  if (entry.type !== 'response_item' || !entry.payload) return null
  const p = entry.payload

  if (p.type === 'message') {
    const blocks = blocksFromCodexMessageContent(p.content)
    if (blocks.length === 0) return null
    const role = p.role === 'user' ? 'user' : 'assistant'
    return {
      type: role,
      timestamp: entry.timestamp,
      message: {
        role,
        content: blocks,
      },
    }
  }

  if (p.type === 'function_call') {
    let input: any
    try {
      input = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments
    } catch {
      input = { raw: p.arguments }
    }
    return {
      type: 'assistant',
      timestamp: entry.timestamp,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: p.name,
            input: input ?? {},
            tool_use_id: p.call_id,
          },
        ],
      },
    }
  }

  if (p.type === 'function_call_output') {
    return {
      type: 'user',
      timestamp: entry.timestamp,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: p.call_id,
            content: p.output,
          },
        ],
      },
    }
  }

  if (p.type === 'reasoning') {
    const text = reasoningTextFromCodex(p)
    if (!text) return null
    return {
      type: 'assistant',
      timestamp: entry.timestamp,
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: text }],
      },
    }
  }

  if (p.type === 'custom_tool_call') {
    return {
      type: 'assistant',
      timestamp: entry.timestamp,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: p.name,
            input: typeof p.input === 'string' ? { raw: p.input } : (p.input ?? {}),
            tool_use_id: p.call_id,
          },
        ],
      },
    }
  }

  return null
}

export function normalizeRawEntries(
  entries: SessionEntry[],
  assistantHandle: string | undefined
): SessionEntry[] {
  if (assistantHandle !== 'codex-cli') return entries
  const out: SessionEntry[] = []
  for (const e of entries) {
    const n = normalizeCodexEntry(e as CodexEntry)
    if (n) out.push(n)
  }
  return out
}
