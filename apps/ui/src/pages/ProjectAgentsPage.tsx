import { useState, useEffect, useCallback } from 'preact/hooks'
import { Link } from 'wouter-preact'
import { Plus, Bot } from 'lucide-preact'
import clsx from 'clsx'
import { getAgents, getProjectAgents, getSessionContext } from '../lib/api'
import type { Agent, SessionContext } from '../types'
import { cardStyles } from '../components/ui'
import { PageHeader } from '../components/layout'
import { useDocumentTitle } from '../hooks'
import styles from './ProjectAgentsPage.module.css'

interface Props {
  projectId: string
}

export function ProjectAgentsPage({ projectId }: Props) {
  const [sessionContext, setSessionContext] = useState<SessionContext | null>(null)
  const [projectAgents, setProjectAgents] = useState<Agent[]>([])
  const [userAgents, setUserAgents] = useState<Agent[]>([])
  const [agentsPath, setAgentsPath] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadedProjectName = sessionContext?.project?.display_name || sessionContext?.project?.name
  const projectName = loadedProjectName || projectId

  useDocumentTitle(loadedProjectName ? `Agents - ${loadedProjectName}` : 'Agents')

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      // Load project context, project agents, and user agents in parallel
      const [context, projectRes, userRes] = await Promise.all([
        getSessionContext(projectId),
        getProjectAgents('claude-code', projectId),
        getAgents('claude-code'),
      ])

      setSessionContext(context)
      setProjectAgents(projectRes.agents)
      setAgentsPath(projectRes.agentsPath || null)
      setUserAgents(userRes.agents)

      if (!context.project?.path) {
        setError('Project path not set. Configure the project path to manage agents.')
      }
    } catch (err: any) {
      console.warn('Failed to load agents:', err)
    } finally {
      setIsLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    loadData()
  }, [loadData])

  if (isLoading) {
    return (
      <div class={styles.page}>
        <div class={styles.loading}>Loading...</div>
      </div>
    )
  }

  return (
    <div class={styles.page}>
      <div class={styles.header}>
        <PageHeader
          title="Agents"
          breadcrumbs={[{ label: 'Projects', href: '/projects' }, { label: projectName || projectId, href: `/projects/${projectId}` }]}
        />
        {agentsPath && (
          <p class={styles.projectPath}>{agentsPath}</p>
        )}
      </div>

      {error && <div class={styles.error}>{error}</div>}

      {!error && sessionContext?.project?.path && (
        <>
          {/* Project Agents Section */}
          <div class={styles.section}>
            <div class={styles.sectionHeader}>
              <h2 class={styles.sectionTitle}>Project Agents</h2>
              <Link
                href={`/projects/${projectId}/agents/new`}
                class={styles.addButton}
                title="Add Project Agent"
              >
                <Plus size={16} />
              </Link>
            </div>

            <div class={styles.agentList}>
              {projectAgents.length === 0 ? (
                <div class={styles.empty}>No project-level agents configured.</div>
              ) : (
                projectAgents.map((agent) => (
                  <Link
                    key={agent.name}
                    href={`/projects/${projectId}/agents/${encodeURIComponent(agent.name)}`}
                    class={clsx(cardStyles.card, cardStyles.interactive, styles.agentCard)}
                  >
                    <Bot size={16} class={styles.agentIcon} />
                    <div class={styles.agentInfo}>
                      <span class={styles.agentName}>{agent.name}</span>
                      {agent.description && (
                        <span class={styles.agentDescription}>{agent.description}</span>
                      )}
                    </div>
                    <span class={styles.scopeBadge}>project</span>
                  </Link>
                ))
              )}
            </div>
          </div>

          {/* User Agents Section (read-only reference) */}
          {userAgents.length > 0 && (
            <div class={styles.section}>
              <div class={styles.sectionHeader}>
                <h2 class={styles.sectionTitle}>User Agents</h2>
                <span class={styles.sectionHint}>Available in all projects</span>
              </div>

              <div class={styles.agentList}>
                {userAgents.map((agent) => (
                  <Link
                    key={agent.name}
                    href={`/assistants/claude-code/agents/${encodeURIComponent(agent.name)}?from=${encodeURIComponent(`/projects/${projectId}/agents`)}`}
                    class={clsx(cardStyles.card, cardStyles.interactive, styles.agentCard, styles.userAgent)}
                  >
                    <Bot size={16} class={styles.agentIcon} />
                    <div class={styles.agentInfo}>
                      <span class={styles.agentName}>{agent.name}</span>
                      {agent.description && (
                        <span class={styles.agentDescription}>{agent.description}</span>
                      )}
                    </div>
                    <span class={styles.scopeBadge}>user</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
