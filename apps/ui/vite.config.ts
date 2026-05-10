import { defineConfig, createLogger, loadEnv } from 'vite'
import preact from '@preact/preset-vite'
import { createWriteStream, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync, statSync } from 'fs'
import { join } from 'path'

const LOG_DIR = process.env.LOG_DIR || join(process.cwd(), '..', '..', 'logs', 'ui')
const LOG_FILE = 'khef-ui.log'
const MAX_LOG_FILES = 10

/**
 * Rotate log file if it's from a previous day.
 * Naming: khef-ui.log -> khef-ui.2026-02-06.log
 */
function rotateIfNeeded(logDir: string, filename: string): void {
  const filePath = join(logDir, filename)
  if (!existsSync(filePath)) return

  const stat = statSync(filePath)
  const fileDate = stat.mtime.toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)

  if (fileDate < today) {
    const base = filename.replace('.log', '')
    renameSync(filePath, join(logDir, `${base}.${fileDate}.log`))
    pruneOldLogs(logDir, base)
  }
}

/**
 * Keep only the most recent MAX_LOG_FILES rotated logs.
 */
function pruneOldLogs(logDir: string, base: string): void {
  const rotated = readdirSync(logDir)
    .filter(f => f.startsWith(`${base}.`) && f.endsWith('.log') && f !== `${base}.log`)
    .sort()
    .reverse()

  for (const old of rotated.slice(MAX_LOG_FILES)) {
    unlinkSync(join(logDir, old))
  }
}

function createFileLogger(logDir: string) {
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true })
  }

  rotateIfNeeded(logDir, LOG_FILE)

  const stream = createWriteStream(join(logDir, LOG_FILE), { flags: 'a' })
  const viteLogger = createLogger()

  const wrap = (level: string, original: Function) => (msg: string, opts?: any) => {
    const stripped = msg.replace(/\x1b\[[0-9;]*m/g, '')
    stream.write(`[${new Date().toISOString()}] [${level}] ${stripped}\n`)
    original(msg, opts)
  }

  viteLogger.info = wrap('INFO', viteLogger.info.bind(viteLogger)) as any
  viteLogger.warn = wrap('WARN', viteLogger.warn.bind(viteLogger)) as any
  viteLogger.error = wrap('ERROR', viteLogger.error.bind(viteLogger)) as any

  return viteLogger
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const modeName = process.env.KHEF_USE_TEST_ENV ? 'test' : mode
  // Load from .env files
  const fileEnv = loadEnv(modeName, process.cwd(), '')
  // process.env takes precedence (for Playwright's webServer.env)
  const env = { ...fileEnv, ...process.env }

  const port = Number(env.KHEF_UI_PORT || env.PORT || 5173)
  const host = env.HOST || true
  const proxyPort = env.KHEF_PROXY_PORT || '5175'
  const proxyTarget = env.KHEF_PROXY_TARGET || 'http://localhost:3201/api'
  // Extract base URL from proxy target (e.g., http://localhost:3201/api -> http://localhost:3201)
  const backendBase = proxyTarget.replace(/\/api\/?$/, '') || 'http://localhost:3201'

  return {
    plugins: [preact()],
    customLogger: createFileLogger(LOG_DIR),
    define: {
      // Expose non-VITE env to the client code at build/dev time
      'import.meta.env.KHEF_API_URL': JSON.stringify(env.KHEF_API_URL || ''),
      'import.meta.env.KHEF_DISABLE_MCP_HEALTH': JSON.stringify(
        env.KHEF_DISABLE_MCP_HEALTH || ''
      ),
      'import.meta.env.KHEF_USE_TEST_ENV': JSON.stringify(
        env.KHEF_USE_TEST_ENV || ''
      ),
    },
    server: {
      port,
      host,
      allowedHosts: true,
      proxy: {
        '/api/trace': {
          target: `http://localhost:${proxyPort}`,
          changeOrigin: true,
        },
        '/api': {
          target: backendBase,
          changeOrigin: true,
          ws: true, // forward WebSocket upgrades (e.g., /api/pty/spawn)
          timeout: 300000, // 5 min for long-running chat requests (Claude + MCP tools)
          configure: (proxy) => {
            // Suppress Vite's verbose AggregateError stack on transient API
            // outages (tsx watch bouncing during refresh). Log a single
            // concise line and return 503 so the client can retry.
            proxy.on('error', (err, _req, res) => {
              const code = (err as NodeJS.ErrnoException).code
              const transient = code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT'
              if (transient) {
                console.warn(`[vite] api proxy: ${code} (api restarting?)`)
              } else {
                console.warn(`[vite] api proxy error: ${err.message}`)
              }
              if (res && 'writeHead' in res && !res.headersSent) {
                try {
                  res.writeHead(503, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ error: 'API unavailable', code: code || 'PROXY_ERROR' }))
                } catch {
                  // socket already gone
                }
              }
            })
          },
        },
      },
    },
    preview: {
      port,
      host,
    },
  }
})
