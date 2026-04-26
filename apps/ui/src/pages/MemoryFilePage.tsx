import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import { Link, useLocation } from 'wouter-preact'
import { Trash2, Pencil, Camera, RotateCcw, RefreshCw } from 'lucide-preact'
import clsx from 'clsx'
import { getProject, getMemoryFile, getMemoryFileSnapshots, getMemoryFileSnapshot, createMemoryFileSnapshot, restoreMemoryFileSnapshot, deleteMemoryFileSnapshot, updateMemoryFile, deleteMemoryFile } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import type { Project, MemoryFile, MemoryFileSnapshot } from '../types'
import { ConfirmModal, useToast } from '../components/ui'
import { PageHeader } from '../components/layout'
import styles from './MemoryFilePage.module.css'

interface Props {
  projectId: string
  filename: string
}

export function MemoryFilePage({ projectId, filename }: Props) {
  const [, setLocation] = useLocation()
  const { showToast } = useToast()
  const [project, setProject] = useState<Project | null>(null)
  const [memFile, setMemFile] = useState<MemoryFile | null>(null)
  const [renderedContent, setRenderedContent] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleteMode, setDeleteMode] = useState(false)
  const [snapshots, setSnapshots] = useState<MemoryFileSnapshot[]>([])
  const [selectedSnapshot, setSelectedSnapshot] = useState<number | null>(null)

  // Snapshot action states
  const [isLoadingSnapshot, setIsLoadingSnapshot] = useState(false)
  const [isCreatingSnapshot, setIsCreatingSnapshot] = useState(false)
  const [isRestoringSnapshot, setIsRestoringSnapshot] = useState(false)
  const [isDeletingSnapshot, setIsDeletingSnapshot] = useState(false)
  const [showRestoreSnapshotConfirm, setShowRestoreSnapshotConfirm] = useState(false)
  const [showDeleteSnapshotConfirm, setShowDeleteSnapshotConfirm] = useState(false)

  // Edit state
  const [isEditing, setIsEditing] = useState(false)
  const [contentMode, setContentMode] = useState<'edit' | 'preview'>('edit')
  const [editContent, setEditContent] = useState('')
  const [renderedEditContent, setRenderedEditContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isViewingOldSnapshot = selectedSnapshot !== null && memFile !== null && selectedSnapshot !== memFile.current_snapshot

  useEffect(() => {
    async function load() {
      setIsLoading(true)
      setError(null)
      try {
        const proj = await getProject(projectId)
        setProject(proj)
        const [f, s] = await Promise.all([
          getMemoryFile('claude-code', proj.handle, filename),
          getMemoryFileSnapshots('claude-code', proj.handle, filename),
        ])
        setMemFile(f)
        setSnapshots(s)
        setSelectedSnapshot(f.current_snapshot)
        setEditContent(f.content)
        const html = await renderMarkdown(f.content)
        setRenderedContent(html)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load memory file')
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [projectId, filename])

  // Render edit preview when in preview mode
  useEffect(() => {
    if (!editContent || contentMode !== 'preview' || !isEditing) return
    let isActive = true
    renderMarkdown(editContent)
      .then((html) => {
        if (isActive) setRenderedEditContent(html)
      })
      .catch(() => {
        if (isActive) setRenderedEditContent(editContent)
      })
    return () => { isActive = false }
  }, [editContent, contentMode, isEditing])

  const hasChanges = isEditing && editContent !== (memFile?.content || '')

  const handleStartEdit = useCallback(() => {
    if (memFile) {
      setEditContent(memFile.content)
      setIsEditing(true)
      setContentMode('edit')
      setSaveError(null)
    }
  }, [memFile])

  const handleCancelEdit = useCallback(() => {
    setEditContent(memFile?.content || '')
    setIsEditing(false)
    setSaveError(null)
  }, [memFile])

  const handleSave = useCallback(async () => {
    if (!memFile || !project) return
    setIsSaving(true)
    setSaveError(null)
    try {
      const updated = await updateMemoryFile('claude-code', project.handle, filename, editContent)
      setMemFile(updated)
      setEditContent(updated.content)
      setIsEditing(false)
      // Re-render the displayed content
      const html = await renderMarkdown(updated.content)
      setRenderedContent(html)
      // Refresh snapshots since PUT triggers snapshotting
      const s = await getMemoryFileSnapshots('claude-code', project.handle, filename)
      setSnapshots(s)
      setSelectedSnapshot(updated.current_snapshot)
      showToast('Memory file saved')
    } catch (err: any) {
      setSaveError(err.message || 'Failed to save')
    } finally {
      setIsSaving(false)
    }
  }, [memFile, project, filename, editContent, showToast])

  // Keyboard shortcuts: Cmd+E to edit, Cmd+S to save, Escape to cancel (with dirty check)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'e') {
        if (isEditing || isViewingOldSnapshot) return
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
        event.preventDefault()
        handleSave()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isEditing, handleSave, handleStartEdit, handleCancelEdit, hasChanges, isViewingOldSnapshot])

  const handleRefresh = async () => {
    if (!memFile || !project) return
    setIsLoading(true)
    try {
      const [f, s] = await Promise.all([
        getMemoryFile('claude-code', project.handle, filename),
        getMemoryFileSnapshots('claude-code', project.handle, filename),
      ])
      setMemFile(f)
      setSnapshots(s)
      setSelectedSnapshot(f.current_snapshot)
      setEditContent(f.content)
      const html = await renderMarkdown(f.content)
      setRenderedContent(html)
      showToast('Refreshed from disk')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh')
    } finally {
      setIsLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!memFile || !project) return
    try {
      await deleteMemoryFile('claude-code', project.handle, filename)
      showToast('Memory file deleted')
      setLocation(`/projects/${projectId}/memory-files`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setDeleteMode(false)
    }
  }

  const handleSnapshotChange = async (snapshotNumber: number) => {
    if (!memFile || !project) return

    if (snapshotNumber === memFile.current_snapshot) {
      // Go back to current
      setSelectedSnapshot(snapshotNumber)
      const html = await renderMarkdown(memFile.content)
      setRenderedContent(html)
    } else {
      // Load historical snapshot
      setIsLoadingSnapshot(true)
      try {
        const s = await getMemoryFileSnapshot('claude-code', project.handle, filename, snapshotNumber)
        setSelectedSnapshot(snapshotNumber)
        const html = await renderMarkdown(s.content || '')
        setRenderedContent(html)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load snapshot')
      } finally {
        setIsLoadingSnapshot(false)
      }
    }
  }

  const handleCreateSnapshot = async () => {
    if (!memFile || !project) return
    setIsCreatingSnapshot(true)
    try {
      const result = await createMemoryFileSnapshot('claude-code', project.handle, filename)
      showToast(`Created snapshot #${result.snapshot_number}`)
      // Refresh snapshots
      const s = await getMemoryFileSnapshots('claude-code', project.handle, filename)
      setSnapshots(s)
      setSelectedSnapshot(result.snapshot_number)
      setMemFile({ ...memFile, current_snapshot: result.snapshot_number })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create snapshot')
    } finally {
      setIsCreatingSnapshot(false)
    }
  }

  const handleRestoreSnapshot = async () => {
    if (!memFile || !project || selectedSnapshot === null) return
    setIsRestoringSnapshot(true)
    try {
      const result = await restoreMemoryFileSnapshot('claude-code', project.handle, filename, selectedSnapshot)
      showToast(`Restored snapshot #${result.restored_snapshot}`)
      // Reload everything
      const [f, s] = await Promise.all([
        getMemoryFile('claude-code', project.handle, filename),
        getMemoryFileSnapshots('claude-code', project.handle, filename),
      ])
      setMemFile(f)
      setSnapshots(s)
      setSelectedSnapshot(f.current_snapshot)
      setEditContent(f.content)
      const html = await renderMarkdown(f.content)
      setRenderedContent(html)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore snapshot')
    } finally {
      setIsRestoringSnapshot(false)
      setShowRestoreSnapshotConfirm(false)
    }
  }

  const handleDeleteSnapshot = async () => {
    if (!memFile || !project || selectedSnapshot === null) return
    setIsDeletingSnapshot(true)
    try {
      await deleteMemoryFileSnapshot('claude-code', project.handle, filename, selectedSnapshot)
      showToast(`Deleted snapshot #${selectedSnapshot}`)
      // Refresh snapshots and go back to current
      const s = await getMemoryFileSnapshots('claude-code', project.handle, filename)
      setSnapshots(s)
      setSelectedSnapshot(memFile.current_snapshot)
      const html = await renderMarkdown(memFile.content)
      setRenderedContent(html)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete snapshot')
    } finally {
      setIsDeletingSnapshot(false)
      setShowDeleteSnapshotConfirm(false)
    }
  }

  if (isLoading) {
    return (
      <div class={styles.page}>
        <div class={styles.loading}>Loading memory file...</div>
      </div>
    )
  }

  const backLink = `/projects/${projectId}/memory-files`

  if (error || !memFile) {
    return (
      <div class={styles.page}>
        <div class={styles.error}>{error || 'Memory file not found'}</div>
        <Link href={backLink}>Memory Files</Link>
      </div>
    )
  }

  // File extension for badge
  const ext = memFile.filename.split('.').pop()?.toUpperCase() || 'FILE'

  return (
    <div class={styles.page}>
      <PageHeader
        title={memFile.filename}
        breadcrumbs={[
          { label: 'Projects', href: '/projects' },
          { label: project?.display_name || project?.name || projectId, href: `/projects/${projectId}` },
          { label: 'Memory Files', href: `/projects/${projectId}/memory-files` },
        ]}
      />

      {/* Title with badge */}
      <div class={styles.header}>
        <h1 class={styles.title}>
          {memFile.filename.replace(/\.[^.]+$/, '')}
          <span class={styles.extBadge}>{ext}</span>
        </h1>
        <div class={styles.filePath}>Path: {memFile.file_path}</div>
      </div>

      {/* Toolbar */}
      <div class={styles.toolbar}>
        <div class={styles.toolbarLeft}>
          {/* Snapshot dropdown */}
          <select
            class={clsx(styles.snapshotSelect, isViewingOldSnapshot && styles.snapshotSelectOld)}
            value={selectedSnapshot ?? memFile.current_snapshot}
            onChange={(e) => handleSnapshotChange(parseInt((e.target as HTMLSelectElement).value, 10))}
            disabled={isEditing || isLoadingSnapshot}
          >
            {snapshots.map((s) => (
              <option key={s.snapshot_number} value={s.snapshot_number}>
                v{s.snapshot_number}{s.snapshot_number === memFile.current_snapshot ? '' : ' (old)'}
              </option>
            ))}
          </select>

          {/* Restore button - only when viewing old snapshot */}
          {isViewingOldSnapshot && !isLoadingSnapshot && (
            <button
              class={styles.restoreButton}
              onClick={() => setShowRestoreSnapshotConfirm(true)}
              disabled={isRestoringSnapshot || isDeletingSnapshot}
              title="Restore this snapshot"
            >
              <RotateCcw size={14} />
              Restore
            </button>
          )}

          {/* Delete snapshot button - only when viewing old snapshot */}
          {isViewingOldSnapshot && !isLoadingSnapshot && (
            <button
              class={styles.toolbarIconButton}
              onClick={() => setShowDeleteSnapshotConfirm(true)}
              disabled={isRestoringSnapshot || isDeletingSnapshot || snapshots.length <= 1}
              title={snapshots.length <= 1 ? 'Cannot delete the only snapshot' : 'Delete this snapshot'}
            >
              <Trash2 size={16} />
            </button>
          )}

          {/* Refresh button */}
          <button
            class={styles.toolbarIconButton}
            onClick={handleRefresh}
            disabled={isLoading || isEditing}
            title="Refresh from disk"
          >
            <RefreshCw size={16} class={isLoading ? styles.spinning : ''} />
          </button>

          {/* Create snapshot button */}
          <button
            class={styles.toolbarIconButton}
            onClick={handleCreateSnapshot}
            disabled={isCreatingSnapshot || isViewingOldSnapshot || isEditing}
            title="Create snapshot"
          >
            <Camera size={16} class={isCreatingSnapshot ? styles.spinning : ''} />
          </button>
        </div>

        <div class={styles.toolbarRight}>
          {isEditing ? (
            <div class={styles.editControls}>
              <div class={styles.modeToggle} role="group" aria-label="Content view">
                <button
                  class={clsx(styles.toggleButton, contentMode === 'edit' && styles.toggleButtonActive)}
                  onClick={() => setContentMode('edit')}
                  type="button"
                >
                  Edit
                </button>
                <button
                  class={clsx(styles.toggleButton, contentMode === 'preview' && styles.toggleButtonActive)}
                  onClick={() => setContentMode('preview')}
                  type="button"
                >
                  Preview
                </button>
              </div>
            </div>
          ) : !isViewingOldSnapshot && (
            <button
              class={styles.toolbarIconButton}
              onClick={handleStartEdit}
              title="Edit (⌘E)"
            >
              <Pencil size={16} />
            </button>
          )}
        </div>
      </div>

      {saveError && <div class={styles.saveError}>{saveError}</div>}

      <div class={clsx(styles.contentWrapper, isEditing && styles.contentEditing)}>
        {isEditing && contentMode === 'edit' ? (
          <textarea
            ref={textareaRef}
            class={styles.contentTextarea}
            value={editContent}
            onInput={(e) => setEditContent((e.target as HTMLTextAreaElement).value)}
            spellcheck={false}
          />
        ) : isEditing && contentMode === 'preview' ? (
          <article
            class={styles.contentMarkdown}
            dangerouslySetInnerHTML={{ __html: renderedEditContent }}
          />
        ) : (
          <article
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

      {deleteMode && (
        <ConfirmModal
          title="Delete Memory File"
          message={`Delete "${memFile.filename}"? This cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setDeleteMode(false)}
        />
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

      {showRestoreSnapshotConfirm && selectedSnapshot !== null && (
        <ConfirmModal
          title="Restore Snapshot"
          message={`Restore snapshot #${selectedSnapshot}? This will write the snapshot content to disk.`}
          confirmLabel={isRestoringSnapshot ? 'Restoring...' : 'Restore'}
          onConfirm={handleRestoreSnapshot}
          onCancel={() => setShowRestoreSnapshotConfirm(false)}
        />
      )}

      {showDeleteSnapshotConfirm && selectedSnapshot !== null && (
        <ConfirmModal
          title="Delete Snapshot"
          message={`Delete snapshot #${selectedSnapshot}? This cannot be undone.`}
          confirmLabel={isDeletingSnapshot ? 'Deleting...' : 'Delete'}
          variant="danger"
          onConfirm={handleDeleteSnapshot}
          onCancel={() => setShowDeleteSnapshotConfirm(false)}
        />
      )}
    </div>
  )
}
