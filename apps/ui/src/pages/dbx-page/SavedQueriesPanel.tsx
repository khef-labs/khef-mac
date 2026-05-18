import { useState, useEffect, useMemo } from 'preact/hooks'
import { Search, X, Star } from 'lucide-preact'
import {
  getSavedQueries, getRecentSavedQueries,
  favoriteSavedQuery, unfavoriteSavedQuery,
  type DbxSavedQuery, type DbxRecentSavedQuery,
} from '../../lib/dbx-api'
import styles from './DbxPage.module.css'

interface Props {
  sessionId: string | null
  activeConnectionId: string | null
  onOpen: (query: DbxSavedQuery) => void
  onManageAll: () => void
  /** Right-click on a query row. Fired with the query plus the click coords. */
  onContextMenu?: (query: DbxSavedQuery, x: number, y: number) => void
}

export function SavedQueriesPanel({ sessionId, onOpen, onManageAll, onContextMenu }: Props) {
  const [favorites, setFavorites] = useState<DbxSavedQuery[]>([])
  const [recent, setRecent] = useState<DbxRecentSavedQuery[]>([])
  const [allQueries, setAllQueries] = useState<DbxSavedQuery[]>([])
  const [filter, setFilter] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  async function reload() {
    if (!sessionId) {
      setFavorites([]); setRecent([]); setAllQueries([])
      return
    }
    try {
      const [favRes, recentRes, allRes] = await Promise.all([
        getSavedQueries({ session_id: sessionId, favorite: true, limit: 50 }),
        getRecentSavedQueries(sessionId, 20),
        getSavedQueries({ session_id: sessionId, limit: 200 }),
      ])
      setFavorites(favRes.saved_queries)
      setRecent(recentRes.recent)
      setAllQueries(allRes.saved_queries)
    } catch {
      // Silently fail — empty state will render
    }
  }

  useEffect(() => { reload() }, [sessionId])

  const recentFiltered = useMemo(() => {
    const q = filter.toLowerCase().trim()
    const seen = new Set(favorites.map(f => f.id))
    return recent
      .filter(r => !seen.has(r.query_id))
      .filter(r => !q || r.name.toLowerCase().includes(q) || r.handle.toLowerCase().includes(q))
  }, [recent, favorites, filter])

  const favFiltered = useMemo(() => {
    const q = filter.toLowerCase().trim()
    return favorites.filter(f => !q || f.name.toLowerCase().includes(q) || f.handle.toLowerCase().includes(q))
  }, [favorites, filter])

  const otherFiltered = useMemo(() => {
    const q = filter.toLowerCase().trim()
    const seenIds = new Set([
      ...favorites.map(f => f.id),
      ...recent.map(r => r.query_id),
    ])
    return allQueries
      .filter(a => !seenIds.has(a.id))
      .filter(a => !q || a.name.toLowerCase().includes(q) || a.handle.toLowerCase().includes(q))
  }, [allQueries, favorites, recent, filter])

  async function toggleFavorite(query: DbxSavedQuery) {
    if (!sessionId) return
    setBusyId(query.id)
    try {
      if (query.is_favorite) {
        await unfavoriteSavedQuery(query.id, sessionId)
      } else {
        await favoriteSavedQuery(query.id, sessionId)
      }
      await reload()
    } finally {
      setBusyId(null)
    }
  }

  const total = favFiltered.length + recentFiltered.length + otherFiltered.length

  return (
    <div class={styles.savedQueriesPanel}>
      <div class={styles.sidebarHeader}>
        <span class={styles.sidebarTitle}>Saved queries</span>
        <button
          class={styles.btnAdd}
          onClick={onManageAll}
          title="Browse all saved queries"
          style={{ marginLeft: 'auto' }}
        >
          Manage
        </button>
      </div>

      {(favorites.length > 0 || recent.length > 0) && (
        <div class={styles.scriptFilterBar}>
          <Search size={11} />
          <input
            class={styles.scriptFilterInput}
            value={filter}
            onInput={e => setFilter((e.target as HTMLInputElement).value)}
            placeholder="Filter..."
          />
          {filter && (
            <button class={styles.treeFilterClear} onClick={() => setFilter('')}>
              <X size={10} />
            </button>
          )}
        </div>
      )}

      <div class={styles.savedQueriesList}>
        {favFiltered.length > 0 && (
          <>
            <div class={styles.scriptGroupLabel}>Favorites</div>
            {favFiltered.map(q => (
              <div
                key={q.id}
                data-testid={`saved-query-row--${q.handle}`}
                class={styles.scriptItem}
                onClick={() => onOpen(q)}
                onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(q, (e as MouseEvent).clientX, (e as MouseEvent).clientY) } : undefined}
                title={q.description || q.handle}
              >
                <Star size={11} class={styles.savedQueryStar} fill="currentColor" />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {q.name}
                </span>
                <button
                  class={styles.scriptDelete}
                  onClick={e => { e.stopPropagation(); toggleFavorite(q) }}
                  disabled={busyId === q.id}
                  title="Remove from favorites"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </>
        )}

        {recentFiltered.length > 0 && (
          <>
            <div class={styles.scriptGroupLabel}>Recent</div>
            {recentFiltered.map(r => {
              const full = allQueries.find(s => s.id === r.query_id)
              return (
                <div
                  key={r.query_id}
                  class={styles.scriptItem}
                  onClick={() => { if (full) onOpen(full) }}
                  onContextMenu={onContextMenu && full ? (e) => { e.preventDefault(); onContextMenu(full, (e as MouseEvent).clientX, (e as MouseEvent).clientY) } : undefined}
                  title={`Last run ${formatRelativeTime(r.last_run_at)}`}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.name}
                  </span>
                </div>
              )
            })}
          </>
        )}

        {otherFiltered.length > 0 && (
          <>
            <div class={styles.scriptGroupLabel}>All</div>
            {otherFiltered.map(q => (
              <div
                key={q.id}
                data-testid={`saved-query-row--${q.handle}`}
                class={styles.scriptItem}
                onClick={() => onOpen(q)}
                onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(q, (e as MouseEvent).clientX, (e as MouseEvent).clientY) } : undefined}
                title={q.description || q.handle}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {q.name}
                </span>
                <button
                  class={styles.scriptDelete}
                  onClick={e => { e.stopPropagation(); toggleFavorite(q) }}
                  disabled={busyId === q.id}
                  title="Add to favorites"
                >
                  <Star size={11} />
                </button>
              </div>
            ))}
          </>
        )}

        {total === 0 && (
          <div style={{ padding: '8px 14px', fontSize: '11px', color: 'var(--muted)' }}>
            {favorites.length + recent.length === 0
              ? 'No saved queries yet'
              : 'No matching queries'}
          </div>
        )}
      </div>
    </div>
  )
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(iso).toLocaleDateString()
}
