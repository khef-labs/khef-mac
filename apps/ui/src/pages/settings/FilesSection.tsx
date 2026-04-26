import { useState, useEffect, useCallback } from 'preact/hooks'
import { useSettings } from './useSettings'
import { migrateFiles } from '../../lib/api'
import styles from './SettingsShared.module.css'

export function FilesSection() {
  const { settings, loading, saving, error, setError, success, save, getDescription, clearMessages } = useSettings()
  const [filesStoragePath, setFilesStoragePath] = useState('')
  const [filesMaxSizeMb, setFilesMaxSizeMb] = useState('')
  const [showMigrateModal, setShowMigrateModal] = useState(false)

  useEffect(() => {
    if (settings) {
      setFilesStoragePath(settings.files.storagePath)
      setFilesMaxSizeMb(String(settings.files.maxSizeMb))
    }
  }, [settings])

  const executeSave = useCallback(async (shouldMigrate: boolean) => {
    const trimmedPath = filesStoragePath.trim()
    const maxSizeMb = parseInt(filesMaxSizeMb, 10)

    if (!trimmedPath) { setError('Storage path cannot be empty'); return }
    if (isNaN(maxSizeMb) || maxSizeMb < 1 || maxSizeMb > 10240) {
      setError('Max file size must be a number between 1 and 10240 MB'); return
    }

    const result = await save({ files: { storagePath: trimmedPath, maxSizeMb } })
    if (!result) return

    if (shouldMigrate) {
      try {
        const migResult = await migrateFiles(trimmedPath)
        if (migResult.failed > 0) {
          setError(`Moved ${migResult.moved} files, ${migResult.failed} failed: ${migResult.errors.join(', ')}`)
        }
      } catch (err: any) {
        setError(err.message || 'Migration failed')
      }
    }
  }, [filesStoragePath, filesMaxSizeMb, save, setError])

  const handleSave = useCallback(async () => {
    const pathChanged = settings && filesStoragePath.trim() !== settings.files.storagePath
    if (pathChanged) {
      setShowMigrateModal(true)
      return
    }
    await executeSave(false)
  }, [settings, filesStoragePath, executeSave])

  const handleMigrateChoice = async (choice: 'keep' | 'move' | 'cancel') => {
    setShowMigrateModal(false)
    if (choice === 'cancel') return
    await executeSave(choice === 'move')
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (settings) {
          setFilesStoragePath(settings.files.storagePath)
          setFilesMaxSizeMb(String(settings.files.maxSizeMb))
        }
        clearMessages()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSave, settings, clearMessages])

  const hasChanges = settings
    ? filesStoragePath !== settings.files.storagePath ||
      filesMaxSizeMb !== String(settings.files.maxSizeMb)
    : false

  if (loading) return <div class={styles.description}>Loading...</div>

  return (
    <>
      <div class={styles.section}>
        <div class={styles.field}>
          <label class={styles.label} htmlFor="filesStoragePath">Storage Path</label>
          <input
            id="filesStoragePath"
            class={styles.inputWide}
            type="text"
            value={filesStoragePath}
            onInput={(e) => setFilesStoragePath((e.target as HTMLInputElement).value)}
          />
          {getDescription('files.storagePath') && (
            <p class={styles.description}>{getDescription('files.storagePath')}</p>
          )}
        </div>
        <div class={styles.field}>
          <label class={styles.label} htmlFor="filesMaxSizeMb">Max File Size (MB)</label>
          <input
            id="filesMaxSizeMb"
            class={styles.input}
            type="number"
            min="1"
            max="10240"
            step="1"
            value={filesMaxSizeMb}
            onInput={(e) => setFilesMaxSizeMb((e.target as HTMLInputElement).value)}
          />
          {getDescription('files.maxSizeMb') && (
            <p class={styles.description}>{getDescription('files.maxSizeMb')}</p>
          )}
        </div>
      </div>

      {error && <div class={styles.error}>{error}</div>}
      {success && <div class={styles.success}>Settings saved successfully</div>}

      {hasChanges && (
        <div class={styles.actions}>
          <button class={styles.saveButton} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          <span class={styles.shortcutHint}>⌘S</span>
        </div>
      )}

      {showMigrateModal && (
        <div class={styles.modalOverlay} onClick={() => handleMigrateChoice('cancel')}>
          <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 class={styles.modalTitle}>Storage Path Changed</h2>
            <p class={styles.modalText}>
              Would you like to move existing files to the new location?
            </p>
            <div class={styles.modalActions}>
              <button class={styles.modalButtonSecondary} onClick={() => handleMigrateChoice('cancel')}>
                Cancel
              </button>
              <button class={styles.modalButtonSecondary} onClick={() => handleMigrateChoice('keep')}>
                Keep
              </button>
              <button class={styles.modalButtonPrimary} onClick={() => handleMigrateChoice('move')}>
                Move
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
