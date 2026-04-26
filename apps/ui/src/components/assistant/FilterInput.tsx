import { Search, X } from 'lucide-preact'
import styles from '../../pages/AssistantPage.module.css'

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder: string
  testId?: string
}

export function FilterInput({ value, onChange, placeholder, testId }: Props) {
  return (
    <div class={styles.filterInputWrapper}>
      <Search size={14} class={styles.filterIcon} />
      <input
        type="text"
        class={styles.filterInput}
        placeholder={placeholder}
        value={value}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onChange('')
        }}
        data-testid={testId}
      />
      {value && (
        <button
          type="button"
          class={styles.filterClear}
          onClick={() => onChange('')}
          aria-label="Clear filter"
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}
