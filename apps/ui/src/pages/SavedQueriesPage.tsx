import { useState, useEffect, useMemo } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { Search, Star, X } from 'lucide-preact'
import {
  getSavedQueries,
  getConnections,
  favoriteSavedQuery,
  unfavoriteSavedQuery,
  deleteSavedQuery,
  type DbxConnection,
  type DbxSavedQuery,
} from '../lib/dbx-api'
import { setNavContext } from '../lib/navContext'
import { useDocumentTitle } from '../hooks'
import { PageHeader } from '../components/layout'
import { ConfirmModal, useToast } from '../components/ui'
import { SavedQueryRow } from '../components/dbx/SavedQueryRow'
import { SavedQueryContextMenu } from '../components/dbx/SavedQueryContextMenu'
import styles from './SavedQueriesPage.module.css'

const UI_SESSION_ID = 'khef-ui'
const PAGE_SIZE = 25

export function SavedQueriesPage() {
  useDocumentTitle('Saved Queries')
  const [, setLocation] = useLocation()

  const [connections, setConnections] = useState<DbxConnection[]>([])
  const [queries, setQueries] = useState<DbxSavedQuery[]>([])
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  // 1-based page index over `visible`. Filters reset it to 1.
  const [page, setPage] = useState(1)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; query: DbxSavedQuery } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<DbxSavedQuery | null>(null)
  const { showToast } = useToast()

  useEffect(() => {
    getConnections().then(({ connections }) => setConnections(connections)).catch(() => {})
  }, [])

  // Fetch once. Connection filtering happens client-side so we can correctly
  // include connection_id=NULL queries (which run against the builtin khef DB)
  // when the user picks the builtin connection. The API's connection_id
  // filter is strict and would exclude those rows.
  useEffect(() => {
    let cancelled = false
    getSavedQueries({ session_id: UI_SESSION_ID, limit: 500 })
      .then(({ saved_queries }) => { if (!cancelled) setQueries(saved_queries) })
      .catch(() => { if (!cancelled) setQueries([]) })
    return () => { cancelled = true }
  }, [])

  const visible = useMemo(() => {
    const q = search.toLowerCase().trim()
    const builtinId = connections.find(c => c.is_builtin)?.id
    return queries.filter(row => {
      if (favoritesOnly && !row.is_favorite) return false
      if (q && !`${row.handle} ${row.name}`.toLowerCase().includes(q)) return false
      if (connectionId) {
        if (connectionId === builtinId) {
          // Picking builtin → include null-bound queries too (they run there).
          if (row.connection_id !== null && row.connection_id !== connectionId) return false
        } else {
          if (row.connection_id !== connectionId) return false
        }
      }
      return true
    })
  }, [queries, connections, search, favoritesOnly, connectionId])

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const pageItems = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  // Snap back to page 1 if the visible set shrinks past the current page.
  useEffect(() => {
    if (page > pageCount) setPage(1)
  }, [pageCount, page])

  function open(q: DbxSavedQuery) {
    // Stash the entire filtered list (not just this page) so the detail view's
    // ←/→ stepping covers everything the user is currently scoped to.
    setNavContext(visible.map(v => v.id), q.id, '/database/saved-queries')
    setLocation(`/database/saved-queries/${q.id}`)
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    const q = pendingDelete
    try {
      await deleteSavedQuery(q.id)
      setQueries(prev => prev.filter(row => row.id !== q.id))
      showToast(`Deleted "${q.name}"`, undefined, { variant: 'success' })
    } catch (err: any) {
      showToast(`Delete failed: ${err?.message || err}`, undefined, { variant: 'error' })
    } finally {
      setPendingDelete(null)
    }
  }

  async function toggleFavorite(q: DbxSavedQuery) {
    try {
      if (q.is_favorite) await unfavoriteSavedQuery(q.id, UI_SESSION_ID)
      else await favoriteSavedQuery(q.id, UI_SESSION_ID)
      // Patch in-place so we don't need a full refetch.
      setQueries(prev => prev.map(row => row.id === q.id ? { ...row, is_favorite: !q.is_favorite } : row))
    } catch {
      // Silent fail; could surface a toast later.
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (pageCount <= 1) return
    if (e.key === 'ArrowRight') {
      setPage(p => p % pageCount + 1)
      e.preventDefault()
    } else if (e.key === 'ArrowLeft') {
      setPage(p => p === 1 ? pageCount : p - 1)
      e.preventDefault()
    }
  }

  return (
    <div class={styles.page} tabIndex={0} onKeyDown={onKeyDown as any}>
      <PageHeader
        title="Saved queries"
        breadcrumbs={[{ label: 'Database', href: '/database' }]}
      />

      <div class={styles.filters}>
        <div class={styles.search}>
          <Search size={13} />
          <input
            class={styles.searchInput}
            value={search}
            placeholder="Filter by handle or name…"
            onInput={e => { setSearch((e.target as HTMLInputElement).value); setPage(1) }}
          />
          {search && (
            <button class={styles.clear} onClick={() => setSearch('')}>
              <X size={11} />
            </button>
          )}
        </div>

        <select
          class={styles.connSelect}
          value={connectionId ?? ''}
          onChange={e => {
            const v = (e.target as HTMLSelectElement).value
            setConnectionId(v || null); setPage(1)
          }}
        >
          <option value="">All connections</option>
          {connections.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <button
          class={favoritesOnly ? `${styles.chip} ${styles.chipActive}` : styles.chip}
          onClick={() => { setFavoritesOnly(v => !v); setPage(1) }}
        >
          <Star size={11} /> Favorites
        </button>

      </div>

      <div class={styles.list}>
        {pageItems.map(q => (
          <SavedQueryRow
            key={q.id}
            query={q}
            connections={connections}
            onClick={() => open(q)}
            onContextMenu={(e) => {
              e.preventDefault()
              const me = e as MouseEvent
              setContextMenu({ x: me.clientX, y: me.clientY, query: q })
            }}
          />
        ))}

        {visible.length === 0 && (
          <div class={styles.empty}>
            {queries.length === 0
              ? 'No saved queries on this connection yet.'
              : 'No queries match the current filters.'}
          </div>
        )}
      </div>

      {contextMenu && (
        <SavedQueryContextMenu
          query={contextMenu.query}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onOpenInEditor={() => setLocation(`/database?open=${contextMenu.query.id}`)}
          onToggleFavorite={() => toggleFavorite(contextMenu.query)}
          onDelete={() => setPendingDelete(contextMenu.query)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title="Delete saved query?"
          message={`"${pendingDelete.name}" will be removed along with its parameters, snapshots, and favorites. Run history is kept (with the link cleared).${pendingDelete.owner_session_id === null ? ' This is a System query — it will reappear after the next db:seed.' : ''}`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      <div class={styles.hint}>
        <span class={styles.hintCount}>{visible.length} of {queries.length}</span>
        <div class={styles.hintPager}>
          <button
            class={styles.pageBtn}
            onClick={() => setPage(p => p === 1 ? pageCount : p - 1)}
            disabled={pageCount <= 1}
            title="Previous page (←)"
          >‹</button>
          <span>Page {page} of {pageCount}</span>
          <button
            class={styles.pageBtn}
            onClick={() => setPage(p => p % pageCount + 1)}
            disabled={pageCount <= 1}
            title="Next page (→)"
          >›</button>
        </div>
      </div>
    </div>
  )
}

