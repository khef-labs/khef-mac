import { Link, useLocation } from 'wouter-preact'
import type { ComponentChildren, ComponentType } from 'preact'
import clsx from 'clsx'
import styles from './PageHeader.module.css'

export interface Breadcrumb {
  label: string
  href: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IconComponent = ComponentType<any>

export interface HeaderAction {
  key: string
  href: string
  icon: IconComponent
  label: string
  iconOnly?: boolean
}

interface PageHeaderProps {
  title: string
  subtitle?: string
  breadcrumbs?: Breadcrumb[]
  actions?: HeaderAction[]
  hideTitle?: boolean
  children?: ComponentChildren
}

export function PageHeader({ title, subtitle, breadcrumbs, actions, hideTitle, children }: PageHeaderProps) {
  const [location] = useLocation()

  return (
    <div class={styles.header}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav class={styles.breadcrumb} data-testid="breadcrumb">
          {breadcrumbs.map((crumb, i) => (
            <>
              {i > 0 && <span class={styles.breadcrumbSep}>/</span>}
              <Link href={crumb.href} class={styles.breadcrumbLink} data-testid={`breadcrumb--${crumb.label.toLowerCase()}`}>
                {crumb.label}
              </Link>
            </>
          ))}
          <span class={styles.breadcrumbSep}>/</span>
          <span class={styles.breadcrumbCurrent}>{title}</span>
        </nav>
      )}

      <div class={clsx(styles.titleRow, hideTitle && styles.srOnly)}>
        <div class={styles.info}>
          <h1 class={styles.title}>{title}</h1>
          {subtitle && <p class={styles.subtitle}>{subtitle}</p>}
        </div>
        {children}
      </div>

      {actions && actions.length > 0 && (
        <div class={styles.actions}>
          {actions.map((action) => (
            <Link
              key={action.key}
              href={action.href}
              class={clsx(
                styles.action,
                action.iconOnly && styles.actionIconOnly,
                location === action.href && styles.actionActive,
              )}
              title={action.label}
            >
              <action.icon size={14} />
              <span>{action.label}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
