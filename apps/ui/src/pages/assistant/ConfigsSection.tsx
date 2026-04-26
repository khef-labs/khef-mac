import { useState, useEffect, useCallback } from 'preact/hooks'
import { Link } from 'wouter-preact'
import clsx from 'clsx'
import { Trash2 } from 'lucide-preact'
import { getAssistantConfigs, deleteAssistantConfig } from '../../lib/api'
import type { AssistantConfig, ConfigScope, ConfigType } from '../../types'
import { cardStyles, ConfirmModal } from '../../components/ui'
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

export function ConfigsSection({ handle }: Props) {
  const [configs, setConfigs] = useState<AssistantConfig[]>([])
  const [isLoading, setIsLoading] = useState(true)
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

  const getLevelName = (scope: ConfigScope, type: ConfigType) =>
    `${SCOPE_LABELS[scope]} ${TYPE_LABELS[type]}`

  if (isLoading) return <div class={styles.loading}>Loading...</div>

  const parentConfigs = configs.filter((c) => !c.is_import)
  const childMap = new Map<string, AssistantConfig[]>()
  for (const c of configs) {
    if (c.is_import && c.parent_config_id) {
      const children = childMap.get(c.parent_config_id) || []
      children.push(c)
      childMap.set(c.parent_config_id, children)
    }
  }

  return (
    <>
      <div class={styles.configList}>
        {configs.length === 0 ? (
          <div class={styles.empty}>No configurations available.</div>
        ) : (
          parentConfigs.map((config) => {
            const children = childMap.get(config.id) || []
            const configName = config.path.split('/').pop() || config.path
            return (
              <div key={config.id} class={styles.configGroup}>
                <div class={styles.configCardWrapper}>
                  <Link
                    href={`/assistants/${handle}/configs/${config.id}?from=${encodeURIComponent(`/assistants/${handle}`)}`}
                    class={clsx(cardStyles.card, cardStyles.interactive, styles.configCard)}
                  >
                    <span class={styles.configLevel}>{configName}</span>
                    <span class={styles.configPath}>{getLevelName(config.scope, config.type)}</span>
                  </Link>
                  {config.is_import && (
                    <button
                      class={styles.configDeleteButton}
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfigToDelete({ id: config.id, name: configName })
                      }}
                      title={`Delete ${configName}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                {children.length > 0 && (
                  <div class={styles.configImports}>
                    {children.map((child) => {
                      const childName = child.path.split('/').pop() || child.path
                      return (
                        <div key={child.id} class={styles.configCardWrapper}>
                          <Link
                            href={`/assistants/${handle}/configs/${child.id}?from=${encodeURIComponent(`/assistants/${handle}`)}`}
                            class={clsx(cardStyles.card, cardStyles.interactive, styles.importCard)}
                          >
                            <span class={styles.configLevel}>{childName}</span>
                            <span class={styles.importBadge}>Import</span>
                          </Link>
                          <button
                            class={styles.configDeleteButton}
                            onClick={(e) => {
                              e.stopPropagation()
                              setConfigToDelete({ id: child.id, name: childName })
                            }}
                            title={`Delete ${childName}`}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

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
