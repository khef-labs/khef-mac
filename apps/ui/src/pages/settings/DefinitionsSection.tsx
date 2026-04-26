import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { Eye, EyeOff } from 'lucide-preact'
import { useSettings } from './useSettings'
import { listJobDefinitions } from '../../lib/api'
import type { JobDefinitionSummary } from '../../types'
import styles from './SettingsShared.module.css'

export function DefinitionsSection() {
  const { settings, loading, error, success, save, clearMessages } = useSettings()
  const [definitions, setDefinitions] = useState<JobDefinitionSummary[]>([])
  const [hiddenKeys, setHiddenKeys] = useState<string[]>([])
  const [definitionsLoaded, setDefinitionsLoaded] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    if (settings) {
      setHiddenKeys(settings.kdag.definitions.hidden)
    }
  }, [settings])

  useEffect(() => {
    listJobDefinitions({ limit: 100, includeHidden: true, sort: 'name', order: 'asc' })
      .then(({ definitions }) => setDefinitions(definitions))
      .catch((err) => console.warn('Failed to load definitions:', err))
      .finally(() => setDefinitionsLoaded(true))
  }, [])

  const toggleDefinition = useCallback((key: string) => {
    setHiddenKeys((prev) => {
      const next = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key]
      save({ kdag: { definitions: { hidden: next } } } as any)
      return next
    })
  }, [save])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (settings) setHiddenKeys(settings.kdag.definitions.hidden)
        setSearchQuery('')
        clearMessages()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [settings, clearMessages])

  const sortedFilteredDefinitions = useMemo(() => {
    const q = searchQuery.toLowerCase()
    return definitions.filter((d) => {
      if (!q) return true
      return d.name.toLowerCase().includes(q) || d.key.toLowerCase().includes(q)
    })
  }, [definitions, searchQuery])

  if (loading || !definitionsLoaded) return <div class={styles.description}>Loading...</div>

  return (
    <>
      <p class={styles.description}>
        Hidden definitions are excluded from the Definitions page. Toggle visibility below.
        Changes are saved automatically.
      </p>

      <div class={styles.field}>
        <input
          class={styles.inputWide}
          type="text"
          placeholder="Filter definitions..."
          value={searchQuery}
          onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class={styles.section}>
        {sortedFilteredDefinitions.map((def) => {
          const isHidden = hiddenKeys.includes(def.key)
          return (
            <button
              key={def.id}
              class={styles.toggleRow}
              onClick={() => toggleDefinition(def.key)}
              title={isHidden ? `Show ${def.key}` : `Hide ${def.key}`}
            >
              <span class={styles.toggleIcon} style={{ opacity: isHidden ? 0.4 : 1 }}>
                {isHidden ? <EyeOff size={16} /> : <Eye size={16} />}
              </span>
              <span class={styles.toggleLabel} style={{ opacity: isHidden ? 0.4 : 1 }}>
                {def.name}
              </span>
              <span class={styles.toggleMeta} style={{ opacity: isHidden ? 0.3 : 0.5 }}>
                {def.key}
              </span>
            </button>
          )
        })}
        {sortedFilteredDefinitions.length === 0 && (
          <div class={styles.description}>No definitions match "{searchQuery}"</div>
        )}
      </div>

      {error && <div class={styles.error}>{error}</div>}
      {success && <div class={styles.success}>Settings saved</div>}
    </>
  )
}
