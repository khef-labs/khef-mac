import { useState, useEffect } from 'preact/hooks'
import { useLocation, useRoute } from 'wouter-preact'
import { ChevronLeft, ChevronRight, Copy, Edit3, Star, Trash2 } from 'lucide-preact'
import {
  getSavedQuery,
  getConnections,
  favoriteSavedQuery,
  unfavoriteSavedQuery,
  createSavedQuery,
  deleteSavedQuery,
  type DbxConnection,
  type DbxSavedQuery,
} from '../lib/dbx-api'
import {
  getNavContext,
  setNavContext,
  updateNavIndex,
  getPrevMemoryId,
  getNextMemoryId,
  getPositionInfo,
} from '../lib/navContext'
import { useDocumentTitle } from '../hooks'
import { PageHeader } from '../components/layout'
import { ConfirmModal, useToast } from '../components/ui'
import { CloneSavedQueryModal } from '../components/dbx/CloneSavedQueryModal'
import { SavedQueryForm } from '../components/dbx/SavedQueryForm'
import styles from './SavedQueryPage.module.css'

const CRUMBS = [
  { label: 'Dbx', href: '/dbx' },
  { label: 'Saved queries', href: '/dbx/saved-queries' },
]

const UI_SESSION_ID = 'khef-ui'

export function SavedQueryPage() {
  const [, params] = useRoute<{ id: string }>('/dbx/saved-queries/:id')
  const [, setLocation] = useLocation()
  const { showToast } = useToast()
  const id = params?.id ?? null

  const [query, setQuery] = useState<DbxSavedQuery | null>(null)
  const [connections, setConnections] = useState<DbxConnection[]>([])
  const [busy, setBusy] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [confirmingClone, setConfirmingClone] = useState(false)
  const [cloneError, setCloneError] = useState<string | null>(null)

  useDocumentTitle(query ? `${query.name} — Saved Queries` : 'Saved Queries')

  useEffect(() => {
    getConnections().then(({ connections }) => setConnections(connections)).catch(() => {})
  }, [])

  useEffect(() => {
    if (!id) return
    setQuery(null); setNotFound(false)
    getSavedQuery(id, UI_SESSION_ID)
      .then(({ saved_query }) => setQuery(saved_query))
      .catch(() => setNotFound(true))
  }, [id])

  async function performDelete() {
    if (!query) return
    try {
      await deleteSavedQuery(query.id)
      showToast(`Deleted "${query.name}"`, undefined, { variant: 'success' })
      setLocation('/dbx/saved-queries')
    } catch (err: any) {
      showToast(`Delete failed: ${err?.message || err}`, undefined, { variant: 'error' })
    }
  }

  async function clone(input: { name: string; connectionId: string | null }) {
    if (!query || busy) return
    setBusy(true); setCloneError(null)
    const baseHandle = slugify(input.name) || query.handle.replace(/-copy(-\d+)?$/, '')
    const params = (query.params ?? []).map(p => ({
      name: p.name,
      value_type: p.value_type,
      required: p.required,
      default_value: p.default_value ?? undefined,
      options: p.options ?? undefined,
      sort_order: p.sort_order,
    }))
    let lastErr: any = null
    for (let i = 1; i <= 6; i++) {
      const handle = i === 1 ? baseHandle : `${baseHandle}-${i}`
      try {
        const { saved_query } = await createSavedQuery({
          name: input.name,
          handle,
          connection_id: input.connectionId,
          description: query.description ?? undefined,
          sql: query.sql,
          schema_scope: query.schema_scope ?? undefined,
          is_shared: false,
          // Clones default to writable so the user can edit; they can re-lock later.
          is_readonly: false,
          owner_session_id: UI_SESSION_ID,
          params,
        })
        // Slot the new id into navContext right after the original so ←/→
        // keep working from the clone's detail page.
        const ctx = getNavContext()
        if (ctx) {
          const origIdx = ctx.ids.indexOf(query.id)
          const insertAt = origIdx >= 0 ? origIdx + 1 : ctx.ids.length
          const newIds = [
            ...ctx.ids.slice(0, insertAt),
            saved_query.id,
            ...ctx.ids.slice(insertAt),
          ]
          setNavContext(newIds, saved_query.id, ctx.source)
        }
        setBusy(false); setConfirmingClone(false)
        showToast(`Cloned as "${saved_query.handle}"`, undefined, { variant: 'success' })
        setLocation(`/dbx/saved-queries/${saved_query.id}`)
        return
      } catch (err: any) {
        lastErr = err
        if (err?.response?.status !== 409) break
      }
    }
    setBusy(false)
    setCloneError(lastErr?.message || 'Could not clone — try again or pick a different name.')
  }

  // When the user lands on this detail page, sync the navContext index so
  // ←/→ stepping picks up correctly even if they navigated here directly.
  useEffect(() => {
    if (!id) return
    const ctx = getNavContext()
    if (!ctx) return
    const idx = ctx.ids.indexOf(id)
    if (idx >= 0) updateNavIndex(idx)
  }, [id])

  // Keyboard shortcuts: ←/→ step through navContext list, e to edit. Skipped
  // while focus is in a form field or the SQL editor.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      if (e.key === 'ArrowLeft') {
        const prev = getPrevMemoryId()
        if (prev) { setLocation(`/dbx/saved-queries/${prev}`); e.preventDefault() }
      } else if (e.key === 'ArrowRight') {
        const next = getNextMemoryId()
        if (next) { setLocation(`/dbx/saved-queries/${next}`); e.preventDefault() }
      } else if (e.key === 'e' && !e.metaKey && !e.ctrlKey) {
        if (query) { setLocation(`/dbx?open=${query.id}`); e.preventDefault() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [query])

  async function toggleFavorite() {
    if (!query || busy) return
    setBusy(true)
    try {
      if (query.is_favorite) await unfavoriteSavedQuery(query.id, UI_SESSION_ID)
      else await favoriteSavedQuery(query.id, UI_SESSION_ID)
      const { saved_query } = await getSavedQuery(query.id, UI_SESSION_ID)
      setQuery(saved_query)
    } finally { setBusy(false) }
  }

  if (notFound) {
    return (
      <div class={styles.page}>
        <PageHeader title="Not found" breadcrumbs={CRUMBS} />
        <div class={styles.notFound}>Saved query not found.</div>
      </div>
    )
  }

  if (!query) {
    return (
      <div class={styles.page}>
        <PageHeader title="Loading…" breadcrumbs={CRUMBS} />
        <div class={styles.notFound}>Loading…</div>
      </div>
    )
  }

  const isBuiltin = query.owner_session_id === null
  const pos = getPositionInfo()
  const prevId = pos ? getPrevMemoryId() : null
  const nextId = pos ? getNextMemoryId() : null

  return (
    <div class={styles.page}>
      <PageHeader title={query.name} breadcrumbs={CRUMBS}>
        <div class={styles.headerExtras}>
          <button
            class={query.is_favorite ? `${styles.star} ${styles.starFilled}` : styles.star}
            onClick={toggleFavorite}
            disabled={busy}
            title={query.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            <Star size={16} fill={query.is_favorite ? 'currentColor' : 'none'} />
          </button>
          {pos && (
            <div class={styles.posIndicator}>
              <button
                class={styles.posBtn}
                onClick={() => prevId && setLocation(`/dbx/saved-queries/${prevId}`)}
                disabled={!prevId}
                title="Previous (←)"
              >
                <ChevronLeft size={14} />
              </button>
              <span>{pos.current} of {pos.total}</span>
              <button
                class={styles.posBtn}
                onClick={() => nextId && setLocation(`/dbx/saved-queries/${nextId}`)}
                disabled={!nextId}
                title="Next (→)"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
          <button
            class={styles.btn}
            onClick={() => setConfirmingClone(true)}
            disabled={busy}
            title="Create a writable copy"
          >
            <Copy size={13} /> Clone
          </button>
          {!isBuiltin && (
            <button
              class={`${styles.btn} ${styles.btnDanger}`}
              onClick={() => setConfirmingDelete(true)}
              title="Delete this saved query"
            >
              <Trash2 size={13} /> Delete
            </button>
          )}
          <button
            class={styles.btn}
            onClick={() => setLocation(`/dbx?open=${query.id}`)}
            title="Open in the run-and-results editor (press e)"
          >
            <Edit3 size={13} /> Dbx Editor
          </button>
        </div>
      </PageHeader>

      <SavedQueryForm
        key={query.id}
        mode="edit"
        existing={query}
        locked={isBuiltin}
        onSaved={setQuery}
        onRequestClone={() => setConfirmingClone(true)}
      />

      {confirmingDelete && (
        <ConfirmModal
          title="Delete saved query?"
          message={`"${query.name}" will be removed along with its parameters, snapshots, and favorites. Run history is kept (with the link cleared).${isBuiltin ? ' This is a System query — it will reappear after the next db:seed.' : ''}`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={performDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}

      {confirmingClone && (
        <CloneSavedQueryModal
          source={query}
          connections={connections}
          busy={busy}
          errorMessage={cloneError}
          onConfirm={clone}
          onCancel={() => { setConfirmingClone(false); setCloneError(null) }}
        />
      )}
    </div>
  )
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
