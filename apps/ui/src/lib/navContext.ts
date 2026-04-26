/**
 * Navigation context for memory list navigation.
 * Stores the current list of memory IDs and position for arrow key navigation.
 */

const STORAGE_KEY = 'khefNavContext'

export interface NavContext {
  /** Ordered list of memory IDs in the current view */
  ids: string[]
  /** Current position in the list (0-indexed) */
  currentIndex: number
  /** Source URL to return to (e.g., /search?q=test or /projects/abc) */
  source: string
}

/**
 * Store navigation context when entering a memory from a list view.
 */
export function setNavContext(ids: string[], currentId: string, source: string): void {
  if (typeof window === 'undefined') return
  const currentIndex = ids.indexOf(currentId)
  if (currentIndex === -1) return

  const context: NavContext = { ids, currentIndex, source }
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(context))
}

/**
 * Get current navigation context.
 */
export function getNavContext(): NavContext | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY)
    if (!stored) return null
    return JSON.parse(stored) as NavContext
  } catch {
    return null
  }
}

/**
 * Update the current index when navigating within the list.
 */
export function updateNavIndex(newIndex: number): void {
  if (typeof window === 'undefined') return
  const context = getNavContext()
  if (!context) return
  if (newIndex < 0 || newIndex >= context.ids.length) return

  context.currentIndex = newIndex
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(context))
}

/**
 * Clear navigation context (e.g., when context is stale).
 */
export function clearNavContext(): void {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(STORAGE_KEY)
}

/**
 * Get the previous memory ID (with wraparound).
 */
export function getPrevMemoryId(): string | null {
  const context = getNavContext()
  if (!context || context.ids.length < 2) return null

  const prevIndex = context.currentIndex === 0
    ? context.ids.length - 1
    : context.currentIndex - 1
  return context.ids[prevIndex]
}

/**
 * Get the next memory ID (with wraparound).
 */
export function getNextMemoryId(): string | null {
  const context = getNavContext()
  if (!context || context.ids.length < 2) return null

  const nextIndex = context.currentIndex === context.ids.length - 1
    ? 0
    : context.currentIndex + 1
  return context.ids[nextIndex]
}

/**
 * Get position info for display (e.g., "3 of 20").
 */
export function getPositionInfo(): { current: number; total: number } | null {
  const context = getNavContext()
  if (!context || context.ids.length < 2) return null
  return {
    current: context.currentIndex + 1,
    total: context.ids.length,
  }
}
