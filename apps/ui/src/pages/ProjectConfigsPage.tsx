import { useState, useEffect, useCallback } from 'preact/hooks'
import { Link } from 'wouter-preact'
import { FileText, Wand2 } from 'lucide-preact'
import clsx from 'clsx'
import { getProjectConfigs, getSessionContext, getCommands } from '../lib/api'
import type { ProjectAssistantConfig, SessionContext, ConfigScope, Command } from '../types'
import { cardStyles } from '../components/ui'
import { PageHeader } from '../components/layout'
import styles from './ProjectConfigsPage.module.css'

interface Props {
  projectId: string
}

export function ProjectConfigsPage({ projectId }: Props) {
  const [sessionContext, setSessionContext] = useState<SessionContext | null>(null)
  const [configs, setConfigs] = useState<ProjectAssistantConfig[]>([])
  const [skills, setSkills] = useState<Command[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const projectName =
    sessionContext?.project?.display_name ||
    sessionContext?.project?.name ||
    projectId

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const [context, configData] = await Promise.all([
        getSessionContext(projectId),
        getProjectConfigs(projectId),
      ])
      setSessionContext(context)
      setConfigs(configData)

      // Load project-level skills (requires project path)
      if (context.project?.path) {
        try {
          const res = await getCommands('claude-code', { scope: 'project', type: 'skill', project: context.project.handle || projectId })
          setSkills(res.commands)
        } catch {
          // Skills are optional
        }
      }
    } catch (err) {
      console.warn('Failed to load project configs:', err)
    } finally {
      setIsLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    loadData()
  }, [loadData])

  const getLevelName = (scope: ConfigScope, type?: string | null) => {
    const scopeLabels: Record<ConfigScope, string> = {
      system: 'System',
      global: 'Global',
      project: 'Project',
      local: 'Local',
    }
    if (!type) return scopeLabels[scope]
    const label = type.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    return `${scopeLabels[scope]} ${label}`
  }

  const getFormatLabel = (format: string) => {
    switch (format) {
      case 'markdown':
        return 'MD'
      case 'json':
        return '{}'
      case 'toml':
        return 'TOML'
      default:
        return format.toUpperCase()
    }
  }

  const grouped = configs.reduce<Record<string, ProjectAssistantConfig[]>>((acc, config) => {
    const key = config.assistant?.handle || 'unknown'
    if (!acc[key]) acc[key] = []
    acc[key].push(config)
    return acc
  }, {})

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
          title="Configs"
          breadcrumbs={[{ label: 'Projects', href: '/projects' }, { label: projectName || projectId, href: `/projects/${projectId}` }]}
        />
        {sessionContext?.project?.path && (
          <p class={styles.projectPath}>{sessionContext.project.path}</p>
        )}
      </div>

      {error && <div class={styles.error}>{error}</div>}

      {!error && (
        <div class={styles.section}>
          <h2 class={styles.sectionTitle}>Configs</h2>
          {configs.length === 0 ? (
            <div class={styles.empty}>No project-level configs found.</div>
          ) : (
            Object.entries(grouped).map(([assistantHandle, assistantConfigs]) => {
              const assistantName = assistantConfigs[0]?.assistant?.name || assistantHandle
              return (
                <div key={assistantHandle} class={styles.assistantGroup}>
                  <div class={styles.assistantHeader}>
                    <FileText size={14} class={styles.assistantIcon} />
                    <span class={styles.assistantName}>{assistantName}</span>
                    <span class={styles.assistantHandle}>@{assistantHandle}</span>
                  </div>
                  <div class={styles.configList}>
                    {assistantConfigs.map((config) => (
                      <Link
                        key={config.id}
                        href={`/assistants/${config.assistant.handle}/configs/${config.id}?from=${encodeURIComponent(`/projects/${projectId}/configs`)}`}
                        class={clsx(cardStyles.card, cardStyles.interactive, styles.configCard)}
                      >
                        <div class={styles.configHeader}>
                          <span class={styles.configLevel}>
                            {config.path.split('/').pop()}
                          </span>
                          {config.readonly && (
                            <span class={styles.readonlyBadge}>Read-only</span>
                          )}
                        </div>
                        <div class={styles.configPath}>{config.path}</div>
                        <div class={styles.configMeta}>
                          <span>{getLevelName(config.scope, config.type)}</span>
                          <span>{getFormatLabel(config.format)}</span>
                          {config.auto_sync && <span>Auto-sync</span>}
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}

      {skills.length > 0 && (
        <div class={styles.section}>
          <h2 class={styles.sectionTitle}>Skills</h2>
          <div class={styles.skillGrid}>
            {skills.map((skill) => (
              <Link
                key={`${skill.scope}-${skill.name}`}
                href={`/assistants/claude-code/skills/${encodeURIComponent(skill.name)}?scope=${skill.scope}&type=skill&project=${encodeURIComponent(sessionContext?.project?.handle || projectId)}&from=${encodeURIComponent(`/projects/${projectId}/configs`)}`}
                class={clsx(cardStyles.card, cardStyles.interactive, styles.skillCard)}
              >
                <Wand2 size={14} class={styles.skillIcon} />
                <div class={styles.skillInfo}>
                  <span class={styles.skillName}>{skill.name}</span>
                  {skill.description && (
                    <span class={styles.skillDescription}>{skill.description}</span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
