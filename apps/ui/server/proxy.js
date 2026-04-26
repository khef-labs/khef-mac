import http from 'node:http'
import { URL } from 'node:url'
import { mkdir, appendFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

function loadEnvFile(filePath) {
  try {
    const contents = readFileSync(filePath, 'utf8')
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx === -1) continue
      const key = trimmed.slice(0, idx).trim()
      if (!key || process.env[key] !== undefined) continue
      let value = trimmed.slice(idx + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      process.env[key] = value
    }
  } catch (error) {
    // ignore missing or unreadable env files
  }
}

if (process.env.KHEF_USE_TEST_ENV) {
  loadEnvFile(resolve(process.cwd(), '.env.test'))
}
loadEnvFile(resolve(process.cwd(), '.env'))

const PORT = Number(process.env.KHEF_PROXY_PORT || process.env.PORT || 5175)
const TARGET = process.env.KHEF_PROXY_TARGET || 'http://localhost:3201/api'
const LOG_PATH = process.env.KHEF_PROXY_LOG || resolve(process.cwd(), '..', '..', 'logs', 'ui', 'api-errors.log')
const TRACE_PATH = process.env.KHEF_TRACE_LOG || resolve(process.cwd(), '..', '..', 'logs', 'ui', 'trace.log')
const LOG_BODY_LIMIT = Number(process.env.KHEF_PROXY_LOG_BODY_LIMIT || 4000)
const REQUEST_TIMEOUT_MS = Number(process.env.KHEF_PROXY_TIMEOUT_MS || 30000)

const targetBase = new URL(TARGET.endsWith('/') ? TARGET : `${TARGET}/`)

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

function setCorsHeaders(res, req) {
  const origin = req.headers.origin || '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Max-Age', '86400')
}

async function ensureLogDir() {
  await mkdir(dirname(LOG_PATH), { recursive: true })
}

function sanitizeBody(body, contentType) {
  if (!body) return ''
  const type = (contentType || '').toLowerCase()
  if (type.includes('application/json') || type.includes('text/')) {
    const text = body.toString('utf8')
    return text.length > LOG_BODY_LIMIT ? `${text.slice(0, LOG_BODY_LIMIT)}…` : text
  }
  return `[binary ${body.length} bytes]`
}

async function logError(entry) {
  await ensureLogDir()
  await appendFile(LOG_PATH, `${JSON.stringify(entry)}\n`)
}

async function writeTrace(entry) {
  await mkdir(dirname(TRACE_PATH), { recursive: true })
  await appendFile(TRACE_PATH, `${JSON.stringify(entry)}\n`)
}

function trace(label, data) {
  const entry = {
    at: new Date().toISOString(),
    source: 'server',
    label,
    data,
  }
  writeTrace(entry).catch(() => {})
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : null))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  // Apply CORS headers to all responses
  setCorsHeaders(res, req)

  if (!req.url) {
    res.statusCode = 400
    res.end('Missing URL')
    return
  }

  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  if (req.url === '/health') {
    res.statusCode = 200
    res.end('ok')
    return
  }

  // Handle trace endpoint - write client traces to log
  if (req.url === '/api/trace' && req.method === 'POST') {
    const body = await collectRequestBody(req).catch(() => null)
    if (body) {
      try {
        const entry = JSON.parse(body.toString('utf8'))
        await writeTrace(entry)
      } catch {
        // ignore malformed trace
      }
    }
    res.statusCode = 204
    res.end()
    return
  }

  if (!req.url.startsWith('/api')) {
    res.statusCode = 404
    res.end('Not found')
    return
  }

  const upstreamPath = req.url.replace(/^\/api\/?/, '')
  const upstreamUrl = new URL(upstreamPath, targetBase)

  const method = req.method || 'GET'
  const body =
    method === 'GET' || method === 'HEAD' ? null : await collectRequestBody(req).catch(() => null)

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue
    if (hopByHopHeaders.has(key.toLowerCase())) continue
    headers.set(key, Array.isArray(value) ? value.join(',') : String(value))
  }

  // Long-running operations get a longer timeout (5 minutes)
  const isLongRunning = /\/backups\/[^/]+\/restore$/.test(req.url)
    || (method === 'POST' && /\/chat$/.test(req.url))
  // SSE streams are long-lived — skip the timeout entirely and stream the body.
  const isSseRequest = /^\/api\/sse(\/|\?|$)/.test(req.url)
  const timeoutMs = isLongRunning ? 300000 : REQUEST_TIMEOUT_MS

  const controller = new AbortController()
  const timeout = isSseRequest ? null : setTimeout(() => controller.abort(), timeoutMs)

  let upstreamRes

  try {
    upstreamRes = await fetch(upstreamUrl, {
      method,
      headers,
      body: body || undefined,
      signal: controller.signal,
    })
  } catch (error) {
    if (timeout) clearTimeout(timeout)
    logError({
      at: new Date().toISOString(),
      method,
      url: req.url,
      upstream: upstreamUrl.toString(),
      status: 502,
      error: error instanceof Error ? error.message : String(error),
    })
    res.statusCode = 502
    res.end('Bad gateway')
    return
  }

  const upstreamContentType = upstreamRes.headers.get('content-type') || ''
  const isSseResponse = upstreamContentType.startsWith('text/event-stream')

  // Stream SSE responses through without buffering so events reach the browser live.
  if (isSseRequest || isSseResponse) {
    res.statusCode = upstreamRes.status
    upstreamRes.headers.forEach((value, key) => {
      if (hopByHopHeaders.has(key.toLowerCase())) return
      res.setHeader(key, value)
    })
    setCorsHeaders(res, req)
    // Disable any buffering at this hop
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    const reader = upstreamRes.body?.getReader()
    if (!reader) {
      res.end()
      return
    }

    const abortUpstream = () => {
      try {
        controller.abort()
      } catch {
        // already aborted
      }
    }
    req.on('close', abortUpstream)

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) res.write(Buffer.from(value))
      }
    } catch {
      // client disconnected or upstream aborted — exit cleanly
    } finally {
      req.off('close', abortUpstream)
      res.end()
    }
    return
  }

  // Non-SSE path: buffer the body and forward in one shot.
  let upstreamBody
  try {
    upstreamBody = Buffer.from(await upstreamRes.arrayBuffer())
  } catch (error) {
    if (timeout) clearTimeout(timeout)
    logError({
      at: new Date().toISOString(),
      method,
      url: req.url,
      upstream: upstreamUrl.toString(),
      status: 502,
      error: error instanceof Error ? error.message : String(error),
    })
    res.statusCode = 502
    res.end('Bad gateway')
    return
  } finally {
    if (timeout) clearTimeout(timeout)
  }

  res.statusCode = upstreamRes.status
  upstreamRes.headers.forEach((value, key) => {
    if (hopByHopHeaders.has(key.toLowerCase())) return
    res.setHeader(key, value)
  })
  // Re-apply CORS headers after upstream headers (in case upstream overwrote them)
  setCorsHeaders(res, req)
  res.end(upstreamBody)

  if (upstreamRes.status >= 400) {
    logError({
      at: new Date().toISOString(),
      method,
      url: req.url,
      upstream: upstreamUrl.toString(),
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      request: sanitizeBody(body, req.headers['content-type']),
      response: sanitizeBody(upstreamBody, upstreamRes.headers.get('content-type')),
    })
  }
})

server.listen(PORT, () => {
  console.log(
    `khef proxy listening on http://localhost:${PORT} -> ${targetBase.toString()}`
  )
})
