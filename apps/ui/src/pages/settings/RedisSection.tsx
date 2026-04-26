import { useState, useEffect, useCallback } from 'preact/hooks'
import { getLiveMessageHealth } from '../../lib/api'
import shared from './SettingsShared.module.css'
import styles from './RuntimeSection.module.css'

interface RedisHealth {
  status: 'ok' | 'unavailable'
  error?: string
}

export function RedisSection() {
  const [health, setHealth] = useState<RedisHealth | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchHealth = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getLiveMessageHealth()
      setHealth(result)
    } catch (err: any) {
      setHealth(null)
      setError(err.message || 'Failed to check Redis health')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchHealth() }, [fetchHealth])

  const isConnected = health?.status === 'ok'

  return (
    <div class={shared.section}>
      <p class={shared.description}>
        Redis provides ephemeral live messaging between active sessions. Messages are stored in-memory with a 24-hour TTL — no database persistence.
      </p>

      <div class={shared.field}>
        <div class={shared.actions}>
          <button
            type="button"
            class={shared.syncButton}
            onClick={fetchHealth}
            disabled={loading}
          >
            {loading ? 'Checking...' : 'Check connection'}
          </button>
        </div>
        {error && <p class={shared.error}>{error}</p>}
      </div>

      <div class={shared.field}>
        <label class={shared.label}>Connection</label>
        <div class={styles.runtimeList}>
          <div class={styles.runtimeItem}>
            <div class={styles.runtimePrimary}>
              <code>redis://localhost:6379</code>
              <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
            </div>
            <div class={styles.runtimeMeta}>
              <span>container: khef-redis</span>
              <span>image: redis:7-alpine</span>
              <span>maxmemory: 64mb</span>
              <span>eviction: allkeys-lru</span>
            </div>
          </div>
        </div>
      </div>

      <div class={shared.field}>
        <label class={shared.label}>Live Messaging</label>
        <div class={styles.runtimeList}>
          <div class={styles.runtimeItem}>
            <div class={styles.runtimePrimary}>
              <span>Status</span>
              <span>{isConnected ? 'Available' : 'Unavailable'}</span>
            </div>
            <div class={styles.runtimeMeta}>
              <span>TTL: 24 hours</span>
              <span>backend: Redis lists</span>
              <span>read mode: destructive (default) or peek</span>
            </div>
          </div>
        </div>
        {health?.error && (
          <p class={shared.error}>{health.error}</p>
        )}
      </div>
    </div>
  )
}
