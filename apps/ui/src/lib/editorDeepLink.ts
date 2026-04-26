/**
 * Editor deep-link via localStorage.
 * Uses localStorage so it works across browser tabs (window.open).
 * Consumed on read to avoid stale links.
 */

const STORAGE_KEY = 'khefEditorDeepLink'

export interface EditorDeepLink {
  path: string
  root?: string
  line?: number
  col?: number
  needle?: string
}

export function setEditorDeepLink(link: EditorDeepLink): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(link))
}

export function consumeEditorDeepLink(): EditorDeepLink | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    localStorage.removeItem(STORAGE_KEY)
    return JSON.parse(raw) as EditorDeepLink
  } catch {
    return null
  }
}
