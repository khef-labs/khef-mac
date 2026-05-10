import { useState, useEffect, useMemo } from 'preact/hooks'
import { useLocation, useSearch } from 'wouter-preact'
import clsx from 'clsx'
import { getSessionCounts, type SessionCount } from '../lib/api'
import { PageHeader } from '../components/layout'
import { SessionsSection } from './assistant/SessionsSection'
import { useDocumentTitle } from '../hooks'
import styles from './SessionsPage.module.css'

export function SessionsPage() {
  useDocumentTitle('Sessions')
  const [, setLocation] = useLocation()
  const searchString = useSearch()
  const params = useMemo(() => new URLSearchParams(searchString), [searchString])
  const assistantFromUrl = params.get('assistant') || ''
  const projectFromUrl = params.get('project') || ''

  const [counts, setCounts] = useState<SessionCount[]>([])
  const [countsLoading, setCountsLoading] = useState(true)
  const [activeHandle, setActiveHandle] = useState<string>('')
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(new Set())

  // Load counts once
  useEffect(() => {
    let mounted = true
    getSessionCounts()
      .then(({ counts }) => {
        if (!mounted) return
        const visible = counts
        setCounts(visible)
        // Pick the tab: URL > first with sessions > first overall
        const resolved = visible.find(c => c.assistant_handle === assistantFromUrl)?.assistant_handle
          ?? visible.find(c => c.total > 0 || c.active > 0)?.assistant_handle
          ?? visible[0]?.assistant_handle
          ?? ''
        setActiveHandle(resolved)
        if (resolved) setMountedTabs(new Set([resolved]))
      })
      .catch(() => {})
      .finally(() => { if (mounted) setCountsLoading(false) })
    return () => { mounted = false }
  }, [])

  const handleTabClick = (handle: string) => {
    setActiveHandle(handle)
    setMountedTabs(prev => prev.has(handle) ? prev : new Set([...prev, handle]))
    const next = new URLSearchParams(searchString)
    next.set('assistant', handle)
    setLocation(`/sessions?${next.toString()}`)
  }

  return (
    <div class={styles.page}>
      <div class={styles.header}>
        <PageHeader title="Sessions" />
        <p class={styles.subtitle}>Browse synced sessions across your coding assistants</p>
      </div>

      {countsLoading ? (
        <div class={styles.loading}>Loading sessions...</div>
      ) : counts.length === 0 ? (
        <div class={styles.empty}>No sessions synced yet.</div>
      ) : (
        <>
          <div class={styles.assistantTabs} role="tablist">
            {counts.map(c => (
              <button
                key={c.assistant_handle}
                role="tab"
                aria-selected={activeHandle === c.assistant_handle}
                class={clsx(styles.tab, activeHandle === c.assistant_handle && styles.tabActive)}
                onClick={() => handleTabClick(c.assistant_handle)}
                data-testid={`sessions-page--tab-${c.assistant_handle}`}
              >
                <span>{c.assistant_name}</span>
                {c.active > 0 && (
                  <span class={styles.tabBadge}>{c.active} active</span>
                )}
                <span class={styles.tabCount}>{c.total}</span>
              </button>
            ))}
          </div>

          <div class={styles.tabPanels}>
            {[...mountedTabs].map(handle => (
              <div
                key={handle}
                class={clsx(styles.tabPanel, activeHandle !== handle && styles.tabPanelHidden)}
              >
                <SessionsSection handle={handle} initialProjectFilter={projectFromUrl} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
