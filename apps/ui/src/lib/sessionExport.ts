import type { SessionEntry, SessionContentBlock } from '../types'

type ExportMode = 'full' | 'compact'
type ExportFormat = 'md' | 'txt'

function formatContentBlocks(blocks: SessionContentBlock[], mode: ExportMode, format: ExportFormat): string {
  const parts: string[] = []

  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text)
    } else if (block.type === 'thinking' && block.thinking) {
      if (mode === 'full') {
        if (format === 'md') {
          parts.push(`> **Thinking**\n> ${block.thinking.split('\n').join('\n> ')}`)
        } else {
          parts.push(`[Thinking]\n${block.thinking}`)
        }
      }
    } else if (block.type === 'tool_use') {
      if (mode === 'full') {
        const inputStr = block.input ? JSON.stringify(block.input, null, 2) : ''
        if (format === 'md') {
          parts.push(`**Tool: ${block.name || 'unknown'}**\n\`\`\`json\n${inputStr}\n\`\`\``)
        } else {
          parts.push(`[Tool: ${block.name || 'unknown'}]\n${inputStr}`)
        }
      }
    } else if (block.type === 'tool_result') {
      if (mode === 'full') {
        const resultStr = typeof block.content === 'string'
          ? block.content
          : block.content ? JSON.stringify(block.content, null, 2) : ''
        if (format === 'md') {
          parts.push(`**Tool Result** (${block.tool_use_id || ''})\n\`\`\`\n${resultStr}\n\`\`\``)
        } else {
          parts.push(`[Tool Result]\n${resultStr}`)
        }
      }
    }
  }

  return parts.join('\n\n')
}

function formatEntry(entry: SessionEntry, mode: ExportMode, format: ExportFormat): string | null {
  if (entry.type === 'summary') {
    const title = entry.summary || 'Session'
    return format === 'md' ? `# ${title}` : `=== ${title} ===`
  }

  if (entry.type === 'user' || entry.type === 'assistant') {
    const role = entry.type === 'user' ? 'User' : 'Assistant'
    const msg = entry.message

    if (!msg) return null

    let body: string
    if (typeof msg.content === 'string') {
      body = msg.content
    } else if (Array.isArray(msg.content)) {
      body = formatContentBlocks(msg.content, mode, format)
    } else {
      return null
    }

    if (!body.trim()) return null

    const header = format === 'md' ? `## ${role}` : `--- ${role} ---`
    const parts = [header, body]

    if (mode === 'full' && msg.usage) {
      const usage = `Tokens: ${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out`
      parts.push(format === 'md' ? `*${usage}*` : usage)
    }

    return parts.join('\n\n')
  }

  // Other entry types only included in full mode
  if (mode === 'compact') return null

  if (entry.type === 'file-history-snapshot' || entry.type === 'progress' || entry.type === 'queue-operation') {
    return null
  }

  // Unknown types: include as JSON in full mode
  return format === 'md'
    ? `\`\`\`json\n${JSON.stringify(entry, null, 2)}\n\`\`\``
    : JSON.stringify(entry, null, 2)
}

/**
 * Export session entries to a text string.
 */
export function exportSession(
  entries: SessionEntry[],
  mode: ExportMode,
  format: ExportFormat,
  title?: string
): string {
  const parts: string[] = []

  if (title) {
    parts.push(format === 'md' ? `# ${title}` : `=== ${title} ===`)
  }

  for (const entry of entries) {
    const formatted = formatEntry(entry, mode, format)
    if (formatted) parts.push(formatted)
  }

  return parts.join('\n\n---\n\n') + '\n'
}

/**
 * Trigger a file download in the browser.
 */
export function triggerDownload(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
