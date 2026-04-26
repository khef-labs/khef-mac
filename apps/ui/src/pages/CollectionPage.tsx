import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import {
  ChevronUp, ChevronDown, Pencil, X, Plus, Search, Trash2, Check, Layers, ChevronRight,
} from 'lucide-preact'
import {
  getCollection,
  updateCollection,
  createCollection,
  deleteCollection,
  removeFromCollection,
  reorderCollection,
  searchMemories,
  addToCollection,
  updateMemoryStatus,
  updateMemory,
  deleteMemory,
  getProjectMemoryTypes,
} from '../lib/api'
import type { CollectionDetail, CollectionMemoryItem, CollectionViewMode } from '../types'
import { ConfirmModal, CopyButton, useToast, SortBar } from '../components/ui'
import type { SortState } from '../components/ui'
import { setNavContext } from '../lib/navContext'
import { useDebounce } from '../hooks/useDebounce'
import { getTypeLabel, getFullTypeLabel } from '../lib/memoryTypes'
import { ViewModeToggle } from '../components/collection/ViewModeToggle'
import { BoardView } from '../components/collection/BoardView'
import type { BoardState } from '../components/collection/BoardView'
import { ColumnFilter } from '../components/collection/ColumnFilter'
import { MemoryPreviewModal } from '../components/collection/MemoryPreviewModal'
import { CollectionCardMenu } from '../components/collection/CollectionCardMenu'
import type { SortField } from '../components/ui'
import { useDocumentTitle } from '../hooks'
import styles from './CollectionPage.module.css'

const SORT_FIELDS: SortField[] = [
  { key: 'position', label: 'Order' },
  { key: 'slide_order', label: 'Slide' },
  { key: 'title', label: 'Title' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'updated_at', label: 'Updated' },
  { key: 'created_at', label: 'Created' },
  { key: 'added_at', label: 'Added' },
]

interface Props {
  projectId: string
  collectionId: string
}

function formatDate(dateString: string): string {
  const date = new Date(dateString)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

interface SearchResult {
  id: string
  handle: string
  title: string
  type: string
  status: string | null
  content_excerpt: string
}

export function CollectionPage({ projectId, collectionId }: Props) {
  const [, setLocation] = useLocation()
  const { showToast } = useToast()
  const [collection, setCollection] = useState<CollectionDetail | null>(null)
  const [parentCollection, setParentCollection] = useState<{ id: string; name: string } | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isDetailsCollapsed, setIsDetailsCollapsed] = useState(true)
  const [isEditingName, setIsEditingName] = useState(false)
  const [editName, setEditName] = useState('')
  const [isEditingDesc, setIsEditingDesc] = useState(false)
  const [editDesc, setEditDesc] = useState('')
  const [removeTarget, setRemoveTarget] = useState<CollectionMemoryItem | null>(null)

  // Search, type filter, and sort
  const [filterText, setFilterText] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [sort, setSort] = useState<SortState>({ field: 'position', direction: 'asc' })

  const typeOptions = useMemo(() => {
    if (!collection) return []
    const types = new Set(collection.memories.map((m) => m.type))
    return Array.from(types).sort((a, b) => getTypeLabel(a).localeCompare(getTypeLabel(b)))
  }, [collection])

  const filteredMemories = useMemo(() => {
    if (!collection) return []
    let result = collection.memories
    if (typeFilter) {
      result = result.filter((m) => m.type === typeFilter)
    }
    if (filterText.trim()) {
      const q = filterText.trim().toLowerCase()
      result = result.filter((m) =>
        m.title.toLowerCase().includes(q) ||
        (m.content_excerpt && m.content_excerpt.toLowerCase().includes(q)) ||
        m.tags.some((t) => t.name.toLowerCase().includes(q))
      )
    }
    if (sort.field !== 'position') {
      const dir = sort.direction === 'desc' ? -1 : 1
      result = [...result].sort((a, b) => {
        switch (sort.field) {
          case 'slide_order': {
            const aVal = Number(a.metadata?.['slide-order'])
            const bVal = Number(b.metadata?.['slide-order'])
            const aNum = Number.isFinite(aVal) ? aVal : Number.POSITIVE_INFINITY
            const bNum = Number.isFinite(bVal) ? bVal : Number.POSITIVE_INFINITY
            return dir * (aNum !== bNum ? aNum - bNum : a.title.localeCompare(b.title))
          }
          case 'title':
            return dir * a.title.localeCompare(b.title)
          case 'type':
            return dir * getTypeLabel(a.type).localeCompare(getTypeLabel(b.type))
          case 'status':
            return dir * (a.status || '').localeCompare(b.status || '')
          case 'updated_at':
            return dir * (new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime())
          case 'created_at':
            return dir * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
          case 'added_at':
            return dir * (new Date(a.added_at).getTime() - new Date(b.added_at).getTime())
          default:
            return 0
        }
      })
    } else if (sort.direction === 'desc') {
      result = [...result].reverse()
    }
    return result
  }, [collection, typeFilter, filterText, sort])

  // Board state (for toolbar filter)
  const [boardState, setBoardState] = useState<BoardState | null>(null)

  // Delete collection
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Sub-collection creation
  const [showSubForm, setShowSubForm] = useState(false)
  const [subName, setSubName] = useState('')
  const [subViewMode, setSubViewMode] = useState<CollectionViewMode>('board')

  // Preview modal state (grid view)
  const [previewMemory, setPreviewMemory] = useState<CollectionMemoryItem | null>(null)

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ memory: CollectionMemoryItem; position: { x: number; y: number } } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CollectionMemoryItem | null>(null)

  // Add memory modal state
  const [showAddModal, setShowAddModal] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [addingMemoryId, setAddingMemoryId] = useState<string | null>(null)
  useDocumentTitle(collection?.name ? `Collection - ${collection.name}` : 'Collection - Loading')

  const debouncedQuery = useDebounce(searchQuery, 300)

  const loadCollection = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await getCollection(projectId, collectionId)
      setCollection(res.collection)
      // Fetch parent name if this is a sub-collection
      if (res.collection.parent_id) {
        const parentRes = await getCollection(projectId, res.collection.parent_id)
        setParentCollection({ id: parentRes.collection.id, name: parentRes.collection.name })
      } else {
        setParentCollection(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load collection')
    } finally {
      setIsLoading(false)
    }
  }, [projectId, collectionId])

  useEffect(() => {
    loadCollection()
  }, [loadCollection])

  // Auto-search when debounced query changes and is 3+ chars
  useEffect(() => {
    if (!showAddModal) return
    if (debouncedQuery.trim().length < 3) {
      setSearchResults([])
      return
    }
    performSearch(debouncedQuery)
  }, [debouncedQuery, showAddModal])

  const performSearch = async (q: string) => {
    setIsSearching(true)
    try {
      const res = await searchMemories({
        project_id: projectId,
        q,
        limit: 10,
        compact: true,
      })
      const existingIds = new Set(collection?.memories.map((m) => m.id) || [])
      const filtered = (res.memories || [])
        .filter((m: any) => !existingIds.has(m.id))
        .map((m: any) => ({
          id: m.id,
          handle: m.handle,
          title: m.title,
          type: m.type,
          status: m.status,
          content_excerpt: m.content_excerpt || '',
        }))
      setSearchResults(filtered)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setIsSearching(false)
    }
  }

  const handleSaveName = async () => {
    if (!collection || !editName.trim()) return
    try {
      await updateCollection(projectId, collectionId, { name: editName.trim() })
      setCollection({ ...collection, name: editName.trim() })
      setIsEditingName(false)
      showToast('Name updated')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update name')
    }
  }

  const handleSaveDesc = async () => {
    if (!collection) return
    try {
      const desc = editDesc.trim() || null
      await updateCollection(projectId, collectionId, { description: desc })
      setCollection({ ...collection, description: desc })
      setIsEditingDesc(false)
      showToast('Description updated')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update description')
    }
  }

  const handleMove = async (index: number, direction: 'up' | 'down') => {
    if (!collection) return
    const memories = [...collection.memories]
    const targetIdx = direction === 'up' ? index - 1 : index + 1
    if (targetIdx < 0 || targetIdx >= memories.length) return

    const temp = memories[index]
    memories[index] = memories[targetIdx]
    memories[targetIdx] = temp

    const reordered = memories.map((m, i) => ({ ...m, position: i }))
    setCollection({ ...collection, memories: reordered })

    try {
      await reorderCollection(
        projectId,
        collectionId,
        reordered.map((m) => ({ memory_id: m.id, position: m.position }))
      )
    } catch (err) {
      loadCollection()
      setError(err instanceof Error ? err.message : 'Failed to reorder')
    }
  }

  const handleRemove = async () => {
    if (!removeTarget || !collection) return
    try {
      await removeFromCollection(projectId, collectionId, removeTarget.id)
      setCollection({
        ...collection,
        memories: collection.memories.filter((m) => m.id !== removeTarget.id),
        memory_count: collection.memory_count - 1,
      })
      showToast('Memory removed from collection')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove memory')
    } finally {
      setRemoveTarget(null)
    }
  }

  const handleAddMemory = async (memoryId: string) => {
    if (!collection) return
    setAddingMemoryId(memoryId)
    try {
      await addToCollection(projectId, collectionId, memoryId)
      setSearchResults((prev) => prev.filter((r) => r.id !== memoryId))
      showToast('Memory added to collection')
      loadCollection()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add memory')
    } finally {
      setAddingMemoryId(null)
    }
  }

  const handleMemoryClick = (memoryId: string) => {
    if (!collection) return
    const ids = filteredMemories.map((m) => m.id)
    const source = `/projects/${projectId}/collections/${collectionId}`
    setNavContext(ids, memoryId, source)
    setLocation(`/memories/${memoryId}?context=collection&contextId=${collectionId}`)
  }

  const handleViewModeChange = async (mode: CollectionViewMode) => {
    if (!collection) return
    setCollection({ ...collection, view_mode: mode })
    try {
      await updateCollection(projectId, collectionId, { view_mode: mode })
    } catch (err) {
      // Rollback on failure
      setCollection({ ...collection })
    }
  }

  const handleCardContextMenu = (e: MouseEvent, memory: CollectionMemoryItem) => {
    e.preventDefault()
    setContextMenu({ memory, position: { x: e.clientX, y: e.clientY } })
  }

  const handleContextTypeChange = async (memoryId: string, type: string) => {
    if (!collection) return
    const mem = collection.memories.find((m) => m.id === memoryId)
    if (!mem || mem.type === type) return
    try {
      // Resolve a valid status for the new type
      const data = await getProjectMemoryTypes(projectId)
      const info = data?.memory_types.find((t: any) => t.type === type)
      const statusValues = info?.statuses?.map((s: any) => s.value).filter(Boolean) || []
      const nextStatus = statusValues.includes(mem.status) ? mem.status : statusValues[0] || mem.status
      await updateMemory(projectId, memoryId, { type: type as any, status: nextStatus as any })
      setCollection({
        ...collection,
        memories: collection.memories.map((m) =>
          m.id === memoryId ? { ...m, type, status: nextStatus } : m
        ),
      })
      showToast(`Type changed to ${type}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change type')
    }
  }

  const handleContextStatusChange = async (memoryId: string, status: string) => {
    if (!collection) return
    try {
      await updateMemoryStatus(projectId, memoryId, status)
      setCollection({
        ...collection,
        memories: collection.memories.map((m) =>
          m.id === memoryId ? { ...m, status } : m
        ),
      })
      showToast(`Status changed to ${status}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status')
    }
  }

  const handleConfirmDelete = async () => {
    if (!collection || !deleteTarget) return
    try {
      await deleteMemory(projectId, deleteTarget.id)
      setCollection({
        ...collection,
        memories: collection.memories.filter((m) => m.id !== deleteTarget.id),
        memory_count: collection.memory_count - 1,
      })
      showToast('Memory deleted')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete memory')
    } finally {
      setDeleteTarget(null)
    }
  }

  const handleDeleteCollection = async () => {
    if (!collection) return
    try {
      await deleteCollection(projectId, collectionId)
      showToast('Collection deleted')
      if (parentCollection) {
        setLocation(`/projects/${projectId}/collections/${parentCollection.id}`)
      } else {
        setLocation(`/projects/${projectId}/collections`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete collection')
    } finally {
      setShowDeleteConfirm(false)
    }
  }

  const handleCreateSub = async () => {
    if (!collection || !subName.trim()) return
    const handle = subName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (!handle) return
    try {
      await createCollection(projectId, {
        handle,
        name: subName.trim(),
        parent_id: collection.id,
        view_mode: subViewMode,
      })
      setSubName('')
      setShowSubForm(false)
      showToast('Sub-collection created')
      loadCollection()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create sub-collection')
    }
  }

  const openAddModal = () => {
    setSearchQuery('')
    setSearchResults([])
    setShowAddModal(true)
  }

  const closeAddModal = () => {
    setShowAddModal(false)
    setSearchQuery('')
    setSearchResults([])
  }

  if (isLoading) {
    return (
      <div class={styles.page}>
        <div class={styles.loading}>Loading collection...</div>
      </div>
    )
  }

  if (!collection) {
    return (
      <div class={styles.page}>
        <div class={styles.error}>{error || 'Collection not found'}</div>
      </div>
    )
  }

  return (
    <div class={collection.view_mode === 'board' ? styles.pageWide : styles.page}>
      <header class={styles.header}>
        <nav class={styles.breadcrumb}>
          <a
            href={`/projects/${projectId}`}
            onClick={(e) => { e.preventDefault(); setLocation(`/projects/${projectId}`) }}
          >
            Project
          </a>
          <span class={styles.breadcrumbSep}>/</span>
          <a
            href={`/projects/${projectId}/collections`}
            onClick={(e) => { e.preventDefault(); setLocation(`/projects/${projectId}/collections`) }}
          >
            Collections
          </a>
          {parentCollection && (
            <>
              <span class={styles.breadcrumbSep}>/</span>
              <a
                href={`/projects/${projectId}/collections/${parentCollection.id}`}
                onClick={(e) => { e.preventDefault(); setLocation(`/projects/${projectId}/collections/${parentCollection.id}`) }}
              >
                {parentCollection.name}
              </a>
            </>
          )}
        </nav>

        <div class={styles.titleRow}>
          {isEditingName ? (
            <div class={styles.editRow}>
              <input
                type="text"
                class={styles.editInput}
                value={editName}
                onInput={(e) => setEditName((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveName()
                  if (e.key === 'Escape') setIsEditingName(false)
                }}
                autoFocus
              />
              <button class={styles.iconBtn} onClick={handleSaveName} title="Save">
                <Check size={16} />
              </button>
              <button class={styles.iconBtn} onClick={() => setIsEditingName(false)} title="Cancel">
                <X size={16} />
              </button>
            </div>
          ) : (
            <h1
              class={styles.title}
              onClick={() => {
                setEditName(collection.name)
                setIsEditingName(true)
              }}
              title="Click to edit"
            >
              <Layers size={22} />
              {collection.name}
              <Pencil size={14} class={styles.editHint} />
            </h1>
          )}
        </div>

      </header>

      {/* Collapsible Details Panel */}
      <div class={styles.detailsSection}>
        <button
          class={styles.detailsToggle}
          onClick={() => setIsDetailsCollapsed(!isDetailsCollapsed)}
        >
          <ChevronRight
            size={14}
            class={`${styles.detailsChevron} ${!isDetailsCollapsed ? styles.detailsChevronOpen : ''}`}
          />
          <span class={styles.detailsLabel}>Details</span>
        </button>

        {isDetailsCollapsed ? (
          <div
            class={styles.detailsCollapsed}
            onClick={() => setIsDetailsCollapsed(false)}
          >
            {collection.description && (
              <span class={styles.detailsCollapsedItem}>
                <span class={styles.detailsCollapsedDesc}>{collection.description}</span>
              </span>
            )}
            <span class={styles.detailsCollapsedItem}>
              <span class={styles.detailsCollapsedLabel}>Updated</span>
              <span>{formatDate(collection.updated_at)}</span>
            </span>
            <span class={styles.detailsCollapsedItem}>
              <span class={styles.detailsCollapsedLabel}>Memories</span>
              <span>{collection.memories.length}</span>
            </span>
            <span class={styles.detailsCollapsedItem} onClick={(e) => e.stopPropagation()}>
              <span class={styles.detailsCollapsedId}>{collection.id.slice(0, 12)}...</span>
              <CopyButton text={collection.id} title="Copy collection ID" size={12} />
            </span>
          </div>
        ) : (
          <div class={styles.detailsExpanded}>
            <div class={styles.detailsRow}>
              <span class={styles.detailsRowLabel}>Handle</span>
              <span class={styles.handle}>{collection.handle}</span>
            </div>
            <div class={styles.detailsRow}>
              <span class={styles.detailsRowLabel}>ID</span>
              <span class={styles.detailsRowValue}>
                {collection.id.slice(0, 12)}...
                <CopyButton text={collection.id} title="Copy collection ID" size={12} />
              </span>
            </div>
            <div class={styles.detailsRow}>
              <span class={styles.detailsRowLabel}>View Mode</span>
              <span>{collection.view_mode}</span>
            </div>
            <div class={styles.detailsRow}>
              <span class={styles.detailsRowLabel}>Memories</span>
              <span>{collection.memories.length}</span>
            </div>
            <div class={styles.detailsRow}>
              <span class={styles.detailsRowLabel}>Created</span>
              <span>{formatDate(collection.created_at)}</span>
            </div>
            <div class={styles.detailsRow}>
              <span class={styles.detailsRowLabel}>Updated</span>
              <span>{formatDate(collection.updated_at)}</span>
            </div>
            <div class={styles.detailsRow}>
              <span class={styles.detailsRowLabel}>Description</span>
              {isEditingDesc ? (
                <div class={styles.editRow}>
                  <input
                    type="text"
                    class={styles.editInput}
                    placeholder="Description (optional)"
                    value={editDesc}
                    onInput={(e) => setEditDesc((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveDesc()
                      if (e.key === 'Escape') setIsEditingDesc(false)
                    }}
                    autoFocus
                  />
                  <button class={styles.iconBtn} onClick={handleSaveDesc} title="Save">
                    <Check size={16} />
                  </button>
                  <button class={styles.iconBtn} onClick={() => setIsEditingDesc(false)} title="Cancel">
                    <X size={16} />
                  </button>
                </div>
              ) : (
                <span
                  class={styles.detailsDescValue}
                  onClick={() => {
                    setEditDesc(collection.description || '')
                    setIsEditingDesc(true)
                  }}
                  title="Click to edit"
                >
                  {collection.description || 'No description'}
                  <Pencil size={12} class={styles.editHint} />
                </span>
              )}
            </div>
            <div class={styles.detailsActions}>
              <button
                class={styles.deleteBtn}
                onClick={() => setShowDeleteConfirm(true)}
              >
                <Trash2 size={14} />
                Delete Collection
              </button>
            </div>
          </div>
        )}
      </div>

      {(collection.children?.length > 0 || !collection.parent_id) && (
        <div class={styles.childChips}>
          {collection.children?.map(child => (
            <a
              key={child.id}
              href={`/projects/${projectId}/collections/${child.id}`}
              class={styles.childChip}
              onClick={(e) => { e.preventDefault(); setLocation(`/projects/${projectId}/collections/${child.id}`) }}
            >
              <span class={styles.childChipName}>{child.name}</span>
              <span class={styles.childChipCount}>{child.memory_count}</span>
            </a>
          ))}
          {!collection.parent_id && !showSubForm && (
            <button class={styles.childChipAdd} onClick={() => setShowSubForm(true)}>+ Add</button>
          )}
        </div>
      )}

      {showSubForm && (
        <div class={styles.subCreateForm}>
          <input
            type="text"
            class={styles.subCreateInput}
            placeholder="Sub-collection name"
            value={subName}
            onInput={(e) => setSubName((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateSub()
              if (e.key === 'Escape') { setShowSubForm(false); setSubName('') }
            }}
            autoFocus
          />
          <div class={styles.subViewPicker}>
            {(['list', 'board', 'grid'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                class={`${styles.subViewBtn} ${subViewMode === mode ? styles.subViewBtnActive : ''}`}
                onClick={() => setSubViewMode(mode)}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
          <button class={styles.subCreateSubmit} onClick={handleCreateSub} disabled={!subName.trim()}>Create</button>
          <button class={styles.subCreateCancel} onClick={() => { setShowSubForm(false); setSubName('') }}>Cancel</button>
        </div>
      )}

      {error && <div class={styles.error}>{error}</div>}

      <div class={styles.toolbar}>
        <ViewModeToggle value={collection.view_mode} onChange={handleViewModeChange} />
        {collection.view_mode !== 'board' && (
          <SortBar fields={SORT_FIELDS} value={sort} onChange={setSort} />
        )}
        {collection.view_mode === 'board' && boardState && (
          <ColumnFilter
            columns={boardState.columns}
            hiddenColumns={boardState.hiddenColumns}
            columnOrder={boardState.columnOrder}
            onToggle={boardState.onToggleColumn}
            onReorder={boardState.onReorderColumns}
          />
        )}
        <div class={styles.filterSearch}>
          <Search size={16} class={styles.filterSearchIcon} />
          <input
            type="text"
            class={styles.filterSearchInput}
            placeholder="Filter memories..."
            value={filterText}
            onInput={(e) => setFilterText((e.target as HTMLInputElement).value)}
          />
          {filterText && (
            <button
              class={styles.filterSearchClear}
              onClick={() => setFilterText('')}
              aria-label="Clear filter"
            >
              <X size={14} />
            </button>
          )}
        </div>
        {typeOptions.length > 1 && (
          <select
            class={styles.typeSelect}
            value={typeFilter}
            onChange={(e) => setTypeFilter((e.target as HTMLSelectElement).value)}
          >
            <option value="">All types</option>
            {typeOptions.map((t) => (
              <option key={t} value={t}>{getTypeLabel(t)}</option>
            ))}
          </select>
        )}
        <button
          class={styles.addButton}
          onClick={openAddModal}
          title="Add Memory"
        >
          <Plus size={16} />
        </button>
      </div>

      {collection.view_mode === 'board' ? (
        <BoardView projectId={projectId} collectionId={collectionId} filterText={filterText} typeFilter={typeFilter} onBoardReady={setBoardState} />
      ) : collection.view_mode === 'grid' && filteredMemories.length > 0 ? (
        <div class={styles.memoryGrid}>
          {filteredMemories.map((memory) => (
            <div
              key={memory.id}
              class={styles.gridCard}
              onClick={() => setPreviewMemory(memory)}
              onContextMenu={(e) => handleCardContextMenu(e, memory)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') setPreviewMemory(memory) }}
            >
              <h3 class={styles.gridCardTitle}>{memory.title}</h3>
              {memory.content_excerpt && (
                <div class={styles.gridCardDesc}>{memory.content_excerpt}</div>
              )}
              <div class={styles.gridCardFooter}>
                {memory.display_project && (
                  <span class={styles.gridCardProject}>{memory.display_project}</span>
                )}
                <span class={styles.gridCardType}>{getFullTypeLabel(memory.type, memory.parent_type)}</span>
                {memory.status && <span class={styles.gridCardStatus}>{memory.status}</span>}
              </div>
            </div>
          ))}
        </div>
      ) : collection.memories.length === 0 ? (
        <div class={styles.empty}>
          <Layers size={36} />
          <p>No memories in this collection yet</p>
          <p class={styles.hint}>Use "Add Memory" to search and add memories</p>
        </div>
      ) : filteredMemories.length === 0 ? (
        <div class={styles.empty}>
          <p>No matching memories{typeFilter ? ` of type ${getTypeLabel(typeFilter)}` : ''}</p>
        </div>
      ) : (
        <div class={styles.memoryList}>
          {filteredMemories.map((memory, index) => (
            <div key={memory.id} class={styles.memoryItem}>
              {sort.field === 'position' && (
                <div class={styles.reorderButtons}>
                  <button
                    class={styles.moveBtn}
                    onClick={() => handleMove(index, 'up')}
                    disabled={index === 0}
                    title="Move up"
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    class={styles.moveBtn}
                    onClick={() => handleMove(index, 'down')}
                    disabled={index === filteredMemories.length - 1}
                    title="Move down"
                  >
                    <ChevronDown size={14} />
                  </button>
                </div>
              )}

              <a
                href={`/memories/${memory.id}`}
                class={styles.memoryContent}
                onClick={(e) => {
                  e.preventDefault()
                  handleMemoryClick(memory.id)
                }}
              >
                <div class={styles.memoryHeader}>
                  <span class={styles.memoryType}>{getTypeLabel(memory.type as any)}</span>
                  {memory.status && <span class={styles.memoryStatus}>{memory.status}</span>}
                </div>
                <h3 class={styles.memoryTitle}>{memory.title}</h3>
                {memory.content_excerpt && (
                  <p class={styles.memoryExcerpt}>{memory.content_excerpt}</p>
                )}
                {memory.tags.length > 0 && (
                  <div class={styles.memoryTags}>
                    {memory.tags.map((tag) => (
                      <span key={tag.id} class={styles.tag}>{tag.name}</span>
                    ))}
                  </div>
                )}
              </a>

              <button
                class={styles.removeBtn}
                onClick={() => setRemoveTarget(memory)}
                title="Remove from collection"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {removeTarget && (
        <ConfirmModal
          title="Remove from Collection"
          message={`Remove "${removeTarget.title}" from this collection? The memory itself won't be deleted.`}
          confirmLabel="Remove"
          variant="danger"
          onConfirm={handleRemove}
          onCancel={() => setRemoveTarget(null)}
        />
      )}

      {showDeleteConfirm && collection && (
        <ConfirmModal
          title="Delete Collection"
          message={
            collection.children && collection.children.length > 0
              ? `Delete "${collection.name}" and its sub-collections?\n\n${collection.children.map(c => `  • ${c.name} (${c.memory_count} memories)`).join('\n')}\n\nMemories won't be deleted — only the collection grouping.`
              : `Delete "${collection.name}"? Memories won't be deleted — only the collection grouping.`
          }
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDeleteCollection}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {/* Context menu (grid view) */}
      {contextMenu && (
        <CollectionCardMenu
          memory={contextMenu.memory}
          projectId={projectId}
          position={contextMenu.position}
          onChangeType={handleContextTypeChange}
          onChangeStatus={handleContextStatusChange}
          onRemove={(mem) => setRemoveTarget(mem)}
          onDelete={(mem) => setDeleteTarget(mem)}
          onClose={() => setContextMenu(null)}
          onShowToast={showToast}
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

      {/* Memory Preview Modal (grid view) */}
      {previewMemory && (
        <MemoryPreviewModal
          memory={previewMemory}
          projectId={projectId}
          onClose={() => setPreviewMemory(null)}
          onOpen={(memoryId) => {
            setPreviewMemory(null)
            handleMemoryClick(memoryId)
          }}
        />
      )}

      {/* Add Memory Modal */}
      {showAddModal && (
        <div class={styles.modalOverlay} onClick={closeAddModal}>
          <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div class={styles.modalHeader}>
              <h3 class={styles.modalTitle}>Add Memory</h3>
              <button class={styles.modalClose} onClick={closeAddModal} aria-label="Close">
                <X size={20} />
              </button>
            </div>
            <div class={styles.modalBody}>
              <div class={styles.searchRow}>
                <div class={styles.searchWrapper}>
                  <Search size={16} class={styles.searchIcon} />
                  <input
                    type="text"
                    class={styles.searchInput}
                    placeholder="Search memories to add..."
                    value={searchQuery}
                    onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && searchQuery.trim()) {
                        performSearch(searchQuery)
                      }
                    }}
                    autoFocus
                  />
                </div>
              </div>

              {isSearching && (
                <div class={styles.searchLoading}>Searching...</div>
              )}

              {!isSearching && searchResults.length > 0 && (
                <div class={styles.searchResults}>
                  {searchResults.map((result) => (
                    <div key={result.id} class={styles.searchResult}>
                      <div class={styles.searchResultInfo}>
                        <span class={styles.searchResultType}>{getTypeLabel(result.type as any)}</span>
                        <span class={styles.searchResultTitle}>{result.title}</span>
                      </div>
                      <button
                        class={styles.addItemButton}
                        onClick={() => handleAddMemory(result.id)}
                        disabled={addingMemoryId === result.id}
                        title="Add to collection"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {!isSearching && searchQuery.trim().length >= 3 && searchResults.length === 0 && debouncedQuery === searchQuery && (
                <div class={styles.searchEmpty}>No memories found</div>
              )}

              {!isSearching && searchQuery.trim().length > 0 && searchQuery.trim().length < 3 && (
                <div class={styles.searchHint}>Type at least 3 characters to search</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
