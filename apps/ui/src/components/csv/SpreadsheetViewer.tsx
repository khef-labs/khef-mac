import { useState, useMemo, useCallback, useRef, useEffect } from 'preact/hooks'
import type { JSX } from 'preact'
import { ArrowUp, ArrowDown, ArrowUpDown, Filter, GripVertical } from 'lucide-preact'
import { parseCsv, inferColumnTypes, rowsToCsv } from '../../lib/csvParser'
import { ColumnFilterDropdown } from './ColumnFilterDropdown'
import styles from './SpreadsheetViewer.module.css'

interface SpreadsheetViewerProps {
  content: string
  onContentChange?: (csv: string) => void
  readOnly?: boolean
}

type SortDir = 'asc' | 'desc' | null

interface EditCell {
  row: number
  col: number
}

interface FilterDropdownState {
  col: number
  anchorRect: DOMRect
}

export function SpreadsheetViewer({ content, onContentChange, readOnly = false }: SpreadsheetViewerProps) {
  const parsed = useMemo(() => parseCsv(content), [content])

  const [headers, setHeaders] = useState(parsed.headers)
  const [rows, setRows] = useState(parsed.rows)
  const [delimiter, setDelimiter] = useState(parsed.delimiter)
  const columnTypes = useMemo(() => inferColumnTypes(rows, headers.length), [rows, headers.length])
  const [sortCol, setSortCol] = useState<number | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>(null)
  const [editCell, setEditCell] = useState<EditCell | null>(null)
  const [editValue, setEditValue] = useState('')
  const [colWidths, setColWidths] = useState<number[]>([])
  const [filters, setFilters] = useState<Map<number, Set<string>>>(new Map())
  const [filterDropdown, setFilterDropdown] = useState<FilterDropdownState | null>(null)
  const [dragCol, setDragCol] = useState<number | null>(null)
  const [dragOverCol, setDragOverCol] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const resizeRef = useRef<{ col: number; startX: number; startWidth: number } | null>(null)
  const headerRefs = useRef<(HTMLTableCellElement | null)[]>([])

  // Sync state when content prop changes
  useEffect(() => {
    setHeaders(parsed.headers)
    setRows(parsed.rows)
    setDelimiter(parsed.delimiter)
    setSortCol(null)
    setSortDir(null)
    setFilters(new Map())
    setFilterDropdown(null)
  }, [parsed])

  // Focus input when editing
  useEffect(() => {
    if (editCell && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editCell])

  // Apply column filters
  const filteredRows = useMemo(() => {
    if (filters.size === 0) return rows
    return rows.filter((row) => {
      for (const [col, allowed] of filters) {
        const val = row[col] ?? ''
        if (!allowed.has(val)) return false
      }
      return true
    })
  }, [rows, filters])

  const sortedRows = useMemo(() => {
    if (sortCol === null || sortDir === null) return filteredRows
    const col = sortCol
    const dir = sortDir
    const isNum = columnTypes[col]?.type === 'number'

    return [...filteredRows].sort((a, b) => {
      const va = a[col] ?? ''
      const vb = b[col] ?? ''
      let cmp: number
      if (isNum) {
        const na = parseFloat(va.replace(/,/g, '')) || 0
        const nb = parseFloat(vb.replace(/,/g, '')) || 0
        cmp = na - nb
      } else {
        cmp = va.localeCompare(vb, undefined, { sensitivity: 'base' })
      }
      return dir === 'desc' ? -cmp : cmp
    })
  }, [filteredRows, sortCol, sortDir, columnTypes])

  const openFilter = useCallback((col: number, e: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setFilterDropdown({ col, anchorRect: rect })
  }, [])

  const applyFilter = useCallback((col: number, selected: Set<string> | null) => {
    setFilters((prev) => {
      const next = new Map(prev)
      if (selected === null) {
        next.delete(col)
      } else {
        next.set(col, selected)
      }
      return next
    })
    setFilterDropdown(null)
  }, [])

  const clearAllFilters = useCallback(() => {
    setFilters(new Map())
  }, [])

  // Column reorder via mouse events
  const reorderColumns = useCallback((fromCol: number, toCol: number) => {
    if (fromCol === toCol) return

    const reorder = <T,>(arr: T[]): T[] => {
      const next = [...arr]
      const [item] = next.splice(fromCol, 1)
      next.splice(toCol, 0, item)
      return next
    }

    const newHeaders = reorder(headers)
    const newRows = rows.map((row) => reorder(row))

    // Update filters to reflect new column indices
    const newFilters = new Map<number, Set<string>>()
    for (const [col, vals] of filters) {
      let newIdx = col
      if (col === fromCol) {
        newIdx = toCol
      } else if (fromCol < toCol) {
        if (col > fromCol && col <= toCol) newIdx = col - 1
      } else {
        if (col >= toCol && col < fromCol) newIdx = col + 1
      }
      newFilters.set(newIdx, vals)
    }

    // Update sort column index
    if (sortCol !== null) {
      let newSortCol = sortCol
      if (sortCol === fromCol) {
        newSortCol = toCol
      } else if (fromCol < toCol) {
        if (sortCol > fromCol && sortCol <= toCol) newSortCol = sortCol - 1
      } else {
        if (sortCol >= toCol && sortCol < fromCol) newSortCol = sortCol + 1
      }
      setSortCol(newSortCol)
    }

    setHeaders(newHeaders)
    setRows(newRows)
    setFilters(newFilters)

    if (onContentChange) {
      onContentChange(rowsToCsv(newHeaders, newRows, delimiter))
    }
  }, [headers, rows, filters, sortCol, delimiter, onContentChange])

  const handleGripMouseDown = useCallback((col: number, e: JSX.TargetedMouseEvent<HTMLSpanElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    let isDragging = false
    const sourceCol = col

    setDragCol(col)

    const findTargetCol = (clientX: number): number | null => {
      for (let i = 0; i < headerRefs.current.length; i++) {
        const th = headerRefs.current[i]
        if (!th || i === sourceCol) continue
        const rect = th.getBoundingClientRect()
        if (clientX >= rect.left && clientX <= rect.right) {
          return i
        }
      }
      return null
    }

    const handleMove = (ev: MouseEvent) => {
      if (!isDragging && Math.abs(ev.clientX - startX) > 5) {
        isDragging = true
      }
      if (isDragging) {
        const target = findTargetCol(ev.clientX)
        setDragOverCol(target)
      }
    }

    const handleUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)

      if (isDragging) {
        const target = findTargetCol(ev.clientX)
        if (target !== null) {
          reorderColumns(sourceCol, target)
        }
      }

      setDragCol(null)
      setDragOverCol(null)
    }

    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }, [reorderColumns])

  const handleSort = useCallback((col: number) => {
    if (sortCol !== col) {
      setSortCol(col)
      setSortDir('asc')
    } else if (sortDir === 'asc') {
      setSortDir('desc')
    } else {
      setSortCol(null)
      setSortDir(null)
    }
  }, [sortCol, sortDir])

  const startEdit = useCallback((row: number, col: number, value: string) => {
    if (readOnly) return
    setEditCell({ row, col })
    setEditValue(value)
  }, [readOnly])

  const commitEdit = useCallback(() => {
    if (!editCell) return
    const { row, col } = editCell
    setRows((prev) => {
      const next = prev.map((r) => [...r])
      // Find the actual index in the unsorted array
      const actualRow = sortCol !== null && sortDir !== null ? rows.indexOf(sortedRows[row]) : row
      if (actualRow >= 0 && next[actualRow]) {
        next[actualRow][col] = editValue
      }
      if (onContentChange) {
        onContentChange(rowsToCsv(headers, next, delimiter))
      }
      return next
    })
    setEditCell(null)
  }, [editCell, editValue, headers, delimiter, onContentChange, rows, sortedRows, sortCol, sortDir])

  const cancelEdit = useCallback(() => {
    setEditCell(null)
  }, [])

  const handleEditKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      commitEdit()
      if (editCell) {
        const nextCol = e.shiftKey ? editCell.col - 1 : editCell.col + 1
        if (nextCol >= 0 && nextCol < headers.length) {
          const val = sortedRows[editCell.row]?.[nextCol] ?? ''
          startEdit(editCell.row, nextCol, val)
        }
      }
    }
  }, [commitEdit, cancelEdit, editCell, headers.length, sortedRows, startEdit])

  // Column resize via drag
  const handleResizeStart = useCallback((e: JSX.TargetedMouseEvent<HTMLDivElement>, col: number) => {
    e.preventDefault()
    e.stopPropagation()
    const th = (e.target as HTMLElement).parentElement
    if (!th) return
    resizeRef.current = { col, startX: e.clientX, startWidth: th.offsetWidth }

    const handleMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      const diff = ev.clientX - resizeRef.current.startX
      const newWidth = Math.max(60, resizeRef.current.startWidth + diff)
      setColWidths((prev) => {
        const next = [...prev]
        next[resizeRef.current!.col] = newWidth
        return next
      })
    }

    const handleUp = () => {
      resizeRef.current = null
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }

    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }, [])

  if (headers.length === 0) {
    return <div class={styles.empty}>No data to display</div>
  }

  const sortIndicator = (col: number) => {
    if (sortCol !== col) return <span class={styles.sortIcon}><ArrowUpDown size={14} /></span>
    if (sortDir === 'asc') return <span class={styles.sortIconActive}><ArrowUp size={14} /></span>
    if (sortDir === 'desc') return <span class={styles.sortIconActive}><ArrowDown size={14} /></span>
    return <span class={styles.sortIcon}><ArrowUpDown size={14} /></span>
  }

  return (
    <div class={styles.wrapper}>
      <div class={styles.info}>
        {filters.size > 0
          ? `${sortedRows.length} of ${rows.length} row${rows.length !== 1 ? 's' : ''} (filtered)`
          : `${sortedRows.length} row${sortedRows.length !== 1 ? 's' : ''}`
        }
        {' '}&times; {headers.length} column{headers.length !== 1 ? 's' : ''}
        {!readOnly && <span class={styles.hint}> · Double-click a cell to edit</span>}
      </div>
      {filters.size > 0 && (
        <div class={styles.activeFilters}>
          {Array.from(filters.entries()).map(([col, selected]) => {
            const totalUnique = new Set(rows.map((r) => r[col] ?? '')).size
            return (
              <span key={col} class={styles.filterChip}>
                <span class={styles.filterChipCol}>{headers[col]}</span>
                <span class={styles.filterChipCount}>
                  {selected.size} of {totalUnique}
                </span>
                <button
                  class={styles.filterChipRemove}
                  onClick={() => applyFilter(col, null)}
                  title={`Remove filter on ${headers[col]}`}
                >
                  &times;
                </button>
              </span>
            )
          })}
          {filters.size > 1 && (
            <button class={styles.clearFiltersBtn} onClick={clearAllFilters}>
              Clear all
            </button>
          )}
        </div>
      )}
      <div class={styles.tableContainer}>
        <table class={styles.table}>
          <thead>
            <tr>
              <th class={styles.rowNumHeader}>#</th>
              {headers.map((h, i) => (
                <th
                  key={i}
                  ref={(el) => { headerRefs.current[i] = el }}
                  class={`${styles.headerCell}${dragCol === i ? ` ${styles.headerDragging}` : ''}${dragOverCol === i ? ` ${styles.headerDragOver}` : ''}`}
                  style={colWidths[i] ? { width: `${colWidths[i]}px`, minWidth: `${colWidths[i]}px` } : undefined}
                  onClick={() => handleSort(i)}
                >
                  <div class={styles.headerContent}>
                    <span
                      class={styles.dragHandle}
                      data-testid={`csv-grip--${i}`}
                      onMouseDown={(e) => handleGripMouseDown(i, e)}
                    >
                      <GripVertical size={12} />
                    </span>
                    <span class={styles.headerText}>{h}</span>
                    {sortIndicator(i)}
                    <button
                      class={`${styles.filterBtn} ${filters.has(i) ? styles.filterBtnActive : ''}`}
                      onClick={(e) => openFilter(i, e)}
                      title={`Filter by ${h}`}
                    >
                      <Filter size={12} />
                    </button>
                  </div>
                  <div
                    class={styles.resizeHandle}
                    onMouseDown={(e) => handleResizeStart(e, i)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, ri) => (
              <tr key={ri} class={ri % 2 === 0 ? styles.rowEven : styles.rowOdd}>
                <td class={styles.rowNum}>{ri + 1}</td>
                {headers.map((_h, ci) => {
                  const val = row[ci] ?? ''
                  const isEditing = editCell?.row === ri && editCell?.col === ci
                  const isNumber = columnTypes[ci]?.type === 'number'

                  if (isEditing) {
                    return (
                      <td key={ci} class={styles.cellEditing}>
                        <input
                          ref={inputRef}
                          class={styles.cellInput}
                          value={editValue}
                          onInput={(e) => setEditValue((e.target as HTMLInputElement).value)}
                          onKeyDown={handleEditKeyDown}
                          onBlur={commitEdit}
                        />
                      </td>
                    )
                  }

                  return (
                    <td
                      key={ci}
                      class={isNumber ? styles.cellNumber : styles.cell}
                      onDblClick={() => startEdit(ri, ci, val)}
                      title={val.length > 50 ? val : undefined}
                    >
                      <span class={styles.cellText}>{val}</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filterDropdown && (
        <ColumnFilterDropdown
          header={headers[filterDropdown.col]}
          values={rows.map((r) => r[filterDropdown.col] ?? '')}
          selected={filters.get(filterDropdown.col) ?? null}
          onApply={(sel) => applyFilter(filterDropdown.col, sel)}
          onClose={() => setFilterDropdown(null)}
          anchorRect={filterDropdown.anchorRect}
        />
      )}
    </div>
  )
}
