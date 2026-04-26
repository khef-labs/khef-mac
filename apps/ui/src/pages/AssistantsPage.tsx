import { Link } from 'wouter-preact'
import clsx from 'clsx'
import { useEffect, useState } from 'preact/hooks'
import { getAssistants, getMcpServersHealth, getActiveSessions } from '../lib/api'
import type { Assistant, McpServersHealthResponse, ActiveSession } from '../types'
import { cardStyles } from '../components/ui'
import { useDocumentTitle } from '../hooks'
import styles from './AssistantsPage.module.css'

export function AssistantsPage() {
  useDocumentTitle('Assistants')
  const [assistants, setAssistants] = useState<Assistant[]>([])
  const [mcpHealth, setMcpHealth] = useState<McpServersHealthResponse | null>(null)
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    setError(null)
    Promise.all([getAssistants(), getMcpServersHealth(), getActiveSessions()])
      .then(([assistantsData, healthData, activeData]) => {
        if (mounted) {
          setAssistants(assistantsData)
          setMcpHealth(healthData)
          setActiveSessions(activeData.sessions || [])
        }
      })
      .catch((err) => {
        if (mounted) console.warn('Failed to load assistants:', err)
      })
      .finally(() => {
        if (mounted) setIsLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [])

  const getAssistantIssues = (handle: string): number => {
    if (!mcpHealth) return 0
    const assistant = mcpHealth.assistants.find(a => a.handle === handle)
    return assistant?.issues ?? 0
  }

  const getActiveCount = (handle: string): number => {
    return activeSessions.filter(s => s.assistant.handle === handle).length
  }

  return (
    <div class={styles.page}>
      <div class={styles.header}>
        <h1 class={styles.title}>Assistants</h1>
        <p class={styles.subtitle} data-testid="assistants-page--subtitle">Manage configuration files for coding assistants</p>
      </div>

      {error && <div class={styles.error}>{error}</div>}

      <div class={styles.list}>
        {isLoading ? (
          <div class={styles.empty}>Loading assistants...</div>
        ) : assistants.length > 0 ? (
          assistants.map((assistant) => {
            const issues = getAssistantIssues(assistant.handle)
            const activeCount = getActiveCount(assistant.handle)
            return (
              <Link
                key={assistant.handle}
                href={`/assistants/${assistant.handle}`}
                class={clsx(cardStyles.card, cardStyles.interactive, styles.assistantCard)}
                data-testid={`assistant-card--${assistant.handle}`}
              >
                <div class={styles.assistantHeader}>
                  <div class={styles.assistantName} data-testid={`assistant-card--name-${assistant.handle}`}>{assistant.name}</div>
                  <div class={styles.headerBadges}>
                    {activeCount > 0 && (
                      <span class={styles.activeBadge}>{activeCount} active</span>
                    )}
                    {issues > 0 && (
                      <span class={styles.issueBadge}>{issues} {issues === 1 ? 'issue' : 'issues'}</span>
                    )}
                  </div>
                </div>
                <div class={styles.assistantDescription} data-testid={`assistant-card--description-${assistant.handle}`}>{assistant.description}</div>
              </Link>
            )
          })
        ) : (
          <div class={styles.empty}>No assistants configured</div>
        )}
      </div>
    </div>
  )
}
