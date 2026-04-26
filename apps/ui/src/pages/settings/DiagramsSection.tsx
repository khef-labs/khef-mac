import { useState, useEffect, useCallback } from 'preact/hooks'
import { useSettings } from './useSettings'
import styles from './SettingsShared.module.css'

export function DiagramsSection() {
  const { settings, loading, saving, error, success, save, getDescription, clearMessages } = useSettings()
  const [diagramMaxWidth, setDiagramMaxWidth] = useState('')

  useEffect(() => {
    if (settings) setDiagramMaxWidth(String(settings.diagram.defaultMaxWidth))
  }, [settings])

  const handleSave = useCallback(async () => {
    const value = parseInt(diagramMaxWidth, 10)
    if (isNaN(value) || value < 200 || value > 2000) return
    await save({ diagram: { defaultMaxWidth: value } })
  }, [diagramMaxWidth, save])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (settings) setDiagramMaxWidth(String(settings.diagram.defaultMaxWidth))
        clearMessages()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSave, settings, clearMessages])

  const hasChanges = settings ? diagramMaxWidth !== String(settings.diagram.defaultMaxWidth) : false

  if (loading) return <div class={styles.description}>Loading...</div>

  return (
    <>
      <div class={styles.section}>
        <div class={styles.field}>
          <label class={styles.label} htmlFor="diagramMaxWidth">
            Default Max Width (pixels)
          </label>
          <input
            id="diagramMaxWidth"
            class={styles.input}
            type="number"
            min="200"
            max="2000"
            step="50"
            value={diagramMaxWidth}
            onInput={(e) => setDiagramMaxWidth((e.target as HTMLInputElement).value)}
          />
          {getDescription('diagram.defaultMaxWidth') && (
            <p class={styles.description}>{getDescription('diagram.defaultMaxWidth')}</p>
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
