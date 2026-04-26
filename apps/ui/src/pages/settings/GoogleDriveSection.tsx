import { useState, useEffect, useCallback } from 'preact/hooks'
import { useSettings } from './useSettings'
import styles from './SettingsShared.module.css'

export function GoogleDriveSection() {
  const { settings, loading, saving, error, success, save, clearMessages } = useSettings()
  const [driveSyncFolder, setDriveSyncFolder] = useState('')

  useEffect(() => {
    if (settings) setDriveSyncFolder(settings.drive.syncFolder)
  }, [settings])

  const handleSave = useCallback(async () => {
    await save({ drive: { syncFolder: driveSyncFolder.trim() } })
  }, [driveSyncFolder, save])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (settings) setDriveSyncFolder(settings.drive.syncFolder)
        clearMessages()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSave, settings, clearMessages])

  const hasChanges = settings ? driveSyncFolder !== settings.drive.syncFolder : false

  if (loading) return <div class={styles.description}>Loading...</div>

  return (
    <>
      <div class={styles.section}>
        <div class={styles.field}>
          <label class={styles.label} htmlFor="driveSyncFolder">Sync Folder Path</label>
          <input
            id="driveSyncFolder"
            class={styles.inputWide}
            type="text"
            placeholder="/Users/you/Google Drive/My Drive/Khef"
            value={driveSyncFolder}
            onInput={(e) => setDriveSyncFolder((e.target as HTMLInputElement).value)}
          />
          <p class={styles.description}>
            Local path to a Google Drive sync folder. Memories saved to Drive will be exported as
            DOCX files here. Leave empty to disable.
          </p>
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
    </>
  )
}
