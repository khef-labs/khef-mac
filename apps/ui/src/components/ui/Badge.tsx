import clsx from 'clsx'
import type { MemoryType, MemoryStatus } from '../../types'
import { getTypeLabel } from '../../lib/memoryTypes'
import styles from './Badge.module.css'

interface TypeBadgeProps {
  type: MemoryType
  parentType?: string
}

const typeLabels: Record<MemoryType, string> = {
  'user-note': 'Note',
  'assistant-note': 'Note',
  'project-note': 'Note',
  'user-todo': 'Todo',
  'assistant-todo': 'Todo',
  decision: 'Decision',
  command: 'Command',
  commands: 'Commands',
  context: 'Context',
  csv: 'CSV',
  api: 'API',
  pattern: 'Pattern',
  reference: 'Reference',
  'assistant-rule': 'Rule',
  diagram: 'Diagram',
  'google-doc': 'Google Doc',
  video: 'Video',
  canvas: 'Canvas',
  widget: 'Widget',
  animation: 'Animation',
  prototype: 'Prototype',
  quiz: 'Quiz',
  knowledge: 'Knowledge',
}

function getTypeVariant(type: MemoryType): string {
  if (type.includes('note')) return styles.note
  if (type.includes('todo')) return styles.todo
  if (type === 'decision') return styles.decision
  if (type === 'pattern') return styles.pattern
  if (type === 'context') return styles.context
  if (type === 'command' || type === 'commands') return styles.command
  if (type === 'api') return styles.api
  if (type === 'reference') return styles.reference
  if (type === 'assistant-rule') return styles.rule
  if (type === 'diagram') return styles.diagram
  if (type === 'csv') return styles.csv
  if (type === 'google-doc') return styles.reference
  if (type === 'video') return styles.video
  if (type === 'canvas' || type === 'widget' || type === 'animation' || type === 'prototype' || type === 'quiz') return styles.canvas
  if (type === 'knowledge') return styles.knowledge
  return styles.note
}

export function TypeBadge({ type, parentType }: TypeBadgeProps) {
  const parentLabel = parentType ? getTypeLabel(parentType) : undefined
  const typeLabel = typeLabels[type] || getTypeLabel(type)

  if (parentLabel) {
    return (
      <span class={clsx(styles.badge, getTypeVariant(type))} data-testid={`type-badge--${type}`}>
        <span class={styles.parentLabel}>{parentLabel}</span>
        <span class={styles.separator}>›</span>
        {typeLabel}
      </span>
    )
  }

  return (
    <span class={clsx(styles.badge, getTypeVariant(type))} data-testid={`type-badge--${type}`}>
      {typeLabel}
    </span>
  )
}

interface StatusBadgeProps {
  status: MemoryStatus
}

function getStatusVariant(status: string): string {
  switch (status) {
    case 'open':
    case 'draft':
    case 'unwatched':
      return styles.statusOpen
    case 'in_progress':
      return styles.statusInProgress
    case 'done':
    case 'accepted':
    case 'active':
    case 'current':
    case 'published':
    case 'verified':
    case 'watched':
    case 'synced':
      return styles.statusDone
    case 'blocked':
    case 'rejected':
    case 'deprecated':
    case 'outdated':
    case 'archived':
    case 'unlinked':
      return styles.statusBlocked
    case 'canceled':
    case 'superseded':
    case 'proposed':
    case 'updated':
    case 'unverified':
      return styles.statusCanceled
    default:
      return styles.statusCanceled
  }
}

const statusLabels: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  done: 'Done',
  blocked: 'Blocked',
  canceled: 'Canceled',
  proposed: 'Proposed',
  accepted: 'Accepted',
  rejected: 'Rejected',
  superseded: 'Superseded',
  active: 'Active',
  deprecated: 'Deprecated',
  current: 'Current',
  updated: 'Updated',
  outdated: 'Outdated',
  draft: 'Draft',
  published: 'Published',
  archived: 'Archived',
  verified: 'Verified',
  unverified: 'Unverified',
  unwatched: 'Unwatched',
  watched: 'Watched',
  synced: 'Synced',
  unlinked: 'Unlinked',
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span class={clsx(styles.badge, getStatusVariant(status))} data-testid={`status-badge--${status}`}>
      {statusLabels[status] || status}
    </span>
  )
}

interface TagBadgeProps {
  name: string
}

export function TagBadge({ name }: TagBadgeProps) {
  return <span class={clsx(styles.badge, styles.tag)} data-testid={`tag-badge--${name}`}>{name}</span>
}
