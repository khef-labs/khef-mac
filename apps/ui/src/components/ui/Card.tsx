import clsx from 'clsx'
import type { ComponentChildren } from 'preact'
import styles from './Card.module.css'

interface CardProps {
  children: ComponentChildren
  class?: string
  interactive?: boolean
  onClick?: () => void
  testId?: string
}

export function Card({ children, class: className, interactive, onClick, testId }: CardProps) {
  const Component = interactive ? 'button' : 'div'

  return (
    <Component
      class={clsx(styles.card, interactive && styles.interactive, className)}
      onClick={onClick}
      type={interactive ? 'button' : undefined}
      data-testid={testId}
    >
      {children}
    </Component>
  )
}

export function CardSkeleton() {
  return (
    <div class={styles.card}>
      <div class={clsx(styles.skeleton, styles.skeletonBadge)} />
      <div class={clsx(styles.skeleton, styles.skeletonBadge)} />
      <div class={clsx(styles.skeleton, styles.skeletonTitle)} />
      <div class={clsx(styles.skeleton, styles.skeletonExcerpt)} />
    </div>
  )
}

export { styles as cardStyles }
