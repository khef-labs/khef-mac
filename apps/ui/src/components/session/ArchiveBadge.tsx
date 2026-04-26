import { Archive } from 'lucide-preact'
import styles from './ArchiveBadge.module.css'

interface ArchiveBadgeProps {
  class?: string
}

export function ArchiveBadge({ class: className }: ArchiveBadgeProps) {
  return (
    <div
      class={`${styles.badge} ${className || ''}`}
      title="Original session file is no longer available. Showing backed-up copy."
    >
      <Archive size={12} />
      <span>Archived</span>
      <span class={styles.detail}>Reading from backup copy — original was pruned upstream</span>
    </div>
  )
}
