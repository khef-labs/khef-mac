import { useState, useEffect, useCallback } from 'preact/hooks'
import { useSettings } from './useSettings'
import styles from './SettingsShared.module.css'

export function LayoutSection() {
  const { settings, loading, saving, error, success, save, getDescription, clearMessages } = useSettings()
  const [pageWidth, setPageWidth] = useState('')
  const [boardMaxWidth, setBoardMaxWidth] = useState('')

  useEffect(() => {
    if (settings) {
      setPageWidth(String(settings.layout.pageWidth))
      setBoardMaxWidth(String(settings.layout.boardMaxWidth))
    }
  }, [settings])

  const handleSave = useCallback(async () => {
    const pw = parseInt(pageWidth, 10)
    const bw = parseInt(boardMaxWidth, 10)
    if (isNaN(pw) || pw < 400 || pw > 2000) return
    if (isNaN(bw) || bw < 600 || bw > 3000) return
    await save({ layout: { pageWidth: pw, boardMaxWidth: bw } })
  }, [pageWidth, boardMaxWidth, save])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (settings) {
          setPageWidth(String(settings.layout.pageWidth))
          setBoardMaxWidth(String(settings.layout.boardMaxWidth))
        }
        clearMessages()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSave, settings, clearMessages])

  const hasChanges = settings
    ? pageWidth !== String(settings.layout.pageWidth) || boardMaxWidth !== String(settings.layout.boardMaxWidth)
    : false

  if (loading) return <div class={styles.description}>Loading...</div>

  return (
    <>
      <div class={styles.section}>
        <div class={styles.field}>
          <label class={styles.label} htmlFor="pageWidth">
            Page Width (pixels)
          </label>
          <input
            id="pageWidth"
            class={styles.input}
            type="number"
            min="400"
            max="2000"
            step="50"
            value={pageWidth}
            onInput={(e) => setPageWidth((e.target as HTMLInputElement).value)}
          />
          {getDescription('layout.pageWidth') && (
            <p class={styles.description}>{getDescription('layout.pageWidth')}</p>
          )}
        </div>
        <div class={styles.field}>
          <label class={styles.label} htmlFor="boardMaxWidth">
            Board View Width (pixels)
          </label>
          <input
            id="boardMaxWidth"
            class={styles.input}
            type="number"
            min="600"
            max="3000"
            step="100"
            value={boardMaxWidth}
            onInput={(e) => setBoardMaxWidth((e.target as HTMLInputElement).value)}
          />
          {getDescription('layout.boardMaxWidth') && (
            <p class={styles.description}>{getDescription('layout.boardMaxWidth')}</p>
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
