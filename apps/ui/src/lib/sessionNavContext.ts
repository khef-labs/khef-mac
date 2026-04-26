/**
 * Navigation context for session transcript navigation.
 * Stores the current list of session IDs and position for arrow key navigation.
 */

const STORAGE_KEY = 'khefSessionNavContext'

export interface SessionNavContext {
  /** Ordered list of session IDs in the current view */
  ids: string[]
  /** Current position in the list (0-indexed) */
  currentIndex: number
  /** Source URL to return to */
  source: string
  /** Project ID for building navigation URLs */
  projectId: string
}

/**
 * Store navigation context when entering a session from a list view.
 */
export function setSessionNavContext(ids: string[], currentId: string, source: string, projectId: string): void {
  if (typeof window === 'undefined') return
  const currentIndex = ids.indexOf(currentId)
  if (currentIndex === -1) return

  const context: SessionNavContext = { ids, currentIndex, source, projectId }
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(context))
}

/**
 * Get current navigation context.
 */
export function getSessionNavContext(): SessionNavContext | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY)
    if (!stored) return null
    return JSON.parse(stored) as SessionNavContext
  } catch {
    return null
  }
}

/**
 * Update the current index when navigating within the list.
 */
export function updateSessionNavIndex(newIndex: number): void {
  if (typeof window === 'undefined') return
  const context = getSessionNavContext()
  if (!context) return
  if (newIndex < 0 || newIndex >= context.ids.length) return

  context.currentIndex = newIndex
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(context))
}

/**
 * Get the previous session ID (with wraparound).
 */
export function getPrevSessionId(): string | null {
  const context = getSessionNavContext()
  if (!context || context.ids.length < 2) return null

  const prevIndex = context.currentIndex === 0
    ? context.ids.length - 1
    : context.currentIndex - 1
  return context.ids[prevIndex]
}

/**
 * Get the next session ID (with wraparound).
 */
export function getNextSessionId(): string | null {
  const context = getSessionNavContext()
  if (!context || context.ids.length < 2) return null

  const nextIndex = context.currentIndex === context.ids.length - 1
    ? 0
    : context.currentIndex + 1
  return context.ids[nextIndex]
}

/**
 * Get position info for display (e.g., "3 of 20").
 */
export function getSessionPositionInfo(): { current: number; total: number } | null {
  const context = getSessionNavContext()
  if (!context || context.ids.length < 2) return null
  return {
    current: context.currentIndex + 1,
    total: context.ids.length,
  }
}
