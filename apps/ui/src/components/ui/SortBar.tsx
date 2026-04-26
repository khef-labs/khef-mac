import clsx from 'clsx'
import styles from './SortBar.module.css'

export interface SortField {
  key: string
  label: string
}

export type SortDirection = 'asc' | 'desc'

export interface SortState {
  field: string
  direction: SortDirection
}

interface SortBarProps {
  fields: SortField[]
  value: SortState
  onChange: (state: SortState) => void
}

const DATE_KEYS = new Set(['updated_at', 'added_at', 'created_at', 'last_used', 'date', 'timestamp'])

export function SortBar({ fields, value, onChange }: SortBarProps) {
  const handleClick = (key: string) => {
    if (value.field === key) {
      onChange({ field: key, direction: value.direction === 'asc' ? 'desc' : 'asc' })
    } else {
      const defaultDir: SortDirection = DATE_KEYS.has(key) ? 'desc' : 'asc'
      onChange({ field: key, direction: defaultDir })
    }
  }

  return (
    <div class={styles.sortBar} role="toolbar" aria-label="Sort options">
      {fields.map((f) => {
        const isActive = value.field === f.key
        return (
          <button
            key={f.key}
            type="button"
            class={clsx(
              styles.sortBtn,
              isActive && styles.active,
              isActive && value.direction === 'desc' && styles.desc,
            )}
            onClick={() => handleClick(f.key)}
            aria-pressed={isActive}
            aria-label={isActive ? `${f.label}, sorted ${value.direction === 'asc' ? 'ascending' : 'descending'}` : `Sort by ${f.label}`}
            data-testid={`sort-bar--${f.key}`}
          >
            {f.label}
            <span class={styles.arrow} aria-hidden="true">▲</span>
          </button>
        )
      })}
    </div>
  )
}
