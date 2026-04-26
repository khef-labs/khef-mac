/**
 * Markdown formatting utilities for textareas.
 * All functions operate on a textarea element, use execCommand('insertText')
 * to preserve native undo, and restore focus + cursor position.
 */

function insertText(textarea: HTMLTextAreaElement, text: string): void {
  textarea.focus()
  document.execCommand('insertText', false, text)
}

/**
 * Wrap/unwrap selection with a symmetric delimiter (e.g. ** for bold, * for italic).
 * If the selection is already wrapped, removes the wrapper. Otherwise adds it.
 */
function wrapSelection(
  textarea: HTMLTextAreaElement,
  wrapper: string
): void {
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const value = textarea.value
  const selected = value.substring(start, end)
  const len = wrapper.length

  // Check if selection is already wrapped
  const before = value.substring(start - len, start)
  const after = value.substring(end, end + len)

  // For single-char wrappers (italic *), count consecutive wrapper chars before
  // the selection to distinguish italic from bold. An even count (e.g. 2 for **)
  // means bold-only — italic is off, so we should wrap rather than unwrap.
  let isWrapped = before === wrapper && after === wrapper
  if (isWrapped && len === 1) {
    let countBefore = 0
    for (let i = start - 1; i >= 0 && value[i] === wrapper; i--) countBefore++
    if (countBefore % 2 === 0) isWrapped = false
  }

  if (isWrapped) {
    // Unwrap: select the wrapper + content + wrapper, then replace with just content
    textarea.setSelectionRange(start - len, end + len)
    insertText(textarea, selected)
    textarea.setSelectionRange(start - len, end - len)
  } else if (selected.startsWith(wrapper) && selected.endsWith(wrapper) && selected.length >= len * 2) {
    // Selection includes the wrappers
    const inner = selected.slice(len, -len)
    insertText(textarea, inner)
    textarea.setSelectionRange(start, start + inner.length)
  } else {
    // Wrap
    const wrapped = wrapper + selected + wrapper
    insertText(textarea, wrapped)
    if (selected.length === 0) {
      // Place cursor between wrappers
      textarea.setSelectionRange(start + len, start + len)
    } else {
      // Re-select the content (inside wrappers)
      textarea.setSelectionRange(start + len, end + len)
    }
  }
}

/**
 * Apply a prefix function to each line in the selection.
 * prefixer receives the current line text and returns the new line text.
 */
function prefixLines(
  textarea: HTMLTextAreaElement,
  prefixer: (line: string, index: number) => string
): void {
  const value = textarea.value
  let start = textarea.selectionStart
  let end = textarea.selectionEnd

  // Expand selection to full lines
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const lineEnd = value.indexOf('\n', end)
  const actualEnd = lineEnd === -1 ? value.length : lineEnd

  const selectedLines = value.substring(lineStart, actualEnd)
  const lines = selectedLines.split('\n')
  const newLines = lines.map(prefixer)
  const replacement = newLines.join('\n')

  textarea.setSelectionRange(lineStart, actualEnd)
  insertText(textarea, replacement)
  textarea.setSelectionRange(lineStart, lineStart + replacement.length)
}

export function formatBold(textarea: HTMLTextAreaElement): void {
  wrapSelection(textarea, '**')
}

export function formatItalic(textarea: HTMLTextAreaElement): void {
  wrapSelection(textarea, '*')
}

/**
 * Set heading level on the current line. If the line already has the
 * requested level, the heading prefix is removed (toggle behavior).
 * @param level 1–3 for h1–h3
 */
export function formatHeading(textarea: HTMLTextAreaElement, level: 1 | 2 | 3 | 4 | 5 = 1): void {
  const value = textarea.value
  const start = textarea.selectionStart

  // Find the current line
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const lineEnd = value.indexOf('\n', start)
  const actualEnd = lineEnd === -1 ? value.length : lineEnd
  const line = value.substring(lineStart, actualEnd)

  // Strip any existing heading prefix
  const match = line.match(/^(#{1,6})\s/)
  const bare = match ? line.substring(match[0].length) : line
  const currentLevel = match ? match[1].length : 0

  // Toggle: if already at the requested level, remove; otherwise set it
  const newLine = currentLevel === level ? bare : '#'.repeat(level) + ' ' + bare

  textarea.setSelectionRange(lineStart, actualEnd)
  insertText(textarea, newLine)
  textarea.setSelectionRange(lineStart, lineStart + newLine.length)
}

export function formatCode(textarea: HTMLTextAreaElement): void {
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selected = textarea.value.substring(start, end)

  // Multi-line → fenced code block
  if (selected.includes('\n')) {
    const fenced = '```\n' + selected + '\n```'
    insertText(textarea, fenced)
    textarea.setSelectionRange(start + 4, start + 4 + selected.length)
  } else {
    wrapSelection(textarea, '`')
  }
}

export async function formatLink(
  textarea: HTMLTextAreaElement,
  url?: string
): Promise<void> {
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selectedText = textarea.value.substring(start, end)
  const linkText = selectedText || ''
  const linkUrl = url || ''
  const markdown = `[${linkText}](${linkUrl})`

  textarea.focus()
  insertText(textarea, markdown)

  // Position cursor at the part that still needs input
  if (!linkText) {
    const pos = start + 1
    textarea.setSelectionRange(pos, pos)
  } else if (!linkUrl) {
    const pos = start + linkText.length + 3
    textarea.setSelectionRange(pos, pos)
  }
}

export function formatBulletList(textarea: HTMLTextAreaElement): void {
  prefixLines(textarea, (line) => {
    if (line.startsWith('- ')) {
      return line.substring(2)
    }
    return '- ' + line
  })
}

export function formatNumberedList(textarea: HTMLTextAreaElement): void {
  prefixLines(textarea, (line, index) => {
    const match = line.match(/^\d+\.\s/)
    if (match) {
      return line.substring(match[0].length)
    }
    return `${index + 1}. ` + line
  })
}

export function formatBlockquote(textarea: HTMLTextAreaElement): void {
  prefixLines(textarea, (line) => {
    if (line.startsWith('> ')) {
      return line.substring(2)
    }
    return '> ' + line
  })
}

export function formatHorizontalRule(textarea: HTMLTextAreaElement): void {
  const start = textarea.selectionStart
  const value = textarea.value

  // Ensure we're on a new line
  const needsNewline = start > 0 && value[start - 1] !== '\n'
  const rule = (needsNewline ? '\n' : '') + '---\n'

  insertText(textarea, rule)
}
