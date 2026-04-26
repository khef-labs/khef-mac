import { useState, useEffect, useCallback } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { Pencil, Trash2 } from 'lucide-preact'
import clsx from 'clsx'
import {
  getCommand,
  updateCommand,
  deleteCommand,
  createCommand,
} from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import type { Command, CommandType, CommandScope } from '../types'
import { ConfirmModal } from '../components/ui'
import { CopyButton } from '../components/ui/CopyButton'
import { CodeEditor } from '../components/editor'
import { useDocumentTitle } from '../hooks'
import styles from './CommandPage.module.css'

interface Props {
  assistantHandle: string
  itemName: string
  kind: 'command' | 'skill'
  routeSection: 'commands' | 'skills'
}

export function AssistantToolPage({ assistantHandle, itemName, kind, routeSection }: Props) {
  const [, setLocation] = useLocation()
  const isNew = itemName === 'new'
  const noun = kind === 'skill' ? 'Skill' : 'Command'
  const nounLower = kind

  const searchParams = new URLSearchParams(window.location.search)
  const initialScope = (searchParams.get('scope') as CommandScope) || 'user'
  const initialType = ((searchParams.get('type') as CommandType) || kind) as CommandType
  const projectParam = searchParams.get('project') || undefined
  const fromUrl = searchParams.get('from')

  const [command, setCommand] = useState<Command | null>(null)
  const [isLoading, setIsLoading] = useState(!isNew)
  const [error, setError] = useState<string | null>(null)

  useDocumentTitle(
    isNew ? `${noun} - New` : command?.name ? `${noun} - ${command.name}` : `${noun} - Loading`,
  )

  const [isEditing, setIsEditing] = useState(isNew)
  const [contentMode, setContentMode] = useState<'edit' | 'preview'>('edit')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [renderedContent, setRenderedContent] = useState('')
  const [viewHtml, setViewHtml] = useState('')

  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editScope, setEditScope] = useState<CommandScope>(initialScope)
  const [currentHash, setCurrentHash] = useState<string>('')

  const loadCommand = useCallback(async () => {
    if (isNew) return
    setIsLoading(true)
    setError(null)
    try {
      const data = await getCommand(assistantHandle, itemName, {
        scope: initialScope,
        type: initialType,
        project: projectParam,
      })
      setCommand(data)
      setCurrentHash(data.hash)
      setEditName(data.name)
      setEditDescription(data.description || '')
      setEditContent(data.content)
      setEditScope(data.scope)
    } catch {
      setError(`Failed to load ${nounLower}`)
    } finally {
      setIsLoading(false)
    }
  }, [assistantHandle, initialScope, initialType, isNew, itemName, nounLower, projectParam])

  useEffect(() => {
    loadCommand()
  }, [loadCommand])

  useEffect(() => {
    if (!command?.content) {
      setViewHtml('')
      return
    }
    let isActive = true
    renderMarkdown(command.content)
      .then((html) => {
        if (isActive) setViewHtml(html)
      })
      .catch(() => {
        if (isActive) setViewHtml('')
      })
    return () => {
      isActive = false
    }
  }, [command?.content])

  useEffect(() => {
    if (contentMode !== 'preview' || !editContent) {
      setRenderedContent('')
      return
    }
    let isActive = true
    renderMarkdown(editContent)
      .then((html) => {
        if (isActive) setRenderedContent(html)
      })
      .catch(() => {
        if (isActive) setRenderedContent(editContent)
      })
    return () => {
      isActive = false
    }
  }, [editContent, contentMode])

  const handleStartEdit = useCallback(() => {
    if (command) {
      setEditName(command.name)
      setEditDescription(command.description || '')
      setEditContent(command.content)
      setEditScope(command.scope)
      setIsEditing(true)
      setContentMode('edit')
      setSaveError(null)
    }
  }, [command])

  const handleCancelEdit = useCallback(() => {
    if (command) {
      setEditName(command.name)
      setEditDescription(command.description || '')
      setEditContent(command.content)
      setEditScope(command.scope)
    }
    setIsEditing(false)
    setSaveError(null)
  }, [command])

  const handleSave = useCallback(async () => {
    if (!editName || !editContent) return
    if (!isNew && !command) return

    setIsSaving(true)
    setSaveError(null)
    try {
      const getRedirectUrl = (name: string, scope: CommandScope, type: CommandType) =>
        `/assistants/${assistantHandle}/${routeSection}/${encodeURIComponent(name)}?scope=${scope}&type=${type}`

      if (isNew) {
        await createCommand(assistantHandle, {
          name: editName,
          description: editDescription || undefined,
          content: editContent,
          scope: editScope,
          type: kind,
        })
        setLocation(getRedirectUrl(editName, editScope, kind))
      } else {
        const updated = await updateCommand(
          assistantHandle,
          command!.name,
          { scope: command!.scope, type: command!.type, project: projectParam },
          {
            name: editName !== command!.name ? editName : undefined,
            description: editDescription || undefined,
            content: editContent,
            expected_hash: currentHash,
          }
        )
        setCommand(updated)
        setCurrentHash(updated.hash)
        setIsEditing(false)

        if (editName !== command!.name) {
          setLocation(getRedirectUrl(editName, updated.scope, updated.type))
        }
      }
    } catch (err: any) {
      if (err.message?.includes('conflict') || err.message?.includes('hash')) {
        setSaveError('File was modified externally. Please refresh and try again.')
      } else {
        setSaveError(err.message || `Failed to save ${nounLower}`)
      }
    } finally {
      setIsSaving(false)
    }
  }, [assistantHandle, command, currentHash, editContent, editDescription, editName, editScope, isNew, kind, nounLower, projectParam, routeSection, setLocation])

  const handleDelete = async () => {
    if (!command) return
    try {
      await deleteCommand(assistantHandle, command.name, {
        scope: command.scope,
        type: command.type,
        project: projectParam,
      })
      setLocation(fromUrl || `/assistants/${assistantHandle}`)
    } catch (err: any) {
      setError(err.message || `Failed to delete ${nounLower}`)
    }
  }

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
  }, [handleCancelEdit, handleSave, handleStartEdit, isEditing])

  if (isLoading) {
    return (
      <div class={styles.page}>
        <div class={styles.loading}>Loading...</div>
      </div>
    )
  }

  if (!isNew && !command) {
    return (
      <div class={styles.page}>
        <div class={styles.error}>{error || `${noun} not found`}</div>
      </div>
    )
  }

  const hasChanges = isNew
    ? (editName && editContent)
    : isEditing && (
        editName !== command!.name ||
        editDescription !== (command!.description || '') ||
        editContent !== command!.content
      )

  const backUrl = fromUrl || `/assistants/${assistantHandle}`
  const isBuiltIn = kind === 'command' && !isNew && command?.name.startsWith('mz-')

  return (
    <div class={styles.page}>
      <div class={styles.header}>
        <div class={styles.titleRow}>
          <h1 class={styles.title} data-testid="command-page--title">{isNew ? `New ${noun}` : `/${command!.name}`}</h1>
          {isBuiltIn && <span class={styles.builtInBadge}>built-in</span>}
        </div>

        {!isNew && command?.file_path && (
          <div class={styles.filePathRow}>
            <span class={styles.filePathLabel}>File:</span>
            <span class={styles.filePath} data-testid="command-page--file-path">{command.file_path}</span>
            <CopyButton text={command.file_path} title="Copy full path" size={13} />
          </div>
        )}
      </div>

      {error && <div class={styles.error}>{error}</div>}

      <div class={styles.toolbar} data-testid="command-page--toolbar">
        <div class={styles.toolbarLeft}>
          {!isNew && (
            <button
              class={styles.deleteButton}
              onClick={() => setShowDeleteConfirm(true)}
              title={`Delete ${nounLower}`}
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
              title="Edit (Cmd+E)"
              type="button"
              data-testid="command-page--edit-button"
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
                placeholder={kind === 'skill' ? 'my-skill' : 'my-command'}
              />
            </div>

            <div class={styles.formRow}>
              <label class={styles.formLabel}>Description</label>
              <textarea
                class={styles.formTextarea}
                value={editDescription}
                onInput={(e) => setEditDescription((e.target as HTMLTextAreaElement).value)}
                placeholder={`What this ${nounLower} does...`}
              />
            </div>

            {isNew && (
              <>
                <div class={styles.formRow}>
                  <label class={styles.formLabel}>Scope</label>
                  <select
                    class={styles.formSelect}
                    value={editScope}
                    onChange={(e) => setEditScope((e.target as HTMLSelectElement).value as CommandScope)}
                  >
                    <option value="user">User (global)</option>
                    <option value="project">Project</option>
                  </select>
                </div>

                <div class={styles.formRow}>
                  <label class={styles.formLabel}>Type</label>
                  <input
                    type="text"
                    class={styles.formInput}
                    value={noun}
                    disabled
                  />
                </div>
              </>
            )}

            <div class={styles.formRow}>
              <div class={styles.contentHeader}>
                <label class={styles.formLabel}>Content</label>
                <div class={styles.modeToggle} role="group" aria-label="Content view">
                  <button
                    type="button"
                    class={clsx(styles.toggleButton, contentMode === 'edit' && styles.toggleButtonActive)}
                    onClick={() => setContentMode('edit')}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    class={clsx(styles.toggleButton, contentMode === 'preview' && styles.toggleButtonActive)}
                    onClick={() => setContentMode('preview')}
                  >
                    Preview
                  </button>
                </div>
              </div>
              {contentMode === 'edit' ? (
                <div class={styles.contentEditor} data-testid="command-page--content-textarea">
                  <CodeEditor
                    value={editContent}
                    onChange={setEditContent}
                    language="markdown"
                    onSave={handleSave}
                    placeholder={`${noun} content (markdown)...`}
                    autoFocus
                  />
                </div>
              ) : (
                <div
                  class={styles.contentPreview}
                  dangerouslySetInnerHTML={{ __html: renderedContent }}
                />
              )}
            </div>
          </div>
        ) : (
          <div class={styles.viewContent}>
            {command!.description && (
              <div class={styles.section}>
                <h3 class={styles.sectionTitle}>Description</h3>
                <p class={styles.description}>{command!.description}</p>
              </div>
            )}

            <div class={styles.section}>
              <h3 class={styles.sectionTitle}>Configuration</h3>
              <div class={styles.configGrid}>
                <div class={styles.configItem}>
                  <span class={styles.configLabel}>Scope</span>
                  <span class={styles.configValue}>{command!.scope}</span>
                </div>
                <div class={styles.configItem}>
                  <span class={styles.configLabel}>Type</span>
                  <span class={styles.configValue}>{command!.type}</span>
                </div>
              </div>
            </div>

            <div class={styles.section}>
              <h3 class={styles.sectionTitle}>Content</h3>
              {viewHtml ? (
                <div
                  class={styles.contentPreview}
                  dangerouslySetInnerHTML={{ __html: viewHtml }}
                  data-testid="command-page--content-markdown"
                />
              ) : (
                <pre class={styles.contentDisplay} data-testid="command-page--content-code">{command!.content}</pre>
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
            data-testid="command-page--cancel-button"
          >
            Cancel
          </button>
          <button
            class={styles.saveButton}
            onClick={handleSave}
            disabled={isSaving || !hasChanges || !editName || !editContent}
            type="button"
            data-testid="command-page--save-button"
          >
            {isSaving ? 'Saving...' : isNew ? `Create ${noun}` : 'Save'}
          </button>
        </div>
      )}

      {showDeleteConfirm && command && (
        <ConfirmModal
          title={`Delete ${noun}`}
          message={`Delete ${nounLower} "/${command.name}"? This will remove the ${nounLower} file.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  )
}
