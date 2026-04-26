import { useState, useRef, useEffect } from 'preact/hooks'
import { Search, X } from 'lucide-preact'
import styles from './SelectUpward.module.css'

export interface SelectOption {
  value: string
  label: string
  group?: string
}

interface SelectUpwardProps {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}

export function SelectUpward({
  value,
  options,
  onChange,
  disabled = false,
  className = '',
}: SelectUpwardProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const selectedOption = options.find((opt) => opt.value === value)
  const displayLabel = selectedOption?.label || value

  // Filter options by search
  const filteredOptions = search.trim()
    ? options.filter((opt) =>
        opt.label.toLowerCase().includes(search.toLowerCase())
      )
    : options

  // Group filtered options by their group property
  const groups = filteredOptions.reduce(
    (acc, opt) => {
      const group = opt.group || ''
      if (!acc[group]) acc[group] = []
      acc[group].push(opt)
      return acc
    },
    {} as Record<string, SelectOption[]>
  )

  const groupNames = Object.keys(groups)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setSearch('')
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false)
        setSearch('')
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleKeyDown)
      // Focus search input when dropdown opens
      setTimeout(() => searchInputRef.current?.focus(), 0)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
        document.removeEventListener('keydown', handleKeyDown)
      }
    }
  }, [isOpen])

  const handleSelect = (optionValue: string) => {
    onChange(optionValue)
    setIsOpen(false)
    setSearch('')
  }

  return (
    <div ref={containerRef} class={`${styles.container} ${className}`}>
      <button
        type="button"
        class={styles.trigger}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
      >
        <span class={styles.triggerLabel}>{displayLabel}</span>
        <span class={styles.triggerIcon}>▾</span>
      </button>
      {isOpen && (
        <div class={styles.dropdown}>
          <div class={styles.searchWrapper}>
            <Search size={14} class={styles.searchIcon} />
            <input
              ref={searchInputRef}
              type="text"
              class={styles.searchInput}
              placeholder="Filter..."
              value={search}
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            />
            {search && (
              <button
                type="button"
                class={styles.clearButton}
                onClick={() => setSearch('')}
                aria-label="Clear filter"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <div class={styles.optionsList}>
            {groupNames.length === 0 ? (
              <div class={styles.noResults}>No matches</div>
            ) : (
              groupNames.map((groupName) => (
                <div key={groupName} class={styles.group}>
                  {groupName && <div class={styles.groupLabel}>{groupName}</div>}
                  {groups[groupName].map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      class={`${styles.option} ${opt.value === value ? styles.selected : ''}`}
                      onClick={() => handleSelect(opt.value)}
                    >
                      {opt.value === value && <span class={styles.checkmark}>✓</span>}
                      {opt.label}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
