import { useState, useEffect } from 'preact/hooks'
import { Search, X, Sparkles } from 'lucide-preact'
import { useDebounce } from '../../hooks'
import styles from './SearchBar.module.css'

interface SearchBarProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  submitOnEnter?: boolean // When true, only emit on Enter key (for semantic search)
  searchMode?: string // '' | 'semantic'
  onSearchModeChange?: (mode: string) => void
}

export function SearchBar({ value, onChange, placeholder = 'Search memories...', submitOnEnter = false, searchMode, onSearchModeChange }: SearchBarProps) {
  const isSemantic = searchMode === 'semantic'
  const effectiveSubmitOnEnter = submitOnEnter || isSemantic
  const [localValue, setLocalValue] = useState(value)
  const debouncedValue = useDebounce(localValue, 200)
  const [isTyping, setIsTyping] = useState(false)

  // Sync external value changes
  useEffect(() => {
    setLocalValue(value)
    setIsTyping(false)
  }, [value])

  // Emit debounced changes (only for keyword/live search mode)
  useEffect(() => {
    if (effectiveSubmitOnEnter) return // Skip debounced emit when in submit-on-enter mode
    if (!isTyping) return
    if (debouncedValue !== value) {
      onChange(debouncedValue)
      setIsTyping(false)
    }
  }, [debouncedValue, value, onChange, isTyping, effectiveSubmitOnEnter])

  const handleClear = () => {
    setLocalValue('')
    setIsTyping(false)
    onChange('')
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && effectiveSubmitOnEnter) {
      e.preventDefault()
      onChange(localValue)
      setIsTyping(false)
    }
  }

  return (
    <div class={styles.container}>
      <Search class={styles.icon} size={16} />
      <input
        type="text"
        class={styles.input}
        placeholder={isSemantic ? 'Semantic search (press Enter)...' : placeholder}
        value={localValue}
        onInput={(e) => {
          setLocalValue((e.target as HTMLInputElement).value)
          setIsTyping(true)
        }}
        onKeyDown={handleKeyDown}
        aria-label="Search"
      />
      {localValue && (
        <button
          type="button"
          class={styles.clearButton}
          onClick={handleClear}
          aria-label="Clear search"
        >
          <X size={14} />
        </button>
      )}
      {onSearchModeChange && (
        <button
          type="button"
          class={isSemantic ? styles.modeToggleActive : styles.modeToggle}
          onClick={() => onSearchModeChange(isSemantic ? '' : 'semantic')}
          title={isSemantic ? 'Switch to keyword search' : 'Switch to semantic search'}
          aria-label="Toggle semantic search"
        >
          <Sparkles size={14} />
        </button>
      )}
    </div>
  )
}
