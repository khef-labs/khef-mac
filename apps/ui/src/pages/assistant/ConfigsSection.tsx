import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { Trash2 } from 'lucide-preact'
import { getAssistantConfigs, deleteAssistantConfig } from '../../lib/api'
import type { AssistantConfig, ConfigScope, ConfigType } from '../../types'
import { ConfirmModal } from '../../components/ui'
import { FilterInput, ResourceCard, ResourceGrid } from '../../components/assistant'
import styles from '../AssistantPage.module.css'

interface Props {
  handle: string
}

const SCOPE_LABELS: Record<ConfigScope, string> = {
  system: 'System',
  global: 'Global',
  project: 'Project',
  local: 'Local',
}

const TYPE_LABELS: Record<ConfigType, string> = {
  settings: 'Settings',
  instructions: 'Instructions',
  rules: 'Rules',
  knowledge: 'Knowledge',
  glossary: 'Glossary',
  mcp: 'MCP',
  state: 'State',
}

const TYPE_DESCRIPTIONS: Record<ConfigType, string> = {
  settings: 'Assistant preferences, hooks, permissions, and runtime options.',
  instructions: 'Custom instructions the assistant reads at the start of every session.',
  rules: 'Behavioral rules auto-imported into the instructions file.',
  knowledge: 'Operational knowledge (commands, context, patterns) auto-imported into instructions.',
  glossary: 'Terminology and shorthand the assistant should recognize.',
  mcp: 'MCP server registrations that expose tools to the assistant.',
  state: 'Persistent state, history, and session metadata.',
}

function configFilename(config: AssistantConfig): string {
  return config.path.split('/').pop() || config.path
}

function levelName(scope: ConfigScope, type: ConfigType): string {
  return `${SCOPE_LABELS[scope]} ${TYPE_LABELS[type]}`
}

export function ConfigsSection({ handle }: Props) {
  const [configs, setConfigs] = useState<AssistantConfig[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [configToDelete, setConfigToDelete] = useState<{ id: string; name: string } | null>(null)

  const loadConfigs = useCallback(async () => {
    setIsLoading(true)
    try {
      const data = await getAssistantConfigs(handle)
      setConfigs(data)
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false)
    }
  }, [handle])

  useEffect(() => {
    loadConfigs()
  }, [loadConfigs])

  const handleDeleteConfig = async (configId: string) => {
    try {
      await deleteAssistantConfig(configId)
      const data = await getAssistantConfigs(handle)
      setConfigs(data)
    } catch {
      // Silently fail
    } finally {
      setConfigToDelete(null)
    }
  }

  // Order: each parent followed immediately by its imports, so visually-adjacent
  // grid cells preserve the parent/child relationship.
  const orderedConfigs = useMemo(() => {
    const parents = configs.filter((c) => !c.is_import)
    const childrenByParent = new Map<string, AssistantConfig[]>()
    for (const c of configs) {
      if (c.is_import && c.parent_config_id) {
        const list = childrenByParent.get(c.parent_config_id) || []
        list.push(c)
        childrenByParent.set(c.parent_config_id, list)
      }
    }
    const ordered: { config: AssistantConfig; parentName?: string }[] = []
    for (const parent of parents) {
      ordered.push({ config: parent })
      const children = childrenByParent.get(parent.id) || []
      const parentName = configFilename(parent)
      for (const child of children) {
        ordered.push({ config: child, parentName })
      }
    }
    // Append any orphaned imports (parent_config_id missing from list)
    for (const c of configs) {
      if (c.is_import && !ordered.some((o) => o.config.id === c.id)) {
        ordered.push({ config: c })
      }
    }
    return ordered
  }, [configs])

  const filteredConfigs = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return orderedConfigs
    return orderedConfigs.filter(({ config }) => {
      const filename = configFilename(config)
      const level = levelName(config.scope, config.type)
      const desc = TYPE_DESCRIPTIONS[config.type] || ''
      return [filename, level, desc, config.path].some((v) => v.toLowerCase().includes(q))
    })
  }, [orderedConfigs, filter])

  const describeConfig = (config: AssistantConfig, parentName?: string): string => {
    const base = TYPE_DESCRIPTIONS[config.type] || ''
    if (config.is_import && parentName) {
      return `Imported by ${parentName}. ${base}`.trim()
    }
    return base
  }

  if (isLoading) return <div class={styles.loading}>Loading...</div>

  return (
    <>
      <div class={styles.sectionHeader}>
        <FilterInput
          value={filter}
          onChange={setFilter}
          placeholder="Filter configs..."
          testId="configs-filter"
        />
        <span />
      </div>

      {configs.length === 0 ? (
        <div class={styles.empty}>No configurations available.</div>
      ) : filteredConfigs.length === 0 ? (
        <div class={styles.empty}>No configs match the filter.</div>
      ) : (
        <div data-testid="configs-grid">
        <ResourceGrid>
          {filteredConfigs.map(({ config, parentName }) => {
            const filename = configFilename(config)
            const level = levelName(config.scope, config.type)
            return (
              <div key={config.id} class={styles.configGridCardWrapper}>
                <ResourceCard
                  kind="config"
                  name={filename}
                  monoName
                  stackMeta
                  scope={level}
                  description={describeConfig(config, parentName)}
                  path={config.path}
                  href={`/assistants/${handle}/configs/${config.id}?from=${encodeURIComponent(`/assistants/${handle}`)}`}
                  badge={
                    config.is_import ? (
                      <span class={styles.importBadge} title={parentName ? `Imported by ${parentName}` : 'Import'}>
                        Import
                      </span>
                    ) : undefined
                  }
                />
                {config.is_import && (
                  <button
                    type="button"
                    class={styles.configGridDeleteButton}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setConfigToDelete({ id: config.id, name: filename })
                    }}
                    title={`Delete ${filename}`}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            )
          })}
        </ResourceGrid>
        </div>
      )}

      {configToDelete && (
        <ConfirmModal
          title="Delete Config"
          message={`Delete "${configToDelete.name}" from tracked configs? The file on disk will not be removed.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={() => handleDeleteConfig(configToDelete.id)}
          onCancel={() => setConfigToDelete(null)}
        />
      )}
    </>
  )
}
