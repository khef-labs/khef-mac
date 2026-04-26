/**
 * Navigation context for project list navigation.
 * Stores the current list of project IDs and position for arrow key navigation.
 */

const STORAGE_KEY = 'khefProjectNavContext'

export interface ProjectNavContext {
  /** Ordered list of project IDs in the current view */
  ids: string[]
  /** Current position in the list (0-indexed) */
  currentIndex: number
  /** Source URL to return to */
  source: string
}

/**
 * Store navigation context when entering a project from a list view.
 */
export function setProjectNavContext(ids: string[], currentId: string, source: string): void {
  if (typeof window === 'undefined') return
  const currentIndex = ids.indexOf(currentId)
  if (currentIndex === -1) return

  const context: ProjectNavContext = { ids, currentIndex, source }
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(context))
}

/**
 * Get current navigation context.
 */
export function getProjectNavContext(): ProjectNavContext | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY)
    if (!stored) return null
    return JSON.parse(stored) as ProjectNavContext
  } catch {
    return null
  }
}

/**
 * Update the current index when navigating within the list.
 */
export function updateProjectNavIndex(newIndex: number): void {
  if (typeof window === 'undefined') return
  const context = getProjectNavContext()
  if (!context) return
  if (newIndex < 0 || newIndex >= context.ids.length) return

  context.currentIndex = newIndex
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(context))
}

/**
 * Clear navigation context.
 */
export function clearProjectNavContext(): void {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(STORAGE_KEY)
}

/**
 * Get the previous project ID (with wraparound).
 */
export function getPrevProjectId(): string | null {
  const context = getProjectNavContext()
  if (!context || context.ids.length < 2) return null

  const prevIndex = context.currentIndex === 0
    ? context.ids.length - 1
    : context.currentIndex - 1
  return context.ids[prevIndex]
}

/**
 * Get the next project ID (with wraparound).
 */
export function getNextProjectId(): string | null {
  const context = getProjectNavContext()
  if (!context || context.ids.length < 2) return null

  const nextIndex = context.currentIndex === context.ids.length - 1
    ? 0
    : context.currentIndex + 1
  return context.ids[nextIndex]
}

/**
 * Get position info for display (e.g., "3 of 20").
 */
export function getProjectPositionInfo(): { current: number; total: number } | null {
  const context = getProjectNavContext()
  if (!context || context.ids.length < 2) return null
  return {
    current: context.currentIndex + 1,
    total: context.ids.length,
  }
}
