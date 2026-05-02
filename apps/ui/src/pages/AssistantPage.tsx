import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { Link } from 'wouter-preact'
import clsx from 'clsx'
import { Plus, Trash2, Server, AlertTriangle, CheckCircle, AlertCircle, HelpCircle, BellOff, Bell, Bot, Terminal, ScrollText, FileText, Sparkles, Brain, ChevronRight, Wand2 } from 'lucide-preact'
import { getAssistant, getAssistantConfigs, deleteAssistantConfig, getMcpServers, addMcpServer, removeMcpServer, getAgents, getCommands, getPrompts, getMemoryProjects } from '../lib/api'
import type { Assistant, AssistantConfig, ConfigScope, ConfigType, McpServer, McpServerStatus, Agent, Command, Prompt, MemoryProject } from '../types'
import { getDismissedServers, dismissServer, restoreServer } from '../lib/mcpDismissed'
import { cardStyles, ConfirmModal } from '../components/ui'
import { ActiveSessionsBanner } from '../components/session'
import { useDocumentTitle } from '../hooks'
import styles from './AssistantPage.module.css'

interface Props {
  handle: string
}

export function AssistantPage({ handle }: Props) {
  useDocumentTitle(`Assistant - ${handle}`)
  const [assistant, setAssistant] = useState<Assistant | null>(null)
  const [configs, setConfigs] = useState<AssistantConfig[]>([])
  const [mcpServers, setMcpServers] = useState<McpServer[]>([])
  const [mcpConfigPath, setMcpConfigPath] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Dismissed warnings state
  const [dismissed, setDismissed] = useState<Set<string>>(() => getDismissedServers())

  // Add MCP server form state
  const [showAddForm, setShowAddForm] = useState(false)
  const [newServerName, setNewServerName] = useState('')
  const [newServerJson, setNewServerJson] = useState('{\n  "type": "stdio",\n  "command": "node",\n  "args": []\n}')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [isAddingServer, setIsAddingServer] = useState(false)
  const [serverToRemove, setServerToRemove] = useState<string | null>(null)

  // Config delete state
  const [configToDelete, setConfigToDelete] = useState<{ id: string; name: string } | null>(null)

  // Agents state
  const [agents, setAgents] = useState<Agent[]>([])
  const [userAgentsPath, setUserAgentsPath] = useState<string>('')

  // Commands state
  const [commands, setCommands] = useState<Command[]>([])


  // Prompts state
  const [prompts, setPrompts] = useState<Prompt[]>([])

  // Memory projects state
  const [memoryProjects, setMemoryProjects] = useState<MemoryProject[]>([])

  const loadMcpServers = useCallback(async () => {
    try {
      const res = await getMcpServers(handle)
      setMcpServers(res.servers)
      setMcpConfigPath(res.configPath)
    } catch {
      // Silently fail - MCP servers are optional
    }
  }, [handle])

  const loadAgents = useCallback(async () => {
    try {
      const res = await getAgents(handle)
      setAgents(res.agents)
      setUserAgentsPath(res.userAgentsPath || '')
    } catch {
      // Silently fail - agents are optional
    }
  }, [handle])

  const loadCommands = useCallback(async () => {
    try {
      const res = await getCommands(handle, { scope: 'user' })
      setCommands(res.commands)
    } catch {
      // Silently fail - commands are optional
    }
  }, [handle])

  const loadPrompts = useCallback(async () => {
    try {
      const res = await getPrompts({ assistant: handle, limit: 10 })
      setPrompts(res.prompts)
    } catch {
      // Silently fail - prompts are optional
    }
  }, [handle])

  const loadMemoryProjects = useCallback(async () => {
    try {
      const res = await getMemoryProjects(handle)
      setMemoryProjects(res.projects)
    } catch {
      // Silently fail - memory projects are optional
    }
  }, [handle])

  const skills = useMemo(() => commands.filter(c => c.type === 'skill'), [commands])
  const commandsOnly = useMemo(() => commands.filter(c => c.type !== 'skill'), [commands])

  useEffect(() => {
    let mounted = true

    const loadData = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const [assistantData, configData] = await Promise.all([
          getAssistant(handle),
          getAssistantConfigs(handle),
        ])
        if (!mounted) return
        setAssistant(assistantData)
        setConfigs(configData)
        await Promise.all([loadMcpServers(), loadAgents(), loadCommands(), loadPrompts(), loadMemoryProjects()])
      } catch (err) {
        if (mounted) console.warn('Failed to load assistant:', err)
      } finally {
        if (mounted) setIsLoading(false)
      }
    }

    loadData()
    return () => {
      mounted = false
    }
  }, [handle, loadMcpServers, loadAgents, loadCommands, loadPrompts, loadMemoryProjects])

  const handleAddServer = async () => {
    if (!newServerName) return

    // Parse and validate JSON
    let parsed: any
    try {
      parsed = JSON.parse(newServerJson)
      setJsonError(null)
    } catch (e: any) {
      setJsonError('Invalid JSON: ' + e.message)
      return
    }

    // Validate required fields
    if (!parsed.type || (parsed.type !== 'stdio' && parsed.type !== 'http')) {
      setJsonError('type must be "stdio" or "http"')
      return
    }
    if (parsed.type === 'stdio' && !parsed.command) {
      setJsonError('command is required for stdio servers')
      return
    }
    if (parsed.type === 'http' && !parsed.url) {
      setJsonError('url is required for http servers')
      return
    }

    setIsAddingServer(true)
    try {
      const server: Parameters<typeof addMcpServer>[1] = {
        name: newServerName,
        type: parsed.type,
        command: parsed.command,
        args: parsed.args,
        url: parsed.url,
        env: parsed.env,
      }

      await addMcpServer(handle, server)
      await loadMcpServers()

      // Reset form
      setShowAddForm(false)
      setNewServerName('')
      setNewServerJson('{\n  "type": "stdio",\n  "command": "node",\n  "args": []\n}')
      setJsonError(null)
    } catch (err: any) {
      setError(err.message || 'Failed to add MCP server')
    } finally {
      setIsAddingServer(false)
    }
  }

  const handleRemoveServer = async (serverName: string) => {
    try {
      await removeMcpServer(handle, serverName)
      await loadMcpServers()
    } catch (err: any) {
      setError(err.message || 'Failed to remove MCP server')
    } finally {
      setServerToRemove(null)
    }
  }

  const handleDeleteConfig = async (configId: string) => {
    try {
      await deleteAssistantConfig(configId)
      const data = await getAssistantConfigs(handle)
      setConfigs(data)
    } catch (err: any) {
      setError(err.message || 'Failed to delete config')
    } finally {
      setConfigToDelete(null)
    }
  }

  const handleDismissWarning = (serverName: string) => {
    dismissServer(serverName)
    setDismissed(getDismissedServers())
  }

  const handleRestoreWarning = (serverName: string) => {
    restoreServer(serverName)
    setDismissed(getDismissedServers())
  }

  const getLevelName = (scope: ConfigScope, type: ConfigType) => {
    const scopeLabels: Record<ConfigScope, string> = {
      system: 'System',
      global: 'Global',
      project: 'Project',
      local: 'Local',
    }
    const typeLabels: Record<ConfigType, string> = {
      settings: 'Settings',
      instructions: 'Instructions',
      rules: 'Rules',
      knowledge: 'Knowledge',
      glossary: 'Glossary',
      mcp: 'MCP',
      state: 'State',
    }
    return `${scopeLabels[scope]} ${typeLabels[type]}`
  }

  const getStatusIcon = (status: McpServerStatus) => {
    switch (status) {
      case 'available':
        return <CheckCircle size={12} class={styles.statusAvailable} />
      case 'stale':
        return <AlertTriangle size={12} class={styles.statusStale} />
      case 'unavailable':
        return <AlertCircle size={12} class={styles.statusUnavailable} />
      default:
        return <HelpCircle size={12} class={styles.statusUnknown} />
    }
  }

  if (isLoading) {
    return (
      <div class={styles.page}>
        <div class={styles.loading}>Loading...</div>
      </div>
    )
  }

  if (!assistant) {
    return (
      <div class={styles.page}>
        <div class={styles.error}>{error || 'Assistant not found'}</div>
      </div>
    )
  }

  return (
    <div class={styles.page}>
      {/* Zone 1: Compact Header */}
      <div class={styles.header}>
        <div class={styles.headerTop}>
          <h1 class={styles.title}>{assistant.name}</h1>
          <span class={styles.handleBadge}>{assistant.handle}</span>
        </div>
        <p class={styles.description}>{assistant.description}</p>
      </div>

      {error && <div class={styles.error}>{error}</div>}

      {/* Zone 2: Configuration — Configs + MCP side by side */}
      <div class={styles.zone}>
        <div class={styles.section}>
          <h2 class={styles.sectionTitle}>Configurations</h2>
          <div class={styles.configList}>
            {configs.length === 0 ? (
              <div class={styles.empty}>No configurations available.</div>
            ) : (
              (() => {
                const parentConfigs = configs.filter((c) => !c.is_import)
                const childMap = new Map<string, AssistantConfig[]>()
                for (const c of configs) {
                  if (c.is_import && c.parent_config_id) {
                    const children = childMap.get(c.parent_config_id) || []
                    children.push(c)
                    childMap.set(c.parent_config_id, children)
                  }
                }

                return parentConfigs.map((config) => {
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
              })()
            )}
          </div>
        </div>

        <div class={styles.section}>
          <div class={styles.sectionHeader}>
            <h2 class={styles.sectionTitle}>MCP Servers</h2>
            <button
              class={styles.addButton}
              onClick={() => setShowAddForm(!showAddForm)}
              title="Add MCP Server"
            >
              <Plus size={16} />
            </button>
          </div>

          {showAddForm && (
            <div class={clsx(cardStyles.card, styles.addForm)}>
              <div class={styles.formRow}>
                <label class={styles.formLabel}>Name</label>
                <input
                  type="text"
                  class={styles.formInput}
                  value={newServerName}
                  onInput={(e) => setNewServerName((e.target as HTMLInputElement).value)}
                  placeholder="my-server"
                />
              </div>
              <div class={styles.formRow}>
                <label class={styles.formLabel}>Config (JSON)</label>
                <textarea
                  class={styles.formTextarea}
                  value={newServerJson}
                  onInput={(e) => {
                    setNewServerJson((e.target as HTMLTextAreaElement).value)
                    setJsonError(null)
                  }}
                  rows={8}
                  spellcheck={false}
                />
              </div>
              {jsonError && <div class={styles.formError}>{jsonError}</div>}
              <div class={styles.formActions}>
                <button
                  class={styles.cancelButton}
                  onClick={() => {
                    setShowAddForm(false)
                    setJsonError(null)
                  }}
                >
                  Cancel
                </button>
                <button
                  class={styles.saveButton}
                  onClick={handleAddServer}
                  disabled={isAddingServer || !newServerName}
                >
                  {isAddingServer ? 'Adding...' : 'Add Server'}
                </button>
              </div>
            </div>
          )}

          <div class={styles.mcpList}>
            {mcpServers.length === 0 ? (
              <div class={styles.empty}>No MCP servers configured.</div>
            ) : (
              mcpServers.map((server) => {
                const hasIssue = server.status === 'stale' || server.status === 'unavailable'
                const isDismissed = dismissed.has(server.name)
                const hasDetails = server.command || (server.args && server.args.length > 0) || server.url || (server.env && Object.keys(server.env).length > 0)
                return (
                  <details key={server.name} class={clsx(cardStyles.card, styles.mcpCard, hasIssue && !isDismissed && styles.mcpCardStale, hasIssue && isDismissed && styles.mcpCardDismissed)}>
                    <summary class={styles.mcpSummary}>
                      {hasDetails && <ChevronRight size={12} class={styles.mcpExpandIcon} />}
                      <Server size={14} class={styles.mcpIcon} />
                      <span class={styles.mcpName}>{server.name}</span>
                      {!isDismissed && getStatusIcon(server.status)}
                      <span class={styles.mcpType}>{server.type}</span>
                      {hasIssue && (
                        <button
                          class={styles.dismissButton}
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            isDismissed ? handleRestoreWarning(server.name) : handleDismissWarning(server.name)
                          }}
                          title={isDismissed ? 'Restore warning' : 'Dismiss warning'}
                        >
                          {isDismissed ? <Bell size={12} /> : <BellOff size={12} />}
                        </button>
                      )}
                      <button
                        class={styles.deleteButton}
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setServerToRemove(server.name)
                        }}
                        title="Remove server"
                      >
                        <Trash2 size={12} />
                      </button>
                    </summary>
                    {server.statusMessage && !isDismissed && (
                      <div class={styles.statusMessage}>
                        {server.statusMessage}
                      </div>
                    )}
                    {hasDetails && (
                      <div class={styles.mcpDetails}>
                        {server.command && (
                          <div class={styles.mcpRow}>
                            <span class={styles.mcpLabel}>Command:</span>
                            <code class={styles.mcpValue}>{server.command}</code>
                          </div>
                        )}
                        {server.args && server.args.length > 0 && (
                          <div class={styles.mcpRow}>
                            <span class={styles.mcpLabel}>Args:</span>
                            <code class={styles.mcpValue}>{server.args.join(' ')}</code>
                          </div>
                        )}
                        {server.url && (
                          <div class={styles.mcpRow}>
                            <span class={styles.mcpLabel}>URL:</span>
                            <code class={styles.mcpValue}>{server.url}</code>
                          </div>
                        )}
                        {server.env && Object.keys(server.env).length > 0 && (
                          <div class={styles.mcpRow}>
                            <span class={styles.mcpLabel}>Env:</span>
                            <code class={styles.mcpValue}>
                              {Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join(', ')}
                            </code>
                          </div>
                        )}
                      </div>
                    )}
                  </details>
                )
              })
            )}
          </div>
          {mcpConfigPath && (
            <div class={styles.mcpConfigPath}>
              Config: <code>{mcpConfigPath}</code>
            </div>
          )}
        </div>
      </div>

      {/* Zone 3: Skills */}
      <div class={styles.section}>
        <h2 class={styles.sectionTitle}>Skills</h2>

        <div class={styles.skillGrid}>
          {skills.length === 0 ? (
            <div class={styles.empty}>No skills configured.</div>
          ) : (
            skills.map((skill) => (
              <Link
                key={`${skill.scope}-${skill.name}`}
                href={`/assistants/${handle}/skills/${encodeURIComponent(skill.name)}?scope=${skill.scope}&type=skill&from=${encodeURIComponent(`/assistants/${handle}`)}`}
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
            ))
          )}
        </div>
      </div>

      {/* Zone 4: Tools — Agents + Commands side by side */}
      <div class={styles.zone}>
        <div class={styles.section}>
          <div class={styles.sectionHeader}>
            <h2 class={styles.sectionTitle}>Agents</h2>
            <Link
              href={`/assistants/${handle}/agents/new?from=${encodeURIComponent(`/assistants/${handle}`)}`}
              class={styles.addButton}
              title="Add Agent"
            >
              <Plus size={16} />
            </Link>
          </div>

          <div class={styles.agentList}>
            {agents.length === 0 ? (
              <div class={styles.empty}>No agents configured.</div>
            ) : (
              agents.map((agent) => (
                <Link
                  key={agent.name}
                  href={`/assistants/${handle}/agents/${encodeURIComponent(agent.name)}?from=${encodeURIComponent(`/assistants/${handle}`)}`}
                  class={clsx(cardStyles.card, cardStyles.interactive, styles.agentCard)}
                >
                  <Bot size={14} class={styles.agentIcon} />
                  <span class={styles.agentName}>{agent.name}</span>
                </Link>
              ))
            )}
          </div>
          {userAgentsPath && (
            <div class={styles.mcpConfigPath}>
              Path: <code>{userAgentsPath}</code>
            </div>
          )}
        </div>

        <div class={styles.section}>
          <div class={styles.sectionHeader}>
            <h2 class={styles.sectionTitle}>Commands</h2>
            <div class={styles.sectionActions}>
              <Link
                href={`/assistants/${handle}/commands/new?from=${encodeURIComponent(`/assistants/${handle}`)}`}
                class={styles.addButton}
                title="Add Command"
              >
                <Plus size={16} />
              </Link>
            </div>
          </div>

          <div class={styles.commandList}>
            {commandsOnly.length === 0 ? (
              <div class={styles.empty}>No commands configured.</div>
            ) : (
              commandsOnly.map((cmd) => (
                <Link
                  key={`${cmd.scope}-${cmd.type}-${cmd.name}`}
                  href={`/assistants/${handle}/commands/${encodeURIComponent(cmd.name)}?scope=${cmd.scope}&type=${cmd.type}&from=${encodeURIComponent(`/assistants/${handle}`)}`}
                  class={clsx(cardStyles.card, cardStyles.interactive, styles.commandCard)}
                >
                  <Terminal size={14} class={styles.commandIcon} />
                  <div class={styles.commandInfo}>
                    <span class={styles.commandName}>/{cmd.name}</span>
                    {cmd.description && (
                      <span class={styles.commandDescription}>{cmd.description}</span>
                    )}
                  </div>
                  {cmd.name.startsWith('mz-') && (
                    <span class={styles.builtInBadge}>built-in</span>
                  )}
                </Link>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Zone 4: Activity — Sessions + Plans side by side */}
      {handle !== 'codex-cli' && (
        <div class={styles.zone}>
          <div class={styles.section}>
            <h2 class={styles.sectionTitle}>Sessions</h2>
            <ActiveSessionsBanner assistantHandle={handle} />
            <div class={styles.commandList}>
              <Link
                href={`/assistants/${handle}/sessions`}
                class={clsx(cardStyles.card, cardStyles.interactive, styles.commandCard)}
              >
                <ScrollText size={14} class={styles.commandIcon} />
                <div class={styles.commandInfo}>
                  <span class={styles.commandName}>Browse Sessions</span>
                  <span class={styles.commandDescription}>Session transcripts across projects</span>
                </div>
              </Link>
            </div>
          </div>

          <div class={styles.section}>
            <h2 class={styles.sectionTitle}>Plans</h2>
            <div class={styles.commandList}>
              <Link
                href={`/assistants/${handle}/plans`}
                class={clsx(cardStyles.card, cardStyles.interactive, styles.commandCard)}
              >
                <FileText size={14} class={styles.commandIcon} />
                <div class={styles.commandInfo}>
                  <span class={styles.commandName}>Browse Plans</span>
                  <span class={styles.commandDescription}>Implementation plans from sessions</span>
                </div>
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Zone 5: Resources — Prompts + Memory Files side by side */}
      <div class={styles.zone}>
        <div class={styles.section}>
          <div class={styles.sectionHeader}>
            <h2 class={styles.sectionTitle}>
              Prompts
              {prompts.length > 0 && (
                <span class={styles.countBadge}>{prompts.length}</span>
              )}
            </h2>
          </div>
          <div class={styles.commandList}>
            {prompts.length === 0 ? (
              <div class={styles.empty}>No prompts for this assistant.</div>
            ) : (
              prompts.slice(0, 5).map((prompt) => (
                <Link
                  key={prompt.id}
                  href={`/prompts/${prompt.id}`}
                  class={clsx(cardStyles.card, cardStyles.interactive, styles.commandCard)}
                >
                  <Sparkles size={14} class={styles.commandIcon} />
                  <div class={styles.commandInfo}>
                    <span class={styles.commandName}>{prompt.title}</span>
                    {prompt.description && (
                      <span class={styles.commandDescription}>{prompt.description}</span>
                    )}
                  </div>
                </Link>
              ))
            )}
            {prompts.length > 5 && (
              <Link
                href={`/prompts?assistant=${handle}`}
                class={clsx(cardStyles.card, cardStyles.interactive, styles.commandCard)}
              >
                <Sparkles size={14} class={styles.commandIcon} />
                <div class={styles.commandInfo}>
                  <span class={styles.commandName}>View All Prompts</span>
                  <span class={styles.commandDescription}>{prompts.length - 5} more prompts</span>
                </div>
              </Link>
            )}
            {prompts.length > 0 && prompts.length <= 5 && (
              <Link
                href={`/prompts?assistant=${handle}`}
                class={clsx(cardStyles.card, cardStyles.interactive, styles.viewAllLink)}
              >
                View all prompts
              </Link>
            )}
          </div>
        </div>

        <div class={styles.section}>
          <h2 class={styles.sectionTitle}>Memory Files</h2>
          <div class={styles.memoryProjectList}>
            {memoryProjects.length === 0 ? (
              <div class={styles.empty}>No memory files found.</div>
            ) : (
              memoryProjects.map((project) =>
                project.matched_project ? (
                  <Link
                    key={project.dir_name}
                    href={`/projects/${project.matched_project.id}/memory-files`}
                    class={clsx(cardStyles.card, cardStyles.interactive, styles.memoryProjectCard)}
                  >
                    <Brain size={14} class={styles.memoryProjectIcon} />
                    <div class={styles.memoryProjectInfo}>
                      <span class={styles.memoryProjectName}>
                        {project.matched_project.name}
                      </span>
                      <span class={styles.memoryProjectMeta}>
                        {project.file_count} {project.file_count === 1 ? 'file' : 'files'}
                        {project.total_size > 0 && ` · ${(project.total_size / 1024).toFixed(1)} KB`}
                      </span>
                    </div>
                  </Link>
                ) : (
                  <div
                    key={project.dir_name}
                    class={clsx(cardStyles.card, styles.memoryProjectCard, styles.memoryProjectOrphan)}
                    title="Not linked to a khef project"
                  >
                    <Brain size={14} class={styles.memoryProjectIcon} />
                    <div class={styles.memoryProjectInfo}>
                      <span class={styles.memoryProjectName}>
                        {project.decoded_path}
                      </span>
                      <span class={styles.memoryProjectMeta}>
                        {project.file_count} {project.file_count === 1 ? 'file' : 'files'}
                        {project.total_size > 0 && ` · ${(project.total_size / 1024).toFixed(1)} KB`}
                      </span>
                    </div>
                  </div>
                )
              )
            )}
          </div>
        </div>
      </div>

      {serverToRemove && (
        <ConfirmModal
          title="Remove MCP Server"
          message={`Remove MCP server "${serverToRemove}"? This will update your configuration file.`}
          confirmLabel="Remove"
          variant="danger"
          onConfirm={() => handleRemoveServer(serverToRemove)}
          onCancel={() => setServerToRemove(null)}
        />
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
    </div>
  )
}
