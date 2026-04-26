import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { Link } from 'wouter-preact'
import { Plus } from 'lucide-preact'
import { getAgents } from '../../lib/api'
import type { Agent } from '../../types'
import { FilterInput, ResourceCard, ResourceGrid } from '../../components/assistant'
import styles from '../AssistantPage.module.css'

interface Props {
  handle: string
}

export function AgentsSection({ handle }: Props) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [userAgentsPath, setUserAgentsPath] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [filter, setFilter] = useState('')

  const loadAgents = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await getAgents(handle)
      setAgents(res.agents)
      setUserAgentsPath(res.userAgentsPath || '')
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false)
    }
  }, [handle])

  useEffect(() => {
    loadAgents()
  }, [loadAgents])

  const filteredAgents = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return agents
    return agents.filter((a) =>
      [a.name, a.description, a.filePath].some((v) => v?.toLowerCase().includes(q))
    )
  }, [agents, filter])

  if (isLoading) return <div class={styles.loading}>Loading...</div>

  return (
    <>
      <div class={styles.sectionHeader}>
        <FilterInput
          value={filter}
          onChange={setFilter}
          placeholder="Filter agents..."
          testId="agents-filter"
        />
        <Link
          href={`/assistants/${handle}/agents/new?from=${encodeURIComponent(`/assistants/${handle}`)}`}
          class={styles.addButton}
          title="Add Agent"
        >
          <Plus size={16} />
        </Link>
      </div>

      {agents.length === 0 ? (
        <div class={styles.empty}>No agents configured.</div>
      ) : filteredAgents.length === 0 ? (
        <div class={styles.empty}>No agents match the filter.</div>
      ) : (
        <ResourceGrid>
          {filteredAgents.map((agent) => (
            <ResourceCard
              key={agent.name}
              kind="agent"
              name={agent.name}
              description={agent.description}
              scope={agent.scope}
              path={agent.filePath}
              href={`/assistants/${handle}/agents/${encodeURIComponent(agent.name)}?from=${encodeURIComponent(`/assistants/${handle}`)}`}
            />
          ))}
        </ResourceGrid>
      )}

      {userAgentsPath && (
        <div class={styles.mcpConfigPath}>
          Path: <code>{userAgentsPath}</code>
        </div>
      )}
    </>
  )
}
