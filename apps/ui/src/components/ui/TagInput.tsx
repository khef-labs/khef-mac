import { useState, useRef } from 'preact/hooks'
import { X } from 'lucide-preact'
import styles from './TagInput.module.css'

interface TagInputProps {
  tags: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
  disabled?: boolean
  density?: 'default' | 'compact'
}

export function TagInput({
  tags,
  onChange,
  placeholder = 'Add tag...',
  disabled = false,
  density = 'default',
}: TagInputProps) {
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const addTag = (value: string) => {
    const trimmed = value.trim().toLowerCase()
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed])
    }
    setInputValue('')
  }

  const removeTag = (tagToRemove: string) => {
    onChange(tags.filter((tag) => tag !== tagToRemove))
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(inputValue)
    } else if (e.key === 'Backspace' && inputValue === '' && tags.length > 0) {
      removeTag(tags[tags.length - 1])
    }
  }

  const handleInput = (e: Event) => {
    const value = (e.target as HTMLInputElement).value
    // If user pastes or types a comma, add the tag
    if (value.includes(',')) {
      const parts = value.split(',')
      parts.forEach((part, index) => {
        if (index < parts.length - 1) {
          addTag(part)
        } else {
          setInputValue(part)
        }
      })
    } else {
      setInputValue(value)
    }
  }

  const handleContainerClick = () => {
    inputRef.current?.focus()
  }

  return (
    <div
      class={density === 'compact' ? `${styles.container} ${styles.compact}` : styles.container}
      onClick={handleContainerClick}
      data-disabled={disabled || undefined}
    >
      {tags.map((tag) => (
        <span key={tag} class={styles.tag} data-testid={`tag-input--tag-${tag}`}>
          {tag}
          {!disabled && (
            <button
              type="button"
              class={styles.removeButton}
              onClick={(e) => {
                e.stopPropagation()
                removeTag(tag)
              }}
              aria-label={`Remove ${tag}`}
            >
              <X size={12} />
            </button>
          )}
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        class={styles.input}
        value={inputValue}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        placeholder={tags.length === 0 ? placeholder : ''}
        disabled={disabled}
        data-testid="tag-input--input"
      />
    </div>
  )
}
