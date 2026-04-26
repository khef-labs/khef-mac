/**
 * Unified tracing for client and server
 * All traces write to logs/trace.log
 */

const TRACE_ENDPOINT = '/api/trace'

interface TraceEntry {
  at: string
  source: 'client' | 'server'
  label: string
  data?: unknown
}

export function trace(label: string, data?: unknown): void {
  const entry: TraceEntry = {
    at: new Date().toISOString(),
    source: 'client',
    label,
    data,
  }

  // Also log to console for immediate feedback
  console.log(`[trace:client] ${label}`, data !== undefined ? data : '')

  // Fire and forget POST to server
  fetch(TRACE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  }).catch(() => {
    // Silently ignore - tracing shouldn't break the app
  })
}
