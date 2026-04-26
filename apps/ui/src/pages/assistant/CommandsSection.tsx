import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { Link } from 'wouter-preact'
import { Plus } from 'lucide-preact'
import { getCommands } from '../../lib/api'
import type { Command } from '../../types'
import { FilterInput, ResourceCard, ResourceGrid } from '../../components/assistant'
import styles from '../AssistantPage.module.css'

interface Props {
  handle: string
}

export function CommandsSection({ handle }: Props) {
  const [commands, setCommands] = useState<Command[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [filter, setFilter] = useState('')

  const loadCommands = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await getCommands(handle, { scope: 'user' })
      setCommands(res.commands.filter((c) => c.type !== 'skill'))
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false)
    }
  }, [handle])

  useEffect(() => {
    loadCommands()
  }, [loadCommands])

  const filteredCommands = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) =>
      [c.name, c.description, c.file_path].some((v) => v?.toLowerCase().includes(q))
    )
  }, [commands, filter])

  if (isLoading) return <div class={styles.loading}>Loading...</div>

  return (
    <>
      <div class={styles.sectionHeader}>
        <FilterInput
          value={filter}
          onChange={setFilter}
          placeholder="Filter commands..."
          testId="commands-filter"
        />
        <Link
          href={`/assistants/${handle}/commands/new?from=${encodeURIComponent(`/assistants/${handle}`)}`}
          class={styles.addButton}
          title="Add Command"
        >
          <Plus size={16} />
        </Link>
      </div>

      {commands.length === 0 ? (
        <div class={styles.empty}>No commands configured.</div>
      ) : filteredCommands.length === 0 ? (
        <div class={styles.empty}>No commands match the filter.</div>
      ) : (
        <ResourceGrid>
          {filteredCommands.map((cmd) => (
            <ResourceCard
              key={`${cmd.scope}-${cmd.type}-${cmd.name}`}
              kind="command"
              name={`/${cmd.name}`}
              monoName
              description={cmd.description}
              scope={cmd.scope}
              path={cmd.file_path}
              href={`/assistants/${handle}/commands/${encodeURIComponent(cmd.name)}?scope=${cmd.scope}&type=${cmd.type}&from=${encodeURIComponent(`/assistants/${handle}`)}`}
            />
          ))}
        </ResourceGrid>
      )}
    </>
  )
}
