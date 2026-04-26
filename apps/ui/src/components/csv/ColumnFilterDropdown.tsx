import { useState, useMemo, useRef, useEffect, useCallback } from 'preact/hooks'
import styles from './SpreadsheetViewer.module.css'

interface ColumnFilterDropdownProps {
  header: string
  values: string[]
  selected: Set<string> | null // null = no filter active (all shown)
  onApply: (selected: Set<string> | null) => void
  onClose: () => void
  anchorRect: DOMRect | null
}

export function ColumnFilterDropdown({
  header,
  values,
  selected,
  onApply,
  onClose,
  anchorRect,
}: ColumnFilterDropdownProps) {
  const uniqueValues = useMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []
    for (const v of values) {
      const key = v ?? ''
      if (!seen.has(key)) {
        seen.add(key)
        result.push(key)
      }
    }
    result.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    return result
  }, [values])

  const [search, setSearch] = useState('')
  const [checked, setChecked] = useState<Set<string>>(() =>
    selected ? new Set(selected) : new Set(uniqueValues)
  )
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // Close on outside click
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [onClose])

  const filtered = useMemo(() => {
    if (!search) return uniqueValues
    const q = search.toLowerCase()
    return uniqueValues.filter((v) => (v || '(empty)').toLowerCase().includes(q))
  }, [uniqueValues, search])

  const allChecked = filtered.length > 0 && filtered.every((v) => checked.has(v))
  const noneChecked = filtered.every((v) => !checked.has(v))

  const toggleAll = useCallback(() => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (allChecked) {
        for (const v of filtered) next.delete(v)
      } else {
        for (const v of filtered) next.add(v)
      }
      return next
    })
  }, [filtered, allChecked])

  const toggle = useCallback((value: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }, [])

  const handleApply = () => {
    // If all values are checked, clear the filter entirely
    if (checked.size === uniqueValues.length) {
      onApply(null)
    } else {
      onApply(new Set(checked))
    }
  }

  const handleClear = () => {
    onApply(null)
  }

  // Position the dropdown below the header cell
  const dropdownStyle: Record<string, string> = {}
  if (anchorRect) {
    dropdownStyle.position = 'fixed'
    dropdownStyle.top = `${anchorRect.bottom + 2}px`
    dropdownStyle.left = `${anchorRect.left}px`
  }

  return (
    <div
      ref={menuRef}
      class={styles.filterDropdown}
      style={dropdownStyle}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div class={styles.filterHeader}>
        <span class={styles.filterTitle}>Filter: {header}</span>
      </div>
      <input
        ref={searchRef}
        class={styles.filterSearch}
        type="text"
        placeholder="Search values..."
        value={search}
        onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
      />
      <div class={styles.filterSelectAll}>
        <label class={styles.filterCheckLabel}>
          <input
            type="checkbox"
            checked={allChecked}
            indeterminate={!allChecked && !noneChecked}
            onChange={toggleAll}
          />
          <span>{search ? `Select visible (${filtered.length})` : 'Select all'}</span>
        </label>
      </div>
      <div class={styles.filterList}>
        {filtered.map((v) => (
          <label key={v} class={styles.filterCheckLabel}>
            <input
              type="checkbox"
              checked={checked.has(v)}
              onChange={() => toggle(v)}
            />
            <span class={styles.filterValue}>{v || '(empty)'}</span>
          </label>
        ))}
        {filtered.length === 0 && (
          <div class={styles.filterEmpty}>No matching values</div>
        )}
      </div>
      <div class={styles.filterActions}>
        <button class={styles.filterClearBtn} onClick={handleClear}>
          Clear
        </button>
        <button class={styles.filterApplyBtn} onClick={handleApply}>
          Apply
        </button>
      </div>
    </div>
  )
}
