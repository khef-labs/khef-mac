import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import type { Commit } from '../types'
import { getCommits, getUncommittedDiff } from '../lib/api'

interface UseCommitsOptions {
  projectId: string
  limit?: number
  targetSha?: string | null
}

export function useCommits({ projectId, limit = 50, targetSha }: UseCommitsOptions) {
  const [commits, setCommits] = useState<Commit[]>([])
  const [branch, setBranch] = useState<string>('')
  const [hasUncommitted, setHasUncommitted] = useState(false)
  const [uncommittedChecked, setUncommittedChecked] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const offsetRef = useRef(0)

  // Ref to track mounted state
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const fetchCommits = useCallback(async (reset = false) => {
    if (!projectId) return

    if (reset) {
      offsetRef.current = 0
      setUncommittedChecked(false)
    }

    setIsLoading(true)
    setError(null)

    try {
      const res = await getCommits(projectId, {
        limit,
        offset: offsetRef.current,
      })

      if (mountedRef.current) {
        if (reset) {
          setCommits(res.commits || [])
        } else {
          setCommits((prev) => [...prev, ...(res.commits || [])])
        }
        setBranch(res.branch || '')
        setHasMore(res.pagination?.has_more ?? false)
        offsetRef.current += res.commits?.length || 0

        // Check for uncommitted changes on initial load
        if (reset && res.branch) {
          try {
            const uncommitted = await getUncommittedDiff(projectId, res.branch)
            if (mountedRef.current) {
              setHasUncommitted(uncommitted.hasChanges)
              setUncommittedChecked(true)
            }
          } catch {
            // Ignore errors checking for uncommitted changes
            if (mountedRef.current) {
              setUncommittedChecked(true)
            }
          }
        } else if (reset) {
          // No branch, mark as checked
          setUncommittedChecked(true)
        }
      }
    } catch (err: any) {
      if (mountedRef.current) {
        setError(err.message || 'Failed to fetch commits')
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [projectId, limit])

  // Load on mount / projectId change
  useEffect(() => {
    fetchCommits(true)
  }, [fetchCommits])

  // Auto-load more batches until the target SHA is visible
  useEffect(() => {
    if (!targetSha || isLoading || !hasMore) return
    const found = commits.some((c) => c.sha === targetSha)
    if (!found) {
      fetchCommits(false)
    }
  }, [targetSha, commits, isLoading, hasMore, fetchCommits])

  const loadMore = useCallback(() => {
    if (!isLoading && hasMore) {
      fetchCommits(false)
    }
  }, [fetchCommits, isLoading, hasMore])

  const refresh = useCallback(() => {
    fetchCommits(true)
  }, [fetchCommits])

  return {
    commits,
    branch,
    hasUncommitted,
    uncommittedChecked,
    isLoading,
    error,
    hasMore,
    loadMore,
    refresh,
  }
}
