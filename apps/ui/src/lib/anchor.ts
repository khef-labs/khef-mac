/**
 * Anchor utilities for comment text anchoring.
 *
 * Pure functions — no React/Preact dependencies.
 */

export interface AnchorContext {
  anchor_text: string
  anchor_prefix: string
  anchor_suffix: string
}

/** Normalize whitespace: collapse runs of whitespace into single spaces, trim. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Score how well a candidate match at `position` aligns with the expected
 * prefix and suffix context.  Higher is better.
 *
 * - `content`  — full text we're searching within
 * - `position` — start index of the candidate match
 * - `length`   — length of the matched anchor text
 * - `prefix`   — expected text immediately before the anchor
 * - `suffix`   — expected text immediately after the anchor
 */
export function scoreMatch(
  content: string,
  position: number,
  length: number,
  prefix?: string,
  suffix?: string
): number {
  let score = 0

  if (prefix) {
    const beforeText = content.slice(Math.max(0, position - prefix.length), position)
    // Longest common suffix between `prefix` and `beforeText`
    let common = 0
    for (let i = 1; i <= Math.min(prefix.length, beforeText.length); i++) {
      if (prefix[prefix.length - i] === beforeText[beforeText.length - i]) {
        common++
      } else {
        break
      }
    }
    score += common
  }

  if (suffix) {
    const afterStart = position + length
    const afterText = content.slice(afterStart, afterStart + suffix.length)
    // Longest common prefix between `suffix` and `afterText`
    let common = 0
    for (let i = 0; i < Math.min(suffix.length, afterText.length); i++) {
      if (suffix[i] === afterText[i]) {
        common++
      } else {
        break
      }
    }
    score += common
  }

  return score
}

/**
 * Extract anchor context from raw content given a user's text selection.
 *
 * Returns `{ anchor_text, anchor_prefix, anchor_suffix }` or `null` if the
 * selected text cannot be found in the raw content.
 *
 * `domPrefix` / `domSuffix` are optional surrounding text captured from the
 * DOM (rendered HTML). When multiple occurrences exist, these are used for
 * disambiguation via scoring.
 */
export function extractAnchorContext(
  rawContent: string,
  selectedText: string,
  domPrefix?: string,
  domSuffix?: string
): AnchorContext | null {
  const normalizedContent = normalize(rawContent)
  const normalizedSelection = normalize(selectedText)

  if (!normalizedSelection) return null

  // Find all occurrences
  const positions: number[] = []
  let searchFrom = 0
  while (true) {
    const idx = normalizedContent.indexOf(normalizedSelection, searchFrom)
    if (idx === -1) break
    positions.push(idx)
    searchFrom = idx + 1
  }

  if (positions.length === 0) return null

  let bestPos = positions[0]

  if (positions.length > 1 && (domPrefix || domSuffix)) {
    // Disambiguate using DOM context
    let bestScore = -1
    for (const pos of positions) {
      const s = scoreMatch(
        normalizedContent,
        pos,
        normalizedSelection.length,
        domPrefix ? normalize(domPrefix) : undefined,
        domSuffix ? normalize(domSuffix) : undefined
      )
      if (s > bestScore) {
        bestScore = s
        bestPos = pos
      }
    }
  }

  const CONTEXT_LEN = 50
  const prefix = normalizedContent.slice(Math.max(0, bestPos - CONTEXT_LEN), bestPos)
  const suffixStart = bestPos + normalizedSelection.length
  const suffix = normalizedContent.slice(suffixStart, suffixStart + CONTEXT_LEN)

  return {
    anchor_text: normalizedSelection,
    anchor_prefix: prefix,
    anchor_suffix: suffix,
  }
}

/**
 * Locate an anchor in the DOM and return a Range spanning the match.
 *
 * Uses a TreeWalker to collect text nodes, concatenate them, find the anchor
 * text, then map the flat offsets back to DOM text node boundaries.
 */
export function locateAnchorInDOM(
  container: HTMLElement,
  anchorText: string,
  anchorPrefix?: string,
  anchorSuffix?: string
): Range | null {
  // Collect text nodes
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  const nodeOffsets: number[] = [] // start offset of each node in concatenated text
  let totalLen = 0

  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    textNodes.push(node)
    nodeOffsets.push(totalLen)
    totalLen += node.textContent?.length || 0
  }

  const fullText = textNodes.map((n) => n.textContent || '').join('')
  const normalizedFull = normalize(fullText)
  const normalizedAnchor = normalize(anchorText)

  if (!normalizedAnchor) return null

  // Find all occurrences in normalized text
  const positions: number[] = []
  let searchFrom = 0
  while (true) {
    const idx = normalizedFull.indexOf(normalizedAnchor, searchFrom)
    if (idx === -1) break
    positions.push(idx)
    searchFrom = idx + 1
  }

  if (positions.length === 0) return null

  let bestPos = positions[0]

  if (positions.length > 1 && (anchorPrefix || anchorSuffix)) {
    let bestScore = -1
    for (const pos of positions) {
      const s = scoreMatch(
        normalizedFull,
        pos,
        normalizedAnchor.length,
        anchorPrefix ? normalize(anchorPrefix) : undefined,
        anchorSuffix ? normalize(anchorSuffix) : undefined
      )
      if (s > bestScore) {
        bestScore = s
        bestPos = pos
      }
    }
  }

  // Map normalized position back to original fullText.
  // Since normalize collapses whitespace, we need to map from normalized offsets
  // to original offsets by walking both strings.
  const startOrig = mapNormalizedToOriginal(fullText, bestPos)
  const endOrig = mapNormalizedToOriginal(fullText, bestPos + normalizedAnchor.length)

  if (startOrig === -1 || endOrig === -1) return null

  // Find the text nodes that contain start and end
  const range = document.createRange()

  let startSet = false
  for (let i = 0; i < textNodes.length; i++) {
    const nodeStart = nodeOffsets[i]
    const nodeEnd = nodeStart + (textNodes[i].textContent?.length || 0)

    if (!startSet && startOrig < nodeEnd) {
      range.setStart(textNodes[i], startOrig - nodeStart)
      startSet = true
    }

    if (startSet && endOrig <= nodeEnd) {
      range.setEnd(textNodes[i], endOrig - nodeStart)
      return range
    }
  }

  return null
}

/**
 * Map an offset in the normalized (whitespace-collapsed) string back to the
 * corresponding offset in the original string.
 */
function mapNormalizedToOriginal(original: string, normalizedOffset: number): number {
  let ni = 0 // normalized index
  let oi = 0 // original index

  // Skip leading whitespace (normalize trims)
  while (oi < original.length && /\s/.test(original[oi])) {
    oi++
  }

  while (oi < original.length && ni < normalizedOffset) {
    if (/\s/.test(original[oi])) {
      // In normalized text, a run of whitespace maps to a single space
      ni++ // one space in normalized
      oi++ // advance past first whitespace char
      // Skip remaining whitespace chars in original
      while (oi < original.length && /\s/.test(original[oi])) {
        oi++
      }
    } else {
      ni++
      oi++
    }
  }

  return oi
}
