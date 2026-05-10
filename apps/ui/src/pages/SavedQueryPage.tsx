import { useState, useEffect } from 'preact/hooks'
import { useLocation, useRoute } from 'wouter-preact'
import { ChevronLeft, ChevronRight, Copy, Edit3, Star, Trash2 } from 'lucide-preact'
import {
  getSavedQuery,
  getConnections,
  favoriteSavedQuery,
  unfavoriteSavedQuery,
  updateSavedQuery,
  createSavedQuery,
  deleteSavedQuery,
  type DbxConnection,
  type DbxSavedQuery,
} from '../lib/dbx-api'
import { SqlEditor } from './dbx-page/SqlEditor'
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
  const [sqlDraft, setSqlDraft] = useState('')
  const [savingSql, setSavingSql] = useState(false)
  const [sqlError, setSqlError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [confirmingClone, setConfirmingClone] = useState(false)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  useDocumentTitle(query ? `${query.name} — Saved Queries` : 'Saved Queries')

  useEffect(() => {
    getConnections().then(({ connections }) => setConnections(connections)).catch(() => {})
  }, [])

  useEffect(() => {
    if (!id) return
    setQuery(null); setNotFound(false); setSqlError(null)
    getSavedQuery(id, UI_SESSION_ID)
      .then(({ saved_query }) => { setQuery(saved_query); setSqlDraft(saved_query.sql) })
      .catch(() => setNotFound(true))
  }, [id])

  const sqlDirty = query !== null && sqlDraft !== query.sql
  // Built-in queries are seed-owned — edits would be reverted on the next
  // db:seed, so the inline editor is locked. Users clone to edit.
  const isLocked = query?.owner_session_id === null

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

  async function saveSql() {
    if (!query || !sqlDirty || savingSql) return
    setSavingSql(true); setSqlError(null)
    try {
      const { saved_query } = await updateSavedQuery(query.id, {
        sql: sqlDraft,
        edited_by: UI_SESSION_ID,
      })
      setQuery(saved_query); setSqlDraft(saved_query.sql)
      showToast('Saved', undefined, { variant: 'success' })
    } catch (err: any) {
      const msg = err?.message || String(err)
      setSqlError(msg)
      showToast(`Save failed: ${msg}`, undefined, { variant: 'error' })
    } finally {
      setSavingSql(false)
    }
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

  // Keyboard shortcuts: ←/→ step through navContext list, e to edit.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'ArrowLeft') {
        const prev = getPrevMemoryId()
        if (prev) { setLocation(`/dbx/saved-queries/${prev}`); e.preventDefault() }
      } else if (e.key === 'ArrowRight') {
        const next = getNextMemoryId()
        if (next) { setLocation(`/dbx/saved-queries/${next}`); e.preventDefault() }
      } else if (e.key === 'e' && !e.metaKey && !e.ctrlKey) {
        if (query) { setLocation(`/dbx?open=${query.id}`); e.preventDefault() }
      } else if (e.key === 'Escape') {
        if (sqlDirty && !isLocked) {
          e.preventDefault()
          setConfirmingDiscard(true)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [query, sqlDirty, isLocked])

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
  const conn = query.connection_id
    ? (connections.find(c => c.id === query.connection_id)?.name ?? '(unknown)')
    : '(unbound)'
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

      <div class={styles.body}>
        <div class={styles.badges}>
          {isBuiltin && (
            <span
              class={`${styles.badge} ${styles.badgeBuiltin}`}
              title="Shipped by khef's seed file. Edits are reverted on reseed."
            >Built-in</span>
          )}
          <span class={`${styles.badge} ${styles.badgeConn}`}>{conn}</span>
        </div>

        {query.description && (
          <p class={styles.description}>{query.description}</p>
        )}

        <section class={styles.section}>
          <div class={styles.sectionHead}>
            <h2 class={styles.sectionTitle}>SQL</h2>
            <span class={styles.sectionMeta}>
              {sqlDraft.split('\n').length} lines
              {!isLocked && sqlDirty && <span class={styles.dirtyDot} title="Unsaved changes"> · unsaved</span>}
              {!isLocked && (
                <>
                  {' · '}
                  <button
                    class={styles.saveBtn}
                    onClick={saveSql}
                    disabled={!sqlDirty || savingSql}
                    title="Save SQL (⌘S)"
                  >
                    {savingSql ? 'Saving…' : 'Save'}
                  </button>
                </>
              )}
            </span>
          </div>
          {isLocked && (
            <div class={styles.lockBanner}>
              Read-only — edits aren't allowed. <button class={styles.lockLink} onClick={() => setConfirmingClone(true)} disabled={busy}>Clone to edit</button>
            </div>
          )}
          <div
            class={styles.editorBox}
            style={{ height: `${Math.min(800, Math.max(300, sqlDraft.split('\n').length * 22 + 32))}px` }}
          >
            <SqlEditor
              value={sqlDraft}
              onChange={setSqlDraft}
              onRun={() => setLocation(`/dbx?open=${query.id}`)}
              onSave={isLocked ? undefined : saveSql}
              readOnly={isLocked}
            />
          </div>
          {sqlError && <div class={styles.sqlError}>{sqlError}</div>}
        </section>

        <section class={styles.section}>
          <div class={styles.sectionHead}>
            <h2 class={styles.sectionTitle}>Parameters</h2>
            <span class={styles.sectionMeta}>
              {(query.params?.filter(p => p.required).length ?? 0)} required ·{' '}
              {(query.params?.filter(p => !p.required).length ?? 0)} optional
            </span>
          </div>
          <div class={styles.params}>
            <div class={styles.paramHead}>Name</div>
            <div class={styles.paramHead}>Type</div>
            <div class={styles.paramHead}>Required</div>
            <div class={styles.paramHead}>Default / Options</div>
            {(!query.params || query.params.length === 0) ? (
              <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--muted-2)' }}>
                No declared parameters
              </div>
            ) : (
              query.params.map(p => {
                const def = p.default_value === null
                  ? (p.value_type === 'enum' && p.options
                      ? `[${p.options.join(' | ')}]`
                      : '—')
                  : p.default_value
                return (
                  <>
                    <div class={styles.pname}>:{p.name}</div>
                    <div class={styles.ptype}>{p.value_type}</div>
                    <div class={p.required ? `${styles.preq} ${styles.preqRequired}` : `${styles.preq} ${styles.preqOptional}`}>
                      {p.required ? 'required' : 'optional'}
                    </div>
                    <div class={styles.pdef}>{def}</div>
                  </>
                )
              })
            )}
          </div>
        </section>

        <section class={styles.section}>
          <h2 class={styles.sectionTitle}>Metadata</h2>
          <dl class={styles.metadata}>
            <dt>Handle</dt><dd>{query.handle}</dd>
            <dt>Connection</dt><dd>{conn}</dd>
            <dt>Owner</dt><dd>{query.owner_session_id ?? 'system (built-in)'}</dd>
            <dt>Created</dt><dd>{new Date(query.created_at).toLocaleString()}</dd>
            <dt>Updated</dt><dd>{new Date(query.updated_at).toLocaleString()}</dd>
            <dt>Shared</dt><dd>{query.is_shared ? 'true' : 'false (private)'}</dd>
          </dl>
        </section>
      </div>

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

      {confirmingDiscard && (
        <ConfirmModal
          title="Discard changes?"
          message="Discard your unsaved SQL changes?"
          confirmLabel="Discard"
          variant="danger"
          onConfirm={() => {
            setSqlDraft(query.sql)
            setSqlError(null)
            setConfirmingDiscard(false)
          }}
          onCancel={() => setConfirmingDiscard(false)}
        />
      )}
    </div>
  )
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

