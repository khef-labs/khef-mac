import { useState, useEffect, useRef } from 'preact/hooks'
import { Maximize2, X } from 'lucide-preact'
import type { DbxTableDetail } from '../../lib/dbx-api'
import { pgArray } from './ResultGrid'
import { CodeEditor } from '../../components/editor/CodeEditor'
import styles from './DatabasePage.module.css'

function isLongTextType(t: string): boolean {
  const lower = t.toLowerCase()
  return /^(text|jsonb?|xml|character varying|varchar)$/.test(lower)
}

function isJsonType(t: string): boolean {
  return /^jsonb?$/.test(t.toLowerCase())
}

interface EditRowDialogProps {
  tableDetail: DbxTableDetail
  columns: { name: string; type: string }[]
  row: any[]
  onSubmit: (updates: { col: string; rawValue: string; isNull: boolean }[], whereClause: string) => void
  onCancel: () => void
}

function formatDisplay(val: any): string {
  if (val === null || val === undefined) return ''
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

export function EditRowDialog({ tableDetail, columns, row, onSubmit, onCancel }: EditRowDialogProps) {
  // Determine primary key columns
  const pkCols: string[] = []
  for (const c of tableDetail.constraints) {
    if (c.type === 'PRIMARY KEY') {
      for (const col of pgArray(c.columns)) pkCols.push(col)
    }
  }

  const hasPk = pkCols.length > 0

  // Track edited values (text) and null flags per column index
  const [values, setValues] = useState<string[]>(() => row.map(v => formatDisplay(v)))
  const [nulls, setNulls] = useState<boolean[]>(() => row.map(v => v === null || v === undefined))
  const firstInputRef = useRef<HTMLInputElement | null>(null)
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [expandedDraft, setExpandedDraft] = useState('')

  useEffect(() => {
    // Focus the first non-PK input
    const firstEditableIdx = columns.findIndex(c => !pkCols.includes(c.name))
    if (firstEditableIdx >= 0) {
      const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-edit-row-col="${firstEditableIdx}"]`)
      el?.focus()
      if ('select' in el!) el!.select()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (expandedIdx !== null) setExpandedIdx(null)
        else onCancel()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [expandedIdx])

  function handleSubmit(e: Event) {
    e.preventDefault()
    if (!hasPk) return

    // Collect only changed non-PK columns
    const updates: { col: string; rawValue: string; isNull: boolean }[] = []
    columns.forEach((col, i) => {
      if (pkCols.includes(col.name)) return
      const originalIsNull = row[i] === null || row[i] === undefined
      const originalStr = formatDisplay(row[i])
      const changed = nulls[i] !== originalIsNull || (!nulls[i] && values[i] !== originalStr)
      if (changed) updates.push({ col: col.name, rawValue: values[i], isNull: nulls[i] })
    })

    if (updates.length === 0) {
      onCancel()
      return
    }

    // Build WHERE clause from PK columns
    const whereParts: string[] = []
    for (const pk of pkCols) {
      const pkIdx = columns.findIndex(c => c.name === pk)
      if (pkIdx < 0) continue
      const pkVal = row[pkIdx]
      if (pkVal === null || pkVal === undefined) {
        whereParts.push(`"${pk}" IS NULL`)
      } else if (typeof pkVal === 'number' || typeof pkVal === 'boolean') {
        whereParts.push(`"${pk}" = ${pkVal}`)
      } else {
        const str = typeof pkVal === 'object' ? JSON.stringify(pkVal) : String(pkVal)
        whereParts.push(`"${pk}" = '${str.replace(/'/g, "''")}'`)
      }
    }
    const whereClause = whereParts.join(' AND ')
    onSubmit(updates, whereClause)
  }

  function openExpanded(i: number) {
    setExpandedDraft(values[i])
    setExpandedIdx(i)
  }

  function saveExpanded() {
    if (expandedIdx === null) return
    const idx = expandedIdx
    setValues(prev => { const next = [...prev]; next[idx] = expandedDraft; return next })
    setExpandedIdx(null)
  }

  const expandedCol = expandedIdx !== null ? columns[expandedIdx] : null
  const expandedLang = expandedCol
    ? isJsonType(expandedCol.type) ? 'json'
      : /^xml$/i.test(expandedCol.type) ? 'html'
      : 'markdown'
    : 'plain'

  return (
    <div class={styles.dialogOverlay} onClick={onCancel}>
      <div class={styles.dialog} onClick={e => e.stopPropagation()} style={{ width: '720px', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div class={styles.dialogTitle}>Edit Row — {tableDetail.name}</div>
        {!hasPk && (
          <div style={{ padding: '12px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid var(--error)', borderRadius: '4px', marginBottom: '12px', color: 'var(--error)', fontSize: '12px' }}>
            This table has no primary key. Row updates are disabled.
          </div>
        )}
        <form onSubmit={handleSubmit} style={{ overflowY: 'auto', flex: 1 }}>
          <table class={styles.dataGrid} style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: '34%' }}>Column</th>
                <th>Value</th>
                <th style={{ width: '56px' }}>NULL</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((col, i) => {
                const isPk = pkCols.includes(col.name)
                const isLong = isLongTextType(col.type)
                return (
                  <tr key={col.name}>
                    <td style={{ fontWeight: 600, color: 'var(--muted)', verticalAlign: 'top', paddingTop: '8px' }}>
                      {col.name}
                      {isPk && <span style={{ marginLeft: '6px', color: 'var(--warning)', fontSize: '10px' }}>PK</span>}
                      <div style={{ fontWeight: 400, fontSize: '10px', color: 'var(--muted)', opacity: 0.7 }}>{col.type}</div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                        {isLong ? (
                          <textarea
                            ref={i === 0 ? firstInputRef as any : undefined}
                            data-edit-row-col={i}
                            class={styles.formInput}
                            value={nulls[i] ? '' : values[i]}
                            placeholder={nulls[i] ? 'NULL' : undefined}
                            disabled={isPk || nulls[i]}
                            rows={3}
                            onInput={e => {
                              const v = (e.target as HTMLTextAreaElement).value
                              setValues(prev => { const next = [...prev]; next[i] = v; return next })
                            }}
                            spellcheck={false}
                            style={{
                              resize: 'vertical',
                              minHeight: '60px',
                              maxHeight: '160px',
                              fontFamily: isJsonType(col.type) ? 'var(--font-mono)' : undefined,
                              fontSize: '12px',
                              opacity: nulls[i] ? 0.5 : 1,
                              fontStyle: nulls[i] ? 'italic' : 'normal',
                              cursor: nulls[i] || isPk ? 'not-allowed' : 'text',
                            }}
                          />
                        ) : (
                          <input
                            ref={i === 0 ? firstInputRef : undefined}
                            data-edit-row-col={i}
                            class={styles.formInput}
                            value={nulls[i] ? '' : values[i]}
                            placeholder={nulls[i] ? 'NULL' : undefined}
                            disabled={isPk || nulls[i]}
                            onInput={e => {
                              const v = (e.target as HTMLInputElement).value
                              setValues(prev => { const next = [...prev]; next[i] = v; return next })
                            }}
                            spellcheck={false}
                            style={{
                              flex: 1,
                              opacity: nulls[i] ? 0.5 : 1,
                              fontStyle: nulls[i] ? 'italic' : 'normal',
                              cursor: nulls[i] || isPk ? 'not-allowed' : 'text',
                            }}
                          />
                        )}
                        {isLong && (
                          <button
                            type="button"
                            class={styles.btnIcon}
                            onClick={() => openExpanded(i)}
                            disabled={isPk || nulls[i]}
                            title="Open in editor"
                            style={{ marginTop: '2px' }}
                          >
                            <Maximize2 size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                    <td style={{ textAlign: 'center', verticalAlign: 'middle' }}>
                      <input
                        type="checkbox"
                        checked={nulls[i]}
                        disabled={isPk}
                        onChange={e => {
                          const checked = (e.target as HTMLInputElement).checked
                          setNulls(prev => { const next = [...prev]; next[i] = checked; return next })
                        }}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div class={styles.dialogActions} style={{ marginTop: '12px' }}>
            <button type="button" class={styles.btnSecondary} onClick={onCancel}>Cancel</button>
            <button type="submit" class={styles.btnPrimary} disabled={!hasPk}>Save Changes</button>
          </div>
        </form>
      </div>

      {/* Expanded editor modal */}
      {expandedIdx !== null && expandedCol && (
        <div
          class={styles.dialogOverlay}
          style={{ zIndex: 1100 }}
          onClick={(e) => { if (e.target === e.currentTarget) setExpandedIdx(null) }}
        >
          <div
            class={styles.dialog}
            onClick={e => e.stopPropagation()}
            style={{ width: '90vw', height: '85vh', display: 'flex', flexDirection: 'column', padding: 0 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
              <div class={styles.dialogTitle} style={{ margin: 0, padding: 0 }}>
                Editing: {expandedCol.name}
                <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--muted)', fontWeight: 400 }}>({expandedCol.type})</span>
              </div>
              <div style={{ flex: 1 }} />
              <button type="button" class={styles.btnIcon} onClick={() => setExpandedIdx(null)} title="Cancel"><X size={14} /></button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <CodeEditor
                value={expandedDraft}
                onChange={v => setExpandedDraft(v)}
                language={expandedLang}
                autoFocus
                onSave={saveExpanded}
              />
            </div>
            <div class={styles.dialogActions} style={{ padding: '12px 16px', borderTop: '1px solid var(--border-subtle)' }}>
              <button type="button" class={styles.btnSecondary} onClick={() => setExpandedIdx(null)}>Cancel</button>
              <button type="button" class={styles.btnPrimary} onClick={saveExpanded}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
