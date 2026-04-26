import { Link } from 'wouter-preact'
import type { ComponentChildren } from 'preact'
import styles from './SectionNav.module.css'

export interface NavItem {
  key: string
  label: string
  href?: string
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

interface SectionNavProps {
  groups: NavGroup[]
  activeKey: string
  basePath: string
  title: string
  subtitle?: string
  hideContentHeader?: boolean
  dirtyKeys?: ReadonlySet<string>
  children: ComponentChildren
}

function getSectionLabel(groups: NavGroup[], key: string): string {
  for (const group of groups) {
    const item = group.items.find((i) => i.key === key)
    if (item) return item.label
  }
  return ''
}

export function SectionNav({
  groups,
  activeKey,
  basePath,
  title,
  subtitle,
  hideContentHeader,
  dirtyKeys,
  children,
}: SectionNavProps) {
  const sectionLabel = getSectionLabel(groups, activeKey)

  return (
    <div class={styles.layout}>
      <div class={styles.sidebar}>
        <div class={styles.sidebarHeader}>
          <h1 class={styles.sidebarTitle}>{title}</h1>
          {subtitle && <span class={styles.sidebarSubtitle}>{subtitle}</span>}
        </div>
        <nav class={styles.nav}>
          {groups.map((group) => (
            <div key={group.label} class={styles.navGroup}>
              <div class={styles.navGroupLabel}>{group.label}</div>
              {group.items.map((item) => {
                const isDirty = dirtyKeys?.has(item.key) ?? false
                return (
                  <Link
                    key={item.key}
                    href={item.href ?? `${basePath}/${item.key}`}
                    class={`${styles.navLink} ${activeKey === item.key ? styles.navLinkActive : ''}`}
                    data-testid={`section-nav--${item.key}`}
                  >
                    <span class={styles.navLinkLabel}>{item.label}</span>
                    {isDirty && (
                      <span
                        class={styles.navLinkDirty}
                        title="Unsaved changes"
                        aria-label="Unsaved changes"
                      />
                    )}
                  </Link>
                )
              })}
            </div>
          ))}
        </nav>
      </div>

      <div class={styles.main}>
        {!hideContentHeader && (
          <div class={styles.contentHeader}>
            <h2 class={styles.contentTitle}>{sectionLabel}</h2>
          </div>
        )}
        <div class={hideContentHeader ? styles.contentFull : styles.content}>
          {children}
        </div>
      </div>
    </div>
  )
}

export const SECTION_KEYS_FROM_GROUPS = (groups: NavGroup[]) =>
  groups.flatMap((g) => g.items.map((i) => i.key))
