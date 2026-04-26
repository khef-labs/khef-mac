import { useState, useEffect, useCallback } from 'preact/hooks'
import { useSettings } from './useSettings'
import styles from './SettingsShared.module.css'

export function SlackSection() {
  const { settings, loading, saving, error, success, save, getDescription, clearMessages } = useSettings()
  const [slackExportDir, setSlackExportDir] = useState('')

  useEffect(() => {
    if (settings) setSlackExportDir(settings.slack.exportDir)
  }, [settings])

  const handleSave = useCallback(async () => {
    await save({ slack: { exportDir: slackExportDir.trim() || 'chats' } })
  }, [slackExportDir, save])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (settings) setSlackExportDir(settings.slack.exportDir)
        clearMessages()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSave, settings, clearMessages])

  const hasChanges = settings ? slackExportDir !== settings.slack.exportDir : false

  if (loading) return <div class={styles.description}>Loading...</div>

  return (
    <>
      <div class={styles.section}>
        <div class={styles.field}>
          <label class={styles.label} htmlFor="slackExportDir">Export Directory</label>
          <input
            id="slackExportDir"
            class={styles.inputWide}
            type="text"
            value={slackExportDir}
            placeholder="chats"
            onInput={(e) => setSlackExportDir((e.target as HTMLInputElement).value)}
          />
          {getDescription('slack.exportDir') && (
            <p class={styles.description}>{getDescription('slack.exportDir')}</p>
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
    </>
  )
}
