import { useState, useEffect } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { Plus, Trash2 } from 'lucide-preact'
import {
  createSavedQuery,
  updateSavedQuery,
  getConnections,
  type DbxConnection,
  type DbxParamType,
  type DbxSavedQuery,
  type DbxSavedQueryParam,
} from '../../lib/dbx-api'
import { SqlEditor } from '../../pages/dbx-page/SqlEditor'
import { useToast } from '../ui'
import styles from './SavedQueryForm.module.css'

const UI_SESSION_ID = 'khef-ui'
const PARAM_TYPES: DbxParamType[] = ['text', 'number', 'bool', 'enum']

// Editor-local param shape. `options` is kept as a comma-separated string here
// and split into an array only when building the request payload.
interface DraftParam {
  name: string
  value_type: DbxParamType
  required: boolean
  default_value: string
  options: string
}

function newParam(): DraftParam {
  return { name: '', value_type: 'text', required: false, default_value: '', options: '' }
}

function paramToDraft(p: DbxSavedQueryParam): DraftParam {
  return {
    name: p.name,
    value_type: p.value_type,
    required: p.required,
    default_value: p.default_value ?? '',
    options: (p.options ?? []).join(', '),
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// Normalised param payload — used both for the request body and for the
// dirty check (compare JSON of current vs. original).
function buildParamPayload(params: DraftParam[]) {
  return params.map((p, idx) => ({
    name: p.name.trim().replace(/^:/, ''),
    value_type: p.value_type,
    required: p.required,
    default_value: p.default_value.trim() ? p.default_value.trim() : null,
    options:
      p.value_type === 'enum'
        ? p.options.split(',').map(o => o.trim()).filter(Boolean)
        : null,
    sort_order: idx,
  }))
}

interface SavedQueryFormProps {
  mode: 'create' | 'edit'
  /** Required in edit mode — the query being edited. */
  existing?: DbxSavedQuery
  /** Built-in queries are seed-owned: render everything read-only. */
  locked?: boolean
  /** Called after a successful create/update with the saved query. */
  onSaved: (query: DbxSavedQuery) => void
  /** Create-mode cancel handler. */
  onCancel?: () => void
  /** Locked-mode "Clone to edit" handler. */
  onRequestClone?: () => void
}

export function SavedQueryForm({
  mode,
  existing,
  locked,
  onSaved,
  onCancel,
  onRequestClone,
}: SavedQueryFormProps) {
  const [, setLocation] = useLocation()
  const { showToast } = useToast()
  const isEdit = mode === 'edit'
  const readOnly = !!locked

  const [connections, setConnections] = useState<DbxConnection[]>([])
  const [name, setName] = useState(existing?.name ?? '')
  const [handle, setHandle] = useState(existing?.handle ?? '')
  // In edit mode the handle is a real identifier — don't let it track the name.
  const [handleTouched, setHandleTouched] = useState(isEdit)
  const [connectionId, setConnectionId] = useState<string | null>(existing?.connection_id ?? null)
  const [description, setDescription] = useState(existing?.description ?? '')
  const [sql, setSql] = useState(existing?.sql ?? '')
  const [params, setParams] = useState<DraftParam[]>(
    existing?.params ? existing.params.map(paramToDraft) : [],
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getConnections()
      .then(({ connections }) => {
        setConnections(connections)
        // Create mode with no connection chosen yet → default to builtin.
        if (!isEdit) {
          const builtin = connections.find(c => c.is_builtin)
          if (builtin) setConnectionId(prev => prev ?? builtin.id)
        }
      })
      .catch(() => {})
  }, [isEdit])

  const effectiveHandle = handleTouched ? handle : slugify(name)

  // Dirty check (edit mode): compare current form state to the saved query.
  const dirty =
    isEdit && existing
      ? name.trim() !== existing.name ||
        effectiveHandle !== existing.handle ||
        connectionId !== existing.connection_id ||
        description.trim() !== (existing.description ?? '') ||
        sql !== existing.sql ||
        JSON.stringify(buildParamPayload(params)) !==
          JSON.stringify(buildParamPayload((existing.params ?? []).map(paramToDraft)))
      : false

  function patchParam(idx: number, patch: Partial<DraftParam>) {
    setParams(prev => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)))
  }
  function addParam() {
    setParams(prev => [...prev, newParam()])
  }
  function removeParam(idx: number) {
    setParams(prev => prev.filter((_, i) => i !== idx))
  }

  function discard() {
    if (!existing) return
    setName(existing.name)
    setHandle(existing.handle)
    setHandleTouched(true)
    setConnectionId(existing.connection_id)
    setDescription(existing.description ?? '')
    setSql(existing.sql)
    setParams((existing.params ?? []).map(paramToDraft))
    setError(null)
  }

  const canSave =
    !readOnly &&
    !saving &&
    !!name.trim() &&
    !!effectiveHandle &&
    !!sql.trim() &&
    (!isEdit || dirty)

  async function save() {
    if (!canSave) return
    setError(null)

    // Validate params before hitting the API so the user gets a focused error.
    const payload = buildParamPayload(params)
    const seen = new Set<string>()
    for (let i = 0; i < payload.length; i++) {
      const p = payload[i]
      if (!p.name) {
        setError(`Parameter ${i + 1} needs a name.`)
        return
      }
      if (seen.has(p.name)) {
        setError(`Duplicate parameter name ":${p.name}".`)
        return
      }
      seen.add(p.name)
      if (p.value_type === 'enum' && (!p.options || p.options.length === 0)) {
        setError(`Enum parameter ":${p.name}" needs at least one option.`)
        return
      }
    }

    setSaving(true)
    try {
      if (isEdit && existing) {
        const { saved_query } = await updateSavedQuery(existing.id, {
          name: name.trim(),
          handle: effectiveHandle,
          connection_id: connectionId,
          description: description.trim(),
          sql,
          params: payload,
          edited_by: UI_SESSION_ID,
        })
        // Re-sync from the response so the dirty check settles.
        setName(saved_query.name)
        setHandle(saved_query.handle)
        setConnectionId(saved_query.connection_id)
        setDescription(saved_query.description ?? '')
        setSql(saved_query.sql)
        setParams((saved_query.params ?? []).map(paramToDraft))
        showToast('Saved', undefined, { variant: 'success' })
        onSaved(saved_query)
      } else {
        const { saved_query } = await createSavedQuery({
          name: name.trim(),
          handle: effectiveHandle,
          connection_id: connectionId,
          description: description.trim() || undefined,
          sql,
          owner_session_id: UI_SESSION_ID,
          params: payload,
        })
        showToast(`Created "${saved_query.name}"`, undefined, { variant: 'success' })
        onSaved(saved_query)
      }
    } catch (err: any) {
      const msg =
        err?.response?.status === 409
          ? `Handle "${effectiveHandle}" is already taken on this connection — pick another.`
          : err?.message || String(err)
      setError(msg)
      showToast(`${isEdit ? 'Save' : 'Create'} failed: ${msg}`, undefined, { variant: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const requiredCount = params.filter(p => p.required).length

  return (
    <div class={styles.body}>
      {locked && (
        <div class={styles.lockBanner}>
          Read-only — this is a built-in query. Edits would be reverted on the next db:seed.
          {onRequestClone && (
            <button class={styles.lockLink} onClick={onRequestClone}>Clone to edit</button>
          )}
        </div>
      )}

      <section class={styles.section}>
        <h2 class={styles.sectionTitle}>Details</h2>
        <div class={styles.fields}>
          <div class={styles.field}>
            <label class={styles.label} for="sq-name">
              Name<span class={styles.requiredMark} aria-hidden="true">*</span>
            </label>
            <input
              id="sq-name"
              class={styles.input}
              value={name}
              placeholder="Recent memories"
              disabled={readOnly}
              onInput={e => setName((e.target as HTMLInputElement).value)}
            />
          </div>

          <div class={styles.field}>
            <label class={styles.label} for="sq-handle">
              Handle<span class={styles.requiredMark} aria-hidden="true">*</span>
            </label>
            <input
              id="sq-handle"
              class={styles.input}
              value={effectiveHandle}
              placeholder="recent-memories"
              disabled={readOnly}
              onInput={e => {
                setHandleTouched(true)
                setHandle(slugify((e.target as HTMLInputElement).value))
              }}
            />
            <span class={styles.fieldHint}>kebab-case, unique per connection</span>
          </div>

          <div class={styles.field}>
            <label class={styles.label} for="sq-connection">Connection</label>
            <select
              id="sq-connection"
              class={styles.select}
              value={connectionId ?? ''}
              disabled={readOnly}
              onChange={e => {
                const v = (e.target as HTMLSelectElement).value
                setConnectionId(v || null)
              }}
            >
              <option value="">Unbound — runs on builtin khef DB</option>
              {connections.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.config?.host ? ` (${c.config.host}:${c.config.port})` : ''}
                </option>
              ))}
            </select>
          </div>

          <div class={`${styles.field} ${styles.fieldWide}`}>
            <label class={styles.label} for="sq-description">Description</label>
            <textarea
              id="sq-description"
              class={styles.textarea}
              value={description}
              placeholder="Optional — what this query is for"
              rows={2}
              disabled={readOnly}
              onInput={e => setDescription((e.target as HTMLTextAreaElement).value)}
            />
          </div>
        </div>
      </section>

      <section class={styles.section}>
        <div class={styles.sectionHead}>
          <h2 class={styles.sectionTitle}>
            SQL<span class={styles.requiredMark} aria-hidden="true">*</span>
          </h2>
          <span class={styles.sectionMeta}>{sql.split('\n').length} lines</span>
        </div>
        <div class={styles.editorBox}>
          <SqlEditor
            value={sql}
            onChange={setSql}
            onRun={() => {
              if (isEdit && existing) setLocation(`/dbx?open=${existing.id}`)
            }}
            onSave={readOnly ? undefined : save}
            readOnly={readOnly}
          />
        </div>
      </section>

      <section class={styles.section}>
        <div class={styles.sectionHead}>
          <h2 class={styles.sectionTitle}>Parameters</h2>
          <span class={styles.sectionMeta}>
            {params.length === 0
              ? 'none'
              : `${requiredCount} required · ${params.length - requiredCount} optional`}
          </span>
        </div>

        {params.length > 0 && (
          <div class={styles.params}>
            <div class={styles.paramHeadRow}>
              <span>Name</span>
              <span>Type</span>
              <span>Required</span>
              <span>Default / options</span>
              <span />
            </div>
            {params.map((p, idx) => (
              <div class={styles.paramRow} key={idx}>
                <div class={styles.paramName}>
                  <span class={styles.paramColon}>:</span>
                  <input
                    class={styles.paramInput}
                    value={p.name}
                    placeholder="param_name"
                    disabled={readOnly}
                    onInput={e => patchParam(idx, { name: (e.target as HTMLInputElement).value })}
                  />
                </div>
                <select
                  class={styles.paramSelect}
                  value={p.value_type}
                  disabled={readOnly}
                  onChange={e =>
                    patchParam(idx, {
                      value_type: (e.target as HTMLSelectElement).value as DbxParamType,
                    })
                  }
                >
                  {PARAM_TYPES.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <label class={styles.paramReq}>
                  <input
                    type="checkbox"
                    checked={p.required}
                    disabled={readOnly}
                    onChange={e => patchParam(idx, { required: (e.target as HTMLInputElement).checked })}
                  />
                  required
                </label>
                {p.value_type === 'enum' ? (
                  <input
                    class={styles.paramInput}
                    value={p.options}
                    placeholder="comma,separated,options"
                    disabled={readOnly}
                    onInput={e => patchParam(idx, { options: (e.target as HTMLInputElement).value })}
                  />
                ) : (
                  <input
                    class={styles.paramInput}
                    value={p.default_value}
                    placeholder="default value (optional)"
                    disabled={readOnly}
                    onInput={e => patchParam(idx, { default_value: (e.target as HTMLInputElement).value })}
                  />
                )}
                {readOnly ? (
                  <span />
                ) : (
                  <button
                    class={styles.paramRemove}
                    onClick={() => removeParam(idx)}
                    title="Remove parameter"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {params.length === 0 && readOnly && (
          <div class={styles.emptyParams}>No declared parameters</div>
        )}

        {!readOnly && (
          <>
            <button class={styles.addParam} onClick={addParam}>
              <Plus size={13} /> Add parameter
            </button>
            <span class={styles.paramsHint}>
              Reference parameters in SQL as <code>:name</code> tokens — they're validated and bound on run.
            </span>
          </>
        )}
      </section>

      {isEdit && existing && (
        <section class={styles.section}>
          <h2 class={styles.sectionTitle}>Metadata</h2>
          <dl class={styles.metadata}>
            <dt>Owner</dt>
            <dd>{existing.owner_session_id ?? 'system (built-in)'}</dd>
            <dt>Created</dt>
            <dd>{new Date(existing.created_at).toLocaleString()}</dd>
            <dt>Updated</dt>
            <dd>{new Date(existing.updated_at).toLocaleString()}</dd>
            <dt>Shared</dt>
            <dd>{existing.is_shared ? 'true' : 'false (private)'}</dd>
          </dl>
        </section>
      )}

      {!readOnly && (
        <div class={styles.actions}>
          {error && <div class={styles.formError}>{error}</div>}
          <div class={styles.actionRow}>
            {isEdit ? (
              <span class={styles.dirtyHint}>{dirty ? 'Unsaved changes' : 'No changes'}</span>
            ) : (
              <span />
            )}
            <div class={styles.actionBtns}>
              {isEdit ? (
                <button class={styles.btnGhost} onClick={discard} disabled={!dirty || saving}>
                  Discard
                </button>
              ) : (
                <button class={styles.btnGhost} onClick={onCancel} disabled={saving}>
                  Cancel
                </button>
              )}
              <button class={`${styles.btn} ${styles.btnPrimary}`} onClick={save} disabled={!canSave}>
                {saving
                  ? isEdit
                    ? 'Saving…'
                    : 'Creating…'
                  : isEdit
                    ? 'Save changes'
                    : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
