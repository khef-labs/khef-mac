import { useEffect, useState, useCallback } from 'preact/hooks'
import { loadSettings, saveSettings, invalidateSettingsCache, getSettingsMetadata, type Settings } from '../../lib/settings'
import type { SettingsMetadata } from '../../lib/api'

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [metadata, setMetadata] = useState<Record<string, SettingsMetadata> | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    invalidateSettingsCache()
    loadSettings()
      .then((s) => {
        setSettings(s)
        setMetadata(getSettingsMetadata())
      })
      .catch((err) => {
        setError('Failed to load settings')
        console.error(err)
      })
      .finally(() => setLoading(false))
  }, [])

  const save = useCallback(async (partial: Partial<Settings>) => {
    setSaving(true)
    setError(null)
    setSuccess(false)
    try {
      const updated = await saveSettings(partial)
      setSettings(updated)
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
      return updated
    } catch (err: any) {
      setError(err.message || 'Failed to save settings')
      return null
    } finally {
      setSaving(false)
    }
  }, [])

  const getDescription = useCallback((key: string): string | null => {
    return metadata?.[key]?.description ?? null
  }, [metadata])

  const clearMessages = useCallback(() => {
    setError(null)
    setSuccess(false)
  }, [])

  return {
    settings,
    setSettings,
    metadata,
    loading,
    saving,
    error,
    setError,
    success,
    setSuccess,
    save,
    getDescription,
    clearMessages,
  }
}
