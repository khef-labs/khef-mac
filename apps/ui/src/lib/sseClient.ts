import { API_BASE } from './apiBase'

/**
 * SSE client that prefers a SharedWorker when available. Every tab in the
 * browser shares ONE EventSource hosted in the worker; events fan out to all
 * tabs via MessagePort. Bypasses Chrome's 6-per-origin HTTP/1.1 cap entirely.
 *
 * If SharedWorker isn't available (Safari < 16.4, some embedded contexts), we
 * fall back to a per-tab singleton EventSource. The fallback also closes its
 * connection while the tab is hidden so background tabs don't pin sockets.
 */

export type LiveHandler = (room: string, delta: unknown) => void

interface Subscription {
  rooms: Set<string>
  handler: LiveHandler
}

const subscriptions = new Map<string, Subscription>()

let nextSubId = 0
function makeSubId(): string {
  nextSubId = (nextSubId + 1) % 1_000_000_000
  return `${Date.now().toString(36)}-${nextSubId.toString(36)}`
}

// ── SharedWorker path ───────────────────────────────────────────────────

interface WorkerEventMessage {
  type: 'event'
  room: string
  delta: unknown
}

let workerPort: MessagePort | null = null
let workerInitTried = false

function initWorker(): MessagePort | null {
  if (workerInitTried) return workerPort
  workerInitTried = true
  if (typeof SharedWorker === 'undefined') return null
  try {
    const worker = new SharedWorker(
      new URL('./sse-worker.ts', import.meta.url),
      { type: 'module', name: 'khef-sse' },
    )
    const port = worker.port
    port.onmessage = (ev: MessageEvent<WorkerEventMessage>) => {
      const msg = ev.data
      if (!msg || msg.type !== 'event') return
      for (const sub of subscriptions.values()) {
        if (sub.rooms.has(msg.room)) {
          try {
            sub.handler(msg.room, msg.delta)
          } catch (err) {
            console.warn('[sseClient] handler threw', err, msg.room)
          }
        }
      }
    }
    port.start()
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        try {
          port.postMessage({ type: 'disconnect' })
        } catch {
          // worker may already be gone
        }
      })
    }
    workerPort = port
    return port
  } catch (err) {
    console.warn('[sseClient] SharedWorker unavailable, falling back', err)
    return null
  }
}

// ── Direct EventSource fallback ─────────────────────────────────────────

interface RoomState {
  count: number
  listener?: (ev: MessageEvent) => void
}

const roomStates = new Map<string, RoomState>()

let directEs: EventSource | null = null
let directCurrentRooms = ''
let directReconnectTimer: ReturnType<typeof setTimeout> | null = null
const RECONNECT_DEBOUNCE_MS = 30

function isPageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

function directDispatch(room: string, ev: MessageEvent): void {
  let delta: unknown
  try {
    delta = JSON.parse(ev.data)
  } catch (err) {
    console.warn('[sseClient] failed to parse delta', err, ev.data)
    return
  }
  for (const sub of subscriptions.values()) {
    if (sub.rooms.has(room)) {
      try {
        sub.handler(room, delta)
      } catch (err) {
        console.warn('[sseClient] handler threw', err, room)
      }
    }
  }
}

function directRoomsKey(): string {
  return Array.from(roomStates.keys()).sort().join(',')
}

function directAttachListener(source: EventSource, room: string): void {
  const state = roomStates.get(room)
  if (!state) return
  if (state.listener) source.removeEventListener(room, state.listener as EventListener)
  const listener = (ev: MessageEvent) => directDispatch(room, ev)
  source.addEventListener(room, listener as EventListener)
  state.listener = listener
}

function directRebuild(): void {
  const key = directRoomsKey()
  const wantOpen = !!key && isPageVisible()

  if (wantOpen && key === directCurrentRooms && directEs) return
  if (!wantOpen && !directEs) {
    directCurrentRooms = key
    return
  }

  if (directEs) {
    directEs.close()
    directEs = null
  }
  directCurrentRooms = key
  if (!wantOpen) return

  const url = `${API_BASE}/sse?rooms=${encodeURIComponent(key)}`
  const source = new EventSource(url)
  source.onerror = () => {
    if (import.meta.env.DEV) {
      console.debug('[sseClient] SSE error (reconnect will follow)', { rooms: key })
    }
  }
  for (const room of roomStates.keys()) {
    directAttachListener(source, room)
  }
  directEs = source
}

function directScheduleRebuild(): void {
  if (directReconnectTimer) return
  directReconnectTimer = setTimeout(() => {
    directReconnectTimer = null
    directRebuild()
  }, RECONNECT_DEBOUNCE_MS)
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (workerPort) return // worker handles socket lifetime
    directScheduleRebuild()
  })
}

function directSubscribe(rooms: string[], subId: string): () => void {
  for (const room of rooms) {
    const state = roomStates.get(room)
    if (state) {
      state.count += 1
    } else {
      roomStates.set(room, { count: 1 })
    }
  }
  directScheduleRebuild()

  let unsubscribed = false
  return () => {
    if (unsubscribed) return
    unsubscribed = true
    subscriptions.delete(subId)
    for (const room of rooms) {
      const state = roomStates.get(room)
      if (state) {
        state.count -= 1
        if (state.count <= 0) {
          if (state.listener && directEs) directEs.removeEventListener(room, state.listener as EventListener)
          roomStates.delete(room)
        }
      }
    }
    directScheduleRebuild()
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Subscribe to a set of rooms. Returns an unsubscribe function. Multiple
 * subscribers can register the same rooms; the underlying connection is
 * shared (one per browser when SharedWorker is available, one per tab in the
 * fallback path).
 */
export function subscribe(rooms: string[], handler: LiveHandler): () => void {
  const unique = Array.from(new Set(rooms.filter(Boolean)))
  if (unique.length === 0) return () => {}

  const subId = makeSubId()
  subscriptions.set(subId, { rooms: new Set(unique), handler })

  const port = initWorker()
  if (port) {
    port.postMessage({ type: 'subscribe', subId, rooms: unique })
    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      subscriptions.delete(subId)
      try {
        port.postMessage({ type: 'unsubscribe', subId })
      } catch {
        // worker is gone; nothing to do
      }
    }
  }

  return directSubscribe(unique, subId)
}
