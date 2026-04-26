import { X } from 'lucide-preact'
import type { MemoryType, MemoryTypeStatusInfo } from '../../types'
import { getProjectMemoryTypeStatuses } from '../../lib/api'
import { useEffect, useMemo, useState } from 'preact/hooks'
import styles from '../search/FiltersPanel.module.css'
import { KNOWLEDGE_CHILDREN, TYPE_HIERARCHY, typeDropdownLabel, getTypeLabel } from '../../lib/memoryTypes'
import { SortBar } from '../ui'
import type { SortField, SortDirection, SortState } from '../ui'

const PROJECT_SORT_FIELDS: SortField[] = [
  { key: 'created_at', label: 'Created' },
  { key: 'updated_at', label: 'Updated' },
  { key: 'slide_order', label: 'Slide' },
  { key: 'title', label: 'Title' },
]

function labelize(status: string): string {
  return status
    .split('_')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ')
}

function normalizeStatusValue(item: unknown): string | null {
  if (typeof item === 'string') return item
  if (item && typeof item === 'object') {
    const obj = item as Record<string, unknown>
    const raw = obj.value ?? obj.name ?? obj.status ?? obj.id
    if (typeof raw === 'string') return raw
    if (typeof raw === 'number') return String(raw)
  }
  return null
}

function normalizeStatusInfo(input: unknown): MemoryTypeStatusInfo[] {
  if (!Array.isArray(input)) return []
  const out: MemoryTypeStatusInfo[] = []
  for (const it of input) {
    const value = normalizeStatusValue(it)
    if (!value) continue
    if (out.some((existing) => existing.value === value)) continue
    if (it && typeof it === 'object') {
      const obj = it as Record<string, unknown>
      out.push({
        value,
        display_name: (obj.display_name ?? obj.displayName ?? null) as string | null,
        description: (obj.description ?? null) as string | null,
        sort_order: (obj.sort_order ?? null) as number | null,
        usage_count:
          typeof obj.usage_count === 'number'
            ? obj.usage_count
            : obj.usage_count !== undefined
              ? Number(obj.usage_count)
              : undefined,
      })
    } else {
      out.push({
        value,
        display_name: null,
        description: null,
        sort_order: null,
      })
    }
  }
  return out
}

function fallbackStatusInfo(type: string): MemoryTypeStatusInfo[] {
  const fallback = STATUS_FALLBACK[type] || []
  return fallback.map((value, index) => ({
    value,
    display_name: null,
    description: null,
    sort_order: index,
  }))
}

function formatStatusLabel(status: MemoryTypeStatusInfo): string {
  // Override "To Do" display_name to show "Open" for consistency
  const base =
    status.value === 'open' ? 'Open' : (status.display_name || labelize(status.value))
  if (typeof status.usage_count === 'number' && Number.isFinite(status.usage_count)) {
    return `${base} (${status.usage_count})`
  }
  return base
}

const STATUS_FALLBACK: Record<string, string[]> = {
  'user-todo': ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  'assistant-todo': ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  decision: ['proposed', 'accepted', 'rejected', 'superseded'],
  pattern: ['proposed', 'active', 'deprecated'],
  context: ['current', 'updated', 'outdated'],
  commands: ['unverified', 'verified', 'deprecated'],
  knowledge: ['current', 'deprecated'],
}

export interface ProjectFilterValues {
  type: string
  subtype: string
  tag: string
  handle: string
  status: string
  sort_field: string
  sort_dir: SortDirection
  date: string
  date_from: string
  date_to: string
  date_range_mode: boolean
  pinned: string // '' | 'true'
  search_mode: string // '' | 'semantic'
}

interface ProjectFiltersPanelProps {
  projectId: string
  filters: ProjectFilterValues
  onChange: (filters: ProjectFilterValues) => void
  typeOptions: string[] | null
  typeHierarchy?: Record<string, string[]> | null
}

export function ProjectFiltersPanel({
  projectId,
  filters,
  onChange,
  typeOptions,
  typeHierarchy,
}: ProjectFiltersPanelProps) {
  const dynamicHierarchy = typeHierarchy && Object.keys(typeHierarchy).length > 0 ? typeHierarchy : null
  const resolvedTypeOptions = (() => {
    const raw = typeOptions || []
    const filtered = raw.filter((t) => !KNOWLEDGE_CHILDREN.includes(t as MemoryType))
    if (dynamicHierarchy) {
      for (const parent of Object.keys(dynamicHierarchy)) {
        if (!filtered.includes(parent)) filtered.push(parent)
      }
      filtered.sort((a, b) => getTypeLabel(a).localeCompare(getTypeLabel(b)))
    } else {
      // Inject parent type when any of its children are present
      const hasKnowledgeChild = raw.some((t) => KNOWLEDGE_CHILDREN.includes(t as MemoryType))
      if (hasKnowledgeChild && !filtered.includes('knowledge')) {
        filtered.push('knowledge' as MemoryType)
        filtered.sort((a, b) => getTypeLabel(a).localeCompare(getTypeLabel(b)))
      }
    }
    return filtered
  })()
  const typeOptionsEmpty = resolvedTypeOptions.length === 0
  const effectiveType = filters.subtype || filters.type
  const subtypeOptions = (dynamicHierarchy && dynamicHierarchy[filters.type]) || TYPE_HIERARCHY[filters.type] || []
  const [typeStatuses, setTypeStatuses] = useState<MemoryTypeStatusInfo[]>([])

  useEffect(() => {
    let mounted = true
    if (effectiveType) {
      getProjectMemoryTypeStatuses(projectId, effectiveType as MemoryType)
        .then((data) => {
          const apiStatuses = normalizeStatusInfo(data?.statuses)
          if (mounted) {
            setTypeStatuses(apiStatuses.length ? apiStatuses : fallbackStatusInfo(effectiveType))
          }
        })
        .catch(() => {
          if (mounted) setTypeStatuses(fallbackStatusInfo(effectiveType))
        })
    } else {
      setTypeStatuses([])
    }
    return () => {
      mounted = false
    }
  }, [projectId, effectiveType])

  const statusOptions = useMemo(() => {
    if (!effectiveType) return []
    const options = typeStatuses && typeStatuses.length ? typeStatuses : fallbackStatusInfo(effectiveType)
    return [...options].sort((a, b) => {
      const aSort = typeof a.sort_order === 'number' ? a.sort_order : Number.POSITIVE_INFINITY
      const bSort = typeof b.sort_order === 'number' ? b.sort_order : Number.POSITIVE_INFINITY
      return aSort - bSort
    })
  }, [effectiveType, typeStatuses])

  const updateFilter = (key: keyof ProjectFilterValues, value: string | boolean) => {
    const newFilters = { ...filters, [key]: value }
    if (key === 'type') {
      newFilters.status = ''
      newFilters.subtype = ''
    }
    if (key === 'subtype') {
      newFilters.status = ''
    }
    onChange(newFilters)
  }

  const clearFilter = (key: keyof ProjectFilterValues) => {
    updateFilter(key, '')
  }

  const clearAll = () => {
    onChange({
      type: '',
      subtype: '',
      tag: '',
      handle: '',
      status: '',
      sort_field: 'created_at',
      sort_dir: 'desc',
      date: '',
      date_from: '',
      date_to: '',
      date_range_mode: false,
      pinned: '',
      search_mode: '',
    })
  }

  const activeFilters: Array<[keyof ProjectFilterValues, string]> = []
  if (filters.type) activeFilters.push(['type', filters.type])
  if (filters.subtype) activeFilters.push(['subtype', filters.subtype])
  if (filters.tag) activeFilters.push(['tag', filters.tag])
  if (filters.handle) activeFilters.push(['handle', filters.handle])
  if (filters.status) activeFilters.push(['status', filters.status])
  if (filters.pinned) activeFilters.push(['pinned', filters.pinned])
  if (filters.date_range_mode) {
    if (filters.date_from) activeFilters.push(['date_from', filters.date_from])
    if (filters.date_to) activeFilters.push(['date_to', filters.date_to])
  } else if (filters.date) {
    activeFilters.push(['date', filters.date])
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
      return
    }

    const seed = filters.date || filters.date_from || filters.date_to || ''
    onChange({
      ...filters,
      date_range_mode: false,
      date: seed,
      date_from: '',
      date_to: '',
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

  return (
    <div>
      <div class={styles.filtersBar}>
        <select
          class={styles.selectCompact}
          value={filters.type}
          onChange={(e) => updateFilter('type', (e.target as HTMLSelectElement).value)}
          disabled={typeOptionsEmpty}
        >
          <option value="">{typeOptionsEmpty ? 'No types' : 'All types'}</option>
          {resolvedTypeOptions.map((t) => (
            <option key={t} value={t}>
              {dynamicHierarchy
                ? dynamicHierarchy[t]?.length
                  ? `${getTypeLabel(t)} \u25B8`
                  : getTypeLabel(t)
                : typeDropdownLabel(t as MemoryType)}
            </option>
          ))}
        </select>

        {subtypeOptions.length > 0 && (
          <select
            class={styles.selectCompact}
            value={filters.subtype}
            onChange={(e) => updateFilter('subtype', (e.target as HTMLSelectElement).value)}
          >
            <option value="">All subtypes</option>
            {subtypeOptions.map((t) => (
              <option key={t} value={t}>
                {getTypeLabel(t)}
              </option>
            ))}
          </select>
        )}

        <select
          class={styles.selectCompact}
          value={filters.status}
          onChange={(e) => updateFilter('status', (e.target as HTMLSelectElement).value)}
          disabled={!effectiveType || statusOptions.length === 0}
        >
          <option value="">
            {!effectiveType
              ? 'All statuses'
              : statusOptions.length === 0
                ? 'No statuses'
                : 'All statuses'}
          </option>
          {statusOptions.map((s) => (
            <option key={s.value} value={s.value}>
              {formatStatusLabel(s)}
            </option>
          ))}
        </select>

        <input
          type="text"
          class={styles.inputCompact}
          placeholder="Tag..."
          value={filters.tag}
          onInput={(e) => updateFilter('tag', (e.target as HTMLInputElement).value)}
        />

        <input
          type="text"
          class={styles.inputCompact}
          placeholder="Handle..."
          value={filters.handle}
          onInput={(e) => updateFilter('handle', (e.target as HTMLInputElement).value)}
        />

        <SortBar
          fields={PROJECT_SORT_FIELDS}
          value={{ field: filters.sort_field, direction: filters.sort_dir }}
          onChange={(state: SortState) => {
            onChange({ ...filters, sort_field: state.field, sort_dir: state.direction })
          }}
        />

        <span class={styles.filterSep} />

        {!filters.date_range_mode && (
          <input
            type="date"
            class={styles.dateCompact}
            value={filters.date}
            onInput={(e) => updateFilter('date', (e.target as HTMLInputElement).value)}
          />
        )}

        {filters.date_range_mode && (
          <>
            <input
              type="date"
              class={styles.dateCompact}
              value={filters.date_from}
              onInput={(e) => updateFilter('date_from', (e.target as HTMLInputElement).value)}
            />
            <input
              type="date"
              class={styles.dateCompact}
              value={filters.date_to}
              onInput={(e) => updateFilter('date_to', (e.target as HTMLInputElement).value)}
            />
          </>
        )}

        <button
          type="button"
          class={styles.rangeToggleCompact}
          onClick={() => toggleDateRange(!filters.date_range_mode)}
        >
          {filters.date_range_mode ? 'Single' : 'Range'}
        </button>

        <span class={styles.filterSep} />

        <button type="button" class={isTodayActive ? styles.datePillActive : styles.datePill} onClick={setToday}>
          Today
        </button>
        <button type="button" class={isYesterdayActive ? styles.datePillActive : styles.datePill} onClick={setYesterday}>
          Yesterday
        </button>
        <button type="button" class={isLastWeekActive ? styles.datePillActive : styles.datePill} onClick={setLastWeek}>
          1 Week
        </button>
      </div>

      {activeFilters.length > 0 && (
        <div class={styles.activeFilters}>
          {activeFilters.map(([key, value]) => {
            let displayValue = value
            if (key === 'type' || key === 'subtype') {
              displayValue = getTypeLabel(value)
            } else if (key === 'pinned') {
              displayValue = 'Pinned'
            } else if (key === 'handle') {
              displayValue = `Handle: ${value}`
            } else if (key === 'date') {
              displayValue = `Date: ${value}`
            } else if (key === 'date_from') {
              displayValue = `From: ${value}`
            } else if (key === 'date_to') {
              displayValue = `To: ${value}`
            }
            return (
              <button
                key={key}
                class={styles.filterChip}
                onClick={() => clearFilter(key as keyof ProjectFilterValues)}
                title={`Clear ${key}`}
                data-testid={`filter-chip--${key}`}
              >
                {displayValue}
                <X size={12} />
              </button>
            )
          })}
          <button class={styles.clearAll} onClick={clearAll}>
            Clear all
          </button>
        </div>
      )}
    </div>
  )
}
