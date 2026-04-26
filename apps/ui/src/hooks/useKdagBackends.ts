import { useState, useEffect } from 'preact/hooks'
import { getKdagBackends } from '../lib/api'
import type { KdagBackend } from '../types'

// Module-level cache so multiple components/pages share the same result
let cachedBackends: KdagBackend[] | null = null
let fetchPromise: Promise<KdagBackend[]> | null = null

export function useKdagBackends() {
  const [backends, setBackends] = useState<KdagBackend[]>(cachedBackends || [])
  const [isLoading, setIsLoading] = useState(!cachedBackends)

  useEffect(() => {
    if (cachedBackends) {
      setBackends(cachedBackends)
      setIsLoading(false)
      return
    }

    if (!fetchPromise) {
      fetchPromise = getKdagBackends()
        .then(data => {
          cachedBackends = data.backends
          return data.backends
        })
        .catch(() => {
          // Fallback: assume claude is available
          const fallback: KdagBackend[] = [
            { key: 'claude-code', name: 'Claude Code', available: true, models: [] },
          ]
          cachedBackends = fallback
          return fallback
        })
        .finally(() => {
          fetchPromise = null
        })
    }

    fetchPromise.then(result => {
      setBackends(result)
      setIsLoading(false)
    })
  }, [])

  return { backends, isLoading }
}
