import { List, LayoutGrid, Kanban } from 'lucide-preact'
import type { CollectionViewMode } from '../../types'
import styles from './ViewModeToggle.module.css'

interface Props {
  value: CollectionViewMode
  onChange: (mode: CollectionViewMode) => void
}

const modes: { value: CollectionViewMode; icon: typeof List; label: string }[] = [
  { value: 'list', icon: List, label: 'List' },
  { value: 'board', icon: Kanban, label: 'Board' },
  { value: 'grid', icon: LayoutGrid, label: 'Grid' },
]

export function ViewModeToggle({ value, onChange }: Props) {
  return (
    <div class={styles.toggle}>
      {modes.map(({ value: mode, icon: Icon, label }) => (
        <button
          key={mode}
          class={`${styles.btn} ${value === mode ? styles.active : ''}`}
          onClick={() => onChange(mode)}
          title={label}
          aria-label={`${label} view`}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  )
}
