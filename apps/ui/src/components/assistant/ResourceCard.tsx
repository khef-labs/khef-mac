import clsx from 'clsx'
import { Link } from 'wouter-preact'
import type { ComponentChildren } from 'preact'
import { Wand2, Bot, Terminal } from 'lucide-preact'
import { cardStyles } from '../ui'
import styles from './ResourceCard.module.css'

export type ResourceKind = 'skill' | 'agent' | 'command'

interface Props {
  kind: ResourceKind
  name: string
  href: string
  description?: string | null
  scope?: string | null
  path?: string | null
  monoName?: boolean
  badge?: ComponentChildren
  testId?: string
}

const ICONS = { skill: Wand2, agent: Bot, command: Terminal }

export function ResourceCard({
  kind,
  name,
  href,
  description,
  scope,
  path,
  monoName,
  badge,
  testId,
}: Props) {
  const Icon = ICONS[kind]
  return (
    <Link
      href={href}
      class={clsx(cardStyles.card, cardStyles.interactive, styles.card)}
      data-kind={kind}
      data-testid={testId}
    >
      <div class={styles.top}>
        <span class={styles.icon}>
          <Icon size={14} />
        </span>
        <span class={clsx(styles.name, monoName && styles.nameMono)}>{name}</span>
        {scope && <span class={styles.scope}>{scope}</span>}
        {badge}
      </div>
      {description && <p class={styles.desc}>{description}</p>}
      {path && <div class={styles.meta}>{path}</div>}
    </Link>
  )
}
