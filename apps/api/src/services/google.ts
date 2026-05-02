/**
 * Google integration service.
 * Uses gcloud CLI for authentication - no OAuth flow needed.
 */

import * as fs from 'fs'
import * as path from 'path'
import { isGcloudInstalled, getGcloudAccount, getGcloudAccessToken } from './gcloud'
import { getGeminiSettings } from './gemini'
import { query } from '../db/client'

// Google API base URLs
export const GOOGLE_DRIVE_API_URL = 'https://www.googleapis.com/drive/v3'
export const GOOGLE_DOCS_API_URL = 'https://docs.googleapis.com/v1/documents'

// Types
export interface GoogleStatus {
  available: boolean
  reason?: 'gcloud_not_installed' | 'gcloud_not_authenticated'
  email?: string
}

export interface GoogleDocContent {
  id: string
  title: string
  content: string // markdown
  url: string
}

export interface GoogleComment {
  id: string
  author: string
  content: string
  quotedText: string | null  // The text the comment was anchored to
  createdTime: string
  resolved: boolean
  replies: GoogleCommentReply[]
}

export interface GoogleCommentReply {
  id: string
  author: string
  content: string
  createdTime: string
}

// Cache for status check (avoid repeated shell calls)
let statusCache: { status: GoogleStatus; timestamp: number } | null = null
const STATUS_CACHE_TTL = 30_000 // 30 seconds

// Cache for access token (refresh before expiry)
let tokenCache: { token: string; timestamp: number } | null = null
const TOKEN_CACHE_TTL = 55 * 60_000 // 55 minutes (tokens last 60 min)

/**
 * Decode HTML entities in a string.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')  // Must be last
}

/**
 * Check if gcloud CLI is available and authenticated.
 */
export async function checkGoogleStatus(): Promise<GoogleStatus> {
  // Return cached status if fresh
  if (statusCache && Date.now() - statusCache.timestamp < STATUS_CACHE_TTL) {
    return statusCache.status
  }

  if (!await isGcloudInstalled()) {
    const status: GoogleStatus = { available: false, reason: 'gcloud_not_installed' }
    statusCache = { status, timestamp: Date.now() }
    return status
  }

  try {
    const email = await getGcloudAccount()

    if (!email) {
      const status: GoogleStatus = { available: false, reason: 'gcloud_not_authenticated' }
      statusCache = { status, timestamp: Date.now() }
      return status
    }

    const status: GoogleStatus = { available: true, email }
    statusCache = { status, timestamp: Date.now() }
    return status
  } catch {
    const status: GoogleStatus = { available: false, reason: 'gcloud_not_authenticated' }
    statusCache = { status, timestamp: Date.now() }
    return status
  }
}

/**
 * Get access token from gcloud CLI.
 * Uses the configured driveAccount setting when available.
 */
export async function getGcloudToken(): Promise<string | null> {
  // Return cached token if fresh
  if (tokenCache && Date.now() - tokenCache.timestamp < TOKEN_CACHE_TTL) {
    return tokenCache.token
  }

  try {
    const settings = await getGeminiSettings()
    const account = settings.driveAccount || undefined
    const token = await getGcloudAccessToken(account)

    if (!token) {
      return null
    }

    tokenCache = { token, timestamp: Date.now() }
    return token
  } catch {
    return null
  }
}

/**
 * Format a Drive API error with actionable hints for common auth issues.
 */
function driveApiError(action: string, status: number, body: string): Error {
  if (status === 403) {
    return new Error(
      `${action}: Drive API access denied (403). ` +
      'Re-authenticate with: gcloud auth login --enable-gdrive-access --force'
    )
  }
  if (status === 401) {
    return new Error(
      `${action}: Token invalid or expired (401). ` +
      'Re-authenticate with: gcloud auth login --enable-gdrive-access --force'
    )
  }
  return new Error(`${action}: ${status} - ${body}`)
}

/**
 * Make a Drive API request with automatic token refresh on 401/403.
 * On auth failure: invalidates the cached token, fetches a fresh one, and retries once.
 */
async function driveApiFetch(url: string, options?: RequestInit): Promise<Response> {
  const token = await getGcloudToken()
  if (!token) {
    throw new Error('Failed to get gcloud access token')
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(options?.headers as Record<string, string> || {}),
  }

  const res = await fetch(url, { ...options, headers })

  if (res.status === 401 || res.status === 403) {
    // Invalidate cached token and retry with a fresh one
    tokenCache = null
    const freshToken = await getGcloudToken()
    if (!freshToken) {
      throw new Error('Failed to get gcloud access token after refresh')
    }

    return fetch(url, {
      ...options,
      headers: { ...headers, Authorization: `Bearer ${freshToken}` },
    })
  }

  return res
}

/**
 * Fetch a Google Doc's content as markdown.
 */
export async function fetchGoogleDoc(docId: string): Promise<GoogleDocContent> {
  // Get document metadata (title)
  const metadataRes = await driveApiFetch(
    `${GOOGLE_DRIVE_API_URL}/files/${docId}?fields=id,name,webViewLink`
  )

  if (!metadataRes.ok) {
    const body = await metadataRes.text()
    throw driveApiError('Failed to fetch document metadata', metadataRes.status, body)
  }

  const metadata = await metadataRes.json() as { id: string; name: string; webViewLink: string }

  // Export as markdown directly
  const exportRes = await driveApiFetch(
    `${GOOGLE_DRIVE_API_URL}/files/${docId}/export?mimeType=text/markdown`
  )

  if (!exportRes.ok) {
    const body = await exportRes.text()
    throw driveApiError('Failed to export document', exportRes.status, body)
  }

  const markdown = await exportRes.text()

  return {
    id: metadata.id,
    title: metadata.name,
    content: markdown,
    url: metadata.webViewLink,
  }
}

/**
 * Fetch comments from a Google Doc.
 */
export async function fetchDocComments(docId: string): Promise<GoogleComment[]> {
  const res = await driveApiFetch(
    `${GOOGLE_DRIVE_API_URL}/files/${docId}/comments?fields=comments(id,author,content,quotedFileContent,createdTime,resolved,replies(id,author,content,createdTime))`
  )

  if (!res.ok) {
    // Comments might not be available for all doc types
    if (res.status === 403 || res.status === 404) {
      return []
    }
    const body = await res.text()
    throw driveApiError('Failed to fetch comments', res.status, body)
  }

  const data = await res.json() as {
    comments?: Array<{
      id: string
      author?: { displayName?: string }
      content?: string
      quotedFileContent?: { value?: string }
      createdTime?: string
      resolved?: boolean
      replies?: Array<{
        id: string
        author?: { displayName?: string }
        content?: string
        createdTime?: string
      }>
    }>
  }

  return (data.comments || []).map((c) => ({
    id: c.id,
    author: c.author?.displayName || 'Unknown',
    content: c.content || '',
    quotedText: c.quotedFileContent?.value ? decodeHtmlEntities(c.quotedFileContent.value) : null,
    createdTime: c.createdTime || '',
    resolved: c.resolved || false,
    replies: (c.replies || []).map((r) => ({
      id: r.id,
      author: r.author?.displayName || 'Unknown',
      content: r.content || '',
      createdTime: r.createdTime || '',
    })),
  }))
}

/**
 * Fetch full-resolution image URLs from the Google Docs API.
 * Returns a map of image reference name (e.g., "image1") to contentUri URL,
 * ordered by appearance in the document body.
 */
export async function fetchDocImageUrls(docId: string): Promise<Map<string, string>> {
  const res = await driveApiFetch(
    `${GOOGLE_DOCS_API_URL}/${docId}?fields=inlineObjects,body.content`
  )

  if (!res.ok) {
    return new Map() // Non-fatal: fall back to base64 thumbnails
  }

  const doc = await res.json() as {
    inlineObjects?: Record<string, {
      inlineObjectProperties?: {
        embeddedObject?: {
          imageProperties?: { contentUri?: string }
        }
      }
    }>
    body?: {
      content?: Array<{
        paragraph?: {
          elements?: Array<{
            inlineObjectElement?: { inlineObjectId?: string }
          }>
        }
      }>
    }
  }

  if (!doc.inlineObjects || !doc.body?.content) {
    return new Map()
  }

  // Walk the document body to get inline objects in order of appearance
  const orderedIds: string[] = []
  for (const block of doc.body.content) {
    if (!block.paragraph?.elements) continue
    for (const el of block.paragraph.elements) {
      if (el.inlineObjectElement?.inlineObjectId) {
        orderedIds.push(el.inlineObjectElement.inlineObjectId)
      }
    }
  }

  // Map ordered object IDs to "imageN" reference names with contentUri
  const imageUrls = new Map<string, string>()
  let imageIndex = 1
  for (const objId of orderedIds) {
    const obj = doc.inlineObjects[objId]
    const uri = obj?.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri
    if (uri) {
      imageUrls.set(`image${imageIndex}`, uri)
      imageIndex++
    }
  }

  return imageUrls
}

/**
 * Download an image from a URL using gcloud authentication.
 * Returns the image data and detected mime type.
 */
async function downloadAuthenticatedImage(url: string): Promise<{ data: Buffer; mimeType: string } | null> {
  try {
    const res = await driveApiFetch(url)
    if (!res.ok) return null

    const contentType = res.headers.get('content-type') || 'image/png'
    const mimeType = contentType.split(';')[0].trim()
    const arrayBuffer = await res.arrayBuffer()
    return { data: Buffer.from(arrayBuffer), mimeType }
  } catch {
    return null
  }
}

/**
 * Find anchor context for a quoted text within content.
 * Returns prefix/suffix to help disambiguate if the text appears multiple times.
 */
export function findAnchorContext(
  content: string,
  quotedText: string,
  contextLength = 50
): { found: boolean; anchorPrefix: string | null; anchorSuffix: string | null } {
  if (!quotedText) {
    return { found: false, anchorPrefix: null, anchorSuffix: null }
  }

  const index = content.indexOf(quotedText)
  if (index === -1) {
    // Try case-insensitive search as fallback
    const lowerContent = content.toLowerCase()
    const lowerQuoted = quotedText.toLowerCase()
    const lowerIndex = lowerContent.indexOf(lowerQuoted)

    if (lowerIndex === -1) {
      return { found: false, anchorPrefix: null, anchorSuffix: null }
    }

    // Use the actual case from content
    const prefixStart = Math.max(0, lowerIndex - contextLength)
    const suffixEnd = Math.min(content.length, lowerIndex + quotedText.length + contextLength)

    return {
      found: true,
      anchorPrefix: lowerIndex > 0 ? content.slice(prefixStart, lowerIndex) : null,
      anchorSuffix: lowerIndex + quotedText.length < content.length
        ? content.slice(lowerIndex + quotedText.length, suffixEnd)
        : null,
    }
  }

  const prefixStart = Math.max(0, index - contextLength)
  const suffixEnd = Math.min(content.length, index + quotedText.length + contextLength)

  return {
    found: true,
    anchorPrefix: index > 0 ? content.slice(prefixStart, index) : null,
    anchorSuffix: index + quotedText.length < content.length
      ? content.slice(index + quotedText.length, suffixEnd)
      : null,
  }
}

/**
 * Format comments as markdown section.
 * @deprecated Use anchored comments instead when possible
 */
export function formatCommentsAsMarkdown(comments: GoogleComment[]): string {
  if (comments.length === 0) {
    return ''
  }

  const lines: string[] = ['', '---', '', '## Comments', '']

  for (const comment of comments) {
    const date = comment.createdTime
      ? new Date(comment.createdTime).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : ''

    lines.push(`> **${comment.author}** (${date}):`)
    lines.push(`> ${comment.content.replace(/\n/g, '\n> ')}`)

    // Add replies indented
    for (const reply of comment.replies) {
      const replyDate = reply.createdTime
        ? new Date(reply.createdTime).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })
        : ''
      lines.push(`>`)
      lines.push(`> - **${reply.author}** (${replyDate}): ${reply.content}`)
    }

    if (comment.resolved) {
      lines.push(`> [Resolved]`)
    }

    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Parse a Google Doc URL or ID to extract the document ID.
 */
export function parseGoogleDocId(input: string): string | null {
  // Already a bare ID (no slashes, reasonable length)
  if (!input.includes('/') && input.length >= 20 && input.length <= 60) {
    return input
  }

  // URL patterns:
  // https://docs.google.com/document/d/DOC_ID/edit
  // https://docs.google.com/document/d/DOC_ID/edit?...
  // https://docs.google.com/document/d/DOC_ID
  const match = input.match(/\/document\/d\/([a-zA-Z0-9_-]+)/)
  return match ? match[1] : null
}

/**
 * Extract the tab ID from a multi-tab Google Doc URL.
 * Tab IDs look like `t.abc123def456` and appear as `?tab=...` (or `&tab=...`).
 * Also tolerates a `#tab=...` fragment form some clients emit.
 */
export function parseGoogleDocTabId(input: string): string | null {
  if (!input || !input.includes('tab=')) return null
  const match = input.match(/[?&#]tab=(t\.[a-zA-Z0-9_-]+)/)
  return match ? match[1] : null
}

/**
 * Invalidate cached status (useful after auth changes).
 */
export function invalidateGoogleStatusCache(): void {
  statusCache = null
  tokenCache = null
}

// ---- Image extraction from Google Doc markdown ----

interface ExtractedImage {
  refName: string   // e.g., "image1"
  mimeType: string  // e.g., "image/png"
  data: Buffer
}

/**
 * Regex to match reference-style image definitions with data URIs.
 * Google Docs markdown export produces: [imageN]: <data:image/png;base64,...>
 */
const IMAGE_REF_RE = /^\[([^\]]+)\]:\s*<data:(image\/[^;]+);base64,([^>]+)>$/gm

/**
 * Parse reference-style base64 image definitions from markdown content.
 * Returns the extracted images and the markdown with those definitions removed.
 */
function parseBase64ImageRefs(markdown: string): { images: ExtractedImage[]; cleanedMarkdown: string } {
  const images: ExtractedImage[] = []
  const cleanedMarkdown = markdown.replace(IMAGE_REF_RE, (_match, refName, mimeType, base64Data) => {
    images.push({
      refName,
      mimeType,
      data: Buffer.from(base64Data, 'base64'),
    })
    return '' // Remove the definition line; will be replaced with a local URL ref
  })

  return { images, cleanedMarkdown }
}

/**
 * Get the file extension for an image mime type.
 */
function imageExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  }
  return map[mimeType] || 'png'
}

/**
 * Get the storage path from settings, falling back to ./uploads.
 */
async function getStoragePath(): Promise<string> {
  const rows = await query<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'files.storagePath'"
  )
  return rows.length > 0 ? rows[0].value : './uploads'
}

/**
 * Build a date-organized storage directory: {storagePath}/{projectHandle}/{YYYY}/{MM}/
 */
export async function buildStorageDir(projectHandle: string): Promise<string> {
  const storagePath = await getStoragePath()
  const now = new Date()
  const year = now.getFullYear().toString()
  const month = (now.getMonth() + 1).toString().padStart(2, '0')
  const dir = path.join(storagePath, projectHandle, year, month)
  await fs.promises.mkdir(dir, { recursive: true })
  return dir
}

/**
 * Extract images from Google Doc markdown, fetch full-resolution versions via Docs API,
 * save them as local files, and rewrite the markdown references to point to /api/files/:id.
 *
 * Falls back to base64 thumbnails from the markdown export if Docs API images are unavailable.
 */
export async function localizeDocImages(
  markdown: string,
  projectId: string,
  memoryId: string,
  projectHandle: string,
  docId?: string,
): Promise<string> {
  const { images, cleanedMarkdown } = parseBase64ImageRefs(markdown)

  if (images.length === 0) {
    return markdown // No images to process
  }

  // Try to get full-resolution image URLs from Docs API
  let highResUrls = new Map<string, string>()
  if (docId) {
    try {
      highResUrls = await fetchDocImageUrls(docId)
    } catch {
      // Fall back to base64 thumbnails
    }
  }

  const storageDir = await buildStorageDir(projectHandle)

  // Build new reference definitions
  const newRefs: string[] = []

  for (const img of images) {
    const fileId = crypto.randomUUID()
    let imageData = img.data
    let mimeType = img.mimeType

    // Try full-resolution image from Docs API
    const highResUrl = highResUrls.get(img.refName)
    if (highResUrl) {
      const downloaded = await downloadAuthenticatedImage(highResUrl)
      if (downloaded) {
        imageData = downloaded.data
        mimeType = downloaded.mimeType
      }
    }

    const ext = imageExtension(mimeType)
    const filename = `${fileId}.${ext}`
    const filePath = path.join(storageDir, filename)

    // Write file to disk
    await fs.promises.writeFile(filePath, imageData)

    // Insert file record with memory_id for cleanup tracking
    await query(
      `INSERT INTO files (id, project_id, filename, original_filename, mime_type, size, path, memory_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [fileId, projectId, filename, `${img.refName}.${ext}`, mimeType, imageData.length, filePath, memoryId]
    )

    // Add new reference pointing to local file API
    newRefs.push(`[${img.refName}]: /api/files/${fileId}`)
  }

  // Append the new reference definitions at the end
  return cleanedMarkdown.trimEnd() + '\n\n' + newRefs.join('\n') + '\n'
}

/**
 * Delete all files associated with a memory (both from disk and DB).
 * Called before re-syncing to avoid stale file accumulation.
 * Note: DB records with memory_id are CASCADE-deleted when the memory is deleted,
 * but disk files need explicit cleanup.
 */
export async function deleteMemoryFiles(memoryId: string): Promise<number> {
  const files = await query<{ id: string; path: string }>(
    'SELECT id, path FROM files WHERE memory_id = $1',
    [memoryId]
  )

  for (const file of files) {
    try {
      await fs.promises.unlink(file.path)
    } catch {
      // File already gone, ignore
    }
  }

  if (files.length > 0) {
    await query('DELETE FROM files WHERE memory_id = $1', [memoryId])
  }

  return files.length
}

/**
 * Convert simple markdown to HTML for Google Docs upload.
 * Handles headings, bold, italic, links, lists, code blocks, and paragraphs.
 */
function markdownToSimpleHtml(markdown: string): string {
  // Strip markdown escape characters (e.g., \# \-- \_) left by Google Docs export
  let cleaned = markdown.replace(/\\([#\-_*`\[\](){}|>~])/g, '$1')

  // Extract code blocks first, replacing with placeholders
  const codeBlocks: string[] = []
  cleaned = cleaned.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length
    const escaped = code.replace(/</g, '&lt;').replace(/>/g, '&gt;').trimEnd()
    codeBlocks.push(`<pre style="font-family:'Courier New',monospace;background-color:#f8f9fa;color:#333;padding:12px 16px;border-radius:4px;white-space:pre-wrap;line-height:1.45;font-size:10pt;">${escaped}</pre>`)
    return `%%CODEBLOCK_${idx}%%`
  })

  let html = cleaned
    // Inline code
    .replace(/`([^`]+)`/g, '<span style="font-family:\'Courier New\',monospace;background-color:#f0f0f0;padding:1px 4px;">$1</span>')
    // Headings (sized to match Google Docs native heading proportions)
    .replace(/^######\s+(.+)$/gm, '<h6 style="font-size:11pt;">$1</h6>')
    .replace(/^#####\s+(.+)$/gm, '<h5 style="font-size:11pt;">$1</h5>')
    .replace(/^####\s+(.+)$/gm, '<h4 style="font-size:12pt;">$1</h4>')
    .replace(/^###\s+(.+)$/gm, '<h3 style="font-size:14pt;">$1</h3>')
    .replace(/^##\s+(.+)$/gm, '<h2 style="font-size:16pt;">$1</h2>')
    .replace(/^#\s+(.+)$/gm, '<h1 style="font-size:20pt;">$1</h1>')
    // Bold and italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<i>$1</i>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Unordered lists
    .replace(/^[\-\*]\s+(.+)$/gm, '<ul-li>$1</ul-li>')
    // Ordered lists
    .replace(/^\d+\.\s+(.+)$/gm, '<ol-li>$1</ol-li>')
    // Horizontal rules
    .replace(/^---+$/gm, '<hr>')
    // Tables: convert markdown tables to HTML
    .replace(/^(\|.+\|)\n(\|[\s\-:|]+\|)\n((?:\|.+\|\n?)*)/gm, (_match, headerRow, _sep, bodyRows) => {
      const headers = headerRow.split('|').filter((c: string) => c.trim()).map((c: string) => `<th>${c.trim()}</th>`).join('')
      const rows = bodyRows.trim().split('\n').filter((r: string) => r.trim()).map((row: string) => {
        const cells = row.split('|').filter((c: string) => c.trim()).map((c: string) => `<td>${c.trim()}</td>`).join('')
        return `<tr>${cells}</tr>`
      }).join('')
      return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`
    })

  // Wrap consecutive list items in appropriate list tags
  html = html.replace(/((?:<ul-li>.*<\/ul-li>\n?)+)/g, (match) => {
    const items = match.replace(/<ul-li>/g, '<li>').replace(/<\/ul-li>/g, '</li>')
    return `<ul>${items}</ul>`
  })
  html = html.replace(/((?:<ol-li>.*<\/ol-li>\n?)+)/g, (match) => {
    const items = match.replace(/<ol-li>/g, '<li>').replace(/<\/ol-li>/g, '</li>')
    return `<ol>${items}</ol>`
  })

  // Wrap remaining plain text lines in <p> tags
  html = html
    .split('\n')
    .map(line => {
      const trimmed = line.trim()
      if (!trimmed) return ''
      if (/^<(h[1-6]|ul|ol|li|pre|hr|table|thead|tbody|tr|\/|%%CODEBLOCK)/.test(trimmed) || /^<(ul|ol)-li>/.test(trimmed)) {
        return line
      }
      return `<p>${trimmed}</p>`
    })
    .join('\n')

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    html = html.replace(`<p>%%CODEBLOCK_${i}%%</p>`, codeBlocks[i])
    html = html.replace(`%%CODEBLOCK_${i}%%`, codeBlocks[i])
  }

  return `<html><body>${html}</body></html>`
}

export interface PushToDocResult {
  docId: string
  title: string
  url: string
}

/**
 * Push khef memory content back to a linked Google Doc.
 * Replaces the entire document body via Drive API media upload with HTML content.
 */
export async function pushToGoogleDoc(docId: string, content: string, title?: string): Promise<PushToDocResult> {
  // Get current document metadata for the response
  const metadataRes = await driveApiFetch(
    `${GOOGLE_DRIVE_API_URL}/files/${docId}?fields=id,name,webViewLink`
  )

  if (!metadataRes.ok) {
    const body = await metadataRes.text()
    throw driveApiError('Failed to fetch document metadata', metadataRes.status, body)
  }

  const metadata = await metadataRes.json() as { id: string; name: string; webViewLink: string }

  // Convert markdown to HTML and upload via Drive API media update
  const html = markdownToSimpleHtml(content)

  const uploadRes = await driveApiFetch(
    `https://www.googleapis.com/upload/drive/v3/files/${docId}?uploadType=media`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'text/html' },
      body: html,
    }
  )

  if (!uploadRes.ok) {
    const body = await uploadRes.text()
    throw driveApiError('Failed to push content to Google Doc', uploadRes.status, body)
  }

  // Sync document title if provided and different
  if (title && title !== metadata.name) {
    await driveApiFetch(`${GOOGLE_DRIVE_API_URL}/files/${docId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: title }),
    })
  }

  return {
    docId: metadata.id,
    title: title || metadata.name,
    url: metadata.webViewLink,
  }
}

// ---------------------------------------------------------------------------
// Workspace Docs API push (batchUpdate)
// ---------------------------------------------------------------------------

interface TextRun {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  link?: string
}

interface DocBlock {
  type: 'heading' | 'paragraph' | 'code' | 'ulist' | 'olist' | 'table' | 'hr'
  level?: number
  runs?: TextRun[]
  items?: TextRun[][]   // list items, each item is an array of runs
  code?: string         // raw code text
  rows?: string[][]     // table rows (first row = header)
}

/**
 * Parse inline markdown formatting into TextRuns.
 */
function parseInlineRuns(text: string): TextRun[] {
  // Strip escape chars from Google Docs export
  text = text.replace(/\\([#\-_*`\[\](){}|>~])/g, '$1')

  const runs: TextRun[] = []
  // Regex matches: bold+italic, bold, italic, inline code, links, or plain text
  const re = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|[^*`\[]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[2]) {
      runs.push({ text: m[2], bold: true, italic: true })
    } else if (m[3]) {
      runs.push({ text: m[3], bold: true })
    } else if (m[4]) {
      runs.push({ text: m[4], italic: true })
    } else if (m[5]) {
      runs.push({ text: m[5], code: true })
    } else if (m[6] && m[7]) {
      runs.push({ text: m[6], link: m[7] })
    } else if (m[0]) {
      runs.push({ text: m[0] })
    }
  }
  return runs.length ? runs : [{ text }]
}

/**
 * Parse markdown content into structured DocBlocks.
 */
function parseMarkdownBlocks(markdown: string): DocBlock[] {
  // Strip escape chars globally
  const cleaned = markdown.replace(/\\([#\-_*`\[\](){}|>~])/g, '$1')
  const lines = cleaned.split('\n')
  const blocks: DocBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Skip empty lines
    if (!line.trim()) { i++; continue }

    // Fenced code block
    if (line.trim().startsWith('```')) {
      const codeLines: string[] = []
      i++ // skip opening fence
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing fence
      blocks.push({ type: 'code', code: codeLines.join('\n') })
      continue
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        runs: parseInlineRuns(headingMatch[2]),
      })
      i++
      continue
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    // Table (header + separator + rows)
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\|[\s\-:|]+\|/.test(lines[i + 1])) {
      const headerCells = line.split('|').filter(c => c.trim()).map(c => c.trim())
      i += 2 // skip header + separator
      const rows = [headerCells]
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i].split('|').filter(c => c.trim()).map(c => c.trim()))
        i++
      }
      blocks.push({ type: 'table', rows })
      continue
    }

    // Unordered list (collect consecutive items)
    if (/^[\-\*]\s+/.test(line)) {
      const items: TextRun[][] = []
      while (i < lines.length && /^[\-\*]\s+/.test(lines[i])) {
        items.push(parseInlineRuns(lines[i].replace(/^[\-\*]\s+/, '')))
        i++
      }
      blocks.push({ type: 'ulist', items })
      continue
    }

    // Ordered list (collect consecutive items)
    if (/^\d+\.\s+/.test(line)) {
      const items: TextRun[][] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(parseInlineRuns(lines[i].replace(/^\d+\.\s+/, '')))
        i++
      }
      blocks.push({ type: 'olist', items })
      continue
    }

    // Regular paragraph
    blocks.push({ type: 'paragraph', runs: parseInlineRuns(line) })
    i++
  }

  return blocks
}

/**
 * Build Google Docs API batchUpdate requests from parsed blocks.
 * Returns the requests array for the batchUpdate call.
 */
interface TablePlaceholder {
  placeholder: string
  rows: string[][]
  placeholderStart: number
}

function buildDocsApiRequests(blocks: DocBlock[]): { requests: object[]; tablePlaceholders: TablePlaceholder[] } {
  const requests: object[] = []
  const tablePlaceholders: TablePlaceholder[] = []
  let tableIndex = 0
  let idx = 1 // Docs API body starts at index 1

  function insertText(text: string): number {
    const startIdx = idx
    requests.push({
      insertText: { location: { index: idx }, text }
    })
    idx += text.length
    return startIdx
  }

  function applyTextStyle(startIndex: number, endIndex: number, style: Record<string, unknown>, fields: string) {
    requests.push({
      updateTextStyle: {
        range: { startIndex, endIndex },
        textStyle: style,
        fields,
      }
    })
  }

  function applyParagraphStyle(startIndex: number, endIndex: number, namedStyleType: string) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex, endIndex },
        paragraphStyle: { namedStyleType },
        fields: 'namedStyleType',
      }
    })
  }

  function insertRuns(runs: TextRun[]): void {
    for (const run of runs) {
      const start = idx
      insertText(run.text)
      const end = idx
      if (run.bold) applyTextStyle(start, end, { bold: true }, 'bold')
      if (run.italic) applyTextStyle(start, end, { italic: true }, 'italic')
      if (run.code) {
        applyTextStyle(start, end, {
          weightedFontFamily: { fontFamily: 'Courier New' },
          fontSize: { magnitude: 9, unit: 'PT' },
        }, 'weightedFontFamily,fontSize')
      }
      if (run.link) {
        applyTextStyle(start, end, {
          link: { url: run.link },
        }, 'link')
      }
    }
  }

  const HEADING_STYLES: Record<number, string> = {
    1: 'HEADING_1', 2: 'HEADING_2', 3: 'HEADING_3',
    4: 'HEADING_4', 5: 'HEADING_5', 6: 'HEADING_6',
  }

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const start = idx
        insertRuns(block.runs!)
        insertText('\n')
        const style = HEADING_STYLES[block.level!] || 'HEADING_3'
        applyParagraphStyle(start, idx, style)
        break
      }

      case 'paragraph': {
        insertRuns(block.runs!)
        insertText('\n')
        break
      }

      case 'code': {
        const start = idx
        const codeText = block.code! + '\n'
        insertText(codeText)
        // Apply monospace font to code text only (not the trailing newline)
        applyTextStyle(start, start + codeText.length - 1, {
          weightedFontFamily: { fontFamily: 'Courier New' },
          fontSize: { magnitude: 9, unit: 'PT' },
          foregroundColor: { color: { rgbColor: { red: 0.2, green: 0.2, blue: 0.2 } } },
        }, 'weightedFontFamily,fontSize,foregroundColor')
        // Add an extra newline after code blocks for spacing
        insertText('\n')
        break
      }

      case 'ulist': {
        for (const item of block.items!) {
          const start = idx
          insertRuns(item)
          insertText('\n')
          requests.push({
            createParagraphBullets: {
              range: { startIndex: start, endIndex: idx },
              bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
            }
          })
        }
        break
      }

      case 'olist': {
        for (const item of block.items!) {
          const start = idx
          insertRuns(item)
          insertText('\n')
          requests.push({
            createParagraphBullets: {
              range: { startIndex: start, endIndex: idx },
              bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN',
            }
          })
        }
        break
      }

      case 'table': {
        // Record a placeholder for the table. We'll insert native tables
        // in a second batchUpdate pass after the main content is committed.
        const placeholder = `%%TABLE_${tableIndex}%%`
        tableIndex++
        insertText(placeholder + '\n')
        tablePlaceholders.push({ placeholder, rows: block.rows!, placeholderStart: idx - placeholder.length - 1 })
        break
      }

      case 'hr': {
        // Insert a horizontal line using a series of underscores or em-dashes
        const start = idx
        insertText('————————————————————————————————\n')
        applyTextStyle(start, idx - 1, {
          foregroundColor: { color: { rgbColor: { red: 0.8, green: 0.8, blue: 0.8 } } },
        }, 'foregroundColor')
        break
      }
    }
  }

  return { requests, tablePlaceholders }
}

/**
 * Push khef memory content to a Google Doc using the Docs API batchUpdate.
 * Uses native Docs formatting (headings, lists, tables) instead of HTML.
 * Requires Google Workspace for best results.
 */
export async function pushToGoogleDocWorkspace(docId: string, content: string, title?: string): Promise<PushToDocResult> {
  // Get document metadata
  const metadataRes = await driveApiFetch(
    `${GOOGLE_DRIVE_API_URL}/files/${docId}?fields=id,name,webViewLink`
  )
  if (!metadataRes.ok) {
    const body = await metadataRes.text()
    throw driveApiError('Failed to fetch document metadata', metadataRes.status, body)
  }
  const metadata = await metadataRes.json() as { id: string; name: string; webViewLink: string }

  // Get the current document to find content length
  const docRes = await driveApiFetch(`${GOOGLE_DOCS_API_URL}/${docId}`)
  if (!docRes.ok) {
    const body = await docRes.text()
    throw driveApiError('Failed to fetch document structure', docRes.status, body)
  }
  const doc = await docRes.json() as { body: { content: { endIndex: number }[] } }
  const endIndex = doc.body.content[doc.body.content.length - 1]?.endIndex || 1

  // Build requests: first delete all content, then insert new content
  const allRequests: object[] = []

  // Delete existing content (keep the trailing newline at endIndex - 1)
  if (endIndex > 2) {
    allRequests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: endIndex - 1 }
      }
    })
  }

  // Parse markdown and build insert/style requests
  const blocks = parseMarkdownBlocks(content)
  const { requests: insertRequests, tablePlaceholders } = buildDocsApiRequests(blocks)

  // Separate insert requests from style requests so we can inject a reset in between
  const inserts: object[] = []
  const styles: object[] = []
  for (const req of insertRequests) {
    const r = req as Record<string, any>
    if (r.insertText) {
      inserts.push(req)
    } else {
      styles.push(req)
    }
  }

  // 1. Inserts first
  allRequests.push(...inserts)

  // 2. Reset all inserted text to default black/Arial/11pt (clears inherited styles)
  let maxIdx = 1
  for (const req of inserts) {
    const r = req as Record<string, any>
    if (r.insertText?.location?.index != null && r.insertText?.text) {
      const end = r.insertText.location.index + r.insertText.text.length
      if (end > maxIdx) maxIdx = end
    }
  }
  if (maxIdx > 1) {
    allRequests.push({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: maxIdx },
        textStyle: {
          foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
          backgroundColor: {},
          weightedFontFamily: { fontFamily: 'Arial' },
          fontSize: { magnitude: 11, unit: 'PT' },
          bold: false,
          italic: false,
        },
        fields: 'foregroundColor,backgroundColor,weightedFontFamily,fontSize,bold,italic',
      }
    })
  }

  // 3. Then apply specific styles (headings, bold, code, etc.)
  allRequests.push(...styles)

  // Execute first batchUpdate (text content + styles)
  const updateRes = await driveApiFetch(`${GOOGLE_DOCS_API_URL}/${docId}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: allRequests }),
  })

  if (!updateRes.ok) {
    const body = await updateRes.text()
    throw driveApiError('Failed to update Google Doc via batchUpdate', updateRes.status, body)
  }

  // Second pass: replace table placeholders with native tables
  if (tablePlaceholders.length > 0) {
    // Re-read the document to get accurate indices for placeholders
    const freshDocRes = await driveApiFetch(`${GOOGLE_DOCS_API_URL}/${docId}`)
    if (freshDocRes.ok) {
      const freshDoc = await freshDocRes.json() as {
        body: { content: { startIndex: number; endIndex: number; paragraph?: { elements: { startIndex: number; endIndex: number; textRun?: { content: string } }[] } }[] }
      }

      // Find placeholder positions in the document
      const fullText: { text: string; startIndex: number }[] = []
      for (const el of freshDoc.body.content) {
        if (el.paragraph) {
          for (const pe of el.paragraph.elements) {
            if (pe.textRun?.content) {
              fullText.push({ text: pe.textRun.content, startIndex: pe.startIndex })
            }
          }
        }
      }

      // Process tables in reverse order to preserve indices
      for (let ti = tablePlaceholders.length - 1; ti >= 0; ti--) {
        const tp = tablePlaceholders[ti]
        // Find the placeholder text in the document
        let placeholderStart = -1
        let placeholderEnd = -1
        for (const ft of fullText) {
          const pos = ft.text.indexOf(tp.placeholder)
          if (pos >= 0) {
            placeholderStart = ft.startIndex + pos
            placeholderEnd = placeholderStart + tp.placeholder.length + 1 // +1 for the \n
            break
          }
        }

        if (placeholderStart < 0) continue

        const tableRequests: object[] = []
        const numRows = tp.rows.length
        const numCols = tp.rows[0]?.length || 1

        // Delete the placeholder text
        tableRequests.push({
          deleteContentRange: {
            range: { startIndex: placeholderStart, endIndex: placeholderEnd }
          }
        })

        // Insert native table at the placeholder position
        tableRequests.push({
          insertTable: {
            location: { index: placeholderStart },
            rows: numRows,
            columns: numCols,
          }
        })

        // Execute table insertion
        const tableRes = await driveApiFetch(`${GOOGLE_DOCS_API_URL}/${docId}:batchUpdate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: tableRequests }),
        })

        if (!tableRes.ok) continue // Skip failed tables silently

        // Now read the doc again to find cell positions and fill them
        const cellDocRes = await driveApiFetch(`${GOOGLE_DOCS_API_URL}/${docId}`)
        if (!cellDocRes.ok) continue

        const cellDoc = await cellDocRes.json() as {
          body: { content: { startIndex: number; endIndex: number; table?: { tableRows: { tableCells: { content: { startIndex: number }[] }[] }[] } }[] }
        }

        // Find the table we just inserted (look for table elements near placeholderStart)
        for (const el of cellDoc.body.content) {
          if (el.table && el.startIndex >= placeholderStart - 2 && el.startIndex <= placeholderStart + 2) {
            const cellRequests: object[] = []
            const tableRows = el.table.tableRows

            // Fill cells in reverse order to preserve indices
            for (let r = tableRows.length - 1; r >= 0; r--) {
              for (let c = tableRows[r].tableCells.length - 1; c >= 0; c--) {
                const cellText = tp.rows[r]?.[c] || ''
                if (!cellText) continue
                const cellContentStart = tableRows[r].tableCells[c].content[0].startIndex
                cellRequests.push({
                  insertText: { location: { index: cellContentStart }, text: cellText }
                })
                // Set bold for header row, explicitly unbold for data rows
                cellRequests.push({
                  updateTextStyle: {
                    range: { startIndex: cellContentStart, endIndex: cellContentStart + cellText.length },
                    textStyle: {
                      bold: r === 0,
                      weightedFontFamily: { fontFamily: 'Arial' },
                      fontSize: { magnitude: 11, unit: 'PT' },
                    },
                    fields: 'bold,weightedFontFamily,fontSize',
                  }
                })
              }
            }

            if (cellRequests.length > 0) {
              await driveApiFetch(`${GOOGLE_DOCS_API_URL}/${docId}:batchUpdate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requests: cellRequests }),
              })
            }
            break
          }
        }
      }
    }
  }

  // Sync document title if provided and different
  if (title && title !== metadata.name) {
    await driveApiFetch(`${GOOGLE_DRIVE_API_URL}/files/${docId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: title }),
    })
  }

  return {
    docId: metadata.id,
    title: title || metadata.name,
    url: metadata.webViewLink,
  }
}
