import { X } from 'lucide-preact'
import styles from './SessionFiltersPanel.module.css'

export interface SessionFilterValues {
  sort: 'date' | 'size'
  order: 'desc' | 'asc'
  date: string // Single date filter
  date_from: string // Range mode start
  date_to: string // Range mode end
  date_range_mode: boolean
  has_companion: '' | 'true' | 'false'
}

interface SessionFiltersPanelProps {
  filters: SessionFilterValues
  onChange: (filters: SessionFilterValues) => void
}

export function SessionFiltersPanel({ filters, onChange }: SessionFiltersPanelProps) {
  const updateFilter = <K extends keyof SessionFilterValues>(key: K, value: SessionFilterValues[K]) => {
    onChange({ ...filters, [key]: value })
  }

  const clearFilter = (key: keyof SessionFilterValues) => {
    if (key === 'sort') {
      updateFilter('sort', 'date')
    } else if (key === 'order') {
      updateFilter('order', 'desc')
    } else if (key === 'date_range_mode') {
      onChange({ ...filters, date_range_mode: false, date: '', date_from: '', date_to: '' })
    } else {
      updateFilter(key, '' as any)
    }
  }

  const clearAll = () => {
    onChange({
      sort: 'date',
      order: 'desc',
      date: '',
      date_from: '',
      date_to: '',
      date_range_mode: false,
      has_companion: '',
    })
  }

  const getLocalDate = (offset = 0) => {
    const now = new Date()
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000 + offset * 24 * 60 * 60 * 1000)
    return local.toISOString().split('T')[0]
  }

  const todayStr = getLocalDate()
  const yesterdayStr = getLocalDate(-1)
  const weekAgoStr = getLocalDate(-6)

  const isTodayActive = !filters.date_range_mode && filters.date === todayStr
  const isYesterdayActive = !filters.date_range_mode && filters.date === yesterdayStr
  const isLastWeekActive = filters.date_range_mode && filters.date_from === weekAgoStr && filters.date_to === todayStr

  const clearDateFilters = () => {
    onChange({ ...filters, date_range_mode: false, date: '', date_from: '', date_to: '' })
  }

  const setToday = () => {
    if (isTodayActive) return clearDateFilters()
    onChange({ ...filters, date_range_mode: false, date: todayStr, date_from: '', date_to: '' })
  }

  const setYesterday = () => {
    if (isYesterdayActive) return clearDateFilters()
    onChange({ ...filters, date_range_mode: false, date: yesterdayStr, date_from: '', date_to: '' })
  }

  const setLastWeek = () => {
    if (isLastWeekActive) return clearDateFilters()
    onChange({ ...filters, date_range_mode: true, date: '', date_from: weekAgoStr, date_to: todayStr })
  }

  const toggleDateRange = (nextValue: boolean) => {
    if (nextValue) {
      const seed = filters.date || ''
      onChange({
        ...filters,
        date_range_mode: true,
        date: '',
        date_from: filters.date_from || seed,
        date_to: filters.date_to || seed,
      })
    } else {
      const seed = filters.date || filters.date_from || filters.date_to || ''
      onChange({
        ...filters,
        date_range_mode: false,
        date: seed,
        date_from: '',
        date_to: '',
      })
    }
  }

  // Build active filters list
  const activeFilters: Array<{ key: keyof SessionFilterValues; label: string }> = []
  if (filters.sort !== 'date') {
    activeFilters.push({ key: 'sort', label: `Sort: ${filters.sort === 'size' ? 'Size' : 'Date'}` })
  }
  if (filters.order !== 'desc') {
    activeFilters.push({ key: 'order', label: 'Oldest first' })
  }
  if (filters.has_companion === 'true') {
    activeFilters.push({ key: 'has_companion', label: 'Has companion' })
  } else if (filters.has_companion === 'false') {
    activeFilters.push({ key: 'has_companion', label: 'No companion' })
  }
  if (filters.date_range_mode) {
    if (filters.date_from) activeFilters.push({ key: 'date_from', label: `From: ${filters.date_from}` })
    if (filters.date_to) activeFilters.push({ key: 'date_to', label: `To: ${filters.date_to}` })
  } else if (filters.date) {
    activeFilters.push({ key: 'date', label: `Date: ${filters.date}` })
  }

  return (
    <div>
      <div class={styles.panel}>
        <div class={styles.filterGroup}>
          <label class={styles.label}>Sort</label>
          <select
            class={styles.select}
            value={filters.sort}
            onChange={(e) => updateFilter('sort', (e.target as HTMLSelectElement).value as 'date' | 'size')}
          >
            <option value="date">Date</option>
            <option value="size">Size</option>
          </select>
        </div>

        <div class={styles.filterGroup}>
          <label class={styles.label}>Order</label>
          <select
            class={styles.select}
            value={filters.order}
            onChange={(e) => updateFilter('order', (e.target as HTMLSelectElement).value as 'desc' | 'asc')}
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </div>

        <div class={styles.filterGroup}>
          <label class={styles.label}>Companion</label>
          <select
            class={styles.select}
            value={filters.has_companion}
            onChange={(e) => updateFilter('has_companion', (e.target as HTMLSelectElement).value as '' | 'true' | 'false')}
          >
            <option value="">All sessions</option>
            <option value="true">With companion</option>
            <option value="false">Without companion</option>
          </select>
        </div>

        {!filters.date_range_mode && (
          <div class={styles.filterGroup}>
            <label class={styles.label}>Date</label>
            <input
              type="date"
              class={styles.input}
              value={filters.date}
              onInput={(e) => updateFilter('date', (e.target as HTMLInputElement).value)}
            />
          </div>
        )}

        {filters.date_range_mode && (
          <>
            <div class={styles.filterGroup}>
              <label class={styles.label}>From</label>
              <input
                type="date"
                class={styles.input}
                value={filters.date_from}
                onInput={(e) => updateFilter('date_from', (e.target as HTMLInputElement).value)}
              />
            </div>

            <div class={styles.filterGroup}>
              <label class={styles.label}>To</label>
              <input
                type="date"
                class={styles.input}
                value={filters.date_to}
                onInput={(e) => updateFilter('date_to', (e.target as HTMLInputElement).value)}
              />
            </div>
          </>
        )}

        <div class={styles.filterGroup}>
          <label class={styles.label}>Range</label>
          <button
            type="button"
            class={styles.rangeToggle}
            onClick={() => toggleDateRange(!filters.date_range_mode)}
          >
            {filters.date_range_mode ? 'Use single date' : 'Use date range'}
          </button>
        </div>

        <div class={styles.filterGroup}>
          <label class={styles.label}>Quick</label>
          <div class={styles.quickActions}>
            <button
              type="button"
              class={isTodayActive ? styles.quickButtonActive : styles.quickButton}
              onClick={setToday}
            >
              Today
            </button>
            <button
              type="button"
              class={isYesterdayActive ? styles.quickButtonActive : styles.quickButton}
              onClick={setYesterday}
            >
              Yesterday
            </button>
            <button
              type="button"
              class={isLastWeekActive ? styles.quickButtonActive : styles.quickButton}
              onClick={setLastWeek}
            >
              1 Week
            </button>
          </div>
        </div>
      </div>

      {activeFilters.length > 0 && (
        <div class={styles.activeFilters}>
          {activeFilters.map(({ key, label }) => (
            <button
              key={key}
              class={styles.filterChip}
              onClick={() => clearFilter(key)}
              title={`Clear ${key}`}
              data-testid={`filter-chip--${key}`}
            >
              {label}
              <X size={12} />
            </button>
          ))}
          <button class={styles.clearAll} onClick={clearAll}>
            Clear all
          </button>
        </div>
      )}
    </div>
  )
}
