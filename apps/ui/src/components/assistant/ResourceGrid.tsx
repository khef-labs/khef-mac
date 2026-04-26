import type { ComponentChildren } from 'preact'
import styles from './ResourceGrid.module.css'

interface Props {
  children: ComponentChildren
}

export function ResourceGrid({ children }: Props) {
  return <div class={styles.grid}>{children}</div>
}
