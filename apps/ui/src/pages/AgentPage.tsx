import { useState, useEffect, useCallback } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { Pencil, Trash2 } from 'lucide-preact'
import clsx from 'clsx'
import {
  getAgent,
  updateAgent,
  deleteAgent,
  createAgent,
  getProjectAgent,
  updateProjectAgent,
  deleteProjectAgent,
  createProjectAgent,
} from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import type { Agent, AgentModel, AgentPermissionMode } from '../types'
import { ConfirmModal, CopyButton } from '../components/ui'
import { CodeEditor } from '../components/editor'
import { useDocumentTitle } from '../hooks'
import styles from './AgentPage.module.css'

interface Props {
  assistantHandle: string
  agentName: string
  projectId?: string
  projectPath?: string
}

export function AgentPage({ assistantHandle, agentName, projectId, projectPath }: Props) {
  const [, setLocation] = useLocation()
  const isNew = agentName === 'new'
  const isProjectScope = Boolean(projectId && projectPath)

  // Get referrer from query param for back navigation
  const fromUrl = new URLSearchParams(window.location.search).get('from')

  const [agent, setAgent] = useState<Agent | null>(null)
  const [isLoading, setIsLoading] = useState(!isNew)
  const [error, setError] = useState<string | null>(null)

  useDocumentTitle(
    isNew ? 'Agent - New' : agent?.name ? `Agent - ${agent.name}` : 'Agent - Loading',
  )

  const [isEditing, setIsEditing] = useState(isNew)
  const [promptMode, setPromptMode] = useState<'edit' | 'preview'>('edit')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [renderedPrompt, setRenderedPrompt] = useState('')
  const [viewHtml, setViewHtml] = useState('')

  // Edit form state
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editModel, setEditModel] = useState<AgentModel | ''>('')
  const [editTools, setEditTools] = useState('')
  const [editDisallowedTools, setEditDisallowedTools] = useState('')
  const [editPermissionMode, setEditPermissionMode] = useState<AgentPermissionMode | ''>('')
  const [editPrompt, setEditPrompt] = useState('')

  const loadAgent = useCallback(async () => {
    if (isNew) return
    setIsLoading(true)
    setError(null)
    try {
      const data = isProjectScope
        ? await getProjectAgent(assistantHandle, projectId!, agentName)
        : await getAgent(assistantHandle, agentName)
      setAgent(data)
      // Initialize edit form
      setEditName(data.name)
      setEditDescription(data.description)
      setEditModel(data.model || '')
      setEditTools(data.tools?.join(', ') || '')
      setEditDisallowedTools(data.disallowedTools?.join(', ') || '')
      setEditPermissionMode(data.permissionMode || '')
      setEditPrompt(data.prompt)
    } catch {
      setError('Failed to load agent')
    } finally {
      setIsLoading(false)
    }
  }, [assistantHandle, agentName, isNew, isProjectScope, projectId])

  useEffect(() => {
    loadAgent()
  }, [loadAgent])

  // Render markdown for view mode when agent loads
  useEffect(() => {
    if (!agent?.prompt) {
      setViewHtml('')
      return
    }
    let isActive = true
    renderMarkdown(agent.prompt)
      .then((html) => {
        if (isActive) setViewHtml(html)
      })
      .catch(() => {
        if (isActive) setViewHtml('')
      })
    return () => {
      isActive = false
    }
  }, [agent?.prompt])

  // Render prompt markdown for edit preview
  useEffect(() => {
    if (promptMode !== 'preview' || !editPrompt) {
      setRenderedPrompt('')
      return
    }
    let isActive = true
    renderMarkdown(editPrompt)
      .then((html) => {
        if (isActive) setRenderedPrompt(html)
      })
      .catch(() => {
        if (isActive) setRenderedPrompt(editPrompt)
      })
    return () => {
      isActive = false
    }
  }, [editPrompt, promptMode])

  const handleStartEdit = useCallback(() => {
    if (agent) {
      setEditName(agent.name)
      setEditDescription(agent.description)
      setEditModel(agent.model || '')
      setEditTools(agent.tools?.join(', ') || '')
      setEditDisallowedTools(agent.disallowedTools?.join(', ') || '')
      setEditPermissionMode(agent.permissionMode || '')
      setEditPrompt(agent.prompt)
      setIsEditing(true)
      setPromptMode('edit')
      setSaveError(null)
    }
  }, [agent])

  const handleCancelEdit = useCallback(() => {
    if (agent) {
      setEditName(agent.name)
      setEditDescription(agent.description)
      setEditModel(agent.model || '')
      setEditTools(agent.tools?.join(', ') || '')
      setEditDisallowedTools(agent.disallowedTools?.join(', ') || '')
      setEditPermissionMode(agent.permissionMode || '')
      setEditPrompt(agent.prompt)
    }
    setIsEditing(false)
    setSaveError(null)
  }, [agent])

  const handleSave = useCallback(async () => {
    if (!editName || !editDescription || !editPrompt) return
    if (!isNew && !agent) return

    setIsSaving(true)
    setSaveError(null)
    try {
      const agentData = {
        name: editName,
        description: editDescription,
        model: editModel || undefined,
        tools: editTools ? editTools.split(',').map(s => s.trim()).filter(Boolean) : undefined,
        disallowedTools: editDisallowedTools ? editDisallowedTools.split(',').map(s => s.trim()).filter(Boolean) : undefined,
        permissionMode: editPermissionMode || undefined,
        prompt: editPrompt,
      }

      const getRedirectUrl = (name: string) =>
        isProjectScope
          ? `/projects/${projectId}/agents/${encodeURIComponent(name)}`
          : `/assistants/${assistantHandle}/agents/${encodeURIComponent(name)}`

      if (isNew) {
        // Create new agent
        if (isProjectScope) {
          await createProjectAgent(assistantHandle, projectId!, agentData)
        } else {
          await createAgent(assistantHandle, agentData)
        }
        setLocation(getRedirectUrl(editName))
      } else {
        // Update existing agent
        const updated = isProjectScope
          ? await updateProjectAgent(assistantHandle, projectId!, agent!.name, agentData)
          : await updateAgent(assistantHandle, agent!.name, agentData)
        setAgent(updated)
        setIsEditing(false)

        // If name changed, redirect to new URL
        if (editName !== agent!.name) {
          setLocation(getRedirectUrl(editName))
        }
      }
    } catch (err: any) {
      setSaveError(err.message || 'Failed to save')
    } finally {
      setIsSaving(false)
    }
  }, [agent, assistantHandle, editName, editDescription, editModel, editTools, editDisallowedTools, editPermissionMode, editPrompt, setLocation, isNew, isProjectScope, projectId, projectPath])

  const handleDelete = async () => {
    if (!agent) return
    try {
      if (isProjectScope) {
        await deleteProjectAgent(assistantHandle, projectId!, agent.name)
      } else {
        await deleteAgent(assistantHandle, agent.name)
      }
      const redirectUrl = isProjectScope
        ? `/projects/${projectId}/agents`
        : `/assistants/${assistantHandle}`
      setLocation(redirectUrl)
    } catch (err: any) {
      setError(err.message || 'Failed to delete agent')
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'e') {
        event.preventDefault()
        if (isEditing) {
          handleCancelEdit()
        } else {
          handleStartEdit()
        }
        return
      }

      if (!isEditing) return

      if (event.key === 'Escape') {
        event.preventDefault()
        handleCancelEdit()
      } else if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        if (event.defaultPrevented) return
        event.preventDefault()
        handleSave()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isEditing, handleSave, handleStartEdit, handleCancelEdit])

  if (isLoading) {
    return (
      <div class={styles.page}>
        <div class={styles.loading}>Loading...</div>
      </div>
    )
  }

  if (!isNew && !agent) {
    return (
      <div class={styles.page}>
        <div class={styles.error}>{error || 'Agent not found'}</div>
      </div>
    )
  }

  const hasChanges = isNew
    ? (editName && editDescription && editPrompt)
    : isEditing && (
        editName !== agent!.name ||
        editDescription !== agent!.description ||
        editModel !== (agent!.model || '') ||
        editTools !== (agent!.tools?.join(', ') || '') ||
        editDisallowedTools !== (agent!.disallowedTools?.join(', ') || '') ||
        editPermissionMode !== (agent!.permissionMode || '') ||
        editPrompt !== agent!.prompt
      )

  const backUrl = fromUrl
    || (isProjectScope
      ? `/projects/${projectId}/agents`
      : `/assistants/${assistantHandle}`)
  return (
    <div class={styles.page}>
      <div class={styles.header}>

        <div class={styles.titleRow}>
          <h1 class={styles.title}>{isNew ? 'New Agent' : agent!.name}</h1>
        </div>

        {!isNew && agent?.filePath && (
          <div class={styles.filePathRow}>
            <span class={styles.filePathLabel}>File:</span>
            <span class={styles.filePath}>{agent.filePath}</span>
            <CopyButton text={agent.filePath} title="Copy full path" size={13} />
          </div>
        )}
      </div>

      {error && <div class={styles.error}>{error}</div>}

      <div class={styles.toolbar}>
        <div class={styles.toolbarLeft}>
          {!isNew && (
            <button
              class={styles.deleteButton}
              onClick={() => setShowDeleteConfirm(true)}
              title="Delete agent"
              type="button"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>

        <div class={styles.toolbarRight}>
          {!isEditing && !isNew && (
            <button
              class={styles.editIconButton}
              onClick={handleStartEdit}
              title="Edit (⌘E)"
              type="button"
            >
              <Pencil size={16} />
            </button>
          )}
        </div>
      </div>

      {saveError && <div class={styles.saveError}>{saveError}</div>}

      <div class={styles.content}>
        {isEditing ? (
          <div class={styles.editForm}>
            <div class={styles.formRow}>
              <label class={styles.formLabel}>Name</label>
              <input
                type="text"
                class={styles.formInput}
                value={editName}
                onInput={(e) => setEditName((e.target as HTMLInputElement).value)}
              />
            </div>

            <div class={styles.formRow}>
              <label class={styles.formLabel}>Description</label>
              <textarea
                class={styles.formTextarea}
                value={editDescription}
                onInput={(e) => setEditDescription((e.target as HTMLTextAreaElement).value)}
              />
            </div>

            <div class={styles.formRow}>
              <label class={styles.formLabel}>Model</label>
              <select
                class={styles.formSelect}
                value={editModel}
                onChange={(e) => setEditModel((e.target as HTMLSelectElement).value as AgentModel | '')}
              >
                <option value="">Inherit</option>
                <option value="sonnet">Sonnet</option>
                <option value="opus">Opus</option>
                <option value="haiku">Haiku</option>
              </select>
            </div>

            <div class={styles.formRow}>
              <label class={styles.formLabel}>Tools (comma-separated)</label>
              <input
                type="text"
                class={styles.formInput}
                value={editTools}
                onInput={(e) => setEditTools((e.target as HTMLInputElement).value)}
                placeholder="Read, Glob, Grep"
              />
            </div>

            <div class={styles.formRow}>
              <label class={styles.formLabel}>Disallowed Tools (comma-separated)</label>
              <input
                type="text"
                class={styles.formInput}
                value={editDisallowedTools}
                onInput={(e) => setEditDisallowedTools((e.target as HTMLInputElement).value)}
                placeholder="Write, Edit"
              />
            </div>

            <div class={styles.formRow}>
              <label class={styles.formLabel}>Permission Mode</label>
              <select
                class={styles.formSelect}
                value={editPermissionMode}
                onChange={(e) => setEditPermissionMode((e.target as HTMLSelectElement).value as AgentPermissionMode | '')}
              >
                <option value="">Default</option>
                <option value="acceptEdits">Accept Edits</option>
                <option value="dontAsk">Don't Ask</option>
                <option value="bypassPermissions">Bypass Permissions</option>
                <option value="plan">Plan Mode</option>
              </select>
            </div>

            <div class={styles.formRow}>
              <div class={styles.promptHeader}>
                <label class={styles.formLabel}>Prompt</label>
                <div class={styles.modeToggle} role="group" aria-label="Prompt view">
                  <button
                    type="button"
                    class={clsx(styles.toggleButton, promptMode === 'edit' && styles.toggleButtonActive)}
                    onClick={() => setPromptMode('edit')}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    class={clsx(styles.toggleButton, promptMode === 'preview' && styles.toggleButtonActive)}
                    onClick={() => setPromptMode('preview')}
                  >
                    Preview
                  </button>
                </div>
              </div>
              {promptMode === 'edit' ? (
                <div class={styles.promptEditor}>
                  <CodeEditor
                    value={editPrompt}
                    onChange={setEditPrompt}
                    language="markdown"
                    onSave={handleSave}
                    autoFocus
                  />
                </div>
              ) : (
                <div
                  class={styles.promptPreview}
                  dangerouslySetInnerHTML={{ __html: renderedPrompt }}
                />
              )}
            </div>
          </div>
        ) : (
          <div class={styles.viewContent}>
            <div class={styles.section}>
              <h3 class={styles.sectionTitle}>Description</h3>
              <p class={styles.description}>{agent!.description}</p>
            </div>

            {(agent!.model || agent!.tools || agent!.disallowedTools || agent!.permissionMode) && (
              <div class={styles.section}>
                <h3 class={styles.sectionTitle}>Configuration</h3>
                <div class={styles.configGrid}>
                  {agent!.model && (
                    <div class={styles.configItem}>
                      <span class={styles.configLabel}>Model</span>
                      <span class={styles.configValue}>{agent!.model}</span>
                    </div>
                  )}
                  {agent!.permissionMode && (
                    <div class={styles.configItem}>
                      <span class={styles.configLabel}>Permission Mode</span>
                      <span class={styles.configValue}>{agent!.permissionMode}</span>
                    </div>
                  )}
                  {agent!.tools && agent!.tools.length > 0 && (
                    <div class={styles.configItem}>
                      <span class={styles.configLabel}>Tools</span>
                      <span class={styles.configValue}>{agent!.tools.join(', ')}</span>
                    </div>
                  )}
                  {agent!.disallowedTools && agent!.disallowedTools.length > 0 && (
                    <div class={styles.configItem}>
                      <span class={styles.configLabel}>Disallowed</span>
                      <span class={styles.configValue}>{agent!.disallowedTools.join(', ')}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div class={styles.section}>
              <h3 class={styles.sectionTitle}>Prompt</h3>
              {viewHtml ? (
                <div
                  class={styles.promptPreview}
                  dangerouslySetInnerHTML={{ __html: viewHtml }}
                />
              ) : (
                <pre class={styles.promptContent}>{agent!.prompt}</pre>
              )}
            </div>
          </div>
        )}
      </div>

      {isEditing && (
        <div class={styles.actionButtons}>
          <button
            class={styles.cancelButton}
            onClick={isNew ? () => setLocation(backUrl) : handleCancelEdit}
            disabled={isSaving}
            type="button"
          >
            Cancel
          </button>
          <button
            class={styles.saveButton}
            onClick={handleSave}
            disabled={isSaving || !hasChanges || !editName || !editDescription || !editPrompt}
            type="button"
          >
            {isSaving ? 'Saving...' : isNew ? 'Create Agent' : 'Save'}
          </button>
        </div>
      )}

      {showDeleteConfirm && agent && (
        <ConfirmModal
          title="Delete Agent"
          message={`Delete agent "${agent.name}"? This will remove the agent file.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  )
}
