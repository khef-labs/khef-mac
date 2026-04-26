import { useRef } from 'preact/hooks'
import styles from './ModelCombobox.module.css'

interface ModelComboboxProps {
  value: string
  onChange: (model: string) => void
  models: string[]
  disabled?: boolean
  className?: string
  id?: string
}

export function ModelCombobox({
  value,
  onChange,
  models,
  disabled = false,
  className = '',
  id,
}: ModelComboboxProps) {
  const listId = useRef(`model-list-${Math.random().toString(36).slice(2, 8)}`).current

  return (
    <div class={`${styles.container} ${className}`}>
      <input
        type="text"
        list={listId}
        value={value}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        placeholder="Default model"
        disabled={disabled}
        class={styles.input}
        id={id}
      />
      <datalist id={listId}>
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  )
}
