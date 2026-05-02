import { useEffect, useRef, useState, useCallback } from 'preact/hooks'
import clsx from 'clsx'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Plug, X as Disconnect } from 'lucide-preact'
import '@xterm/xterm/css/xterm.css'
import styles from './SessionTerminal.module.css'

export interface SessionTerminalProps {
  sessionId?: string | null
  filePath?: string | null
  /**
   * Which CLI to spawn when there's no `sessionId` (chat / fresh PTY use case).
   * When `sessionId` is set, this is ignored and the session's CLI (claude --resume)
   * is used. Defaults to 'claude'.
   */
  cmd?: 'claude' | 'codex'
  /**
   * Override the spawn cwd for fresh PTYs (chat use case). Ignored when
   * `sessionId` is set (resume reads cwd from the session JSONL). When unset,
   * the API falls back to $HOME.
   */
  cwd?: string | null
}

type Mode = 'idle' | 'connecting' | 'live' | 'closed' | 'error'

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
}

/**
 * Best-effort decode of the ~/.claude/projects/-Foo-bar/<uuid>.jsonl path
 * back into a real cwd ("/Foo/bar"). Lossy for paths containing dashes —
 * the API will validate and fall back to $HOME if the path doesn't exist.
 */
function decodeProjectCwd(filePath: string | null | undefined): string | null {
  if (!filePath) return null
  const m = filePath.match(/\/projects\/(-[^/]+)\//)
  if (!m) return null
  return m[1].replace(/-/g, '/')
}

export function SessionTerminal({
  sessionId,
  filePath,
  cmd,
  cwd: cwdOverride,
}: SessionTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const inputDisposableRef = useRef<{ dispose: () => void } | null>(null)
  // 'connected' = the user wants a live PTY for the current sessionId; the
  // component should auto-reconnect on dropped websockets and switch sessions
  // when sessionId changes. 'disconnected' = explicit user action (or fatal
  // error) — no reconnects.
  const userIntentRef = useRef<'connected' | 'disconnected'>('disconnected')
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [mode, setMode] = useState<Mode>('idle')
  const [statusMessage, setStatusMessage] = useState<string>('')

  // Initialize xterm once
  useEffect(() => {
    if (!hostRef.current) return
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: false,
      cursorStyle: 'bar',
      scrollback: 500,
      convertEol: true,
      // Option+letter sends ESC+letter (Meta encoding) instead of falling
      // through to the macOS character composer (Option+B → ∫, etc.). Lets
      // readline-style word ops (ESC b / ESC f) work in claude's prompt.
      macOptionIsMeta: true,
      theme: {
        background: '#0a0a0a',
        foreground: '#e5e5e5',
        cursor: '#60a5fa',
        cursorAccent: '#0a0a0a',
        selectionBackground: '#1f2937',
        black: '#0a0a0a',
        red: '#f87171',
        green: '#6ee7b7',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#a855f7',
        cyan: '#22d3ee',
        white: '#e5e5e5',
        brightBlack: '#6b7280',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#c084fc',
        brightCyan: '#67e8f9',
        brightWhite: '#f3f4f6',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    try { fit.fit() } catch { /* ignore */ }

    termRef.current = term
    fitRef.current = fit

    // Capture-phase keydown handler for Shift+Enter. xterm's
    // attachCustomKeyEventHandler doesn't reliably see Shift+Enter (xterm
    // pre-handles the keystroke before it reaches the handler), so we
    // intercept on the host element. Send `\` + CR so claude treats it as a
    // line continuation in the prompt — same bytes `claude /terminal-setup`
    // configures iTerm to send for Shift+Enter.
    const onShiftEnter = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return
      if (!event.shiftKey) return
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      event.preventDefault()
      event.stopPropagation()
      try { ws.send(JSON.stringify({ type: 'input', data: '\\\r' })) } catch { /* ignore */ }
    }
    const hostEl = hostRef.current
    hostEl.addEventListener('keydown', onShiftEnter, true)

    // Layout may not be settled at mount (especially after a view-toggle from
    // Parsed → Terminal). Re-fit after a frame and again after a short tick to
    // catch async layout completion.
    const fitLater = () => { try { fit.fit() } catch { /* ignore */ } }
    const raf = requestAnimationFrame(fitLater)
    const t = setTimeout(fitLater, 80)

    const onResize = () => {
      try { fit.fit() } catch { /* ignore */ }
      // If a PTY is connected, propagate the resize.
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        } catch { /* ignore */ }
      }
    }
    window.addEventListener('resize', onResize)
    const ro = new ResizeObserver(onResize)
    ro.observe(hostRef.current)

    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
      window.removeEventListener('resize', onResize)
      hostEl.removeEventListener('keydown', onShiftEnter, true)
      ro.disconnect()
      try { wsRef.current?.close() } catch { /* ignore */ }
      try { inputDisposableRef.current?.dispose() } catch { /* ignore */ }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cursor only blinks while live
  useEffect(() => {
    if (!termRef.current) return
    termRef.current.options.cursorBlink = mode === 'live'
  }, [mode])

  const connect = useCallback(() => {
    const term = termRef.current
    if (!term) return
    if (mode === 'connecting' || mode === 'live') return

    userIntentRef.current = 'connected'
    setMode('connecting')
    setStatusMessage('connecting…')
    term.clear()

    // For resume (sessionId present) we infer cwd from the file path; for fresh
    // PTYs (chat) we honor an explicit cwd override and let the API fall back
    // to $HOME otherwise.
    const cwd = sessionId ? decodeProjectCwd(filePath) : (cwdOverride || null)
    const params = new URLSearchParams()
    if (cwd) params.set('cwd', cwd)
    if (sessionId) params.set('resume', sessionId)
    if (sessionId && filePath) params.set('filePath', filePath)
    // For fresh PTY (no sessionId), pick which CLI to spawn. With a sessionId
    // the API ignores `cmd` and always resumes via claude.
    if (!sessionId && cmd) params.set('cmd', cmd)
    params.set('cols', String(term.cols))
    params.set('rows', String(term.rows))

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/api/pty/spawn?${params.toString()}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      setMode('live')
      setStatusMessage('live')
      term.clear()
      term.focus()
      // Wire xterm input → ws
      inputDisposableRef.current = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }))
        }
      })
      // Remap Option+arrow / Option+Backspace / Option+D to readline word
      // bindings (ESC b, ESC f, ESC ⌫, ESC d). xterm.js' default for Option+
      // arrow is CSI 1;3D/C which Ink-based TUIs (claude) don't act on.
      // Shift+Enter is handled by a separate capture-phase keydown listener
      // on the host element (xterm pre-handles it before this callback runs).
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true
        if (!event.altKey || event.ctrlKey || event.metaKey) return true
        const sendBytes = (data: string) => {
          if (ws.readyState !== WebSocket.OPEN) return
          try { ws.send(JSON.stringify({ type: 'input', data })) } catch { /* ignore */ }
        }
        if (event.key === 'ArrowLeft')  { sendBytes('\x1bb');   return false }
        if (event.key === 'ArrowRight') { sendBytes('\x1bf');   return false }
        if (event.key === 'Backspace')  { sendBytes('\x1b\x7f'); return false }
        if (event.key.toLowerCase() === 'd') { sendBytes('\x1bd'); return false }
        return true
      })
      // Send an immediate resize so the PTY matches the current xterm size
      try {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      } catch { /* ignore */ }
    }

    ws.onmessage = (ev) => {
      let msg: any
      try { msg = JSON.parse(ev.data) } catch { return }
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'data' && typeof msg.data === 'string') {
        term.write(msg.data)
      } else if (msg.type === 'ready' && typeof msg.pid === 'number') {
        const reused = msg.reused === true
        setStatusMessage('live')
        // Reattach case: claude (Ink TUI) drew to the PTY before we attached,
        // so our xterm has no buffer. Kick it with a resize flicker — Ink
        // redraws its component tree on SIGWINCH.
        if (reused) {
          try {
            const cols = term.cols
            const rows = term.rows
            ws.send(JSON.stringify({ type: 'resize', cols: Math.max(2, cols - 1), rows }))
            setTimeout(() => {
              if (ws.readyState !== WebSocket.OPEN) return
              try { ws.send(JSON.stringify({ type: 'resize', cols, rows })) } catch { /* ignore */ }
            }, 50)
          } catch { /* ignore */ }
        }
      } else if (msg.type === 'exit') {
        const code = msg.code ?? 0
        // PTY actually exited (claude quit, killed, etc.) — don't auto-respawn
        // a fresh process from a stale ws.onclose tick.
        userIntentRef.current = 'disconnected'
        setStatusMessage(`exited (${code})`)
      } else if (msg.type === 'error' && typeof msg.message === 'string') {
        term.writeln(`${ANSI.red}error: ${msg.message}${ANSI.reset}`)
      }
    }

    ws.onerror = () => {
      // Don't loop on persistent errors (no daemon, bad URL, etc.) — let the
      // user retry manually.
      userIntentRef.current = 'disconnected'
      setMode('error')
      setStatusMessage('connection error')
    }

    ws.onclose = () => {
      try { inputDisposableRef.current?.dispose() } catch { /* ignore */ }
      inputDisposableRef.current = null
      wsRef.current = null
      setMode((prev) => (prev === 'error' ? 'error' : 'closed'))
      setStatusMessage((prev) => {
        // Preserve "exited (n)" or "connection error" if already set; otherwise
        // clear (no "disconnected" pill — the "Click Connect…" preview banner
        // already conveys the closed state).
        if (prev?.startsWith('exited') || prev === 'connection error') return prev
        return ''
      })
      // Wipe the buffer so the disconnected viewport is uniformly empty —
      // no stale TUI content reading as if the session were still live.
      try { termRef.current?.clear() } catch { /* ignore */ }
    }
  }, [filePath, sessionId, mode, cmd, cwdOverride])

  const disconnect = useCallback(() => {
    userIntentRef.current = 'disconnected'
    const ws = wsRef.current
    if (!ws) return
    try { ws.send(JSON.stringify({ type: 'kill' })) } catch { /* ignore */ }
    try { ws.close() } catch { /* ignore */ }
  }, [])

  // When sessionId/filePath change while the user wants a live PTY, close
  // the existing ws (without `kill` — we don't want to terminate the old
  // PTY, just stop watching it). The auto-reconnect effect below will
  // re-open against the new session, and the daemon will reattach if a
  // PTY for that key already exists.
  const isFirstSessionRef = useRef(true)
  useEffect(() => {
    if (isFirstSessionRef.current) {
      isFirstSessionRef.current = false
      return
    }
    if (userIntentRef.current !== 'connected') return
    const ws = wsRef.current
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try { ws.close() } catch { /* ignore */ }
    }
  }, [sessionId, filePath])

  // Auto-reconnect: if the websocket closed but the user still wants to be
  // connected (sessionId switch, transient drop), retry after a short delay.
  // Cleared on intent flip (Disconnect, exit, error) and on unmount.
  useEffect(() => {
    if (mode !== 'closed') return
    if (userIntentRef.current !== 'connected') return
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      if (userIntentRef.current === 'connected') connect()
    }, 200)
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }
  }, [mode, connect])

  const showConnect = mode === 'idle' || mode === 'closed' || mode === 'error'
  const showDisconnect = mode === 'live' || mode === 'connecting'

  return (
    <div class={styles.root} data-testid="session-terminal">
      <div class={styles.header}>
        {sessionId && (
          <span class={styles.headerMeta}>{sessionId}</span>
        )}
        <span class={styles.spacer} />
        {statusMessage && (
          <span class={clsx(styles.headerStatus, mode === 'live' && styles.live, mode === 'error' && styles.errorPill)}>
            {statusMessage}
          </span>
        )}
        {(showConnect || showDisconnect) && (
          <div class={styles.actionGroup}>
            {showConnect && (
              <button
                class={clsx(styles.actionBtn, styles.actionBtnPrimary)}
                onClick={connect}
                title="Open a live PTY (claude --resume <session_id>) over WebSocket"
              >
                <Plug size={12} />
                <span>Connect</span>
              </button>
            )}
            {showDisconnect && (
              <button
                class={clsx(styles.actionBtn, styles.actionBtnDanger)}
                onClick={disconnect}
                title="Kill the PTY and disconnect"
              >
                <Disconnect size={12} />
                <span>Disconnect</span>
              </button>
            )}
          </div>
        )}
      </div>

      <div class={styles.previewBanner}>
        <span>
          {mode === 'idle' && (sessionId
            ? 'Click Connect to spawn a live PTY (claude --resume <session_id>).'
            : `Click Connect to spawn a live ${cmd ?? 'claude'} PTY.`)}
          {mode === 'connecting' && 'Connecting to PTY…'}
          {mode === 'live' && 'Live PTY connected. Keystrokes go directly to claude. Disconnect to kill.'}
          {mode === 'closed' && 'Disconnected. Click Connect to spawn again.'}
          {mode === 'error' && 'Connection failed. Check API logs (apps/api/logs/khef.log) and retry.'}
        </span>
      </div>

      <div class={styles.terminalHost} ref={hostRef} />
    </div>
  )
}
