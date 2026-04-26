import type { ComponentType } from 'preact'
import clsx from 'clsx'
import styles from './TabBar.module.css'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IconComponent = ComponentType<any>

export interface Tab {
  key: string
  label: string
  icon?: IconComponent
  hidden?: boolean
  disabled?: boolean
}

interface TabBarProps {
  tabs: Tab[]
  activeKey: string
  onChange: (key: string) => void
}

export function TabBar({ tabs, activeKey, onChange }: TabBarProps) {
  return (
    <div class={styles.tabs}>
      {tabs.filter((t) => !t.hidden).map((tab) => (
        <button
          key={tab.key}
          type="button"
          class={clsx(styles.tab, activeKey === tab.key && styles.tabActive)}
          onClick={() => onChange(tab.key)}
          disabled={tab.disabled}
          data-testid={`tab-bar--${tab.key}`}
        >
          {tab.icon && <tab.icon size={14} />}
          {tab.label}
        </button>
      ))}
    </div>
  )
}
