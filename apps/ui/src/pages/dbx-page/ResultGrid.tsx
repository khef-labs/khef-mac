import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import { ChevronRight, ChevronLeft, List, Grid3X3, Download, ArrowUp, ArrowDown, Copy, Check } from 'lucide-preact'
import clsx from 'clsx'
import type { DbxQueryResult } from '../../lib/dbx-api'
import styles from './DbxPage.module.css'

/** Parse pg array string like "{a,b,c}" into ["a","b","c"], or pass through if already an array */
export function pgArray(val: any): string[] {
  if (Array.isArray(val)) return val
  if (typeof val === 'string' && val.startsWith('{') && val.endsWith('}')) {
    return val.slice(1, -1).split(',').map(s => s.trim())
  }
  return [String(val)]
}

export function renderCell(value: any, colType: string) {
  if (value === null || value === undefined) {
    return <span class={styles.cellNull}>NULL</span>
  }
  if (colType === 'uuid') {
    return <span class={styles.cellUuid}>{String(value)}</span>
  }
  if (['int2', 'int4', 'int8', 'float4', 'float8', 'numeric'].includes(colType)) {
    return <span class={styles.cellNum}>{String(value)}</span>
  }
  if (colType === 'bool') {
    return <span class={styles.cellBool}>{String(value)}</span>
  }
  if (['timestamp', 'timestamptz', 'date'].includes(colType)) {
    return <span class={styles.cellTs}>{String(value)}</span>
  }
  if (typeof value === 'object') {
    return String(JSON.stringify(value))
  }
  return String(value)
}

interface ResultGridProps {
  result: DbxQueryResult
  queryError: string | null
  maxRows: number
  onMaxRowsChange: (n: number) => void
  viewMode: 'grid' | 'record'
  onViewModeChange: (mode: 'grid' | 'record') => void
  recordIndex: number
  onRecordIndexChange: (i: number) => void
  onSort?: (column: string, direction: 'asc' | 'desc') => void
  onFilter?: (where: string) => void
  onRowDoubleClick?: (rowIndex: number) => void
}

function escapeCsvField(val: any): string {
  if (val === null || val === undefined) return ''
  const s = typeof val === 'object' ? JSON.stringify(val) : String(val)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function ResultGrid({
  result, queryError, maxRows, onMaxRowsChange,
  viewMode, onViewModeChange, recordIndex, onRecordIndexChange, onSort, onFilter, onRowDoubleClick,
}: ResultGridProps) {
  const [sortCol, setSortCol] = useState<number | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [copied, setCopied] = useState(false)
  const [copiedCsv, setCopiedCsv] = useState(false)
  const [copiedJson, setCopiedJson] = useState(false)
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; rowIndex: number; colIndex: number | null } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close row context menu on outside click / escape / scroll
  useEffect(() => {
    if (!rowMenu) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setRowMenu(null)
    }
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setRowMenu(null) }
    const handleScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      setRowMenu(null)
    }
    const timer = setTimeout(() => document.addEventListener('click', handleClick), 0)
    document.addEventListener('keydown', handleKey)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handleClick)
      document.removeEventListener('keydown', handleKey)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [rowMenu])

  const handleCellContextMenu = useCallback((e: MouseEvent, rowIndex: number, colIndex: number | null) => {
    e.preventDefault()
    const menuWidth = 220, menuHeight = 160, pad = 8
    let x = e.clientX, y = e.clientY
    if (x + menuWidth + pad > window.innerWidth) x = window.innerWidth - menuWidth - pad
    if (y + menuHeight + pad > window.innerHeight) y = window.innerHeight - menuHeight - pad
    setRowMenu({ x, y, rowIndex, colIndex })
  }, [])

  // Arrow key navigation in record view
  useEffect(() => {
    if (viewMode !== 'record' || !result.rows || result.rows.length === 0) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        onRecordIndexChange(Math.max(0, recordIndex - 1))
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        onRecordIndexChange(Math.min(result.rows.length - 1, recordIndex + 1))
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [viewMode, recordIndex, result.rows?.length])

  if (!result.columns || !result.rows) return null

  function toggleSort(colIndex: number) {
    const newDir = sortCol === colIndex && sortDir === 'asc' ? 'desc' : 'asc'
    setSortCol(colIndex)
    setSortDir(newDir)
    if (onSort) {
      onSort(result.columns[colIndex].name, newDir)
    }
  }

  const sortedRows = sortCol !== null && !onSort
    ? [...result.rows].sort((a, b) => {
        const va = a[sortCol]
        const vb = b[sortCol]
        if (va === null || va === undefined) return sortDir === 'asc' ? 1 : -1
        if (vb === null || vb === undefined) return sortDir === 'asc' ? -1 : 1
        if (typeof va === 'number' && typeof vb === 'number') return sortDir === 'asc' ? va - vb : vb - va
        const sa = String(va), sb = String(vb)
        return sortDir === 'asc' ? sa.localeCompare(sb) : sb.localeCompare(sa)
      })
    : result.rows

  const safeRecordIdx = Math.min(recordIndex, Math.max(0, sortedRows.length - 1))
  const currentRow = sortedRows[safeRecordIdx]

  function exportCsv() {
    const header = result.columns.map(c => escapeCsvField(c.name)).join(',')
    const rows = result.rows.map(row => row.map(cell => escapeCsvField(cell)).join(','))
    downloadFile([header, ...rows].join('\n'), 'query-results.csv', 'text/csv')
  }

  function exportJson() {
    const data = result.rows.map(row => {
      const obj: Record<string, any> = {}
      result.columns.forEach((col, i) => { obj[col.name] = row[i] })
      return obj
    })
    downloadFile(JSON.stringify(data, null, 2), 'query-results.json', 'application/json')
  }

  function copyTsv() {
    const header = result.columns.map(c => c.name).join('\t')
    const rows = result.rows.map(row =>
      row.map(cell => cell === null || cell === undefined ? '' : typeof cell === 'object' ? JSON.stringify(cell) : String(cell)).join('\t')
    )
    navigator.clipboard.writeText([header, ...rows].join('\n')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  function copyCsv() {
    const header = result.columns.map(c => escapeCsvField(c.name)).join(',')
    const rows = result.rows.map(row => row.map(cell => escapeCsvField(cell)).join(','))
    navigator.clipboard.writeText([header, ...rows].join('\n')).then(() => {
      setCopiedCsv(true)
      setTimeout(() => setCopiedCsv(false), 1500)
    })
  }

  function copyJson() {
    const data = result.rows.map(row => {
      const obj: Record<string, any> = {}
      result.columns.forEach((col, i) => { obj[col.name] = row[i] })
      return obj
    })
    navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => {
      setCopiedJson(true)
      setTimeout(() => setCopiedJson(false), 1500)
    })
  }

  return (
    <>
      <div class={styles.gridWrapper}>
        {viewMode === 'grid' ? (
          <>
            <table class={styles.dataGrid}>
              <thead>
                <tr>
                  <th>#</th>
                  {result.columns.map((col, ci) => (
                    <th key={col.name} class={styles.sortableHeader} onClick={() => toggleSort(ci)}>
                      {col.name}
                      {sortCol === ci && (sortDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row, i) => (
                  <tr
                    key={i}
                    onContextMenu={e => handleCellContextMenu(e as unknown as MouseEvent, i, null)}
                    onDblClick={onRowDoubleClick ? () => onRowDoubleClick(i) : undefined}
                    style={onRowDoubleClick ? { cursor: 'pointer' } : undefined}
                  >
                    <td class={styles.cellNum}>{i + 1}</td>
                    {row.map((cell, j) => (
                      <td key={j} onContextMenu={e => { e.stopPropagation(); handleCellContextMenu(e as unknown as MouseEvent, i, j) }}>{renderCell(cell, result.columns[j]?.type || '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rowMenu && (
              <div
                ref={menuRef}
                class={styles.contextMenu}
                style={{ left: `${rowMenu.x}px`, top: `${rowMenu.y}px` }}
                onClick={e => e.stopPropagation()}
                onMouseDown={e => e.stopPropagation()}
              >
                <button class={styles.contextMenuItem} onClick={() => {
                  onViewModeChange('record')
                  onRecordIndexChange(rowMenu.rowIndex)
                  setRowMenu(null)
                }}>
                  <List size={14} /> View Record
                </button>
                <button class={styles.contextMenuItem} onClick={() => {
                  const row = sortedRows[rowMenu.rowIndex]
                  if (!row) { setRowMenu(null); return }
                  const obj: Record<string, any> = {}
                  result.columns.forEach((col, ci) => { obj[col.name] = row[ci] })
                  navigator.clipboard.writeText(JSON.stringify(obj, null, 2)).catch(() => {})
                  setRowMenu(null)
                }}>
                  <Copy size={14} /> Copy Row JSON
                </button>
                {rowMenu.colIndex !== null && (() => {
                  const col = result.columns[rowMenu.colIndex]
                  const val = sortedRows[rowMenu.rowIndex]?.[rowMenu.colIndex]
                  const displayVal = val === null || val === undefined ? 'NULL' : typeof val === 'object' ? JSON.stringify(val) : String(val)
                  const truncated = displayVal.length > 30 ? displayVal.slice(0, 27) + '...' : displayVal
                  return (
                    <>
                      <button class={styles.contextMenuItem} onClick={() => {
                        const text = val === null || val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val)
                        navigator.clipboard.writeText(text).catch(() => {})
                        setRowMenu(null)
                      }}>
                        <Copy size={14} /> Copy Cell
                      </button>
                      {onFilter && (
                        <button class={styles.contextMenuItem} onClick={() => {
                          const where = val === null || val === undefined
                            ? `${col.name} IS NULL`
                            : typeof val === 'number' || typeof val === 'boolean'
                              ? `${col.name} = ${val}`
                              : `${col.name} = '${String(val).replace(/'/g, "''")}'`
                          onFilter(where)
                          setRowMenu(null)
                        }}>
                          <ArrowDown size={14} /> Filter: {col.name} = {truncated}
                        </button>
                      )}
                    </>
                  )
                })()}
              </div>
            )}
          </>
        ) : currentRow ? (
          <table class={styles.dataGrid}>
            <thead>
              <tr>
                <th style={{ width: '200px' }}>Column</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {result.columns.map((col, j) => (
                <tr key={col.name}>
                  <td style={{ fontWeight: 600, color: 'var(--muted)' }}>{col.name}</td>
                  <td style={{ whiteSpace: 'pre-wrap', maxWidth: 'none' }}>{renderCell(currentRow[j], col.type)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
      <div class={styles.statusBar}>
        {queryError ? (
          <span class={styles.statusError}>{queryError}</span>
        ) : (
          <>
            <span class={styles.statusSuccess}>
              {result.affectedRows !== null
                ? `${result.affectedRows} affected`
                : `${result.rowCount} rows`}
              {result.truncated && ' (truncated)'}
            </span>
            <span>{result.duration}ms</span>
          </>
        )}
        <div class={styles.spacer} />
        <div class={styles.viewToggle}>
          <button
            class={clsx(styles.viewToggleBtn, viewMode === 'grid' && styles.active)}
            onClick={() => onViewModeChange('grid')}
            title="Table view"
          >
            <Grid3X3 size={13} />
          </button>
          <button
            class={clsx(styles.viewToggleBtn, viewMode === 'record' && styles.active)}
            onClick={() => { onViewModeChange('record'); onRecordIndexChange(0) }}
            title="Record view"
          >
            <List size={13} />
          </button>
        </div>
        {viewMode === 'record' && result.rows.length > 0 && (
          <div class={styles.recordNav}>
            <button
              class={styles.recordNavBtn}
              disabled={safeRecordIdx <= 0}
              onClick={() => onRecordIndexChange(Math.max(0, safeRecordIdx - 1))}
            >
              <ChevronLeft size={14} />
            </button>
            <span>{safeRecordIdx + 1} / {result.rows.length}</span>
            <button
              class={styles.recordNavBtn}
              disabled={safeRecordIdx >= result.rows.length - 1}
              onClick={() => onRecordIndexChange(Math.min(result.rows.length - 1, safeRecordIdx + 1))}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}
        {result.rows.length > 0 && (
          <div class={styles.exportBtns}>
            <div class={styles.exportMenuContainer}>
              <button class={styles.exportBtn} onClick={copyTsv} title="Copy to clipboard">
                {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
              </button>
              <div class={styles.exportMenuOptions}>
                <button class={styles.exportOption} onClick={copyCsv} title="Copy as CSV">
                  {copiedCsv ? <Check size={12} /> : <Copy size={12} />} {copiedCsv ? 'Copied' : 'CSV'}
                </button>
                <button class={styles.exportOption} onClick={copyJson} title="Copy as JSON">
                  {copiedJson ? <Check size={12} /> : <Copy size={12} />} {copiedJson ? 'Copied' : 'JSON'}
                </button>
              </div>
            </div>
            <button class={styles.exportBtn} onClick={exportCsv} title="Export as CSV"><Download size={12} /> CSV</button>
            <button class={styles.exportBtn} onClick={exportJson} title="Export as JSON"><Download size={12} /> JSON</button>
          </div>
        )}
        <div class={styles.rowLimitControl}>
          <span>Rows:</span>
          <select value={maxRows} onChange={e => onMaxRowsChange(parseInt((e.target as HTMLSelectElement).value, 10))}>
            <option value={200}>200</option>
            <option value={500}>500</option>
            <option value={1000}>1000</option>
            <option value={5000}>5000</option>
          </select>
        </div>
      </div>
    </>
  )
}
