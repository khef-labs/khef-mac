import type { MemoryType } from '../types'

// Sorted alphabetically by label
export const MEMORY_TYPES: MemoryType[] = [
  'animation',
  'assistant-rule',
  'api',
  'assistant-note',
  'assistant-todo',
  'canvas',
  'command',
  'commands',
  'context',
  'csv',
  'decision',
  'diagram',
  'google-doc',
  'knowledge',
  'pattern',
  'project-note',
  'prototype',
  'quiz',
  'reference',
  'user-note',
  'user-todo',
  'video',
  'widget',
]

export const TYPE_LABELS: Record<MemoryType, string> = {
  animation: 'Animation',
  'assistant-rule': 'Assistant Rule',
  api: 'API',
  'assistant-note': 'Assistant Note',
  'assistant-todo': 'Assistant Todo',
  canvas: 'Canvas',
  command: 'Command',
  commands: 'Commands',
  context: 'Context',
  csv: 'CSV',
  decision: 'Decision',
  diagram: 'Diagram',
  'google-doc': 'Google Doc',
  knowledge: 'Knowledge',
  pattern: 'Pattern',
  'project-note': 'Project Note',
  prototype: 'Prototype',
  quiz: 'Quiz',
  reference: 'Reference',
  'user-note': 'User Note',
  'user-todo': 'User Todo',
  video: 'Video',
  widget: 'Widget',
}

// Knowledge is a parent type that groups these child types
export const KNOWLEDGE_CHILDREN: MemoryType[] = ['commands', 'context', 'pattern']

// Canvas is a parent type that groups interactive HTML/JS/CSS content types
export const CANVAS_CHILDREN: MemoryType[] = ['widget', 'animation', 'prototype', 'quiz']

// All child types across all hierarchies
const ALL_CHILDREN: MemoryType[] = [...KNOWLEDGE_CHILDREN, ...CANVAS_CHILDREN]

// Parent → children mapping for types with subtypes
export const TYPE_HIERARCHY: Record<string, MemoryType[]> = {
  knowledge: KNOWLEDGE_CHILDREN,
  canvas: CANVAS_CHILDREN,
}

// Top-level types shown in the primary Type dropdown (excludes children that belong to a parent)
export const TOP_LEVEL_TYPES: MemoryType[] = MEMORY_TYPES.filter(
  (t) => !ALL_CHILDREN.includes(t)
)

export function uniqueTypeList<T extends string>(types: T[]): T[] {
  const seen = new Set<string>()
  return types.filter((type) => {
    if (seen.has(type)) return false
    seen.add(type)
    return true
  })
}

// Convert kebab-case to Title Case for custom types
function kebabToTitleCase(str: string): string {
  return str
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

// Get label for any type (built-in or custom)
export function getTypeLabel(type: string): string {
  return TYPE_LABELS[type as MemoryType] || kebabToTitleCase(type)
}

// Full type label showing parent > child when a parent_type exists
export function getFullTypeLabel(type: string, parentType?: string | null): string {
  if (parentType) {
    return `${getTypeLabel(parentType)} \u203A ${getTypeLabel(type)}`
  }
  return getTypeLabel(type)
}

// Label for dropdowns — appends ▸ to parent types that have children
export function typeDropdownLabel(type: MemoryType): string {
  const label = getTypeLabel(type)
  return type in TYPE_HIERARCHY ? `${label} \u25B8` : label
}

export function buildTypeHierarchy(
  items: Array<{ type: string; parent_type?: string; children?: string[] }>
): { hierarchy: Record<string, string[]>; childTypes: Set<string> } {
  const map = new Map<string, Set<string>>()
  const childTypes = new Set<string>()

  for (const item of items) {
    const children = Array.isArray(item.children) ? item.children.filter(Boolean) : []
    if (children.length > 0) {
      const set = map.get(item.type) ?? new Set<string>()
      for (const child of children) {
        set.add(child)
        childTypes.add(child)
      }
      map.set(item.type, set)
    }

    if (item.parent_type) {
      const set = map.get(item.parent_type) ?? new Set<string>()
      set.add(item.type)
      map.set(item.parent_type, set)
      childTypes.add(item.type)
    }
  }

  const hierarchy: Record<string, string[]> = {}
  for (const [parent, set] of map.entries()) {
    hierarchy[parent] = Array.from(set)
  }

  return { hierarchy, childTypes }
}


// Given a memory's type and parent_type, resolve the "primary" type for the dropdown
export function resolvePrimaryType(type: MemoryType, parentType?: string): MemoryType {
  // If memory has a parent_type, that's the primary type for the dropdown
  if (parentType) return parentType as MemoryType
  return type
}

// Given a memory's type and parent_type, resolve the subtype (or empty string if none)
export function resolveSubtype(type: MemoryType, parentType?: string): string {
  // If memory has a parent_type, then type is the subtype
  if (parentType) return type
  return ''
}
