/**
 * Navigation context for project list navigation.
 * Stores the current list of project IDs and position for arrow key navigation.
 *
 * Backed by sessionStorage['khef-state'].projectNav via lib/store.
 */

import { loadSession, saveSession, type NavListContext } from './store'

export type ProjectNavContext = NavListContext

/**
 * Store navigation context when entering a project from a list view.
 */
export function setProjectNavContext(ids: string[], currentId: string, source: string): void {
  if (typeof window === 'undefined') return
  const currentIndex = ids.indexOf(currentId)
  if (currentIndex === -1) return
  saveSession({ projectNav: { ids, currentIndex, source } })
}

/**
 * Get current navigation context.
 */
export function getProjectNavContext(): ProjectNavContext | null {
  if (typeof window === 'undefined') return null
  return loadSession().projectNav
}

/**
 * Update the current index when navigating within the list.
 */
export function updateProjectNavIndex(newIndex: number): void {
  if (typeof window === 'undefined') return
  const context = getProjectNavContext()
  if (!context) return
  if (newIndex < 0 || newIndex >= context.ids.length) return
  saveSession({ projectNav: { ...context, currentIndex: newIndex } })
}

/**
 * Clear navigation context.
 */
export function clearProjectNavContext(): void {
  if (typeof window === 'undefined') return
  saveSession({ projectNav: null })
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
