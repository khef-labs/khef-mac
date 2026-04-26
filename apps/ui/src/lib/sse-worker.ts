/// <reference lib="webworker" />

// SharedWorker that holds a single EventSource for the entire browser session.
// All tabs connect via MessagePort and exchange room subscriptions; events fan
// out to every interested port. Effectively one SSE socket per browser, not
// per tab — sidesteps Chrome's 6-per-origin HTTP/1.1 cap entirely.

declare const self: SharedWorkerGlobalScope

type ClientMessage =
  | { type: 'subscribe'; subId: string; rooms: string[] }
  | { type: 'unsubscribe'; subId: string }
  | { type: 'disconnect' }
  | { type: 'ping' }

type WorkerMessage =
  | { type: 'event'; room: string; delta: unknown }
  | { type: 'pong' }

interface PortState {
  // subId → set of rooms
  subs: Map<string, Set<string>>
}

const ports = new Map<MessagePort, PortState>()
const roomCounts = new Map<string, number>()

let es: EventSource | null = null
let currentRoomsKey = ''
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const RECONNECT_DEBOUNCE_MS = 30

function roomsKey(): string {
  return Array.from(roomCounts.keys()).sort().join(',')
}

function broadcast(room: string, delta: unknown): void {
  for (const [port, state] of ports.entries()) {
    let interested = false
    for (const rooms of state.subs.values()) {
      if (rooms.has(room)) {
        interested = true
        break
      }
    }
    if (interested) {
      const msg: WorkerMessage = { type: 'event', room, delta }
      try {
        port.postMessage(msg)
      } catch {
        // port may have closed
      }
    }
  }
}

function rebuild(): void {
  const key = roomsKey()
  if (key === currentRoomsKey && es) return

  if (es) {
    es.close()
    es = null
  }
  currentRoomsKey = key
  if (!key) return

  const url = `${self.location.origin}/api/sse?rooms=${encodeURIComponent(key)}`
  const source = new EventSource(url)
  for (const room of roomCounts.keys()) {
    source.addEventListener(room, (ev) => {
      const msgEv = ev as MessageEvent
      let delta: unknown
      try {
        delta = JSON.parse(msgEv.data)
      } catch {
        return
      }
      broadcast(room, delta)
    })
  }
  source.onerror = () => {
    // Native EventSource auto-reconnects per the server's `retry:` directive.
  }
  es = source
}

function scheduleRebuild(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    rebuild()
  }, RECONNECT_DEBOUNCE_MS)
}

function addRooms(rooms: string[]): boolean {
  let changed = false
  for (const room of rooms) {
    if (!room) continue
    const next = (roomCounts.get(room) ?? 0) + 1
    roomCounts.set(room, next)
    if (next === 1) changed = true
  }
  return changed
}

function removeRooms(rooms: string[]): boolean {
  let changed = false
  for (const room of rooms) {
    if (!room) continue
    const next = (roomCounts.get(room) ?? 0) - 1
    if (next <= 0) {
      roomCounts.delete(room)
      changed = true
    } else {
      roomCounts.set(room, next)
    }
  }
  return changed
}

function dropPort(port: MessagePort): void {
  const state = ports.get(port)
  if (!state) return
  for (const rooms of state.subs.values()) {
    removeRooms([...rooms])
  }
  ports.delete(port)
  scheduleRebuild()
}

self.onconnect = (event: MessageEvent) => {
  const port = event.ports[0]
  ports.set(port, { subs: new Map() })

  port.onmessage = (msgEvent: MessageEvent<ClientMessage>) => {
    const msg = msgEvent.data
    const state = ports.get(port)
    if (!state) return

    switch (msg.type) {
      case 'subscribe': {
        const rooms = new Set(msg.rooms.filter(Boolean))
        state.subs.set(msg.subId, rooms)
        if (addRooms([...rooms])) scheduleRebuild()
        break
      }
      case 'unsubscribe': {
        const rooms = state.subs.get(msg.subId)
        if (!rooms) break
        state.subs.delete(msg.subId)
        if (removeRooms([...rooms])) scheduleRebuild()
        break
      }
      case 'disconnect': {
        dropPort(port)
        break
      }
      case 'ping': {
        try {
          port.postMessage({ type: 'pong' } satisfies WorkerMessage)
        } catch {
          dropPort(port)
        }
        break
      }
    }
  }

  port.start()
}
