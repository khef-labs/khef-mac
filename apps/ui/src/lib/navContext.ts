/**
 * Navigation context for memory list navigation.
 * Stores the current list of memory IDs and position for arrow key navigation.
 *
 * Backed by sessionStorage['khef-state'].memoryNav via lib/store. Legacy
 * top-level 'khefNavContext' keys are migrated lazily on first read.
 */

import { loadSession, saveSession, type NavListContext } from './store'

export type NavContext = NavListContext

/**
 * Store navigation context when entering a memory from a list view.
 */
export function setNavContext(ids: string[], currentId: string, source: string): void {
  if (typeof window === 'undefined') return
  const currentIndex = ids.indexOf(currentId)
  if (currentIndex === -1) return
  saveSession({ memoryNav: { ids, currentIndex, source } })
}

/**
 * Get current navigation context.
 */
export function getNavContext(): NavContext | null {
  if (typeof window === 'undefined') return null
  return loadSession().memoryNav
}

/**
 * Update the current index when navigating within the list.
 */
export function updateNavIndex(newIndex: number): void {
  if (typeof window === 'undefined') return
  const context = getNavContext()
  if (!context) return
  if (newIndex < 0 || newIndex >= context.ids.length) return
  saveSession({ memoryNav: { ...context, currentIndex: newIndex } })
}

/**
 * Clear navigation context (e.g., when context is stale).
 */
export function clearNavContext(): void {
  if (typeof window === 'undefined') return
  saveSession({ memoryNav: null })
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
