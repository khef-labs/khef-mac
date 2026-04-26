import { useState, useEffect, useCallback } from 'preact/hooks'
import { useSettings } from './useSettings'
import styles from './SettingsShared.module.css'

export function EditorScratchSection() {
  const { settings, loading, saving, error, success, save, clearMessages } = useSettings()
  const [scratchHome, setScratchHome] = useState('')
  const [drawerEnabled, setDrawerEnabled] = useState(false)

  useEffect(() => {
    if (settings) {
      setScratchHome(settings.editor.scratchHome)
      setDrawerEnabled(settings.editor.scratchDrawer.enabled)
    }
  }, [settings])

  const handleSave = useCallback(async () => {
    await save({
      editor: {
        scratchHome: scratchHome.trim(),
        scratchDrawer: { enabled: drawerEnabled },
      },
    })
  }, [scratchHome, drawerEnabled, save])

  const toggleDrawer = useCallback(async () => {
    const next = !drawerEnabled
    setDrawerEnabled(next)
    await save({
      editor: {
        scratchHome: scratchHome.trim(),
        scratchDrawer: { enabled: next },
      },
    })
  }, [drawerEnabled, scratchHome, save])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (settings) {
          setScratchHome(settings.editor.scratchHome)
          setDrawerEnabled(settings.editor.scratchDrawer.enabled)
        }
        clearMessages()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSave, settings, clearMessages])

  const hasPathChange = settings
    ? scratchHome.trim() !== settings.editor.scratchHome
    : false

  if (loading) return <div class={styles.description}>Loading...</div>

  return (
    <>
      <div class={styles.section}>
        <div class={styles.field}>
          <label class={styles.label} htmlFor="scratchDrawerEnabled">
            Show Scratches Tab
          </label>
          <div class={styles.toggleRow}>
            <button
              id="scratchDrawerEnabled"
              type="button"
              class={`${styles.toggle} ${drawerEnabled ? styles.toggleOn : ''}`}
              onClick={toggleDrawer}
              role="switch"
              aria-checked={drawerEnabled}
              disabled={saving}
            >
              <span class={styles.toggleSlider} />
            </button>
            <span class={styles.toggleLabel}>{drawerEnabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          <p class={styles.description}>
            Adds a Scratches tab (chicken icon) to the Editor sidebar, backed by the scratch home below.
          </p>
        </div>

        <div class={styles.field}>
          <label class={styles.label} htmlFor="scratchHome">Scratch Home</label>
          <input
            id="scratchHome"
            class={styles.inputWide}
            type="text"
            placeholder="(default: <khef-repo>/khef-scratches)"
            value={scratchHome}
            onInput={(e) => setScratchHome((e.target as HTMLInputElement).value)}
          />
          <p class={styles.description}>
            Absolute path where scratch files are stored and listed. Leave empty to default to{' '}
            <code>&lt;khef-repo&gt;/khef-scratches</code> (gitignored). Files saved here survive
            across sessions and show up in the Scratches tab.
          </p>
        </div>
      </div>

      {error && <div class={styles.error}>{error}</div>}
      {success && <div class={styles.success}>Settings saved successfully</div>}

      {hasPathChange && (
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
