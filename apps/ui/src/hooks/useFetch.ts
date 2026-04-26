import { useState, useEffect, useCallback, useRef } from 'preact/hooks'

interface FetchState<T> {
  data: T | undefined
  error: Error | undefined
  isLoading: boolean
  isValidating: boolean
}

interface UseFetchOptions {
  enabled?: boolean
  staleTime?: number
  onSuccess?: <T>(data: T) => void
  onError?: (error: Error) => void
}

const cache = new Map<string, { data: unknown; timestamp: number }>()

export function useFetch<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: UseFetchOptions = {}
): FetchState<T> & { mutate: (data?: T) => void; refetch: () => Promise<void> } {
  const { enabled = true, staleTime = 30000, onSuccess, onError } = options

  const [state, setState] = useState<FetchState<T>>({
    data: undefined,
    error: undefined,
    isLoading: true,
    isValidating: false,
  })

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const fetch = useCallback(async () => {
    if (!key || !enabled) return

    const cached = cache.get(key)
    const now = Date.now()

    // Use cached data if fresh
    if (cached && now - cached.timestamp < staleTime) {
      setState({
        data: cached.data as T,
        error: undefined,
        isLoading: false,
        isValidating: false,
      })
      return
    }

    // Show cached data while revalidating
    if (cached) {
      setState((prev) => ({
        ...prev,
        data: cached.data as T,
        isLoading: false,
        isValidating: true,
      }))
    } else {
      setState((prev) => ({ ...prev, isLoading: true, isValidating: true }))
    }

    try {
      const data = await fetcherRef.current()
      cache.set(key, { data, timestamp: Date.now() })
      setState({
        data,
        error: undefined,
        isLoading: false,
        isValidating: false,
      })
      onSuccess?.(data)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      setState((prev) => ({
        ...prev,
        error,
        isLoading: false,
        isValidating: false,
      }))
      onError?.(error)
    }
  }, [key, enabled, staleTime, onSuccess, onError])

  useEffect(() => {
    fetch()
  }, [fetch])

  const mutate = useCallback(
    (data?: T) => {
      if (!key) return
      if (data !== undefined) {
        cache.set(key, { data, timestamp: Date.now() })
        setState((prev) => ({ ...prev, data }))
      } else {
        cache.delete(key)
        fetch()
      }
    },
    [key, fetch]
  )

  const refetch = useCallback(async () => {
    if (key) cache.delete(key)
    await fetch()
  }, [key, fetch])

  return { ...state, mutate, refetch }
}

// Clear cache entry
export function invalidate(key: string) {
  cache.delete(key)
}

// Clear all cache
export function clearCache() {
  cache.clear()
}
