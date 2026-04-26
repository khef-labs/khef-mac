import { FastifyPluginAsync } from 'fastify'
import {
  renderDiagram,
  DiagramType,
  DiagramTheme,
  DiagramRenderError,
  isKrokiAvailable,
  scaleSvgToMaxWidth,
} from '../services/diagram'
import { query } from '../db/client'

interface PreviewBody {
  type: DiagramType
  content: string
  theme?: DiagramTheme
  maxWidth?: number
}

const diagramRoutes: FastifyPluginAsync = async (fastify) => {
  // Health check for diagram rendering service
  fastify.get('/health', async (request, reply) => {
    const available = await isKrokiAvailable()
    if (!available) {
      return reply.code(503).send({
        status: 'unavailable',
        message: 'Kroki diagram service is not available',
      })
    }
    return { status: 'ok' }
  })

  // Preview endpoint - renders diagram without storing
  fastify.post<{ Body: PreviewBody }>('/preview', async (request, reply) => {
    const { type, content, theme: requestTheme, maxWidth } = request.body

    if (!type || !content) {
      return reply.code(400).send({
        error: 'Missing required fields: type and content',
      })
    }

    const validTypes: DiagramType[] = ['mermaid', 'd2', 'plantuml', 'graphviz']
    if (!validTypes.includes(type)) {
      return reply.code(400).send({
        error: `Invalid diagram type. Must be one of: ${validTypes.join(', ')}`,
      })
    }

    const validThemes: DiagramTheme[] = ['dark', 'light', 'neutral', 'forest', 'ocean']

    // Use request theme, or fall back to user setting, or default to 'dark'
    let theme: DiagramTheme = 'dark'
    if (requestTheme) {
      if (!validThemes.includes(requestTheme)) {
        return reply.code(400).send({
          error: `Invalid theme. Must be one of: ${validThemes.join(', ')}`,
        })
      }
      theme = requestTheme
    } else {
      // Fetch default from settings
      const rows = await query<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'export.imageTheme'"
      )
      if (rows.length > 0 && rows[0].value && validThemes.includes(rows[0].value as DiagramTheme)) {
        theme = rows[0].value as DiagramTheme
      }
    }

    if (maxWidth !== undefined && (typeof maxWidth !== 'number' || maxWidth <= 0)) {
      return reply.code(400).send({
        error: 'maxWidth must be a positive number',
      })
    }

    try {
      let svg = await renderDiagram(type, content, theme)

      // Scale SVG if maxWidth is specified
      if (maxWidth) {
        svg = scaleSvgToMaxWidth(svg, maxWidth)
      }

      return { svg }
    } catch (err) {
      if (err instanceof DiagramRenderError) {
        return reply.code(422).send({
          error: err.message,
        })
      }
      throw err
    }
  })
}

export default diagramRoutes
