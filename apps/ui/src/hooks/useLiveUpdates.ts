import { useEffect, useRef } from 'preact/hooks'
import { subscribe } from '../lib/sseClient'

export type LiveDelta =
  | { type: 'session.created'; session_id: string; project_id: string | null; started_at: string | null }
  | { type: 'session.updated'; session_id: string; message_count: number; usage_delta?: LiveUsageDelta; at: string }
  | { type: 'session.ended'; session_id: string; ended_at: string }
  | { type: 'session.nickname'; session_id: string; nickname: string }

export interface LiveUsageDelta {
  input: number
  output: number
  cache_creation?: number
  cache_read?: number
  model: string | null
}

export type LiveHandler = (room: string, delta: LiveDelta) => void

/**
 * Subscribe to push-based session deltas over SSE. All callers in the tab
 * share a single underlying EventSource via `lib/sseClient`. Pass an empty
 * array to skip.
 */
export function useLiveUpdates(rooms: string[], onDelta: LiveHandler): void {
  const handlerRef = useRef<LiveHandler>(onDelta)
  handlerRef.current = onDelta

  // Stable key for the effect dependency so we don't resubscribe on every render
  const roomsKey = rooms.slice().sort().join(',')

  useEffect(() => {
    if (!roomsKey) return
    const list = roomsKey.split(',').filter(Boolean)
    return subscribe(list, (room, delta) => handlerRef.current(room, delta as LiveDelta))
  }, [roomsKey])
}
