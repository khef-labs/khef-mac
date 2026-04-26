/**
 * Google integration routes.
 * Provides access to Google Docs via gcloud CLI authentication.
 */

import { FastifyPluginAsync } from 'fastify'
import { getClient, query } from '../db/client'
import { resolveProject } from './projects'
import { isValidHandle } from '../utils/slugify'
import { sanitizeTags } from '../utils/tags'
import {
  checkGoogleStatus,
  fetchGoogleDoc,
  fetchDocComments,
  findAnchorContext,
  parseGoogleDocId,
  localizeDocImages,
  pushToGoogleDoc,
  pushToGoogleDocWorkspace,
  GoogleComment,
} from '../services/google'

interface ImportBody {
  project_id: string
  handle?: string
  type?: string
  subtype?: string
  tags?: string[]
  includeComments?: boolean
}

const CHUNK_SIZE = 2000

const chunkText = (text: string): string[] => {
  if (text.length <= CHUNK_SIZE) return [text]

  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    chunks.push(text.slice(start, start + CHUNK_SIZE))
    start += CHUNK_SIZE
  }

  return chunks
}

const googleRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/google/status - Check gcloud availability and auth status
  fastify.get('/status', async () => {
    const status = await checkGoogleStatus()
    return status
  })

  // GET /api/google/docs/:docId - Fetch document content
  fastify.get<{
    Params: { docId: string }
    Querystring: { includeComments?: string }
  }>('/docs/:docId', async (request, reply) => {
    const { docId } = request.params
    const includeComments = request.query.includeComments !== 'false'

    // Check Google availability first
    const status = await checkGoogleStatus()
    if (!status.available) {
      return reply.code(503).send({
        error: 'Google integration unavailable',
        reason: status.reason,
      })
    }

    // Parse doc ID from URL if needed
    const parsedId = parseGoogleDocId(docId)
    if (!parsedId) {
      return reply.code(400).send({ error: 'Invalid Google Doc ID or URL' })
    }

    try {
      const doc = await fetchGoogleDoc(parsedId)

      let comments: GoogleComment[] = []
      if (includeComments) {
        comments = await fetchDocComments(parsedId)
      }

      return {
        id: doc.id,
        title: doc.title,
        content: doc.content,
        url: doc.url,
        comments,
      }
    } catch (err: any) {
      return reply.code(502).send({
        error: 'Failed to fetch Google Doc',
        message: err.message,
      })
    }
  })

  // POST /api/google/docs/:docId/import - Import doc as memory
  fastify.post<{
    Params: { docId: string }
    Body: ImportBody
  }>('/docs/:docId/import', async (request, reply) => {
    const { docId } = request.params
    const {
      project_id,
      handle: inputHandle,
      type = 'google-doc',
      subtype,
      tags = [],
      includeComments = true,
    } = request.body

    if (!project_id) {
      return reply.code(400).send({ error: 'project_id is required' })
    }

    // Check Google availability first
    const status = await checkGoogleStatus()
    if (!status.available) {
      return reply.code(503).send({
        error: 'Google integration unavailable',
        reason: status.reason,
      })
    }

    // Parse doc ID from URL if needed
    const parsedId = parseGoogleDocId(docId)
    if (!parsedId) {
      return reply.code(400).send({ error: 'Invalid Google Doc ID or URL' })
    }

    // Resolve project
    const project = await resolveProject(project_id)
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' })
    }

    try {
      // Fetch document content
      const doc = await fetchGoogleDoc(parsedId)

      // Fetch comments if requested (will create as anchored comments, not appended markdown)
      let googleComments: GoogleComment[] = []
      if (includeComments) {
        googleComments = await fetchDocComments(parsedId)
      }

      // Generate handle from title if not provided
      const handle = inputHandle || doc.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50)

      if (!isValidHandle(handle)) {
        return reply.code(400).send({
          error: 'Invalid handle format. Use lowercase letters, numbers and hyphens.',
        })
      }

      // Create memory with external source metadata
      const client = await getClient()

      try {
        await client.query('BEGIN')

        // Get memory_type_id — when subtype is provided, resolve as child of the parent type
        let typeResult: { rows: { id: string }[] }
        if (subtype) {
          typeResult = await client.query<{ id: string }>(
            `SELECT mt.id
             FROM memory_types mt
             INNER JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
             WHERE mt.name = $1 AND mt_parent.name = $2
             LIMIT 1`,
            [subtype, type]
          )
          if (typeResult.rows.length === 0) {
            await client.query('ROLLBACK')
            return reply.code(400).send({ error: `Invalid subtype '${subtype}' under parent type '${type}'` })
          }
        } else {
          typeResult = await client.query<{ id: string }>(
            `SELECT id FROM memory_types WHERE name = $1 LIMIT 1`,
            [type]
          )
          if (typeResult.rows.length === 0) {
            await client.query('ROLLBACK')
            return reply.code(400).send({ error: `Invalid memory type: ${type}` })
          }
        }

        const memoryTypeId = typeResult.rows[0].id

        // Get default status for this memory type
        let defaultStatusResult = await client.query<{ id: string; status_value: string }>(
          'SELECT id, status_value FROM memory_type_statuses WHERE memory_type_id = $1 AND sort_order = 0 LIMIT 1',
          [memoryTypeId]
        )
        if (defaultStatusResult.rows.length === 0) {
          defaultStatusResult = await client.query<{ id: string; status_value: string }>(
            `SELECT mts.id, mts.status_value FROM memory_type_statuses mts
             INNER JOIN memory_types mt ON mt.parent_id = mts.memory_type_id
             WHERE mt.id = $1
             ORDER BY mts.sort_order LIMIT 1`,
            [memoryTypeId]
          )
        }
        const defaultStatusId = defaultStatusResult.rows.length > 0 ? defaultStatusResult.rows[0].id : null

        // Check for handle uniqueness within project
        const handleCheck = await client.query(
          'SELECT id FROM memories WHERE project_id = $1 AND handle = $2',
          [project.id, handle]
        )
        if (handleCheck.rows.length > 0) {
          await client.query('ROLLBACK')
          return reply.code(409).send({
            error: 'A memory with this handle already exists in this project',
            handle,
          })
        }

        // Check for title uniqueness within project
        const titleCheck = await client.query(
          'SELECT id FROM memories WHERE project_id = $1 AND title = $2',
          [project.id, doc.title]
        )
        if (titleCheck.rows.length > 0) {
          await client.query('ROLLBACK')
          return reply.code(409).send({
            error: 'A memory with this title already exists in this project',
          })
        }

        // Create the memory with original content
        const memoryResult = await client.query<{ id: string; created_at: string; updated_at: string }>(
          `INSERT INTO memories (project_id, handle, title, content, memory_type_id, status_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, created_at, updated_at`,
          [project.id, handle, doc.title, doc.content, memoryTypeId, defaultStatusId]
        )
        const memory = memoryResult.rows[0]

        // Chunk content
        const chunks = chunkText(doc.content)
        if (chunks.length > 1) {
          for (let i = 0; i < chunks.length; i++) {
            await client.query(
              'INSERT INTO memory_chunks (memory_id, chunk_index, content) VALUES ($1, $2, $3)',
              [memory.id, i, chunks[i]]
            )
          }
        }

        // Add tags
        const validTags = sanitizeTags(tags)
        for (const tagName of validTags) {
          let tagResult = await client.query<{ id: string }>(
            'SELECT id FROM tags WHERE name = $1',
            [tagName]
          )
          if (tagResult.rows.length === 0) {
            tagResult = await client.query<{ id: string }>(
              'INSERT INTO tags (name) VALUES ($1) RETURNING id',
              [tagName]
            )
          }
          await client.query(
            'INSERT INTO memory_tags (memory_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [memory.id, tagResult.rows[0].id]
          )
        }

        // Set external source metadata
        const metadataFields = [
          { field: 'external-source-type', value: 'google-doc' },
          { field: 'external-source-id', value: parsedId },
          { field: 'external-source-url', value: doc.url },
          { field: 'external-source-last-synced-at', value: new Date().toISOString() },
        ]

        for (const { field, value } of metadataFields) {
          // Get metadata field ID
          const metaResult = await client.query<{ id: string }>(
            "SELECT id FROM metadata WHERE entity_type = 'memory' AND field = $1",
            [field]
          )
          if (metaResult.rows.length > 0) {
            await client.query(
              `INSERT INTO memory_metadata (memory_id, metadata_id, value)
               VALUES ($1, $2, $3)
               ON CONFLICT (memory_id, metadata_id) DO UPDATE SET value = $3, updated_at = NOW()`,
              [memory.id, metaResult.rows[0].id, value]
            )
          }
        }

        // Create anchored comments from Google Doc comments
        for (const gComment of googleComments) {
          // Find anchor context if the comment has quoted text
          let anchorText: string | null = null
          let anchorPrefix: string | null = null
          let anchorSuffix: string | null = null

          if (gComment.quotedText) {
            const context = findAnchorContext(doc.content, gComment.quotedText)
            if (context.found) {
              anchorText = gComment.quotedText
              anchorPrefix = context.anchorPrefix
              anchorSuffix = context.anchorSuffix
            }
          }

          // Format author with date (truncate to 50 chars for DB constraint)
          const formatAuthor = (name: string, date?: string) => {
            const formatted = date
              ? `${name} (${new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})`
              : name
            return formatted.slice(0, 50)
          }

          const authorWithDate = formatAuthor(gComment.author, gComment.createdTime)

          // Create the parent comment
          const parentResult = await client.query(
            `INSERT INTO comments (entity_type, entity_id, content, anchor_text, anchor_prefix, anchor_suffix, author, status)
             VALUES ('memory', $1, $2, $3, $4, $5, $6, $7)
             RETURNING id`,
            [
              memory.id,
              gComment.content,
              anchorText,
              anchorPrefix,
              anchorSuffix,
              authorWithDate,
              gComment.resolved ? 'resolved' : 'active',
            ]
          )

          // Create threaded replies as child comments
          const parentCommentId = parentResult.rows[0].id
          for (const reply of gComment.replies) {
            const replyAuthor = formatAuthor(reply.author, reply.createdTime)
            await client.query(
              `INSERT INTO comments (entity_type, entity_id, content, author, parent_comment_id)
               VALUES ('memory', $1, $2, $3, $4)`,
              [memory.id, reply.content, replyAuthor, parentCommentId]
            )
          }
        }

        await client.query('COMMIT')
        client.release()

        // After commit: localize base64 images from Google Doc export.
        // This runs outside the transaction since it writes files to disk
        // and inserts file records independently.
        let imagesLocalized = 0
        try {
          const localizedContent = await localizeDocImages(doc.content, project.id, memory.id, project.handle, parsedId)
          if (localizedContent !== doc.content) {
            // Update memory with localized content and re-chunk
            await query(
              'UPDATE memories SET content = $1, updated_at = NOW() WHERE id = $2',
              [localizedContent, memory.id]
            )
            await query('DELETE FROM memory_chunks WHERE memory_id = $1', [memory.id])
            const localizedChunks = chunkText(localizedContent)
            if (localizedChunks.length > 1) {
              for (let i = 0; i < localizedChunks.length; i++) {
                await query(
                  'INSERT INTO memory_chunks (memory_id, chunk_index, content) VALUES ($1, $2, $3)',
                  [memory.id, i, localizedChunks[i]]
                )
              }
            }
            imagesLocalized = localizedChunks.length // approximate
          }
        } catch {
          // Image localization is best-effort; original content remains
        }

        // Resolve the effective type name and parent for the response
        const effectiveType = subtype || type
        const parentType = subtype ? type : undefined

        return {
          memory: {
            id: memory.id,
            handle,
            title: doc.title,
            type: effectiveType,
            ...(parentType ? { parent_type: parentType } : {}),
            project_id: project.id,
            created_at: memory.created_at,
            updated_at: memory.updated_at,
            external_source: {
              type: 'google-doc',
              id: parsedId,
              url: doc.url,
              last_synced_at: new Date().toISOString(),
            },
            comments_imported: googleComments.length,
            images_localized: imagesLocalized,
          },
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        try { client.release() } catch { /* already released after commit */ }
      }
    } catch (err: any) {
      if (err.message?.includes('Failed to fetch') || err.message?.includes('Failed to export')) {
        return reply.code(502).send({
          error: 'Failed to fetch Google Doc',
          message: err.message,
        })
      }
      throw err
    }
  })
  // POST /api/google/docs/:docId/push - Push khef memory content back to linked Google Doc
  fastify.post<{
    Params: { docId: string }
    Body: { memory_id: string; mode?: 'html' | 'workspace' }
  }>('/docs/:docId/push', async (request, reply) => {
    const { docId } = request.params
    const { memory_id, mode } = request.body

    if (!memory_id) {
      return reply.code(400).send({ error: 'memory_id is required' })
    }

    // Check Google availability
    const status = await checkGoogleStatus()
    if (!status.available) {
      return reply.code(503).send({
        error: 'Google integration unavailable',
        reason: status.reason,
      })
    }

    // Parse doc ID from URL if needed
    const parsedId = parseGoogleDocId(docId)
    if (!parsedId) {
      return reply.code(400).send({ error: 'Invalid Google Doc ID or URL' })
    }

    // Fetch the memory content
    const memoryRows = await query<{ id: string; content: string; title: string }>(
      'SELECT id, content, title FROM memories WHERE id = $1',
      [memory_id]
    )

    if (memoryRows.length === 0) {
      return reply.code(404).send({ error: 'Memory not found' })
    }

    const memory = memoryRows[0]

    try {
      // Determine push mode: explicit param, setting, or default to html
      let pushMode = mode
      if (!pushMode) {
        const settingRows = await query<{ value: string }>(
          "SELECT value FROM settings WHERE key = 'google.workspace'"
        )
        pushMode = settingRows.length > 0 && settingRows[0].value === 'true' ? 'workspace' : 'html'
      }

      const result = pushMode === 'workspace'
        ? await pushToGoogleDocWorkspace(parsedId, memory.content, memory.title)
        : await pushToGoogleDoc(parsedId, memory.content, memory.title)

      // Update last synced timestamp
      const syncedAt = new Date().toISOString()
      const metaResult = await query<{ id: string }>(
        "SELECT id FROM metadata WHERE entity_type = 'memory' AND field = 'external-source-last-synced-at'"
      )
      if (metaResult.length > 0) {
        await query(
          `INSERT INTO memory_metadata (memory_id, metadata_id, value)
           VALUES ($1, $2, $3)
           ON CONFLICT (memory_id, metadata_id) DO UPDATE SET value = $3, updated_at = NOW()`,
          [memory_id, metaResult[0].id, syncedAt]
        )
      }

      return {
        success: true,
        doc: result,
        synced_at: syncedAt,
      }
    } catch (err: any) {
      if (err.message?.includes('Failed to')) {
        return reply.code(502).send({
          error: 'Failed to push to Google Doc',
          message: err.message,
        })
      }
      throw err
    }
  })
}

export default googleRoutes
