/**
 * Diagram rendering service using Kroki
 *
 * For PNG output, we use Kroki's native PNG endpoint which renders via Puppeteer.
 * This properly handles mermaid's foreignObject text elements.
 * Note: Kroki's PNG endpoint doesn't support scaling - diagrams render at natural size.
 */

import { logger } from '../lib/logger';

const log = logger.child({ component: 'diagram' });

const KROKI_PORT = process.env.KROKI_PORT || '8101'
const KROKI_URL = process.env.KROKI_URL || `http://localhost:${KROKI_PORT}`

export type DiagramType = 'mermaid' | 'd2' | 'plantuml' | 'graphviz'

export class DiagramRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiagramRenderError'
  }
}

type DiagramRenderOptions = {
  disableHtmlLabels?: boolean
}

export function normalizeMermaidForNoHtmlLabels(content: string): string {
  return content
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\\n/g, ' ')
}

function buildMermaidOptionsHeaders(options?: DiagramRenderOptions): Record<string, string> {
  if (!options?.disableHtmlLabels) {
    return {}
  }

  return {
    // Force Word-safe SVG by disabling foreignObject-based HTML labels.
    'Kroki-Diagram-Options-Flowchart_Html-Labels': 'false',
    'Kroki-Diagram-Options-Class_Html-Labels': 'false',
    'Kroki-Diagram-Options-Sequence_Html-Labels': 'false',
    'Kroki-Diagram-Options-State_Html-Labels': 'false',
  }
}

function buildMermaidDiagramOptions(options?: DiagramRenderOptions): Record<string, string> | null {
  if (!options?.disableHtmlLabels) {
    return null
  }

  return {
    'html-labels': 'false',
    'flowchart_html-labels': 'false',
    'class_html-labels': 'false',
    'sequence_html-labels': 'false',
    'state_html-labels': 'false',
  }
}

export function inlineSvgStylesForWord(svg: string): string {
  const styleMatch = svg.match(/<style[^>]*>([\s\S]*?)<\/style>/i)
  if (!styleMatch) {
    return svg
  }

  const styleBlock = styleMatch[1]
  const relationMatch = styleBlock.match(/\.relation\{[^}]*\bstroke:([^;]+);[^}]*\bstroke-width:([^;]+);[^}]*\bfill:([^;]+);/i)
  const markerMatch = styleBlock.match(/\.marker\{[^}]*\bfill:([^;]+);[^}]*\bstroke:([^;]+);/i)

  const relationStroke = relationMatch?.[1]?.trim() ?? '#94a3b8'
  const relationWidth = relationMatch?.[2]?.trim() ?? '1'
  const relationFill = relationMatch?.[3]?.trim() ?? 'none'
  const markerFill = markerMatch?.[1]?.trim() ?? relationStroke
  const markerStroke = markerMatch?.[2]?.trim() ?? relationStroke

  const withEdgeStrokes = svg.replace(
    /<path([^>]*class="[^"]*relation[^"]*"[^>]*)>/gi,
    (match, attrs) => {
      if (/\bstroke=/.test(attrs)) {
        return match
      }
      return `<path${attrs} stroke="${relationStroke}" stroke-width="${relationWidth}" fill="${relationFill}">`
    }
  )

  return withEdgeStrokes.replace(
    /<marker\b[^>]*>[\s\S]*?<\/marker>/gi,
    (markerBlock) =>
      markerBlock.replace(/<(path|circle)\b([^>]*?)>/gi, (match, tag, attrs) => {
        let updated = attrs
        if (!/\bfill=/.test(updated)) {
          updated += ` fill="${markerFill}"`
        }
        if (!/\bstroke=/.test(updated)) {
          updated += ` stroke="${markerStroke}"`
        }
        return `<${tag}${updated}>`
      })
  )
}

export function sanitizeSvgForRasterization(svg: string): string {
  let sanitized = svg

  if (!/xmlns=/.test(sanitized)) {
    sanitized = sanitized.replace(
      '<svg',
      '<svg xmlns="http://www.w3.org/2000/svg"'
    )
  }

  sanitized = sanitized
    // Remove font-face blocks that reference external fonts
    .replace(/@font-face\s*{[\s\S]*?}/gi, '')
    // Remove external font URLs in style blocks
    .replace(/url\((['"]?)(https?:)?\/\/[^)]+\1\)/gi, '')
    // Normalize font-family in styles
    .replace(/font-family:\s*[^;"}]+;?/gi, 'font-family: system-ui, -apple-system, sans-serif;')
    // Normalize font-family attributes
    .replace(/font-family="[^"]*"/gi, 'font-family="system-ui, -apple-system, sans-serif"')

  return sanitized
}

export async function renderSvgToPngWithPlaywright(
  svg: string,
  options: { scale: number; background?: string; timeoutMs?: number }
): Promise<Buffer> {
  const { logDebug } = await import('../utils/debug-log');
  logDebug(`Playwright PNG render start: scale=${options.scale} background=${options.background ?? '#161b22'}`);
  const sanitized = sanitizeSvgForRasterization(svg)
  const dimensions = parseSvgDimensions(sanitized)
  if (!dimensions) {
    logDebug('Playwright PNG render failed: unable to parse SVG dimensions');
    throw new Error('Unable to determine SVG dimensions for rasterization')
  }

  const width = Math.max(1, Math.round(dimensions.width))
  const height = Math.max(1, Math.round(dimensions.height))
  const scale = Math.max(1, Math.round(options.scale || 1))
  const renderWidth = Math.max(1, Math.round(width * scale))
  const renderHeight = Math.max(1, Math.round(height * scale))
  const background = options.background ?? '#161b22'
  const timeoutMs = options.timeoutMs ?? 10000

  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(sanitized).toString('base64')}`

  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch (error) {
    log.warn({ err: error }, 'Playwright not installed or failed to load, falling back to Kroki PNG')
    logDebug(`Playwright PNG render failed: playwright import error: ${String(error)}`);
    throw error
  }

  const envExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  let browser
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      ...(envExecutablePath ? { executablePath: envExecutablePath } : {}),
    })
  } catch (error) {
    const fallbackExecutable = envExecutablePath || findArm64ChromiumExecutable()
    if (fallbackExecutable) {
      logDebug(`Playwright PNG render retry with executablePath=${fallbackExecutable}`);
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: fallbackExecutable,
      })
    } else {
      log.warn({ err: error }, 'Playwright Chromium not available, falling back to Kroki PNG')
      logDebug(`Playwright PNG render failed: chromium launch error: ${String(error)}`);
      throw error
    }
  }

  try {
    const page = await browser.newPage({
      viewport: { width: renderWidth, height: renderHeight },
      deviceScaleFactor: 1,
    })

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; padding: 0; background: ${background}; }
      #root { width: ${renderWidth}px; height: ${renderHeight}px; }
      img { width: ${renderWidth}px; height: ${renderHeight}px; display: block; }
    </style>
  </head>
  <body>
    <div id="root"><img src="${svgDataUrl}" /></div>
  </body>
</html>`

    await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs })
    await page.waitForFunction(
      `(() => { const img = document.querySelector('img'); return !!img && img.complete; })()`,
      { timeout: timeoutMs }
    )

    const buffer = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: renderWidth, height: renderHeight },
    })
    logDebug(`Playwright PNG render success: pngBytes=${buffer.length} width=${width} height=${height} scale=${scale} renderWidth=${renderWidth} renderHeight=${renderHeight}`);
    return buffer as Buffer
  } finally {
    await browser.close()
  }
}

function findArm64ChromiumExecutable(): string | null {
  try {
    const os = require('os')
    const fs = require('fs')
    const path = require('path')
    const baseDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    if (!fs.existsSync(baseDir)) {
      return null
    }

    const candidates = fs
      .readdirSync(baseDir)
      .filter((name: string) => name.startsWith('chromium_headless_shell-') || name.startsWith('chromium-'))
      .sort()
      .reverse()

    for (const dir of candidates) {
      const headlessPath = path.join(baseDir, dir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
      if (fs.existsSync(headlessPath)) {
        return headlessPath
      }
      const chromePath = path.join(
        baseDir,
        dir,
        'chrome-mac-arm64',
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing'
      )
      if (fs.existsSync(chromePath)) {
        return chromePath
      }
    }
  } catch {
    return null
  }

  return null
}

export function getPlaywrightExecutablePath(): string | null {
  const envPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  if (envPath && envPath.trim().length > 0) {
    return envPath
  }

  const fallback = findArm64ChromiumExecutable()
  if (fallback) {
    return fallback
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const playwright = require('playwright')
    const chromiumPath = playwright?.chromium?.executablePath?.()
    if (chromiumPath) {
      return chromiumPath
    }
  } catch {
    return null
  }

  return null
}

export function isPlaywrightAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('playwright')
  } catch {
    return false
  }

  try {
    const fs = require('fs')
    const executable = getPlaywrightExecutablePath()
    if (!executable) {
      return false
    }
    return fs.existsSync(executable)
  } catch {
    return false
  }
}

async function renderDiagramViaKrokiJson(options: {
  type: DiagramType
  outputFormat: 'svg' | 'png'
  content: string
  theme: DiagramTheme
  renderOptions?: DiagramRenderOptions
}): Promise<Response> {
  const diagramOptions = options.type === 'mermaid'
    ? buildMermaidDiagramOptions(options.renderOptions)
    : null
  const diagramSource = options.type === 'mermaid'
    ? prepareMermaidContent(options.content, options.theme)
    : options.content

  return fetch(KROKI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      diagram_type: options.type,
      output_format: options.outputFormat,
      diagram_source: diagramSource,
      ...(diagramOptions ? { diagram_options: diagramOptions } : {}),
    }),
  })
}

/**
 * Sanitize SVG to prevent XSS attacks
 * Defense-in-depth since browsers block scripts in innerHTML-injected SVG
 */
function sanitizeSvg(svg: string): string {
  return svg
    // Remove script tags and their contents
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // Remove event handlers (onclick, onload, onerror, etc.)
    .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\s+on\w+\s*=\s*[^\s>]+/gi, '')
    // Remove javascript: URLs in href/xlink:href
    .replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"')
    .replace(/xlink:href\s*=\s*["']javascript:[^"']*["']/gi, 'xlink:href="#"')
    // Remove data: URLs that could contain scripts (but allow data:image)
    .replace(/href\s*=\s*["']data:(?!image)[^"']*["']/gi, 'href="#"')
    // Remove foreignObject javascript execution vectors
    .replace(/<foreignObject[\s\S]*?<script[\s\S]*?<\/foreignObject>/gi, '')
}

export type DiagramTheme = 'dark' | 'light' | 'neutral' | 'forest' | 'ocean'

const DARK_THEME_CONFIG = `%%{init: {
  'theme': 'dark',
  'themeVariables': {
    'primaryColor': '#6366f1',
    'primaryTextColor': '#f1f5f9',
    'primaryBorderColor': '#818cf8',
    'lineColor': '#94a3b8',
    'secondaryColor': '#4f46e5',
    'tertiaryColor': '#1e1b4b',
    'textColor': '#f1f5f9',
    'mainBkg': '#1e1b4b',
    'nodeBorder': '#818cf8',
    'clusterBkg': '#312e81',
    'titleColor': '#f1f5f9',
    'edgeLabelBackground': '#1e1b4b',
    'actorTextColor': '#f1f5f9',
    'actorLineColor': '#818cf8',
    'signalColor': '#f1f5f9',
    'signalTextColor': '#f1f5f9',
    'labelBoxBkgColor': '#1e1b4b',
    'labelBoxBorderColor': '#818cf8',
    'labelTextColor': '#f1f5f9',
    'loopTextColor': '#f1f5f9',
    'noteBkgColor': '#312e81',
    'noteTextColor': '#f1f5f9',
    'noteBorderColor': '#818cf8',
    'activationBkgColor': '#4f46e5',
    'sequenceNumberColor': '#f1f5f9',
    'sectionBkgColor': '#1e293b',
    'altSectionBkgColor': '#162032',
    'gridColor': '#334155',
    'todayLineColor': '#ef4444',
    'taskBkgColor': '#6366f1',
    'taskBorderColor': '#818cf8',
    'taskTextColor': '#f1f5f9',
    'taskTextOutsideColor': '#cbd5e1',
    'taskTextDarkColor': '#f1f5f9',
    'taskTextLightColor': '#f1f5f9',
    'doneTaskBkgColor': '#475569',
    'doneTaskBorderColor': '#64748b',
    'activeTaskBkgColor': '#818cf8',
    'activeTaskBorderColor': '#a5b4fc',
    'critBkgColor': '#ef4444',
    'critBorderColor': '#f87171'
  },
  'class': {'useMaxWidth': false},
  'flowchart': {'useMaxWidth': false},
  'sequence': {'useMaxWidth': false},
  'gantt': {'useMaxWidth': false, 'barHeight': 28, 'barGap': 6, 'fontSize': 13, 'leftPadding': 130}
}}%%`

const LIGHT_THEME_CONFIG = `%%{init: {
  'theme': 'base',
  'themeVariables': {
    'primaryColor': '#e0e7ff',
    'primaryTextColor': '#1e1b4b',
    'primaryBorderColor': '#6366f1',
    'lineColor': '#64748b',
    'secondaryColor': '#c7d2fe',
    'tertiaryColor': '#f1f5f9',
    'textColor': '#1e293b',
    'mainBkg': '#ffffff',
    'nodeBorder': '#6366f1',
    'clusterBkg': '#f8fafc',
    'clusterBorder': '#cbd5e1',
    'titleColor': '#1e293b',
    'edgeLabelBackground': '#ffffff',
    'actorTextColor': '#1e293b',
    'actorLineColor': '#6366f1',
    'actorBkg': '#e0e7ff',
    'signalColor': '#1e293b',
    'signalTextColor': '#1e293b',
    'labelBoxBkgColor': '#f8fafc',
    'labelBoxBorderColor': '#6366f1',
    'labelTextColor': '#1e293b',
    'loopTextColor': '#1e293b',
    'noteBkgColor': '#fef3c7',
    'noteTextColor': '#1e293b',
    'noteBorderColor': '#f59e0b',
    'activationBkgColor': '#c7d2fe',
    'sequenceNumberColor': '#1e293b',
    'background': '#ffffff',
    'sectionBkgColor': '#f8fafc',
    'altSectionBkgColor': '#f1f5f9',
    'gridColor': '#e2e8f0',
    'todayLineColor': '#ef4444',
    'taskBkgColor': '#6366f1',
    'taskBorderColor': '#4f46e5',
    'taskTextColor': '#ffffff',
    'taskTextOutsideColor': '#334155',
    'taskTextDarkColor': '#1e293b',
    'taskTextLightColor': '#ffffff',
    'doneTaskBkgColor': '#94a3b8',
    'doneTaskBorderColor': '#64748b',
    'activeTaskBkgColor': '#3b82f6',
    'activeTaskBorderColor': '#2563eb',
    'critBkgColor': '#ef4444',
    'critBorderColor': '#dc2626'
  },
  'class': {'useMaxWidth': false},
  'flowchart': {'useMaxWidth': false},
  'sequence': {'useMaxWidth': false},
  'gantt': {'useMaxWidth': false, 'barHeight': 28, 'barGap': 6, 'fontSize': 13, 'leftPadding': 130}
}}%%`

// Neutral - clean grayscale, professional
const NEUTRAL_THEME_CONFIG = `%%{init: {
  'theme': 'base',
  'themeVariables': {
    'primaryColor': '#e5e7eb',
    'primaryTextColor': '#111827',
    'primaryBorderColor': '#6b7280',
    'lineColor': '#9ca3af',
    'secondaryColor': '#d1d5db',
    'tertiaryColor': '#f3f4f6',
    'textColor': '#1f2937',
    'mainBkg': '#ffffff',
    'nodeBorder': '#6b7280',
    'clusterBkg': '#f9fafb',
    'clusterBorder': '#d1d5db',
    'titleColor': '#111827',
    'edgeLabelBackground': '#ffffff',
    'actorTextColor': '#1f2937',
    'actorLineColor': '#6b7280',
    'actorBkg': '#e5e7eb',
    'signalColor': '#1f2937',
    'signalTextColor': '#1f2937',
    'labelBoxBkgColor': '#f9fafb',
    'labelBoxBorderColor': '#6b7280',
    'labelTextColor': '#1f2937',
    'loopTextColor': '#1f2937',
    'noteBkgColor': '#fef9c3',
    'noteTextColor': '#1f2937',
    'noteBorderColor': '#ca8a04',
    'activationBkgColor': '#d1d5db',
    'sequenceNumberColor': '#1f2937',
    'background': '#ffffff',
    'sectionBkgColor': '#f9fafb',
    'altSectionBkgColor': '#f3f4f6',
    'gridColor': '#e5e7eb',
    'todayLineColor': '#ef4444',
    'taskBkgColor': '#6b7280',
    'taskBorderColor': '#4b5563',
    'taskTextColor': '#ffffff',
    'taskTextOutsideColor': '#374151',
    'taskTextDarkColor': '#111827',
    'taskTextLightColor': '#ffffff',
    'doneTaskBkgColor': '#d1d5db',
    'doneTaskBorderColor': '#9ca3af',
    'activeTaskBkgColor': '#4b5563',
    'activeTaskBorderColor': '#374151',
    'critBkgColor': '#ef4444',
    'critBorderColor': '#dc2626'
  },
  'class': {'useMaxWidth': false},
  'flowchart': {'useMaxWidth': false},
  'sequence': {'useMaxWidth': false},
  'gantt': {'useMaxWidth': false, 'barHeight': 28, 'barGap': 6, 'fontSize': 13, 'leftPadding': 130}
}}%%`

// Forest - earthy greens
const FOREST_THEME_CONFIG = `%%{init: {
  'theme': 'base',
  'themeVariables': {
    'primaryColor': '#dcfce7',
    'primaryTextColor': '#14532d',
    'primaryBorderColor': '#16a34a',
    'lineColor': '#6b7280',
    'secondaryColor': '#bbf7d0',
    'tertiaryColor': '#f0fdf4',
    'textColor': '#166534',
    'mainBkg': '#ffffff',
    'nodeBorder': '#16a34a',
    'clusterBkg': '#f0fdf4',
    'clusterBorder': '#86efac',
    'titleColor': '#14532d',
    'edgeLabelBackground': '#ffffff',
    'actorTextColor': '#166534',
    'actorLineColor': '#16a34a',
    'actorBkg': '#dcfce7',
    'signalColor': '#166534',
    'signalTextColor': '#166534',
    'labelBoxBkgColor': '#f0fdf4',
    'labelBoxBorderColor': '#16a34a',
    'labelTextColor': '#166534',
    'loopTextColor': '#166534',
    'noteBkgColor': '#fef3c7',
    'noteTextColor': '#166534',
    'noteBorderColor': '#d97706',
    'activationBkgColor': '#bbf7d0',
    'sequenceNumberColor': '#166534',
    'background': '#ffffff',
    'sectionBkgColor': '#f0fdf4',
    'altSectionBkgColor': '#ecfdf5',
    'gridColor': '#d1fae5',
    'todayLineColor': '#ef4444',
    'taskBkgColor': '#16a34a',
    'taskBorderColor': '#15803d',
    'taskTextColor': '#ffffff',
    'taskTextOutsideColor': '#166534',
    'taskTextDarkColor': '#14532d',
    'taskTextLightColor': '#ffffff',
    'doneTaskBkgColor': '#86efac',
    'doneTaskBorderColor': '#4ade80',
    'activeTaskBkgColor': '#22c55e',
    'activeTaskBorderColor': '#16a34a',
    'critBkgColor': '#ef4444',
    'critBorderColor': '#dc2626'
  },
  'class': {'useMaxWidth': false},
  'flowchart': {'useMaxWidth': false},
  'sequence': {'useMaxWidth': false},
  'gantt': {'useMaxWidth': false, 'barHeight': 28, 'barGap': 6, 'fontSize': 13, 'leftPadding': 130}
}}%%`

// Ocean - cool blues and teals
const OCEAN_THEME_CONFIG = `%%{init: {
  'theme': 'base',
  'themeVariables': {
    'primaryColor': '#cffafe',
    'primaryTextColor': '#164e63',
    'primaryBorderColor': '#0891b2',
    'lineColor': '#64748b',
    'secondaryColor': '#a5f3fc',
    'tertiaryColor': '#ecfeff',
    'textColor': '#155e75',
    'mainBkg': '#ffffff',
    'nodeBorder': '#0891b2',
    'clusterBkg': '#ecfeff',
    'clusterBorder': '#67e8f9',
    'titleColor': '#164e63',
    'edgeLabelBackground': '#ffffff',
    'actorTextColor': '#155e75',
    'actorLineColor': '#0891b2',
    'actorBkg': '#cffafe',
    'signalColor': '#155e75',
    'signalTextColor': '#155e75',
    'labelBoxBkgColor': '#ecfeff',
    'labelBoxBorderColor': '#0891b2',
    'labelTextColor': '#155e75',
    'loopTextColor': '#155e75',
    'noteBkgColor': '#fef3c7',
    'noteTextColor': '#155e75',
    'noteBorderColor': '#d97706',
    'activationBkgColor': '#a5f3fc',
    'sequenceNumberColor': '#155e75',
    'background': '#ffffff',
    'sectionBkgColor': '#ecfeff',
    'altSectionBkgColor': '#f0f9ff',
    'gridColor': '#bae6fd',
    'todayLineColor': '#ef4444',
    'taskBkgColor': '#0891b2',
    'taskBorderColor': '#0e7490',
    'taskTextColor': '#ffffff',
    'taskTextOutsideColor': '#155e75',
    'taskTextDarkColor': '#164e63',
    'taskTextLightColor': '#ffffff',
    'doneTaskBkgColor': '#67e8f9',
    'doneTaskBorderColor': '#22d3ee',
    'activeTaskBkgColor': '#06b6d4',
    'activeTaskBorderColor': '#0891b2',
    'critBkgColor': '#ef4444',
    'critBorderColor': '#dc2626'
  },
  'class': {'useMaxWidth': false},
  'flowchart': {'useMaxWidth': false},
  'sequence': {'useMaxWidth': false},
  'gantt': {'useMaxWidth': false, 'barHeight': 28, 'barGap': 6, 'fontSize': 13, 'leftPadding': 130}
}}%%`

const THEME_CONFIGS: Record<DiagramTheme, string> = {
  dark: DARK_THEME_CONFIG,
  light: LIGHT_THEME_CONFIG,
  neutral: NEUTRAL_THEME_CONFIG,
  forest: FOREST_THEME_CONFIG,
  ocean: OCEAN_THEME_CONFIG,
}

/**
 * Gantt section2 colors by theme.
 * Mermaid derives .section2 from secondaryColor via internal algorithm,
 * which often produces jarring results (e.g. light beige on dark background).
 * We post-process the SVG to override section2 with a consistent shade.
 */
const GANTT_SECTION2_OVERRIDES: Record<DiagramTheme, string> = {
  dark: '#1a2332',     // slightly blue-shifted dark slate
  light: '#f0f4ff',    // subtle indigo tint
  neutral: '#f5f5f4',  // warm gray
  forest: '#ecfdf5',   // mint tint
  ocean: '#eff6ff',    // light blue tint
}

/**
 * Prepend mermaid configuration directives if not already present
 */
/**
 * Mermaid diagram types that don't support %%{init:}%% theme directives.
 * These must receive raw content without a prepended config block.
 */
const THEME_UNSUPPORTED_TYPES = ['xychart-beta', 'sankey-beta', 'block-beta']

/**
 * Widen a gantt SVG by scaling layout coordinates horizontally
 * while counter-scaling text elements to keep them at normal proportions.
 */
function widenGanttSvg(svg: string, scaleX: number): string {
  const vbMatch = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)
  if (!vbMatch) return svg

  const origW = parseFloat(vbMatch[1])
  const origH = parseFloat(vbMatch[2])
  const newW = Math.round(origW * scaleX)
  const invScale = +(1 / scaleX).toFixed(4)

  let result = svg

  // 1. Update viewBox to wider dimensions
  result = result.replace(
    `viewBox="0 0 ${vbMatch[1]} ${vbMatch[2]}"`,
    `viewBox="0 0 ${newW} ${origH}"`
  )

  // 2. Remove fixed width/height so CSS controls sizing
  result = result.replace(/<svg([^>]*)\swidth="[\d.]+"/, '<svg$1')
  result = result.replace(/<svg([^>]*)\sheight="[\d.]+"/, '<svg$1')

  // 3. Wrap all children in a horizontal scale group
  result = result.replace(/<\/style>/, `</style><g transform="scale(${scaleX}, 1)">`)
  result = result.replace(/<\/svg>/, '</g></svg>')

  // 4. Counter-scale <text> elements: multiply x by scaleX (to keep position after
  //    inverse scale), then add inverse scale transform so glyphs render normally.
  //    Texts without an x attribute (e.g. inside positioned <g> ticks) just get the
  //    inverse scale.
  result = result.replace(/<text([^>]*)>/g, (match, attrs: string) => {
    const xMatch = attrs.match(/\bx="([\d.]+)"/)
    let newAttrs = attrs
    if (xMatch) {
      const newX = +(parseFloat(xMatch[1]) * scaleX).toFixed(1)
      newAttrs = newAttrs.replace(`x="${xMatch[1]}"`, `x="${newX}"`)
    }
    return `<text${newAttrs} transform="scale(${invScale}, 1)">`
  })

  // 5. Counter-scale <tspan> x attributes (section titles use tspan with x)
  result = result.replace(/<tspan([^>]*)\bx="([\d.]+)"([^>]*)>/g, (_match, before, x, after) => {
    const newX = +(parseFloat(x) * scaleX).toFixed(1)
    return `<tspan${before}x="${newX}"${after}>`
  })

  return result
}

function prepareMermaidContent(content: string, theme: DiagramTheme = 'dark'): string {
  // If already has init directive, don't add another
  if (content.includes('%%{init:')) {
    return content
  }

  // Some diagram types don't support init directives
  const firstLine = content.trimStart().split('\n')[0].trim()
  if (THEME_UNSUPPORTED_TYPES.some(t => firstLine.startsWith(t))) {
    return content
  }

  const config = THEME_CONFIGS[theme] || DARK_THEME_CONFIG
  return `${config}\n${content}`
}

/**
 * Render a diagram to SVG using Kroki
 */
export async function renderDiagram(
  type: DiagramType,
  content: string,
  theme: DiagramTheme = 'dark',
  options?: DiagramRenderOptions
): Promise<string> {
  const url = `${KROKI_URL}/${type}/svg`
  const normalizedContent = type === 'mermaid' && options?.disableHtmlLabels
    ? normalizeMermaidForNoHtmlLabels(content)
    : content

  // Apply mermaid-specific configuration
  const body = type === 'mermaid' ? prepareMermaidContent(normalizedContent, theme) : normalizedContent
  const extraHeaders = type === 'mermaid' ? buildMermaidOptionsHeaders(options) : {}

  const response = options?.disableHtmlLabels
    ? await renderDiagramViaKrokiJson({
        type,
        outputFormat: 'svg',
        content: normalizedContent,
        theme,
        renderOptions: options,
      })
    : await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', ...extraHeaders },
        body,
      })

  if (!response.ok) {
    const errorText = await response.text()
    throw new DiagramRenderError(
      `Failed to render ${type} diagram: ${errorText}`
    )
  }

  let svg = await response.text()

  // Post-process mermaid SVGs to fix class diagram text truncation
  // Mermaid calculates widths based on internal font metrics that don't match browser rendering
  if (type === 'mermaid') {
    // Remove max-width constraints on inner divs
    svg = svg.replace(/max-width:\s*\d+px/g, 'max-width: none')
    // Increase foreignObject widths to prevent clipping (add 50% buffer)
    svg = svg.replace(/<foreignObject width="([\d.]+)"/g, (match, width) => {
      const newWidth = Math.ceil(parseFloat(width) * 1.5)
      return `<foreignObject width="${newWidth}"`
    })

    // Gantt-specific post-processing
    if (svg.includes('aria-roledescription="gantt"')) {
      // Normalize section2 fill color (Mermaid derives it from secondaryColor,
      // which often produces jarring results like light beige on dark backgrounds)
      const sectionFill = GANTT_SECTION2_OVERRIDES[theme]
      if (sectionFill) {
        svg = svg.replace(
          /\.section2\{fill:[^;}]+;?\}/,
          `.section2{fill:${sectionFill};}`
        )
      }

      // Widen the gantt chart by scaling layout coordinates while keeping text
      // at normal proportions. Mermaid hardcodes ~584px; we stretch to ~2x.
      svg = widenGanttSvg(svg, 2.0)
    }
  }

  // Sanitize SVG to prevent XSS (defense-in-depth)
  return sanitizeSvg(svg)
}

/**
 * Extract mermaid code from markdown content
 * Returns the mermaid code if found, null otherwise
 */
export function extractMermaidFromMarkdown(content: string): string | null {
  const match = content.match(/```mermaid\n([\s\S]*?)\n```/)
  return match ? match[1].trim() : null
}

/**
 * Render a diagram to PNG using Kroki.
 *
 * Note: Kroki's mermaid renderer uses Puppeteer internally, which properly
 * renders text in foreignObject elements. The scale parameter is accepted
 * for API consistency but Kroki's PNG endpoint doesn't support scaling.
 * The rendered PNG will be at the diagram's natural size.
 */
export async function renderDiagramToPng(
  type: DiagramType,
  content: string,
  theme: DiagramTheme = 'light',
  _scale: number = 2, // Accepted but not used - Kroki PNG doesn't support scaling
  options?: DiagramRenderOptions
): Promise<Buffer> {
  const url = `${KROKI_URL}/${type}/png`
  const normalizedContent = type === 'mermaid' && options?.disableHtmlLabels
    ? normalizeMermaidForNoHtmlLabels(content)
    : content

  // Apply mermaid-specific configuration
  const body = type === 'mermaid' ? prepareMermaidContent(normalizedContent, theme) : normalizedContent
  const extraHeaders = type === 'mermaid' ? buildMermaidOptionsHeaders(options) : {}

  const response = options?.disableHtmlLabels
    ? await renderDiagramViaKrokiJson({
        type,
        outputFormat: 'png',
        content: normalizedContent,
        theme,
        renderOptions: options,
      })
    : await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', ...extraHeaders },
        body,
      })

  if (!response.ok) {
    const errorText = await response.text()
    throw new DiagramRenderError(
      `Failed to render ${type} diagram to PNG: ${errorText}`
    )
  }

  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

/**
 * Parse PNG dimensions from buffer header
 * PNG stores width/height in IHDR chunk at bytes 16-23
 */
export function parsePngDimensions(buffer: Buffer): { width: number; height: number } {
  // Verify PNG signature
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
    throw new Error('Invalid PNG signature')
  }

  // Width is at bytes 16-19, height at 20-23 (big-endian)
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)

  return { width, height }
}

/**
 * Parse SVG dimensions from width/height or viewBox.
 * Returns null if dimensions cannot be determined.
 */
export function parseSvgDimensions(svg: string): { width: number; height: number } | null {
  const widthMatch = svg.match(/<svg[^>]*\swidth="([\d.]+)(?:px)?"/i)
  const heightMatch = svg.match(/<svg[^>]*\sheight="([\d.]+)(?:px)?"/i)

  if (widthMatch && heightMatch) {
    const width = Math.round(parseFloat(widthMatch[1]))
    const height = Math.round(parseFloat(heightMatch[1]))
    if (Number.isFinite(width) && Number.isFinite(height)) {
      return { width, height }
    }
  }

  const viewBoxMatch = svg.match(/<svg[^>]*\sviewBox="[\d.\s]+ [\d.\s]+ ([\d.]+) ([\d.]+)"/i)
  if (viewBoxMatch) {
    const width = Math.round(parseFloat(viewBoxMatch[1]))
    const height = Math.round(parseFloat(viewBoxMatch[2]))
    if (Number.isFinite(width) && Number.isFinite(height)) {
      return { width, height }
    }
  }

  return null
}

/**
 * Check if Kroki service is available
 */
export async function isKrokiAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${KROKI_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Scale SVG to fit within maxWidth while preserving aspect ratio
 * Returns the original SVG if width is already within bounds or cannot be parsed
 */
export function scaleSvgToMaxWidth(svg: string, maxWidth: number): string {
  // Extract width and height from SVG attributes
  const widthMatch = svg.match(/<svg[^>]*\swidth="([\d.]+)(?:px)?"/i)
  const heightMatch = svg.match(/<svg[^>]*\sheight="([\d.]+)(?:px)?"/i)

  if (!widthMatch || !heightMatch) {
    // Try to extract from viewBox if explicit dimensions not present
    const viewBoxMatch = svg.match(/<svg[^>]*\sviewBox="[\d.\s]+ [\d.\s]+ ([\d.]+) ([\d.]+)"/i)
    if (!viewBoxMatch) {
      return svg // Cannot determine dimensions, return unchanged
    }

    const viewBoxWidth = parseFloat(viewBoxMatch[1])
    const viewBoxHeight = parseFloat(viewBoxMatch[2])

    if (viewBoxWidth <= maxWidth) {
      return svg // Already within bounds
    }

    const scale = maxWidth / viewBoxWidth
    const newHeight = Math.round(viewBoxHeight * scale)

    // Add explicit width/height attributes to the SVG
    return svg.replace(
      /<svg([^>]*)>/i,
      `<svg$1 width="${maxWidth}" height="${newHeight}">`
    )
  }

  const currentWidth = parseFloat(widthMatch[1])
  const currentHeight = parseFloat(heightMatch[1])

  if (currentWidth <= maxWidth) {
    return svg // Already within bounds
  }

  const scale = maxWidth / currentWidth
  const newHeight = Math.round(currentHeight * scale)

  // Replace width and height attributes
  let scaledSvg = svg.replace(
    /(<svg[^>]*\s)width="[\d.]+(?:px)?"/i,
    `$1width="${maxWidth}"`
  )
  scaledSvg = scaledSvg.replace(
    /(<svg[^>]*\s)height="[\d.]+(?:px)?"/i,
    `$1height="${newHeight}"`
  )

  return scaledSvg
}
