import { useState, useEffect, useCallback } from 'preact/hooks'
import clsx from 'clsx'
import { Plus, Trash2, Server, AlertTriangle, CheckCircle, AlertCircle, HelpCircle, BellOff, Bell, ChevronRight, Wrench } from 'lucide-preact'
import { getMcpServers, addMcpServer, removeMcpServer, getMcpServerTools } from '../../lib/api'
import type { McpServer, McpServerStatus } from '../../types'
import type { McpToolInfo } from '../../lib/api'
import { getDismissedServers, dismissServer, restoreServer } from '../../lib/mcpDismissed'
import { cardStyles, ConfirmModal } from '../../components/ui'
import styles from '../AssistantPage.module.css'

const TOOLS_SUPPORTED_SERVERS = new Set(['khef'])
const TOOLS_PAGE_SIZE = 20

interface ServerToolsState {
  loading: boolean
  tools: McpToolInfo[] | null
  error: string | null
}

interface Props {
  handle: string
}

export function McpSection({ handle }: Props) {
  const [mcpServers, setMcpServers] = useState<McpServer[]>([])
  const [mcpConfigPath, setMcpConfigPath] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(() => getDismissedServers())
  const [showAddForm, setShowAddForm] = useState(false)
  const [newServerName, setNewServerName] = useState('')
  const [newServerJson, setNewServerJson] = useState('{\n  "type": "stdio",\n  "command": "node",\n  "args": []\n}')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [isAddingServer, setIsAddingServer] = useState(false)
  const [serverToRemove, setServerToRemove] = useState<string | null>(null)
  const [toolsByServer, setToolsByServer] = useState<Record<string, ServerToolsState>>({})
  const [toolFilter, setToolFilter] = useState<Record<string, string>>({})
  const [toolsPage, setToolsPage] = useState<Record<string, number>>({})
  const [expandedTools, setExpandedTools] = useState<Record<string, Set<string>>>({})
  const [hoveredServer, setHoveredServer] = useState<string | null>(null)

  const loadServers = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await getMcpServers(handle)
      setMcpServers(res.servers)
      setMcpConfigPath(res.configPath)
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false)
    }
  }, [handle])

  useEffect(() => {
    loadServers()
  }, [loadServers])

  const handleAddServer = async () => {
    if (!newServerName) return
    let parsed: any
    try {
      parsed = JSON.parse(newServerJson)
      setJsonError(null)
    } catch (e: any) {
      setJsonError('Invalid JSON: ' + e.message)
      return
    }
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
      await addMcpServer(handle, {
        name: newServerName,
        type: parsed.type,
        command: parsed.command,
        args: parsed.args,
        url: parsed.url,
        env: parsed.env,
      })
      await loadServers()
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
      await loadServers()
    } catch (err: any) {
      setError(err.message || 'Failed to remove MCP server')
    } finally {
      setServerToRemove(null)
    }
  }

  const loadServerTools = useCallback(
    async (serverName: string) => {
      setToolsByServer((prev) =>
        prev[serverName]?.tools || prev[serverName]?.loading
          ? prev
          : { ...prev, [serverName]: { loading: true, tools: null, error: null } }
      )
      try {
        const res = await getMcpServerTools(handle, serverName)
        setToolsByServer((prev) => ({
          ...prev,
          [serverName]: { loading: false, tools: res.tools, error: null },
        }))
      } catch (err: any) {
        setToolsByServer((prev) => ({
          ...prev,
          [serverName]: { loading: false, tools: null, error: err.message || 'Failed to load tools' },
        }))
      }
    },
    [handle]
  )

  const toggleToolExpanded = (serverName: string, toolName: string) => {
    setExpandedTools((prev) => {
      const current = new Set(prev[serverName] || [])
      if (current.has(toolName)) current.delete(toolName)
      else current.add(toolName)
      return { ...prev, [serverName]: current }
    })
  }

  const setToolFilterFor = (serverName: string, value: string) => {
    setToolFilter((prev) => ({ ...prev, [serverName]: value }))
    setToolsPage((prev) => ({ ...prev, [serverName]: 0 }))
  }

  const filterToolsFor = useCallback(
    (serverName: string): McpToolInfo[] => {
      const tools = toolsByServer[serverName]?.tools || []
      const q = (toolFilter[serverName] || '').trim().toLowerCase()
      if (!q) return tools
      return tools.filter(
        (t) => t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
      )
    },
    [toolsByServer, toolFilter]
  )

  // Left/right arrow keys paginate tools for the hovered server card
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      if (!hoveredServer) return
      const filtered = filterToolsFor(hoveredServer)
      const totalPages = Math.ceil(filtered.length / TOOLS_PAGE_SIZE)
      if (totalPages <= 1) return
      const currentPage = toolsPage[hoveredServer] || 0
      if (e.key === 'ArrowLeft' && currentPage > 0) {
        e.preventDefault()
        setToolsPage((prev) => ({ ...prev, [hoveredServer]: currentPage - 1 }))
      } else if (e.key === 'ArrowRight' && currentPage < totalPages - 1) {
        e.preventDefault()
        setToolsPage((prev) => ({ ...prev, [hoveredServer]: currentPage + 1 }))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hoveredServer, toolsPage, filterToolsFor])

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

  if (isLoading) return <div class={styles.loading}>Loading...</div>

  return (
    <>
      <div class={styles.sectionHeader}>
        <span />
        <button
          class={styles.addButton}
          onClick={() => setShowAddForm(!showAddForm)}
          title="Add MCP Server"
        >
          <Plus size={16} />
        </button>
      </div>

      {error && <div class={styles.error}>{error}</div>}

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
              onClick={() => { setShowAddForm(false); setJsonError(null) }}
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
            const hasConfigDetails = server.command || (server.args && server.args.length > 0) || server.url || (server.env && Object.keys(server.env).length > 0)
            const supportsTools = TOOLS_SUPPORTED_SERVERS.has(server.name)
            const hasDetails = hasConfigDetails || supportsTools
            const toolsState = toolsByServer[server.name]
            const tools = toolsState?.tools || []
            const filter = toolFilter[server.name] || ''
            const filterQ = filter.trim().toLowerCase()
            const filteredTools = filterQ
              ? tools.filter(
                  (t) =>
                    t.name.toLowerCase().includes(filterQ) ||
                    (t.description || '').toLowerCase().includes(filterQ)
                )
              : tools
            const expandedSet = expandedTools[server.name] || new Set<string>()
            const totalFiltered = filteredTools.length
            const totalPages = Math.max(1, Math.ceil(totalFiltered / TOOLS_PAGE_SIZE))
            const rawPage = toolsPage[server.name] || 0
            const currentPage = Math.min(rawPage, totalPages - 1)
            const pageStart = currentPage * TOOLS_PAGE_SIZE
            const pageEnd = Math.min(pageStart + TOOLS_PAGE_SIZE, totalFiltered)
            const pagedTools = filteredTools.slice(pageStart, pageEnd)
            const hasPrev = currentPage > 0
            const hasNext = currentPage < totalPages - 1
            return (
              <details
                key={server.name}
                class={clsx(cardStyles.card, styles.mcpCard, hasIssue && !isDismissed && styles.mcpCardStale, hasIssue && isDismissed && styles.mcpCardDismissed)}
                onToggle={(e) => {
                  if ((e.target as HTMLDetailsElement).open && supportsTools && !toolsState) {
                    void loadServerTools(server.name)
                  }
                }}
                onMouseEnter={() => setHoveredServer(server.name)}
                onMouseLeave={() => setHoveredServer((prev) => (prev === server.name ? null : prev))}
              >
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
                        if (isDismissed) {
                          restoreServer(server.name)
                        } else {
                          dismissServer(server.name)
                        }
                        setDismissed(getDismissedServers())
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
                  <div class={styles.statusMessage}>{server.statusMessage}</div>
                )}
                {hasConfigDetails && (
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
                {supportsTools && (
                  <div class={styles.mcpToolsSection}>
                    <div class={styles.mcpToolsHeader}>
                      <Wrench size={12} class={styles.mcpIcon} />
                      <span class={styles.mcpToolsTitle}>
                        Tools
                        {toolsState?.tools && (
                          <span class={styles.mcpToolsCount}>{tools.length}</span>
                        )}
                      </span>
                      {toolsState?.tools && tools.length > 0 && (
                        <input
                          type="text"
                          class={styles.mcpToolsFilter}
                          placeholder="Filter tools..."
                          value={filter}
                          onInput={(e) =>
                            setToolFilterFor(server.name, (e.target as HTMLInputElement).value)
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setToolFilterFor(server.name, '')
                          }}
                        />
                      )}
                    </div>
                    {toolsState?.loading && <div class={styles.empty}>Loading tools...</div>}
                    {toolsState?.error && <div class={styles.error}>{toolsState.error}</div>}
                    {toolsState?.tools && totalFiltered === 0 && (
                      <div class={styles.empty}>
                        {filter ? 'No tools match the filter.' : 'No tools available.'}
                      </div>
                    )}
                    {toolsState?.tools && pagedTools.length > 0 && (
                      <div class={styles.mcpToolsList}>
                        {pagedTools.map((tool) => {
                          const isExpanded = expandedSet.has(tool.name)
                          return (
                            <div key={tool.name} class={styles.mcpTool}>
                              <button
                                type="button"
                                class={styles.mcpToolHeader}
                                onClick={() => toggleToolExpanded(server.name, tool.name)}
                              >
                                <ChevronRight
                                  size={11}
                                  class={clsx(styles.mcpToolChevron, isExpanded && styles.mcpToolChevronOpen)}
                                />
                                <code class={styles.mcpToolName}>{tool.name}</code>
                                <span class={styles.mcpToolDescription}>{tool.description}</span>
                              </button>
                              {isExpanded && (
                                <pre class={styles.mcpToolSchema}>
                                  {JSON.stringify(tool.inputSchema, null, 2)}
                                </pre>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {toolsState?.tools && totalFiltered > 0 && (
                      <div class={styles.mcpToolsPagerFooter}>
                        {totalPages > 1 && (
                          <button
                            type="button"
                            class={styles.mcpToolsPageBtn}
                            disabled={!hasPrev}
                            onClick={() =>
                              setToolsPage((prev) => ({ ...prev, [server.name]: currentPage - 1 }))
                            }
                            title="Previous page"
                          >
                            &larr;
                          </button>
                        )}
                        <span class={styles.mcpToolsPageInfo}>
                          {pageStart + 1}-{pageEnd} of {totalFiltered}
                        </span>
                        {totalPages > 1 && (
                          <button
                            type="button"
                            class={styles.mcpToolsPageBtn}
                            disabled={!hasNext}
                            onClick={() =>
                              setToolsPage((prev) => ({ ...prev, [server.name]: currentPage + 1 }))
                            }
                            title="Next page"
                          >
                            &rarr;
                          </button>
                        )}
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
    </>
  )
}
