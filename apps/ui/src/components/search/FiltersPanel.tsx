import { X, ChevronDown, Check } from 'lucide-preact'
import type { MemoryType, MemoryTypeStatusInfo, Project } from '../../types'
import { getProjectMemoryTypeStatuses } from '../../lib/api'
import { useEffect, useMemo, useState, useRef } from 'preact/hooks'
import styles from './FiltersPanel.module.css'
import { KNOWLEDGE_CHILDREN, TOP_LEVEL_TYPES, TYPE_HIERARCHY, typeDropdownLabel, getTypeLabel } from '../../lib/memoryTypes'

function labelize(status: string): string {
  // Convert snake_case to Title Case
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

// Fallback statuses per type (used only when API returns nothing)
const STATUS_FALLBACK: Record<string, string[]> = {
  'user-todo': ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  'assistant-todo': ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  decision: ['proposed', 'accepted', 'rejected', 'superseded'],
  pattern: ['proposed', 'active', 'deprecated'],
  context: ['current', 'updated', 'outdated'],
  commands: ['unverified', 'verified', 'deprecated'],
  knowledge: ['current', 'deprecated'],
}

export interface FilterValues {
  project_ids: string // Comma-separated project IDs
  type: string
  subtype: string
  tag: string
  handle: string
  status: string
  sort: string
  date: string // Single date filter (default mode)
  date_from: string // Range mode start
  date_to: string // Range mode end
  date_range_mode: boolean // Toggle for range mode
  pinned: string // '' | 'true'
}

interface FiltersPanelProps {
  filters: FilterValues
  onChange: (filters: FilterValues) => void
  projects: Project[]
  typeOptions: string[] | null
  typeHierarchy?: Record<string, string[]> | null
}

export function FiltersPanel({ filters, onChange, projects, typeOptions, typeHierarchy }: FiltersPanelProps) {
  const projectList = Array.isArray(projects) ? projects : []
  const hasProjectTypeFilter = typeOptions !== null
  const dynamicHierarchy = typeHierarchy && Object.keys(typeHierarchy).length > 0 ? typeHierarchy : null
  const dynamicChildTypes = dynamicHierarchy
    ? new Set(Object.values(dynamicHierarchy).flat())
    : null
  const resolvedTypeOptions = hasProjectTypeFilter
    ? (() => {
        const raw = typeOptions || []
        const filtered = raw.filter((t) => {
          if (dynamicChildTypes) return !dynamicChildTypes.has(t)
          return !KNOWLEDGE_CHILDREN.includes(t as MemoryType)
        })
        if (dynamicHierarchy) {
          for (const parent of Object.keys(dynamicHierarchy)) {
            if (!filtered.includes(parent)) filtered.push(parent)
          }
          filtered.sort((a, b) => getTypeLabel(a).localeCompare(getTypeLabel(b)))
        } else {
          const hasKnowledgeChild = raw.some((t) => KNOWLEDGE_CHILDREN.includes(t as MemoryType))
          if (hasKnowledgeChild && !filtered.includes('knowledge')) {
            filtered.push('knowledge' as MemoryType)
            filtered.sort((a, b) => getTypeLabel(a).localeCompare(getTypeLabel(b)))
          }
        }
        return filtered
      })()
    : TOP_LEVEL_TYPES
  const typeOptionsEmpty = resolvedTypeOptions.length === 0
  const effectiveType = filters.subtype || filters.type
  const subtypeOptions = (dynamicHierarchy && dynamicHierarchy[filters.type]) || TYPE_HIERARCHY[filters.type] || []
  const [typeStatuses, setTypeStatuses] = useState<MemoryTypeStatusInfo[]>([])
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false)
  const projectDropdownRef = useRef<HTMLDivElement>(null)

  // Parse selected project IDs
  const selectedProjectIds = filters.project_ids ? filters.project_ids.split(',').filter(Boolean) : []

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (projectDropdownRef.current && !projectDropdownRef.current.contains(e.target as Node)) {
        setProjectDropdownOpen(false)
      }
    }
    if (projectDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [projectDropdownOpen])

  const toggleProject = (projectId: string) => {
    const current = new Set(selectedProjectIds)
    if (current.has(projectId)) {
      current.delete(projectId)
    } else {
      current.add(projectId)
    }
    onChange({ ...filters, project_ids: Array.from(current).join(',') })
  }

  const getProjectLabel = () => {
    if (selectedProjectIds.length === 0) return 'All projects'
    if (selectedProjectIds.length === 1) {
      const p = projectList.find((p) => p.id === selectedProjectIds[0])
      return p?.display_name || p?.name || p?.handle || '1 project'
    }
    return `${selectedProjectIds.length} projects`
  }

  // Load type-specific statuses when effective type changes
  // Use first selected project for status lookup
  const firstProjectId = selectedProjectIds[0] || ''
  useEffect(() => {
    let mounted = true
    if (effectiveType) {
      if (firstProjectId) {
        getProjectMemoryTypeStatuses(firstProjectId, effectiveType as MemoryType)
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
        setTypeStatuses(fallbackStatusInfo(effectiveType))
      }
    } else {
      setTypeStatuses([])
    }
    return () => {
      mounted = false
    }
  }, [firstProjectId, effectiveType])

  const statusOptions = useMemo(() => {
    if (!effectiveType) return []
    const options = typeStatuses && typeStatuses.length ? typeStatuses : fallbackStatusInfo(effectiveType)
    return [...options].sort((a, b) => {
      const aSort = typeof a.sort_order === 'number' ? a.sort_order : Number.POSITIVE_INFINITY
      const bSort = typeof b.sort_order === 'number' ? b.sort_order : Number.POSITIVE_INFINITY
      return aSort - bSort
    })
  }, [effectiveType, typeStatuses])

  const updateFilter = (key: keyof FilterValues, value: string | boolean) => {
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

  const clearFilter = (key: keyof FilterValues) => {
    updateFilter(key, '')
  }

  const clearAll = () => {
    onChange({
      project_ids: '',
      type: '',
      subtype: '',
      tag: '',
      handle: '',
      status: '',
      sort: 'created_at',
      date: '',
      date_from: '',
      date_to: '',
      date_range_mode: false,
      pinned: '',
    })
  }

  const activeFilters: Array<[keyof FilterValues, string]> = []
  if (filters.project_ids) activeFilters.push(['project_ids', filters.project_ids])
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
  const isTodosActive = filters.type === 'assistant-todo' && filters.status === 'open'
  const isPinnedActive = filters.pinned === 'true'

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

  const setTodos = () => {
    if (isTodosActive) {
      onChange({ ...filters, type: '', subtype: '', status: '' })
      return
    }
    onChange({ ...filters, type: 'assistant-todo', status: 'open' })
  }

  const setPinned = () => {
    onChange({ ...filters, pinned: isPinnedActive ? '' : 'true' })
  }

  return (
    <div>
      <div class={styles.panel}>
        <div class={styles.filterGroup} ref={projectDropdownRef}>
          <label class={styles.label}>Project</label>
          <button
            type="button"
            class={styles.multiSelect}
            onClick={() => setProjectDropdownOpen(!projectDropdownOpen)}
          >
            <span class={styles.multiSelectLabel}>{getProjectLabel()}</span>
            <ChevronDown size={14} class={styles.multiSelectIcon} />
          </button>
          {projectDropdownOpen && (
            <div class={styles.multiSelectDropdown}>
              {projectList.map((p) => {
                const isSelected = selectedProjectIds.includes(p.id)
                return (
                  <div
                    key={p.id}
                    class={styles.multiSelectOption}
                    onClick={() => toggleProject(p.id)}
                  >
                    <span class={`${styles.multiSelectCheckbox} ${isSelected ? styles.checked : ''}`}>
                      {isSelected && <Check size={12} class={styles.checkIcon} />}
                    </span>
                    <span>{p.display_name || p.name || p.handle}</span>
                  </div>
                )
              })}
              {selectedProjectIds.length > 0 && (
                <button
                  type="button"
                  class={styles.multiSelectClear}
                  onClick={() => onChange({ ...filters, project_ids: '' })}
                >
                  Clear selection
                </button>
              )}
            </div>
          )}
        </div>

        <div class={styles.filterGroup}>
          <label class={styles.label}>Type</label>
          <select
            class={styles.select}
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
        </div>

        {subtypeOptions.length > 0 && (
          <div class={styles.filterGroup}>
            <label class={styles.label}>Subtype</label>
            <select
              class={styles.select}
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
          </div>
        )}

        <div class={styles.filterGroup}>
          <label class={styles.label}>Status</label>
          <select
            class={styles.select}
            value={filters.status}
            onChange={(e) => updateFilter('status', (e.target as HTMLSelectElement).value)}
            disabled={!effectiveType || statusOptions.length === 0}
          >
            <option value="">
              {!effectiveType
                ? 'Select type first'
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
        </div>

        <div class={styles.filterGroup}>
          <label class={styles.label}>Tag</label>
          <input
            type="text"
            class={styles.input}
            placeholder="Enter tag..."
            value={filters.tag}
            onInput={(e) => updateFilter('tag', (e.target as HTMLInputElement).value)}
          />
        </div>

        <div class={styles.filterGroup}>
          <label class={styles.label}>Handle</label>
          <input
            type="text"
            class={styles.input}
            placeholder="Enter handle..."
            value={filters.handle}
            onInput={(e) => updateFilter('handle', (e.target as HTMLInputElement).value)}
          />
        </div>

        <div class={styles.filterGroup}>
          <label class={styles.label}>Sort</label>
          <select
            class={styles.select}
            value={filters.sort}
            onChange={(e) => updateFilter('sort', (e.target as HTMLSelectElement).value)}
          >
            <option value="relevance">Relevance</option>
            <option value="created_at">Newest</option>
            <option value="updated_at">Recently Updated</option>
            <option value="title">Title</option>
          </select>
        </div>

        <div class={styles.rowBreak} />

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
            <button type="button" class={isTodayActive ? styles.quickButtonActive : styles.quickButton} onClick={setToday}>
              Today
            </button>
            <button type="button" class={isYesterdayActive ? styles.quickButtonActive : styles.quickButton} onClick={setYesterday}>
              Yesterday
            </button>
            <button type="button" class={isLastWeekActive ? styles.quickButtonActive : styles.quickButton} onClick={setLastWeek}>
              1 Week
            </button>
            <button type="button" class={isTodosActive ? styles.quickButtonActive : styles.quickButton} onClick={setTodos}>
              Todos
            </button>
            <button type="button" class={isPinnedActive ? styles.quickButtonActive : styles.quickButton} onClick={setPinned}>
              Pinned
            </button>
          </div>
        </div>
      </div>

      {activeFilters.length > 0 && (
        <div class={styles.activeFilters}>
          {activeFilters.map(([key, value]) => {
            let displayValue = value
            if (key === 'type' || key === 'subtype') {
              displayValue = getTypeLabel(value)
            } else if (key === 'project_ids') {
              const ids = value.split(',').filter(Boolean)
              if (ids.length === 1) {
                const p = projectList.find((p) => p.id === ids[0])
                displayValue = p?.display_name || p?.name || p?.handle || value
              } else {
                displayValue = `${ids.length} projects`
              }
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
                onClick={() => clearFilter(key as keyof FilterValues)}
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
