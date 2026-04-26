import { useState, useEffect, useMemo, useRef } from 'preact/hooks'
import { Link } from 'wouter-preact'
import { Layers, Plus, Trash2, FolderInput } from 'lucide-preact'
import clsx from 'clsx'
import { getProject, getProjectCollections, createCollection, deleteCollection, updateCollection } from '../lib/api'
import type { Collection, Pagination, Project } from '../types'
import { cardStyles, ConfirmModal, useToast, SortBar } from '../components/ui'
import type { SortField, SortState } from '../components/ui'
import { PageHeader } from '../components/layout'
import styles from './CollectionsPage.module.css'

const COLLECTION_SORT_FIELDS: SortField[] = [
  { key: 'updated_at', label: 'Updated' },
  { key: 'created_at', label: 'Created' },
  { key: 'memory_count', label: 'Memories' },
  { key: 'name', label: 'Name' },
]

interface Props {
  projectId: string
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

export function CollectionsPage({ projectId }: Props) {
  const { showToast } = useToast()
  const [project, setProject] = useState<Project | null>(null)
  const [collections, setCollections] = useState<Collection[]>([])
  const [, setPagination] = useState<Pagination | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createParentId, setCreateParentId] = useState('')
  const [createViewMode, setCreateViewMode] = useState<'list' | 'board' | 'grid'>('list')
  const [isCreating, setIsCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Collection | null>(null)
  const [sort, setSort] = useState<SortState>({ field: 'updated_at', direction: 'desc' })

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ collection: Collection; x: number; y: number } | null>(null)
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const sortedCollections = useMemo(() => {
    const dir = sort.direction === 'asc' ? 1 : -1
    return [...collections].sort((a, b) => {
      if (sort.field === 'name') return dir * a.name.localeCompare(b.name)
      if (sort.field === 'memory_count') return dir * ((a.memory_count ?? 0) - (b.memory_count ?? 0))
      const key = sort.field as 'updated_at' | 'created_at'
      return dir * (new Date(a[key] || 0).getTime() - new Date(b[key] || 0).getTime())
    })
  }, [collections, sort])

  const loadCollections = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await getProjectCollections(projectId, { parent_id: 'null' })
      setCollections(res.collections)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load collections')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    getProject(projectId).then(p => setProject(p)).catch(() => {})
    loadCollections()
  }, [projectId])

  const handleCreate = async (e: Event) => {
    e.preventDefault()
    if (!createName.trim()) return

    const handle = createName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')

    if (!handle) return

    setIsCreating(true)
    setError(null)
    try {
      const res = await createCollection(projectId, {
        handle,
        name: createName.trim(),
        description: createDescription.trim() || undefined,
        parent_id: createParentId || undefined,
        view_mode: createViewMode,
      })
      // If created as sub-collection, refresh to update parent's children; else prepend
      if (createParentId) {
        loadCollections()
      } else {
        setCollections((prev) => [{ ...res.collection, memory_count: 0 }, ...prev])
      }
      setCreateName('')
      setCreateDescription('')
      setCreateParentId('')
      setCreateViewMode('list')
      setShowCreateForm(false)
      showToast('Collection created')
    } catch (err: any) {
      const msg = err?.response
        ? await err.response.text().catch(() => 'Failed to create collection')
        : err instanceof Error ? err.message : 'Failed to create collection'
      setError(typeof msg === 'string' && msg.includes('error') ? JSON.parse(msg).error : msg)
    } finally {
      setIsCreating(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await deleteCollection(projectId, deleteTarget.id)
      setCollections((prev) => prev.filter((c) => c.id !== deleteTarget.id))
      showToast('Collection deleted')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete collection')
    } finally {
      setDeleteTarget(null)
    }
  }

  const handleContextMenu = (e: MouseEvent, collection: Collection) => {
    e.preventDefault()
    e.stopPropagation()
    setShowMoveSubmenu(false)
    setContextMenu({ collection, x: e.clientX, y: e.clientY })
  }

  const closeContextMenu = () => {
    setContextMenu(null)
    setShowMoveSubmenu(false)
  }

  const handleMoveToParent = async (parentId: string) => {
    if (!contextMenu) return
    const col = contextMenu.collection
    closeContextMenu()
    try {
      await updateCollection(projectId, col.id, { parent_id: parentId })
      showToast(`Moved "${col.name}" to sub-collection`)
      loadCollections()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to move collection')
    }
  }

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeContextMenu()
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [contextMenu])

  // Available parents: root collections that aren't the selected one
  // Also exclude collections that already have children if the selected one has children (can't nest a parent under another)
  const availableParents = contextMenu
    ? sortedCollections.filter(c => {
        if (c.id === contextMenu.collection.id) return false
        // The target must not be a sub-collection itself (all listed are roots, so this is fine)
        // The source must not have children (can't make a parent into a sub-collection)
        return true
      })
    : []

  // Disable "Move to parent" if the collection has children
  const canMove = contextMenu ? (contextMenu.collection.child_count ?? 0) === 0 : false

  return (
    <div class={styles.page}>
      <header class={styles.header}>
        <PageHeader
          title="Collections"
          breadcrumbs={[{ label: 'Projects', href: '/projects' }, { label: project?.display_name || project?.name || projectId, href: `/projects/${projectId}` }]}
        />
        <div class={styles.titleRow}>
          <h1>
            <Layers size={24} />
            Collections
          </h1>
          <div class={styles.titleActions}>
            <SortBar fields={COLLECTION_SORT_FIELDS} value={sort} onChange={setSort} />
            <button
              class={styles.addButton}
              onClick={() => setShowCreateForm(!showCreateForm)}
            >
              <Plus size={16} />
              New Collection
            </button>
          </div>
        </div>
        <p class={styles.subtitle}>Group related memories into curated collections</p>
      </header>

      {showCreateForm && (
        <form class={styles.createForm} onSubmit={handleCreate}>
          <input
            type="text"
            class={styles.input}
            placeholder="Collection name"
            value={createName}
            onInput={(e) => setCreateName((e.target as HTMLInputElement).value)}
            autoFocus
          />
          <input
            type="text"
            class={styles.input}
            placeholder="Description (optional)"
            value={createDescription}
            onInput={(e) => setCreateDescription((e.target as HTMLInputElement).value)}
          />
          <div class={styles.createRow}>
            <div class={styles.createField}>
              <label class={styles.createLabel}>Parent</label>
              <select
                class={styles.createSelect}
                value={createParentId}
                onChange={(e) => setCreateParentId((e.target as HTMLSelectElement).value)}
              >
                <option value="">None (root)</option>
                {sortedCollections.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div class={styles.createField}>
              <label class={styles.createLabel}>Default View</label>
              <div class={styles.viewModePicker}>
                {(['list', 'board', 'grid'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    class={`${styles.viewModeBtn} ${createViewMode === mode ? styles.viewModeBtnActive : ''}`}
                    onClick={() => setCreateViewMode(mode)}
                  >
                    {mode.charAt(0).toUpperCase() + mode.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div class={styles.createActions}>
            <button
              type="submit"
              class={styles.submitButton}
              disabled={isCreating || !createName.trim()}
            >
              {isCreating ? 'Creating...' : 'Create'}
            </button>
            <button
              type="button"
              class={styles.cancelButton}
              onClick={() => {
                setShowCreateForm(false)
                setCreateName('')
                setCreateDescription('')
                setCreateParentId('')
                setCreateViewMode('list')
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <div class={styles.error}>{error}</div>}

      {isLoading ? (
        <div class={styles.loading}>Loading collections...</div>
      ) : sortedCollections.length === 0 ? (
        <div class={styles.empty}>
          <Layers size={48} />
          <p>No collections yet</p>
          <p class={styles.hint}>Create a collection to group related memories together</p>
        </div>
      ) : (
        <div class={styles.list}>
          {sortedCollections.map((collection) => (
            <Link
              key={collection.id}
              href={`/projects/${projectId}/collections/${collection.id}`}
              class={clsx(cardStyles.card, styles.collectionCard)}
              onContextMenu={(e: MouseEvent) => handleContextMenu(e, collection)}
            >
              <div class={styles.cardContent}>
                <h3 class={styles.cardTitle}>{collection.name}</h3>
                <span class={styles.cardHandle}>{collection.handle}</span>
                {collection.description && (
                  <p class={styles.cardDescription}>{collection.description}</p>
                )}
                <div class={styles.cardMeta}>
                  <span class={styles.memoryCount}>
                    {collection.memory_count} {collection.memory_count === 1 ? 'memory' : 'memories'}
                  </span>
                  <span class={styles.metaDate}>{formatDate(collection.updated_at)}</span>
                </div>
                {collection.children && collection.children.length > 0 && (
                  <div class={styles.cardChildren}>
                    <span class={styles.cardChildrenLabel}>Sub:</span>
                    {collection.children.map(child => (
                      <span key={child.id} class={styles.cardChildChip}>
                        {child.name}
                        <span class={styles.chipCount}>{child.memory_count}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <button
                class={styles.deleteButton}
                title="Delete collection"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setDeleteTarget(collection)
                }}
              >
                <Trash2 size={14} />
              </button>
            </Link>
          ))}
        </div>
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete Collection"
          message={
            deleteTarget.children && deleteTarget.children.length > 0
              ? `Delete "${deleteTarget.name}" and its sub-collections?\n\n${deleteTarget.children.map(c => `  • ${c.name} (${c.memory_count} memories)`).join('\n')}\n\nMemories won't be deleted — only the collection grouping.`
              : `Delete "${deleteTarget.name}"? Memories won't be deleted — only the collection grouping.`
          }
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {contextMenu && (
        <div
          ref={menuRef}
          class={styles.contextMenu}
          style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            class={`${styles.contextMenuItem} ${!canMove ? styles.contextMenuDisabled : ''}`}
            onClick={() => canMove && setShowMoveSubmenu(!showMoveSubmenu)}
            title={!canMove ? 'Collections with sub-collections cannot be moved' : ''}
          >
            <FolderInput size={14} />
            Move to parent...
          </button>
          {showMoveSubmenu && canMove && (
            <div class={styles.contextSubmenu}>
              {availableParents.length === 0 ? (
                <div class={styles.contextMenuEmpty}>No other collections</div>
              ) : (
                availableParents.map(parent => (
                  <button
                    key={parent.id}
                    class={styles.contextMenuItem}
                    onClick={() => handleMoveToParent(parent.id)}
                  >
                    <Layers size={12} />
                    {parent.name}
                  </button>
                ))
              )}
            </div>
          )}
          <button
            class={`${styles.contextMenuItem} ${styles.contextMenuDanger}`}
            onClick={() => {
              const col = contextMenu.collection
              closeContextMenu()
              setDeleteTarget(col)
            }}
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
