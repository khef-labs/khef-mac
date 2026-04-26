import { useState, useEffect } from 'preact/hooks'
import { getSessionContext } from '../lib/api'
import { AgentPage } from './AgentPage'
import styles from './ProjectAgentsPage.module.css'

interface Props {
  projectId: string
  agentName: string
}

export function ProjectAgentPage({ projectId, agentName }: Props) {
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setIsLoading(true)
    setError(null)
    getSessionContext(projectId)
      .then((context) => {
        if (context.project?.path) {
          setProjectPath(context.project.path)
        } else {
          setError('Project path not set')
        }
      })
      .catch((err) => {
        setError(err.message || 'Failed to load project')
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [projectId])

  if (isLoading) {
    return (
      <div class={styles.page}>
        <div class={styles.loading}>Loading...</div>
      </div>
    )
  }

  if (error || !projectPath) {
    return (
      <div class={styles.page}>
        <div class={styles.error}>{error || 'Project path not configured'}</div>
      </div>
    )
  }

  return (
    <AgentPage
      assistantHandle="claude-code"
      agentName={agentName}
      projectId={projectId}
      projectPath={projectPath}
    />
  )
}
