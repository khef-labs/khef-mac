import { useEffect, useRef } from 'preact/hooks'
import type { RefObject } from 'preact'

const BLOCK_SELECTORS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, tr, pre'
const TTS_ATTR = 'data-tts-active'

/**
 * Highlights the block-level DOM element that corresponds to the
 * word currently being spoken by TTS. Uses the onboundary charIndex
 * to extract a snippet from the chunk and match it to a DOM block.
 */
export function useTtsHighlight(
  contentRef: RefObject<HTMLDivElement>,
  isSpeaking: boolean,
  currentChunkIndex: number,
  chunks: string[],
  spokenCharIndex: number
) {
  const prevElRef = useRef<Element | null>(null)
  const blockMapRef = useRef<{ el: Element; text: string }[]>([])

  // Rebuild the block map whenever the content div changes
  useEffect(() => {
    if (!contentRef.current) {
      blockMapRef.current = []
      return
    }
    const blocks = contentRef.current.querySelectorAll(BLOCK_SELECTORS)
    blockMapRef.current = Array.from(blocks).map(el => ({
      el,
      text: normalize(el.textContent || ''),
    }))
  }, [contentRef, isSpeaking, currentChunkIndex])

  useEffect(() => {
    // Clear highlight when not speaking
    if (!isSpeaking || currentChunkIndex < 0 || spokenCharIndex < 0) {
      clearHighlight(prevElRef)
      return
    }

    const chunk = chunks[currentChunkIndex]
    if (!chunk) return

    // Extract a snippet around the current spoken position
    const snippet = extractSnippet(chunk, spokenCharIndex)
    if (!snippet) return

    // Find the block containing this snippet
    const target = findBlockBySnippet(blockMapRef.current, snippet)

    if (target && target.el !== prevElRef.current) {
      clearHighlight(prevElRef)
      target.el.setAttribute(TTS_ATTR, 'true')
      prevElRef.current = target.el
      target.el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [isSpeaking, currentChunkIndex, chunks, spokenCharIndex])

  // Cleanup on unmount
  useEffect(() => {
    return () => clearHighlight(prevElRef)
  }, [])
}

function clearHighlight(ref: { current: Element | null }) {
  if (ref.current) {
    ref.current.removeAttribute(TTS_ATTR)
    ref.current = null
  }
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Extracts a ~60-char snippet around the current charIndex in the chunk.
 * Returns the normalized words around the spoken position.
 */
function extractSnippet(chunk: string, charIndex: number): string | null {
  // Grab a window around the current position
  const start = Math.max(0, charIndex)
  const end = Math.min(chunk.length, charIndex + 60)
  const raw = chunk.slice(start, end)
  const snip = normalize(raw)
  // Need at least a few words to match reliably
  if (snip.split(' ').length < 2) return null
  return snip
}

/**
 * Finds the first block whose text contains the spoken snippet.
 */
function findBlockBySnippet(
  blocks: { el: Element; text: string }[],
  snippet: string
): { el: Element; text: string } | null {
  // Try direct containment first
  for (const block of blocks) {
    if (block.text && block.text.includes(snippet)) {
      return block
    }
  }

  // Fall back to matching the first few words (handles minor whitespace/punctuation differences)
  const words = snippet.split(' ').slice(0, 4).filter(w => w.length > 2)
  if (words.length < 2) return null

  for (const block of blocks) {
    if (!block.text) continue
    const hits = words.filter(w => block.text.includes(w)).length
    if (hits >= words.length) {
      return block
    }
  }

  return null
}
