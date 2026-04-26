import type { VNode } from 'preact'

const CONTAINER_ID = 'app'

/**
 * Read the Preact VNode tree from the render container.
 * Preact stores the root VNode at container.__k after render().
 * No initialization needed — just read the tree when the panel opens.
 */
export function getRootVNode(): VNode | null {
  const container = document.getElementById(CONTAINER_ID)
  if (!container) return null
  return (container as any).__k ?? null
}

/**
 * Get internal children array from a VNode.
 * Preact 10 uses __k for the reconciled children array.
 */
export function getVNodeChildren(node: VNode): (VNode | null)[] {
  return (node as any).__k ?? []
}
