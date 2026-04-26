import { useState, useEffect, useCallback } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { ExternalLink, Link2, Loader2 } from 'lucide-preact'
import { getCollectionBoard, getMemory, updateCollection, updateMemoryStatus, updateMemory, getProjectMemoryTypes, deleteMemory, removeFromCollection } from '../../lib/api'
import { getFullTypeLabel } from '../../lib/memoryTypes'
import { setNavContext } from '../../lib/navContext'
import type { BoardColumn, CollectionMemoryItem } from '../../types'
import { useToast, ConfirmModal } from '../ui'
import { CollectionCardMenu } from './CollectionCardMenu'
import styles from './BoardView.module.css'

export interface BoardState {
  columns: BoardColumn[]
  hiddenColumns: string[]
  columnOrder: string[]
  onToggleColumn: (statusValue: string) => void
  onReorderColumns: (order: string[]) => void
}

interface Props {
  projectId: string
  collectionId: string
  filterText?: string
  typeFilter?: string
  onBoardReady?: (state: BoardState) => void
}

const TICKET_TYPES = new Set(['ticket', 'epic', 'story', 'spike', 'task'])

interface ParsedContent {
  checklist: { checked: boolean; text: string }[]
  description: string
}

function parseTicketContent(content: string): ParsedContent {
  const lines = content.split('\n')
  const checklist: { checked: boolean; text: string }[] = []
  const descLines: string[] = []

  for (const line of lines) {
    const checkMatch = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+)/)
    if (checkMatch) {
      checklist.push({
        checked: checkMatch[1] !== ' ',
        text: checkMatch[2].replace(/`([^`]+)`/g, '$1').trim(),
      })
    } else {
      // Skip headings and empty lines, keep plain text
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
        descLines.push(trimmed)
      }
    }
  }

  return { checklist, description: descLines.join(' ') }
}

const STATUS_COLORS: Record<string, string> = {
  backlog: 'var(--muted)',
  open: 'var(--accent)',
  in_progress: '#eab308',
  in_review: '#a855f7',
  blocked: '#ef4444',
  done: '#22c55e',
  canceled: 'var(--muted)',
  // Fallbacks for other status types
  proposed: 'var(--accent)',
  accepted: '#22c55e',
  rejected: '#ef4444',
  current: 'var(--accent)',
  draft: 'var(--muted)',
  active: '#22c55e',
  deprecated: '#f97316',
}

export function BoardView({ projectId, collectionId, filterText, typeFilter, onBoardReady }: Props) {
  const [, setLocation] = useLocation()
  const { showToast } = useToast()
  const [columns, setColumns] = useState<BoardColumn[]>([])
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([])
  const [columnOrder, setColumnOrder] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dragCardId, setDragCardId] = useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = useState<string | null>(null)
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null)
  const [expandedContent, setExpandedContent] = useState<ParsedContent | null>(null)
  const [isLoadingContent, setIsLoadingContent] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ memory: CollectionMemoryItem; position: { x: number; y: number } } | null>(null)
  const [removeTarget, setRemoveTarget] = useState<CollectionMemoryItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CollectionMemoryItem | null>(null)

  const loadBoard = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await getCollectionBoard(projectId, collectionId)
      const hidden = res.collection.board_config?.hiddenColumns || []
      const order = res.collection.board_config?.columnOrder || []
      setColumns(res.columns)
      setHiddenColumns(hidden)
      setColumnOrder(order)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load board')
    } finally {
      setIsLoading(false)
    }
  }, [projectId, collectionId])

  useEffect(() => {
    loadBoard()
  }, [loadBoard])

  useEffect(() => {
    if (columns.length > 0 && onBoardReady) {
      onBoardReady({ columns, hiddenColumns, columnOrder, onToggleColumn: handleToggleColumn, onReorderColumns: handleReorderColumns })
    }
  }, [columns, hiddenColumns, columnOrder])

  const handleReorderColumns = async (order: string[]) => {
    setColumnOrder(order)
    try {
      await updateCollection(projectId, collectionId, {
        board_config: { hiddenColumns, columnOrder: order },
      })
    } catch {
      setColumnOrder(columnOrder)
    }
  }

  const handleToggleColumn = async (statusValue: string) => {
    const next = hiddenColumns.includes(statusValue)
      ? hiddenColumns.filter(s => s !== statusValue)
      : [...hiddenColumns, statusValue]
    setHiddenColumns(next)
    try {
      await updateCollection(projectId, collectionId, {
        board_config: { hiddenColumns: next, columnOrder },
      })
    } catch {
      // Rollback
      setHiddenColumns(hiddenColumns)
    }
  }

  const sortedColumns = columnOrder.length > 0
    ? [
        ...columnOrder
          .map(sv => columns.find(c => c.status_value === sv))
          .filter(Boolean) as BoardColumn[],
        ...columns.filter(c => !columnOrder.includes(c.status_value)),
      ]
    : columns

  const visibleColumns = sortedColumns
    .filter(col => !hiddenColumns.includes(col.status_value))
    .map(col => {
      let mems = col.memories
      if (typeFilter) {
        mems = mems.filter(m => m.type === typeFilter || m.parent_type === typeFilter)
      }
      if (filterText?.trim()) {
        const q = filterText.trim().toLowerCase()
        mems = mems.filter(m =>
          m.title.toLowerCase().includes(q) ||
          (m.content_excerpt && m.content_excerpt.toLowerCase().includes(q)) ||
          m.tags.some(t => t.name.toLowerCase().includes(q))
        )
      }
      return mems === col.memories ? col : { ...col, memories: mems }
    })

  const handleDragStart = (e: DragEvent, cardId: string) => {
    if (!e.dataTransfer) return
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', cardId)
    setDragCardId(cardId)
  }

  const handleDragEnd = () => {
    setDragCardId(null)
    setDragOverCol(null)
  }

  const handleDragOver = (e: DragEvent, statusValue: string) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    setDragOverCol(statusValue)
  }

  const handleDragLeave = (e: DragEvent) => {
    // Only clear if leaving the column (not entering a child)
    const related = e.relatedTarget as HTMLElement | null
    if (related && (e.currentTarget as HTMLElement).contains(related)) return
    setDragOverCol(null)
  }

  const handleDrop = async (e: DragEvent, targetStatus: string) => {
    e.preventDefault()
    setDragOverCol(null)
    const cardId = e.dataTransfer?.getData('text/plain')
    if (!cardId) return

    // Find the card and its current column
    let sourceCol: BoardColumn | undefined
    let card: CollectionMemoryItem | undefined
    for (const col of columns) {
      const found = col.memories.find(m => m.id === cardId)
      if (found) {
        sourceCol = col
        card = found
        break
      }
    }

    if (!card || !sourceCol || sourceCol.status_value === targetStatus) return

    // Optimistic update
    const prevColumns = columns
    setColumns(cols => cols.map(col => {
      if (col.status_value === sourceCol!.status_value) {
        return { ...col, memories: col.memories.filter(m => m.id !== cardId) }
      }
      if (col.status_value === targetStatus) {
        return { ...col, memories: [...col.memories, { ...card!, status: targetStatus }] }
      }
      return col
    }))

    try {
      await updateMemoryStatus(projectId, cardId, targetStatus)
      showToast(`Moved to ${columns.find(c => c.status_value === targetStatus)?.display_name || targetStatus}`)
    } catch (err) {
      // Rollback
      setColumns(prevColumns)
      setError(err instanceof Error ? err.message : 'Failed to update status')
    }
  }

  const handleCardClick = async (e: MouseEvent, mem: CollectionMemoryItem) => {
    e.preventDefault()
    const isTicket = TICKET_TYPES.has(mem.type) || (mem.parent_type && TICKET_TYPES.has(mem.parent_type))

    if (isTicket) {
      if (expandedCardId === mem.id) {
        setExpandedCardId(null)
        setExpandedContent(null)
        return
      }
      setExpandedCardId(mem.id)
      setExpandedContent(null)
      setIsLoadingContent(true)
      try {
        const full = await getMemory(mem.id)
        setExpandedContent(parseTicketContent(full.content || ''))
      } catch {
        setExpandedContent({ checklist: [], description: 'Failed to load content' })
      } finally {
        setIsLoadingContent(false)
      }
    } else {
      const allMemIds = columns.flatMap(col => col.memories.map(m => m.id))
      const source = `/projects/${projectId}/collections/${collectionId}`
      setNavContext(allMemIds, mem.id, source)
      setLocation(`/memories/${mem.id}?context=collection&contextId=${collectionId}`)
    }
  }

  const handleOpenMemory = (e: MouseEvent) => {
    e.stopPropagation()
    // Let the native <a target="_blank"> handle it
  }

  const handleCardContextMenu = (e: MouseEvent, mem: CollectionMemoryItem) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ memory: mem, position: { x: e.clientX, y: e.clientY } })
  }

  const handleContextTypeChange = async (memoryId: string, type: string) => {
    // Find the card
    let card: CollectionMemoryItem | undefined
    for (const col of columns) {
      card = col.memories.find(m => m.id === memoryId)
      if (card) break
    }
    if (!card || card.type === type) return
    try {
      const data = await getProjectMemoryTypes(projectId)
      const info = data?.memory_types.find((t: any) => t.type === type)
      const statusValues = info?.statuses?.map((s: any) => s.value).filter(Boolean) || []
      const nextStatus = statusValues.includes(card.status) ? card.status : statusValues[0] || card.status
      await updateMemory(projectId, memoryId, { type: type as any, status: nextStatus as any })
      // Reload board since type change may affect column grouping
      loadBoard()
      showToast(`Type changed to ${type}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change type')
    }
  }

  const handleContextStatusChange = async (memoryId: string, status: string) => {
    const prevColumns = columns
    // Optimistic: move card to new column
    setColumns(cols => {
      let card: CollectionMemoryItem | undefined
      const updated = cols.map(col => {
        const found = col.memories.find(m => m.id === memoryId)
        if (found) {
          card = { ...found, status }
          return { ...col, memories: col.memories.filter(m => m.id !== memoryId) }
        }
        return col
      })
      if (card) {
        return updated.map(col =>
          col.status_value === status
            ? { ...col, memories: [...col.memories, card!] }
            : col
        )
      }
      return updated
    })
    try {
      await updateMemoryStatus(projectId, memoryId, status)
      showToast(`Status changed to ${status}`)
    } catch (err) {
      setColumns(prevColumns)
      setError(err instanceof Error ? err.message : 'Failed to update status')
    }
  }

  const handleContextRemove = async () => {
    if (!removeTarget) return
    try {
      await removeFromCollection(projectId, collectionId, removeTarget.id)
      setColumns(cols => cols.map(col => ({
        ...col,
        memories: col.memories.filter(m => m.id !== removeTarget.id),
      })))
      showToast('Memory removed from collection')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove memory')
    } finally {
      setRemoveTarget(null)
    }
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    try {
      await deleteMemory(projectId, deleteTarget.id)
      setColumns(cols => cols.map(col => ({
        ...col,
        memories: col.memories.filter(m => m.id !== deleteTarget.id),
      })))
      showToast('Memory deleted')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete memory')
    } finally {
      setDeleteTarget(null)
    }
  }

  if (isLoading) {
    return <div class={styles.loading}>Loading board...</div>
  }

  if (error) {
    return <div class={styles.error}>{error}</div>
  }

  if (columns.length === 0) {
    return <div class={styles.empty}>No memories in this collection yet. Add memories to see them on the board.</div>
  }

  return (
    <div>
      {contextMenu && (
        <CollectionCardMenu
          memory={contextMenu.memory}
          projectId={projectId}
          position={contextMenu.position}
          onChangeType={handleContextTypeChange}
          onChangeStatus={handleContextStatusChange}
          onRemove={(mem) => { setRemoveTarget(mem) }}
          onDelete={(mem) => setDeleteTarget(mem)}
          onClose={() => setContextMenu(null)}
          onShowToast={showToast}
        />
      )}
      {removeTarget && (
        <ConfirmModal
          title="Remove from Collection"
          message={`Remove "${removeTarget.title}" from this collection? The memory itself won't be deleted.`}
          confirmLabel="Remove"
          variant="danger"
          onConfirm={handleContextRemove}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
      {deleteTarget && (
        <ConfirmModal
          title="Delete Memory"
          message={`Permanently delete "${deleteTarget.title}"? This cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      <div class={styles.board}>
      {visibleColumns.map(col => (
        <div key={col.status_value} class={styles.column}>
          <div class={styles.columnHeader}>
            <span
              class={styles.columnDot}
              style={{ background: STATUS_COLORS[col.status_value] || 'var(--muted)' }}
            />
            <span class={styles.columnTitle}>{col.display_name}</span>
            <span class={styles.columnCount}>{col.memories.length}</span>
          </div>

          <div
            class={`${styles.columnCards} ${dragOverCol === col.status_value ? styles.dragOver : ''}`}
            onDragOver={(e) => handleDragOver(e, col.status_value)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, col.status_value)}
          >
            {col.memories.map(mem => {
              const isExpanded = expandedCardId === mem.id
              return (
                <div
                  key={mem.id}
                  class={`${styles.card} ${dragCardId === mem.id ? styles.dragging : ''} ${isExpanded ? styles.cardExpanded : ''}`}
                  draggable={!isExpanded}
                  onDragStart={(e) => handleDragStart(e, mem.id)}
                  onDragEnd={handleDragEnd}
                  onClick={(e) => handleCardClick(e, mem)}
                  onContextMenu={(e) => handleCardContextMenu(e, mem)}
                >
                  <div class={styles.cardHeader}>
                    <div class={styles.cardTitle}>{mem.title}</div>
                    {isExpanded && (
                      <a
                        href={`/memories/${mem.id}`}
                        target="_blank"
                        rel="noopener"
                        class={styles.cardOpenLink}
                        onClick={handleOpenMemory}
                        title="Open memory"
                      >
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                  {!isExpanded && mem.content_excerpt && (
                    <div class={styles.cardDesc}>{mem.content_excerpt}</div>
                  )}
                  {isExpanded && (
                    <div class={styles.cardContent}>
                      {isLoadingContent ? (
                        <div class={styles.cardLoading}><Loader2 size={14} class="spin" /></div>
                      ) : expandedContent ? (
                        <>
                          {expandedContent.checklist.length > 0 && (
                            <ul class={styles.checklist}>
                              {expandedContent.checklist.map((item, i) => (
                                <li key={i} class={styles.checkItem}>
                                  <input type="checkbox" checked={item.checked} disabled />
                                  <span class={item.checked ? styles.checkDone : ''}>{item.text}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {expandedContent.description && (
                            <p class={styles.cardDescExpanded}>{expandedContent.description}</p>
                          )}
                        </>
                      ) : null}
                    </div>
                  )}
                  <div class={styles.cardFooter}>
                    {mem.metadata?.['external-source-url'] && (
                      <a
                        href={mem.metadata['external-source-url']}
                        target="_blank"
                        rel="noopener"
                        class={styles.cardExternalPill}
                        onClick={(e) => e.stopPropagation()}
                        title={mem.metadata['external-source-url']}
                      >
                        <Link2 size={10} />
                        {mem.metadata['external-source-id'] || mem.metadata['external-source-type'] || 'link'}
                      </a>
                    )}
                    {mem.display_project && (
                      <span class={styles.cardProject}>{mem.display_project}</span>
                    )}
                    <span class={styles.cardType}>{getFullTypeLabel(mem.type, mem.parent_type)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
      </div>
    </div>
  )
}
