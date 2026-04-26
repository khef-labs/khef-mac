import { useState, useEffect, useCallback } from 'preact/hooks'
import { useLocation, Link } from 'wouter-preact'
import { Pencil, RefreshCw, Repeat, FileText, ChevronRight, RotateCcw, Camera, Trash2, BookOpen } from 'lucide-preact'
import clsx from 'clsx'
import { getAssistantConfig, updateAssistantConfig, importAssistantConfig, syncProjectRules, getConfigSnapshots, getConfigSnapshot, restoreConfigSnapshot, createConfigSnapshot, deleteConfigSnapshot, deleteAssistantConfig } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import { ConfirmModal, useToast, TabBar } from '../components/ui'
import { CopyButton } from '../components/ui/CopyButton'
import { CodeEditor } from '../components/editor'
import type { EditorLanguage } from '../components/editor'
import type { AssistantConfig, ConfigScope, ConfigSnapshotSummary } from '../types'
import { useDocumentTitle } from '../hooks'
import styles from './ConfigPage.module.css'

interface Props {
  assistantHandle: string
  configId: string
}

export function ConfigPage({ assistantHandle, configId }: Props) {
  const [, setLocation] = useLocation()
  const { showToast } = useToast()

  const [config, setConfig] = useState<AssistantConfig | null>(null)

  useDocumentTitle(config?.type ? `Config - ${config.type}` : 'Config - Loading')

  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Snapshot state (current_snapshot is computed from MAX(snapshot_number), returned from /snapshots endpoint)
  const [snapshots, setSnapshots] = useState<ConfigSnapshotSummary[]>([])
  const [currentSnapshot, setCurrentSnapshot] = useState<number>(0)
  const [selectedSnapshot, setSelectedSnapshot] = useState<number | null>(null)
  const [showSnapshotMenu, setShowSnapshotMenu] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)
  const [isCreatingSnapshot, setIsCreatingSnapshot] = useState(false)
  const [isDeletingSnapshot, setIsDeletingSnapshot] = useState(false)
  const [showDeleteSnapshotConfirm, setShowDeleteSnapshotConfirm] = useState(false)
  const [viewingHistorical, setViewingHistorical] = useState(false)
  const [historicalContent, setHistoricalContent] = useState<string | null>(null)

  const [isSyncingRules, setIsSyncingRules] = useState(false)
  const [syncRulesFlash, setSyncRulesFlash] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [showDeleteConfigConfirm, setShowDeleteConfigConfirm] = useState(false)

  const [isEditing, setIsEditing] = useState(false)
  const [contentMode, setContentMode] = useState<'edit' | 'preview'>('edit')
  const [editContent, setEditContent] = useState('')
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Docs (notes) tab state
  const [activeTab, setActiveTab] = useState<'content' | 'docs'>('content')
  const [isEditingDocs, setIsEditingDocs] = useState(false)
  const [editNotes, setEditNotes] = useState('')
  const [isSavingDocs, setIsSavingDocs] = useState(false)
  const [renderedNotes, setRenderedNotes] = useState('')

  const [renderedContent, setRenderedContent] = useState('')
  const [renderedEditContent, setRenderedEditContent] = useState('')
  const [renderedHistoricalContent, setRenderedHistoricalContent] = useState('')

  // Load data - configId is the config instance ID
  const loadData = useCallback(async (autoImport = true) => {
    setIsLoading(true)
    setError(null)
    try {
      const [baseConfig, snapshotsResponse] = await Promise.all([
        getAssistantConfig(configId),
        getConfigSnapshots(configId),
      ])
      let configInstance = baseConfig
      let latestSnapshot = snapshotsResponse.current_snapshot
      let snapshotList = snapshotsResponse.snapshots

      // Auto-import from disk to ensure we have the latest content
      if (autoImport) {
        try {
          configInstance = await importAssistantConfig(configId)
          // Reload snapshots after import (may have created new snapshot)
          const updated = await getConfigSnapshots(configId)
          latestSnapshot = updated.current_snapshot
          snapshotList = updated.snapshots
        } catch {
          // If import fails, use existing config and snapshots
        }
      }

      setSnapshots(snapshotList)
      setCurrentSnapshot(latestSnapshot)
      setConfig(configInstance)
      setEditContent(configInstance.content)
      setSelectedSnapshot(latestSnapshot)
      setViewingHistorical(false)
      setHistoricalContent(null)
    } catch {
      setError('Failed to load config')
    } finally {
      setIsLoading(false)
    }
  }, [configId])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Render content for main display
  useEffect(() => {
    if (!config) return
    // Only render as markdown for markdown format
    if (config.format === 'markdown') {
      let isActive = true
      renderMarkdown(config.content)
        .then((html) => {
          if (isActive) setRenderedContent(html)
        })
        .catch(() => {
          if (isActive) setRenderedContent(config.content)
        })
      return () => {
        isActive = false
      }
    } else {
      // For JSON/TOML, just use the raw content (will be displayed in pre block)
      setRenderedContent(config.content)
    }
  }, [config?.content, config?.format])

  // Render content for edit preview
  useEffect(() => {
    if (!editContent || contentMode !== 'preview') return
    // Only render as markdown for markdown format
    if (config?.format === 'markdown') {
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
    } else {
      setRenderedEditContent(editContent)
    }
  }, [editContent, contentMode, config?.format])

  // Render notes for docs tab (always markdown)
  useEffect(() => {
    if (!config?.notes) {
      setRenderedNotes('')
      return
    }
    let isActive = true
    renderMarkdown(config.notes)
      .then((html) => {
        if (isActive) setRenderedNotes(html)
      })
      .catch(() => {
        if (isActive) setRenderedNotes(config.notes || '')
      })
    return () => {
      isActive = false
    }
  }, [config?.notes])

  const handleRefresh = async () => {
    if (!config) return
    setIsRefreshing(true)
    try {
      // Import from disk to get latest content
      const updated = await importAssistantConfig(config.id)
      setConfig(updated)
      setEditContent(updated.content)
    } catch (err: any) {
      setError(err.message || 'Failed to refresh')
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleSyncRules = async () => {
    if (!config) return
    setIsSyncingRules(true)
    setSyncRulesFlash(null)
    try {
      const result = await syncProjectRules('user')
      const count = result.rulesCount
      const updated = result.results.filter((r) => r.action !== 'unchanged').length
      setSyncRulesFlash({
        type: 'success',
        message: updated > 0 ? `Synced ${count} rules` : 'Already up to date',
      })
    } catch (err: any) {
      setSyncRulesFlash({ type: 'error', message: err.message || 'Sync failed' })
    } finally {
      setIsSyncingRules(false)
      setTimeout(() => setSyncRulesFlash(null), 3000)
    }
  }

  const getLevelName = (scope: ConfigScope, type: string) => {
    const scopeLabels: Record<ConfigScope, string> = {
      system: 'System',
      global: 'Global',
      project: 'Project',
      local: 'Local',
    }
    const label = type.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    return `${scopeLabels[scope]} ${label}`
  }

  const hasChanges = isEditing && editContent !== (config?.content || '')

  const handleStartEdit = useCallback(() => {
    if (config) {
      setEditContent(config.content)
      setIsEditing(true)
      setContentMode('edit')
      setSaveError(null)
    }
  }, [config])

  const handleCancelEdit = useCallback(() => {
    setEditContent(config?.content || '')
    setIsEditing(false)
    setSaveError(null)
  }, [config])

  const handleSave = useCallback(async () => {
    if (!config) return

    setIsSaving(true)
    setSaveError(null)
    try {
      const updated = await updateAssistantConfig(config.id, { content: editContent })
      setConfig(updated)
      setIsEditing(false)
    } catch (err: any) {
      // On conflict (file modified externally), re-import to update DB hash, then retry
      if (err.response?.status === 409) {
        try {
          await importAssistantConfig(config.id)
          const updated = await updateAssistantConfig(config.id, { content: editContent })
          setConfig(updated)
          setIsEditing(false)
          return
        } catch (retryErr: any) {
          setSaveError(retryErr.message || 'Failed to save after re-import')
          return
        }
      }
      setSaveError(err.message || 'Failed to save')
    } finally {
      setIsSaving(false)
    }
  }, [config, editContent])

  const handleStartEditDocs = useCallback(() => {
    if (config) {
      setEditNotes(config.notes || '')
      setIsEditingDocs(true)
    }
  }, [config])

  const handleCancelEditDocs = useCallback(() => {
    setEditNotes(config?.notes || '')
    setIsEditingDocs(false)
  }, [config])

  const handleSaveDocs = useCallback(async () => {
    if (!config) return
    setIsSavingDocs(true)
    try {
      const updated = await updateAssistantConfig(config.id, { notes: editNotes })
      setConfig(updated)
      setIsEditingDocs(false)
    } catch (err: any) {
      setSaveError(err.message || 'Failed to save notes')
    } finally {
      setIsSavingDocs(false)
    }
  }, [config, editNotes])

  // Handle snapshot selection
  const handleSnapshotSelect = useCallback(async (snapshotNumber: number) => {
    if (!config) return
    setShowSnapshotMenu(false)

    // Current snapshot is from state (computed from MAX(snapshot_number))
    if (snapshotNumber === currentSnapshot) {
      // Current snapshot - reset to current config content
      setSelectedSnapshot(snapshotNumber)
      setViewingHistorical(false)
      setHistoricalContent(null)
      setRenderedHistoricalContent('')
    } else {
      // Historical snapshot - fetch from API
      try {
        const snapshot = await getConfigSnapshot(configId, snapshotNumber)
        setSelectedSnapshot(snapshotNumber)
        setViewingHistorical(true)
        setHistoricalContent(snapshot.content)
        // Render the historical content
        if (config.format === 'markdown') {
          const html = await renderMarkdown(snapshot.content)
          setRenderedHistoricalContent(html)
        } else {
          setRenderedHistoricalContent(snapshot.content)
        }
      } catch (err: any) {
        setError(err.message || 'Failed to load snapshot')
      }
    }
  }, [config, configId, currentSnapshot])

  // Handle snapshot restore
  const handleRestore = useCallback(async () => {
    if (!config || !selectedSnapshot || selectedSnapshot === currentSnapshot) return

    setIsRestoring(true)
    try {
      await restoreConfigSnapshot(configId, selectedSnapshot)
      showToast(`Restored to snapshot ${selectedSnapshot}`)
      // Reload everything
      await loadData(false)
    } catch (err: any) {
      setError(err.message || 'Failed to restore snapshot')
    } finally {
      setIsRestoring(false)
    }
  }, [config, selectedSnapshot, currentSnapshot, configId, loadData, showToast])

  // Handle create snapshot (allowed for readonly configs too - snapshotting doesn't modify the config)
  const handleCreateSnapshot = useCallback(async () => {
    if (!config) return

    setIsCreatingSnapshot(true)
    try {
      const result = await createConfigSnapshot(configId)
      showToast(`Created snapshot ${result.snapshot_number}`)
      // Reload snapshots
      const updated = await getConfigSnapshots(configId)
      setSnapshots(updated.snapshots)
      setCurrentSnapshot(updated.current_snapshot)
      setSelectedSnapshot(updated.current_snapshot)
    } catch (err: any) {
      setError(err.message || 'Failed to create snapshot')
    } finally {
      setIsCreatingSnapshot(false)
    }
  }, [config, configId, showToast])

  // Handle delete snapshot
  const handleDeleteSnapshot = useCallback(async () => {
    if (!config || !selectedSnapshot || selectedSnapshot === currentSnapshot) return

    setIsDeletingSnapshot(true)
    try {
      await deleteConfigSnapshot(configId, selectedSnapshot)
      showToast(`Deleted snapshot ${selectedSnapshot}`)
      // Reload snapshots
      const updated = await getConfigSnapshots(configId)
      setSnapshots(updated.snapshots)
      setCurrentSnapshot(updated.current_snapshot)
      setSelectedSnapshot(updated.current_snapshot)
      setViewingHistorical(false)
      setHistoricalContent(null)
    } catch (err: any) {
      setError(err.message || 'Failed to delete snapshot')
    } finally {
      setIsDeletingSnapshot(false)
      setShowDeleteSnapshotConfirm(false)
    }
  }, [config, selectedSnapshot, currentSnapshot, configId, showToast])

  // Handle delete config
  const handleDeleteConfig = useCallback(async () => {
    try {
      await deleteAssistantConfig(configId)
      setLocation(`/assistants/${assistantHandle}`)
    } catch (err: any) {
      setError(err.message || 'Failed to delete config')
      setShowDeleteConfigConfirm(false)
    }
  }, [configId, assistantHandle, setLocation])

  // Close snapshot menu on outside click
  useEffect(() => {
    if (!showSnapshotMenu) return
    const handleClick = () => setShowSnapshotMenu(false)
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [showSnapshotMenu])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // CMD+E to toggle edit mode (skip for readonly configs)
      if ((event.metaKey || event.ctrlKey) && event.key === 'e') {
        if (config?.readonly) return // Don't intercept for readonly configs
        if (isEditing) return
        event.preventDefault()
        handleStartEdit()
        return
      }

      // Docs editing shortcuts
      if (isEditingDocs) {
        if (event.key === 'Escape') {
          event.preventDefault()
          handleCancelEditDocs()
          return
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 's') {
          if (event.defaultPrevented) return
          event.preventDefault()
          handleSaveDocs()
          return
        }
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
        if (event.defaultPrevented) return
        event.preventDefault()
        handleSave()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isEditing, isEditingDocs, handleSave, handleSaveDocs, handleStartEdit, handleCancelEdit, handleCancelEditDocs, hasChanges])

  if (isLoading) {
    return (
      <div class={styles.page}>
        <div class={styles.loading}>Loading...</div>
      </div>
    )
  }

  if (!config) {
    return (
      <div class={styles.page}>
        <div class={styles.error}>{error || 'Config not found'}</div>
      </div>
    )
  }

  const showRulesSync = config.scope === 'global' && config.type === 'rules'
  const configFormatToLanguage = (format: string): EditorLanguage => {
    switch (format) {
      case 'markdown': return 'markdown'
      case 'json': return 'json'
      case 'toml': return 'yaml' // closest available
      default: return 'plain'
    }
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

  return (
    <div class={styles.page}>
      <div class={styles.header}>

        <div class={styles.titleRow}>
          <h1 class={styles.title} data-testid="config-page--title">{getLevelName(config.scope, config.type)}</h1>
          {config.readonly && <span class={styles.readonlyBadge}>Read-only</span>}
          <span class={styles.formatBadge}>{getFormatLabel(config.format)}</span>
        </div>

        <div class={styles.filePathRow}>
          <span class={styles.filePathLabel}>Path:</span>
          <span class={styles.filePath} data-testid="config-page--file-path">{config.path}</span>
          <CopyButton text={config.path} title="Copy full path" size={13} />
        </div>

        {config.is_import && (
          <div class={styles.titleRow}>
            <span class={styles.importBadge}>Import</span>
          </div>
        )}
      </div>

      {error && <div class={styles.error}>{error}</div>}

      <div class={styles.toolbar} data-testid="config-page--toolbar">
        <div class={styles.toolbarLeft}>
          {snapshots.length > 1 && (
            <div class={styles.snapshotDropdown}>
              <button
                class={clsx(styles.snapshotBtn, viewingHistorical && styles.snapshotOld)}
                onClick={(e) => {
                  e.stopPropagation()
                  setShowSnapshotMenu((prev) => !prev)
                }}
                disabled={isEditing}
                type="button"
              >
                v{selectedSnapshot}
                {viewingHistorical && ' (old)'}
                <ChevronRight size={14} class={clsx(styles.snapshotChevron, showSnapshotMenu && styles.open)} />
              </button>
              {showSnapshotMenu && (
                <div class={styles.snapshotMenu}>
                  {snapshots.map((s) => (
                    <button
                      key={s.snapshot_number}
                      class={clsx(styles.snapshotMenuItem, s.snapshot_number === selectedSnapshot && styles.selected)}
                      onClick={() => handleSnapshotSelect(s.snapshot_number)}
                      type="button"
                    >
                      <span>v{s.snapshot_number}</span>
                      {s.snapshot_number === currentSnapshot && <span class={styles.currentBadge}>current</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {viewingHistorical && (
            <>
              <button
                class={styles.restoreButton}
                onClick={handleRestore}
                disabled={isRestoring || isEditing || isDeletingSnapshot}
                title={`Restore snapshot ${selectedSnapshot}`}
                type="button"
              >
                <RotateCcw size={14} />
                {isRestoring ? 'Restoring...' : 'Restore'}
              </button>
              <button
                class={styles.deleteSnapshotButton}
                onClick={() => setShowDeleteSnapshotConfirm(true)}
                disabled={isRestoring || isEditing || isDeletingSnapshot || snapshots.length <= 1}
                title={snapshots.length <= 1 ? 'Cannot delete the only snapshot' : `Delete snapshot ${selectedSnapshot}`}
                type="button"
              >
                <Trash2 size={14} />
              </button>
            </>
          )}
          <button
            class={styles.iconButton}
            onClick={handleRefresh}
            disabled={isRefreshing || isEditing || !config || viewingHistorical}
            title="Refresh from disk"
            type="button"
          >
            <RefreshCw size={16} class={isRefreshing ? styles.spinning : ''} />
          </button>
          <button
            class={styles.iconButton}
            onClick={handleCreateSnapshot}
            disabled={isCreatingSnapshot || isEditing || !config || viewingHistorical}
            title="Create snapshot"
            type="button"
          >
            <Camera size={16} class={isCreatingSnapshot ? styles.spinning : ''} />
          </button>
          {showRulesSync && (
            <button
              class={styles.iconButton}
              onClick={handleSyncRules}
              disabled={isSyncingRules || isEditing || !config}
              title="Sync rules to disk"
              type="button"
            >
              <Repeat size={16} class={isSyncingRules ? styles.spinning : ''} />
            </button>
          )}
          {syncRulesFlash && (
            <span
              class={
                syncRulesFlash.type === 'success' ? styles.flashSuccess : styles.flashError
              }
            >
              {syncRulesFlash.message}
            </span>
          )}
          {config && config.is_import && (
            <button
              class={clsx(styles.iconButton, styles.deleteConfigButton)}
              onClick={() => setShowDeleteConfigConfirm(true)}
              disabled={isEditing}
              title="Delete config"
              type="button"
            >
              <Trash2 size={16} />
            </button>
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
            <button
              class={styles.editIconButton}
              onClick={handleStartEdit}
              title={config?.readonly ? 'Read-only' : viewingHistorical ? 'Restore to edit' : 'Edit (⌘E)'}
              type="button"
              disabled={!config || config.readonly || viewingHistorical}
              data-testid="config-page--edit-button"
            >
              <Pencil size={16} />
            </button>
          )}
        </div>
      </div>

      {saveError && <div class={styles.saveError}>{saveError}</div>}

      <TabBar
        tabs={[
          { key: 'content', label: 'Content', icon: FileText, disabled: isEditingDocs },
          { key: 'docs', label: 'Docs', icon: BookOpen, disabled: isEditing },
        ]}
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'content' | 'docs')}
      />

      {activeTab === 'docs' ? (
        <div class={clsx(styles.contentWrapper, isEditingDocs && styles.contentEditing)}>
          {isEditingDocs ? (
            <>
              <textarea
                class={styles.contentTextarea}
                value={editNotes}
                onInput={(e) => setEditNotes((e.target as HTMLTextAreaElement).value)}
                spellcheck={false}
                placeholder="Write documentation in markdown..."
              />
              <div class={styles.actionButtons}>
                <button
                  class={styles.cancelButton}
                  onClick={handleCancelEditDocs}
                  disabled={isSavingDocs}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  class={styles.saveButton}
                  onClick={handleSaveDocs}
                  disabled={isSavingDocs || editNotes === (config?.notes || '')}
                  type="button"
                >
                  {isSavingDocs ? 'Saving...' : 'Save'}
                </button>
              </div>
            </>
          ) : config.notes ? (
            <div class={styles.docsContent}>
              <div
                class={styles.contentMarkdown}
                dangerouslySetInnerHTML={{ __html: renderedNotes }}
              />
              <button
                class={styles.docsEditButton}
                onClick={handleStartEditDocs}
                type="button"
              >
                <Pencil size={14} />
                Edit
              </button>
            </div>
          ) : (
            <div class={styles.docsEmpty}>
              <BookOpen size={32} />
              <p>No documentation yet</p>
              <button
                class={styles.docsAddButton}
                onClick={handleStartEditDocs}
                type="button"
              >
                Add documentation
              </button>
            </div>
          )}
        </div>
      ) : (
      <>
      <div class={clsx(styles.contentWrapper, isEditing && styles.contentEditing)}>
        {isEditing && contentMode === 'edit' ? (
          <div class={styles.contentEditor} data-testid="config-page--content-textarea">
            <CodeEditor
              value={editContent}
              onChange={setEditContent}
              language={configFormatToLanguage(config.format)}
              onSave={handleSave}
              autoFocus
            />
          </div>
        ) : isEditing && contentMode === 'preview' ? (
          config.format === 'markdown' ? (
            <div
              class={styles.contentMarkdown}
              dangerouslySetInnerHTML={{ __html: renderedEditContent }}
            />
          ) : (
            <pre class={styles.contentCode}>
              <code>{renderedEditContent}</code>
            </pre>
          )
        ) : !config ? (
          <div class={styles.emptyContent}>
            No content yet. This config file hasn't been imported.
          </div>
        ) : viewingHistorical ? (
          config.format === 'markdown' ? (
            <div
              class={styles.contentMarkdown}
              dangerouslySetInnerHTML={{ __html: renderedHistoricalContent }}
            />
          ) : (
            <pre class={styles.contentCode}>
              <code>{historicalContent}</code>
            </pre>
          )
        ) : config.format === 'markdown' ? (
          <div
            class={styles.contentMarkdown}
            dangerouslySetInnerHTML={{ __html: renderedContent }}
            data-testid="config-page--content-markdown"
          />
        ) : (
          <pre class={styles.contentCode} data-testid="config-page--content-code">
            <code>{renderedContent}</code>
          </pre>
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
            data-testid="config-page--cancel-button"
          >
            Cancel
          </button>
          <button
            class={styles.saveButton}
            onClick={handleSave}
            disabled={isSaving || !hasChanges}
            type="button"
            data-testid="config-page--save-button"
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      )}
      </>
      )}

      {config.imports && config.imports.length > 0 && activeTab === 'content' && (
        <div class={styles.importsSection}>
          <h3 class={styles.importsSectionTitle}>Imported Files</h3>
          <div class={styles.importsList}>
            {config.imports.map((imp) => (
              <Link
                key={imp.id}
                href={`/assistants/${assistantHandle}/configs/${imp.id}?from=${encodeURIComponent(`/assistants/${assistantHandle}/configs/${config.id}`)}`}
                class={styles.importLink}
              >
                <FileText size={14} />
                <span class={styles.importLinkName}>{imp.path.split('/').pop()}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {showDiscardConfirm && (
        <ConfirmModal
          title="Discard Changes"
          message="Discard your unsaved config changes?"
          confirmLabel="Discard"
          variant="danger"
          onConfirm={() => {
            setShowDiscardConfirm(false)
            handleCancelEdit()
          }}
          onCancel={() => setShowDiscardConfirm(false)}
        />
      )}

      {showDeleteSnapshotConfirm && (
        <ConfirmModal
          title="Delete Snapshot"
          message={`Delete snapshot ${selectedSnapshot}? This cannot be undone.`}
          confirmLabel={isDeletingSnapshot ? 'Deleting...' : 'Delete'}
          variant="danger"
          onConfirm={handleDeleteSnapshot}
          onCancel={() => setShowDeleteSnapshotConfirm(false)}
        />
      )}

      {showDeleteConfigConfirm && config && (
        <ConfirmModal
          title="Delete Config"
          message={`Delete "${config.path.split('/').pop()}" from tracked configs? The file on disk will not be removed.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDeleteConfig}
          onCancel={() => setShowDeleteConfigConfirm(false)}
        />
      )}

    </div>
  )
}
