import { useState, useEffect, useCallback } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { Pencil, RefreshCw, Trash2, Plus, X, Bot, Terminal, ScrollText, FileText, Save, Copy, Check, Download } from 'lucide-preact'
import clsx from 'clsx'
import {
  getPrompt,
  createPrompt,
  updatePrompt,
  deletePrompt,
  getPromptSnapshots,
  getPromptSnapshot,
  getPromptSnapshotDiff,
  createPromptSnapshot,
  deletePromptSnapshot,
  getPromptSyncStatus,
  syncPrompt,
  addPromptAssistant,
  removePromptAssistant,
} from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import { SnapshotDiffViewer } from '../components/diff'
import { ConfirmModal, CopyButton, useToast } from '../components/ui'
import { CodeEditor } from '../components/editor'
import { PageHeader } from '../components/layout'
import { useDocumentTitle } from '../hooks'
import { useKdagBackends } from '../hooks/useKdagBackends'
import type { Prompt, PromptSnapshot, PromptSnapshotDiffResponse, PromptSyncStatus, PromptType } from '../types'
import styles from './PromptPage.module.css'

interface Props {
  id?: string
  isNew?: boolean
}

function getPromptTypeIcon(type: PromptType) {
  switch (type) {
    case 'agent':
      return <Bot size={14} />
    case 'command':
      return <Terminal size={14} />
    case 'prompt':
      return <ScrollText size={14} />
    default:
      return <FileText size={14} />
  }
}

function getPromptTypeLabel(type: PromptType) {
  switch (type) {
    case 'agent':
      return 'Agent'
    case 'command':
      return 'Command'
    case 'prompt':
      return 'Prompt'
    default:
      return type
  }
}

export function PromptPage({ id, isNew }: Props) {
  const [, setLocation] = useLocation()
  const { showToast } = useToast()
  const { backends } = useKdagBackends()

  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [isLoading, setIsLoading] = useState(!isNew)
  const [error, setError] = useState<string | null>(null)

  const [isEditing, setIsEditing] = useState(isNew || false)
  const [contentMode, setContentMode] = useState<'edit' | 'preview'>('edit')
  const [editContent, setEditContent] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editHandle, setEditHandle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showDeleteSnapshotConfirm, setShowDeleteSnapshotConfirm] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [renderedContent, setRenderedContent] = useState('')
  const [renderedEditContent, setRenderedEditContent] = useState('')

  // Snapshots
  const [snapshots, setSnapshots] = useState<PromptSnapshot[]>([])
  const [viewingSnapshotNum, setViewingSnapshotNum] = useState<number | null>(null)
  const [snapshotContent, setSnapshotContent] = useState<string | null>(null)
  const [isLoadingSnapshot, setIsLoadingSnapshot] = useState(false)
  const [isCreatingSnapshot, setIsCreatingSnapshot] = useState(false)
  const [isDeletingSnapshot, setIsDeletingSnapshot] = useState(false)
  const [showSnapshotDiff, setShowSnapshotDiff] = useState(false)
  const [snapshotDiffData, setSnapshotDiffData] = useState<PromptSnapshotDiffResponse | null>(null)
  const [isLoadingDiff, setIsLoadingDiff] = useState(false)

  // Sync status
  const [syncStatus, setSyncStatus] = useState<PromptSyncStatus[]>([])
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [syncConflict, setSyncConflict] = useState<{ path: string; assistant: string } | null>(null)

  // Add assistant
  const [showAddAssistant, setShowAddAssistant] = useState(false)
  const [newAssistantHandle, setNewAssistantHandle] = useState('claude-code')
  const [newPromptType, setNewPromptType] = useState<PromptType>('agent')
  const [newSourcePath, setNewSourcePath] = useState('')
  const [isAddingAssistant, setIsAddingAssistant] = useState(false)

  const currentSnapshotNumber = snapshots.length > 0 ? Math.max(...snapshots.map((s) => s.snapshot_number)) + 1 : (prompt?.current_snapshot ?? 1)
  const isViewingHistoricalSnapshot = viewingSnapshotNum !== null && viewingSnapshotNum < currentSnapshotNumber
  useDocumentTitle(
    isNew ? 'Prompt - New' : prompt?.title ? `Prompt - ${prompt.title}` : 'Prompt - Loading',
  )

  // Load prompt
  const loadPrompt = useCallback(async () => {
    if (!id || isNew) return
    setIsLoading(true)
    setError(null)
    try {
      const data = await getPrompt(id)
      setPrompt(data)
      setEditContent(data.content)
      setEditTitle(data.title)
      setEditHandle(data.handle)
      setEditDescription(data.description || '')

      // Load sync status
      const status = await getPromptSyncStatus(id)
      setSyncStatus(status.status)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load prompt')
    } finally {
      setIsLoading(false)
    }
  }, [id, isNew])

  useEffect(() => {
    loadPrompt()
  }, [loadPrompt])

  // Load snapshots
  useEffect(() => {
    if (!id || isNew) return
    getPromptSnapshots(id)
      .then((res) => setSnapshots(res.snapshots))
      .catch(() => setSnapshots([]))
  }, [id, isNew])

  useEffect(() => {
    if (!id || !isViewingHistoricalSnapshot || viewingSnapshotNum === null) {
      setSnapshotDiffData(null)
      setIsLoadingDiff(false)
      return
    }

    let isActive = true
    setIsLoadingDiff(true)
    getPromptSnapshotDiff(id, viewingSnapshotNum, 'current')
      .then((diff) => {
        if (isActive) setSnapshotDiffData(diff)
      })
      .catch(() => {
        if (isActive) setSnapshotDiffData(null)
      })
      .finally(() => {
        if (isActive) setIsLoadingDiff(false)
      })

    return () => {
      isActive = false
    }
  }, [id, isViewingHistoricalSnapshot, viewingSnapshotNum])

  // Render content
  useEffect(() => {
    if (!prompt) return
    let isActive = true
    const contentToRender = snapshotContent || prompt.content
    renderMarkdown(contentToRender)
      .then((html) => {
        if (isActive) setRenderedContent(html)
      })
      .catch(() => {
        if (isActive) setRenderedContent(contentToRender)
      })
    return () => {
      isActive = false
    }
  }, [prompt?.content, snapshotContent])

  // Render edit preview
  useEffect(() => {
    if (!editContent || contentMode !== 'preview') return
    let isActive = true
    renderMarkdown(editContent)
      .then((html) => {
        if (isActive) setRenderedEditContent(html)
      })
      .catch(() => {
        if (isActive) setRenderedEditContent(editContent)
      })
    return () => {
      isActive = false
    }
  }, [editContent, contentMode])

  const handleRefresh = async () => {
    if (!id) return
    setIsRefreshing(true)
    try {
      await loadPrompt()
      showToast('Refreshed')
    } catch (err: any) {
      setError(err.message || 'Failed to refresh')
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleSync = async (force = false) => {
    if (!id) return
    setSyncConflict(null)
    try {
      const result = await syncPrompt(id, force)
      if (result.conflicts.length > 0 && !force) {
        setSyncConflict({
          path: result.conflicts[0].path,
          assistant: result.conflicts[0].assistant,
        })
      } else {
        showToast(`Synced to ${result.synced.length} file(s)`)
        // Refresh sync status
        const status = await getPromptSyncStatus(id)
        setSyncStatus(status.status)
      }
    } catch (err: any) {
      if (err.response?.status === 409) {
        const body = await err.response.json()
        if (body.conflicts?.length > 0) {
          setSyncConflict({
            path: body.conflicts[0].path,
            assistant: body.conflicts[0].assistant,
          })
        } else {
          setError('Sync conflict detected')
        }
      } else {
        setError(err.message || 'Sync failed')
      }
    }
  }

  const hasChanges =
    isEditing &&
    (editContent !== (prompt?.content || '') ||
      editTitle !== (prompt?.title || '') ||
      editDescription !== (prompt?.description || ''))

  const handleStartEdit = useCallback(() => {
    if (prompt) {
      setEditContent(prompt.content)
      setEditTitle(prompt.title)
      setEditHandle(prompt.handle)
      setEditDescription(prompt.description || '')
      setIsEditing(true)
      setContentMode('edit')
      setSaveError(null)
      setViewingSnapshotNum(null)
      setSnapshotContent(null)
      setShowSnapshotDiff(false)
      setSnapshotDiffData(null)
    }
  }, [prompt])

  const handleCancelEdit = useCallback(() => {
    if (isNew) {
      setLocation('/prompts')
      return
    }
    setEditContent(prompt?.content || '')
    setEditTitle(prompt?.title || '')
    setEditDescription(prompt?.description || '')
    setIsEditing(false)
    setSaveError(null)
  }, [prompt, isNew, setLocation])

  const handleSave = useCallback(async () => {
    if (isNew) {
      // Create new prompt
      if (!editHandle || !editTitle || !editContent) {
        setSaveError('Handle, title, and content are required')
        return
      }

      setIsSaving(true)
      setSaveError(null)
      try {
        const created = await createPrompt({
          handle: editHandle,
          title: editTitle,
          content: editContent,
          description: editDescription || undefined,
        })
        showToast('Prompt created')
        setLocation(`/prompts/${created.id}`)
      } catch (err: any) {
        setSaveError(err.message || 'Failed to create prompt')
      } finally {
        setIsSaving(false)
      }
      return
    }

    if (!id) return

    setIsSaving(true)
    setSaveError(null)
    try {
      const updated = await updatePrompt(id, {
        title: editTitle,
        content: editContent,
        description: editDescription || undefined,
      })
      setPrompt((p) => (p ? { ...p, ...updated } : updated))
      setIsEditing(false)
      showToast('Saved')

      const snapshotRes = await getPromptSnapshots(id)
      setSnapshots(snapshotRes.snapshots)

      // Refresh sync status
      const status = await getPromptSyncStatus(id)
      setSyncStatus(status.status)
    } catch (err: any) {
      if (err.response?.status === 409) {
        const body = await err.response.json()
        if (body.conflicts?.length > 0) {
          setSyncConflict({
            path: body.conflicts[0].path,
            assistant: body.conflicts[0].assistant,
          })
        }
        setSaveError('Sync conflict - file was modified externally')
      } else {
        setSaveError(err.message || 'Failed to save')
      }
    } finally {
      setIsSaving(false)
    }
  }, [id, isNew, editHandle, editTitle, editContent, editDescription, setLocation, showToast])

  const handleDelete = async () => {
    if (!id) return
    try {
      await deletePrompt(id)
      showToast('Prompt deleted')
      setLocation('/prompts')
    } catch (err: any) {
      setError(err.message || 'Failed to delete')
    } finally {
      setShowDeleteConfirm(false)
    }
  }

  const handleAddAssistant = async () => {
    if (!id) return
    setIsAddingAssistant(true)
    try {
      await addPromptAssistant(id, {
        assistant_handle: newAssistantHandle,
        prompt_type: newPromptType,
        source_path: newSourcePath || undefined,
      })
      showToast('Assistant added')
      await loadPrompt()
      setShowAddAssistant(false)
      setNewSourcePath('')
    } catch (err: any) {
      setError(err.message || 'Failed to add assistant')
    } finally {
      setIsAddingAssistant(false)
    }
  }

  const handleRemoveAssistant = async (assistantHandle: string) => {
    if (!id) return
    try {
      await removePromptAssistant(id, assistantHandle)
      showToast('Assistant removed')
      await loadPrompt()
    } catch (err: any) {
      setError(err.message || 'Failed to remove assistant')
    }
  }

  const handleSnapshotChange = async (snapshotNum: number | null) => {
    if (snapshotNum === null) {
      // Back to current
      setViewingSnapshotNum(null)
      setSnapshotContent(null)
      setShowSnapshotDiff(false)
      return
    }

    // Check if this is the "current" version (highest snapshot number or no snapshots)
    const currentNum = currentSnapshotNumber
    if (snapshotNum >= currentNum) {
      setViewingSnapshotNum(null)
      setSnapshotContent(null)
      setShowSnapshotDiff(false)
      return
    }

    setIsLoadingSnapshot(true)
    try {
      const full = await getPromptSnapshot(id!, snapshotNum)
      setViewingSnapshotNum(snapshotNum)
      setSnapshotContent(full.content ?? null)
      setShowSnapshotDiff(true)
    } catch (err) {
      setError('Failed to load snapshot')
    } finally {
      setIsLoadingSnapshot(false)
    }
  }

  const handleCreateSnapshot = async () => {
    if (!id) return
    setIsCreatingSnapshot(true)
    try {
      await createPromptSnapshot(id)
      showToast('Snapshot created')
      // Refresh snapshots list
      const res = await getPromptSnapshots(id)
      setSnapshots(res.snapshots)
    } catch (err: any) {
      setError(err.message || 'Failed to create snapshot')
    } finally {
      setIsCreatingSnapshot(false)
    }
  }

  const handleDeleteSnapshot = async () => {
    if (!id || viewingSnapshotNum === null) return
    setIsDeletingSnapshot(true)
    try {
      const deletedSnapshotNum = viewingSnapshotNum
      await deletePromptSnapshot(id, deletedSnapshotNum)
      setViewingSnapshotNum(null)
      setSnapshotContent(null)
      setShowSnapshotDiff(false)
      setSnapshotDiffData(null)
      setShowDeleteSnapshotConfirm(false)
      const res = await getPromptSnapshots(id)
      setSnapshots(res.snapshots)
      showToast(`Deleted snapshot #${deletedSnapshotNum}`)
    } catch (err: any) {
      setError(err.message || 'Failed to delete snapshot')
    } finally {
      setIsDeletingSnapshot(false)
    }
  }

  // Copy/export
  const [copiedContent, setCopiedContent] = useState(false)

  const copyContent = async () => {
    if (!prompt) return
    const content = snapshotContent || prompt.content
    try {
      await navigator.clipboard.writeText(content)
      setCopiedContent(true)
      setTimeout(() => setCopiedContent(false), 2000)
    } catch (err) {
      console.error('Failed to copy content:', err)
    }
  }

  const handleExportMarkdown = () => {
    if (!prompt) return
    const content = snapshotContent || prompt.content
    const blob = new Blob([content], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${prompt.handle}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'e') {
        if (isEditing || isNew) return
        event.preventDefault()
        handleStartEdit()
        return
      }

      if (!isEditing) return

      if (event.key === 'Escape') {
        event.preventDefault()
        if (hasChanges) {
          setShowDiscardConfirm(true)
        } else {
          handleCancelEdit()
        }
      } else if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        // Skip if the CodeEditor (or another inner handler) already handled ⌘S.
        // Prevents double-save / double-snapshot when the editor is focused.
        if (event.defaultPrevented) return
        event.preventDefault()
        handleSave()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isEditing, isNew, hasChanges, handleSave, handleStartEdit, handleCancelEdit])

  if (isLoading) {
    return (
      <div class={styles.page}>
        <div class={styles.loading}>Loading...</div>
      </div>
    )
  }

  if (!isNew && !prompt) {
    return (
      <div class={styles.page}>
        <div class={styles.error}>{error || 'Prompt not found'}</div>
      </div>
    )
  }

  // New prompt form - cleaner layout
  if (isNew) {
    return (
      <div class={styles.page}>
        <PageHeader
          title="New Prompt"
          breadcrumbs={[{ label: 'Prompts', href: '/prompts' }]}
        />

        {error && <div class={styles.error}>{error}</div>}
        {saveError && <div class={styles.saveError}>{saveError}</div>}

        <div class={styles.newPromptForm}>
          <div class={styles.formSection}>
            <label class={styles.formLabel}>Title</label>
            <input
              type="text"
              class={styles.formInput}
              value={editTitle}
              onInput={(e) => setEditTitle((e.target as HTMLInputElement).value)}
              placeholder="My Prompt"
              autoFocus
            />
          </div>

          <div class={styles.formSection}>
            <label class={styles.formLabel}>Handle</label>
            <input
              type="text"
              class={styles.formInputMono}
              value={editHandle}
              onInput={(e) => setEditHandle((e.target as HTMLInputElement).value)}
              placeholder="my-prompt"
            />
          </div>

          <div class={styles.formSection}>
            <label class={styles.formLabel}>Description <span class={styles.optional}>(optional)</span></label>
            <input
              type="text"
              class={styles.formInput}
              value={editDescription}
              onInput={(e) => setEditDescription((e.target as HTMLInputElement).value)}
              placeholder="Brief description of this prompt"
            />
          </div>

          <div class={styles.formSection}>
            <div class={styles.contentLabelRow}>
              <label class={styles.formLabel}>Content</label>
              <div class={styles.modeToggle} role="group" aria-label="Content view">
                <button
                  class={clsx(
                    styles.toggleButton,
                    contentMode === 'edit' && styles.toggleButtonActive
                  )}
                  onClick={() => setContentMode('edit')}
                  type="button"
                >
                  Edit
                </button>
                <button
                  class={clsx(
                    styles.toggleButton,
                    contentMode === 'preview' && styles.toggleButtonActive
                  )}
                  onClick={() => setContentMode('preview')}
                  type="button"
                >
                  Preview
                </button>
              </div>
            </div>
            <div class={styles.contentWrapper}>
              {contentMode === 'edit' ? (
                <div class={styles.contentEditor}>
                  <CodeEditor
                    value={editContent}
                    onChange={setEditContent}
                    language="markdown"
                    onSave={handleSave}
                    placeholder="Enter prompt content..."
                    autoFocus
                  />
                </div>
              ) : (
                <div
                  class={styles.contentMarkdown}
                  dangerouslySetInnerHTML={{ __html: renderedEditContent || '<p class="placeholder">Nothing to preview</p>' }}
                />
              )}
            </div>
          </div>

          <div class={styles.formActions}>
            <button
              class={styles.cancelButton}
              onClick={() => setLocation('/prompts')}
              disabled={isSaving}
              type="button"
            >
              Cancel
            </button>
            <button
              class={styles.saveButton}
              onClick={handleSave}
              disabled={isSaving || !editHandle || !editTitle || !editContent}
              type="button"
            >
              {isSaving ? 'Creating...' : 'Create Prompt'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div class={styles.page}>
      <div class={styles.header}>
        <PageHeader
          title={prompt?.title || ''}
          breadcrumbs={[{ label: 'Prompts', href: '/prompts' }]}
          hideTitle
        />

        <div class={styles.titleRow}>
          {isEditing ? (
            <input
              type="text"
              class={styles.titleInput}
              value={editTitle}
              onInput={(e) => setEditTitle((e.target as HTMLInputElement).value)}
              placeholder="Prompt title"
            />
          ) : (
            <h1 class={styles.title}>{prompt?.title}</h1>
          )}
        </div>

        <div class={styles.handleRow}>
          <span class={styles.handle}>{prompt?.handle}</span>
          <CopyButton text={prompt?.id || ''} title="Copy ID" size={12} />
        </div>

        <div class={styles.descriptionRow}>
          {isEditing ? (
            <input
              type="text"
              class={styles.descriptionInput}
              value={editDescription}
              onInput={(e) => setEditDescription((e.target as HTMLInputElement).value)}
              placeholder="Brief description (optional)"
            />
          ) : prompt?.description ? (
            <p class={styles.description}>{prompt.description}</p>
          ) : null}
        </div>
      </div>

      {error && <div class={styles.error}>{error}</div>}

      <div class={styles.toolbar}>
        <div class={styles.toolbarLeft}>
          <button
            class={styles.iconButton}
            onClick={handleRefresh}
            disabled={isRefreshing || isEditing}
            title="Refresh"
            type="button"
          >
            <RefreshCw size={16} class={clsx(isRefreshing && styles.spinning)} />
          </button>
          {snapshots.length > 0 && (
            <select
              class={styles.snapshotSelect}
              value={viewingSnapshotNum ?? 'current'}
              onChange={(e) => {
                const val = (e.target as HTMLSelectElement).value
                handleSnapshotChange(val === 'current' ? null : parseInt(val, 10))
              }}
              disabled={isLoadingSnapshot || isEditing}
            >
              <option value="current">#{currentSnapshotNumber} current</option>
              {snapshots.map((s) => (
                <option key={s.id} value={s.snapshot_number}>
                  #{s.snapshot_number} - {s.source}
                </option>
              ))}
            </select>
          )}
        </div>

        <div class={styles.toolbarRight}>
          {isEditing ? (
            <div class={styles.editControls}>
              <div class={styles.modeToggle} role="group" aria-label="Content view">
                <button
                  class={clsx(
                    styles.toggleButton,
                    contentMode === 'edit' && styles.toggleButtonActive
                  )}
                  onClick={() => setContentMode('edit')}
                  type="button"
                >
                  Edit
                </button>
                <button
                  class={clsx(
                    styles.toggleButton,
                    contentMode === 'preview' && styles.toggleButtonActive
                  )}
                  onClick={() => setContentMode('preview')}
                  type="button"
                >
                  Preview
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                class={styles.editIconButton}
                onClick={handleStartEdit}
                title="Edit (Cmd+E)"
                type="button"
              >
                <Pencil size={16} />
              </button>
              <button
                class={styles.iconButton}
                onClick={copyContent}
                title="Copy content to clipboard"
                type="button"
              >
                {copiedContent ? <Check size={16} /> : <Copy size={16} />}
              </button>
              <button
                class={styles.iconButton}
                onClick={handleExportMarkdown}
                title="Export as Markdown"
                type="button"
              >
                <Download size={16} />
              </button>
              <button
                class={styles.iconButton}
                onClick={handleCreateSnapshot}
                disabled={isCreatingSnapshot}
                title="Save snapshot"
                type="button"
              >
                <Save size={16} />
              </button>
              <button
                class={styles.deleteIconButton}
                onClick={() => setShowDeleteConfirm(true)}
                title="Delete prompt"
                type="button"
              >
                <Trash2 size={16} />
              </button>
            </>
          )}
        </div>
      </div>

      {saveError && <div class={styles.saveError}>{saveError}</div>}

      {isViewingHistoricalSnapshot && viewingSnapshotNum !== null && (
        <div class={styles.snapshotBanner}>
          <span>
            Viewing snapshot #{viewingSnapshotNum} (read-only).
            {' '}
            <button
              class={styles.snapshotBannerLink}
              onClick={() => handleSnapshotChange(null)}
              type="button"
            >
              Return to current
            </button>
            {' · '}
            <button
              class={clsx(styles.snapshotBannerLink, showSnapshotDiff && styles.snapshotBannerLinkActive)}
              onClick={() => setShowSnapshotDiff((value) => !value)}
              type="button"
            >
              {showSnapshotDiff ? 'Hide diff' : 'Show diff vs current'}
            </button>
            {' · '}
            <button
              class={clsx(styles.snapshotBannerLink, styles.snapshotDeleteLink)}
              onClick={() => setShowDeleteSnapshotConfirm(true)}
              disabled={isDeletingSnapshot}
              type="button"
            >
              Delete snapshot
            </button>
          </span>
        </div>
      )}

      {isViewingHistoricalSnapshot && showSnapshotDiff && viewingSnapshotNum !== null && (
        <div class={styles.section}>
          <div class={styles.sectionHeader}>
            <h3 class={styles.sectionTitle}>Diff</h3>
          </div>
          <SnapshotDiffViewer
            changes={snapshotDiffData?.changes ?? []}
            stats={snapshotDiffData?.stats ?? { additions: 0, deletions: 0, unchanged: 0 }}
            isLoading={isLoadingDiff}
            fromLabel={`#${viewingSnapshotNum}`}
            toLabel={`#${currentSnapshotNumber} (current)`}
          />
        </div>
      )}

      <div class={clsx(styles.contentWrapper, isEditing && styles.contentEditing)}>
        {isEditing && contentMode === 'edit' ? (
          <div class={styles.contentEditor}>
            <CodeEditor
              value={editContent}
              onChange={setEditContent}
              language="markdown"
              onSave={handleSave}
              placeholder="Enter prompt content..."
              autoFocus
            />
          </div>
        ) : isEditing && contentMode === 'preview' ? (
          <div
            class={styles.contentMarkdown}
            dangerouslySetInnerHTML={{ __html: renderedEditContent }}
          />
        ) : (
          <div
            class={styles.contentMarkdown}
            dangerouslySetInnerHTML={{ __html: renderedContent }}
          />
        )}
      </div>

      {isEditing && (
        <div class={styles.actionButtons}>
          <button
            class={styles.cancelButton}
            onClick={() => {
              if (hasChanges) {
                setShowDiscardConfirm(true)
              } else {
                handleCancelEdit()
              }
            }}
            disabled={isSaving}
            type="button"
          >
            Cancel
          </button>
          <button
            class={styles.saveButton}
            onClick={handleSave}
            disabled={isSaving || !hasChanges}
            type="button"
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      )}

      {/* Assistants section */}
      {!isNew && prompt && (
        <div class={styles.section}>
          <div class={styles.sectionHeader}>
            <h3 class={styles.sectionTitle}>Assistants</h3>
            <button
              class={styles.addAssistantButton}
              onClick={() => setShowAddAssistant(!showAddAssistant)}
              title="Add assistant"
              type="button"
            >
              <Plus size={14} />
            </button>
          </div>

          {showAddAssistant && (
            <div class={styles.addAssistantForm}>
              <div class={styles.formRow}>
                <label class={styles.formLabel}>Assistant</label>
                <select
                  class={styles.formSelect}
                  value={newAssistantHandle}
                  onChange={(e) => setNewAssistantHandle((e.target as HTMLSelectElement).value)}
                >
                  {backends.map(b => (
                    <option key={b.key} value={b.key}>{b.name}</option>
                  ))}
                </select>
              </div>
              <div class={styles.formRow}>
                <label class={styles.formLabel}>Type</label>
                <select
                  class={styles.formSelect}
                  value={newPromptType}
                  onChange={(e) => setNewPromptType((e.target as HTMLSelectElement).value as PromptType)}
                >
                  <option value="agent">Agent</option>
                  <option value="command">Command</option>
                  <option value="prompt">Prompt</option>
                </select>
              </div>
              <div class={styles.formRow}>
                <label class={styles.formLabel}>Source Path (optional)</label>
                <input
                  type="text"
                  class={styles.formInput}
                  value={newSourcePath}
                  onInput={(e) => setNewSourcePath((e.target as HTMLInputElement).value)}
                  placeholder="~/.claude/agents/my-agent.md"
                />
              </div>
              <div class={styles.formActions}>
                <button
                  class={styles.cancelButton}
                  onClick={() => setShowAddAssistant(false)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  class={styles.saveButton}
                  onClick={handleAddAssistant}
                  disabled={isAddingAssistant}
                  type="button"
                >
                  {isAddingAssistant ? 'Adding...' : 'Add'}
                </button>
              </div>
            </div>
          )}

          {prompt.assistants.length === 0 ? (
            <div class={styles.emptyAssistants}>
              <p>No assistants associated with this prompt.</p>
              <p class={styles.hint}>Universal prompts work with any assistant.</p>
            </div>
          ) : (
            <div class={styles.assistantsList}>
              {prompt.assistants.map((a) => {
                const status = syncStatus.find((s) => s.assistant === a.assistant_handle)
                return (
                  <div key={`${a.assistant_handle}-${a.prompt_type}`} class={styles.assistantCard}>
                    <div class={styles.assistantInfo}>
                      {getPromptTypeIcon(a.prompt_type)}
                      <span class={styles.assistantName}>{a.assistant_handle}</span>
                      <span class={styles.typeBadge}>{getPromptTypeLabel(a.prompt_type)}</span>
                      {status && (
                        <span
                          class={clsx(
                            styles.syncBadge,
                            status.status === 'synced' && styles.syncBadgeSynced,
                            status.status === 'modified_externally' && styles.syncBadgeModified,
                            status.status === 'missing' && styles.syncBadgeMissing
                          )}
                        >
                          {status.status === 'synced' && 'Synced'}
                          {status.status === 'modified_externally' && 'Modified'}
                          {status.status === 'missing' && 'Missing'}
                        </span>
                      )}
                    </div>
                    {a.source_path && (
                      <div class={styles.assistantPath}>
                        <code>{a.source_path}</code>
                        <CopyButton text={a.source_path!} title="Copy path" size={12} />
                      </div>
                    )}
                    <button
                      class={styles.removeAssistantButton}
                      onClick={() => handleRemoveAssistant(a.assistant_handle)}
                      title="Remove association"
                      type="button"
                    >
                      <X size={14} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {showDiscardConfirm && (
        <ConfirmModal
          title="Discard Changes"
          message="Discard your unsaved changes?"
          confirmLabel="Discard"
          variant="danger"
          onConfirm={() => {
            setShowDiscardConfirm(false)
            handleCancelEdit()
          }}
          onCancel={() => setShowDiscardConfirm(false)}
        />
      )}

      {showDeleteConfirm && (
        <ConfirmModal
          title="Delete Prompt"
          message={`Delete "${prompt?.title}"? This cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {showDeleteSnapshotConfirm && (
        <ConfirmModal
          title="Delete Snapshot"
          message={viewingSnapshotNum !== null ? `Delete snapshot #${viewingSnapshotNum}? This cannot be undone.` : 'Delete this snapshot?'}
          confirmLabel={isDeletingSnapshot ? 'Deleting...' : 'Delete'}
          variant="danger"
          onConfirm={handleDeleteSnapshot}
          onCancel={() => setShowDeleteSnapshotConfirm(false)}
        />
      )}

      {syncConflict && (
        <ConfirmModal
          title="Sync Conflict"
          message={`The file "${syncConflict.path}" was modified externally. Force overwrite?`}
          confirmLabel="Force Sync"
          variant="danger"
          onConfirm={() => {
            setSyncConflict(null)
            handleSync(true)
          }}
          onCancel={() => setSyncConflict(null)}
        />
      )}
    </div>
  )
}
