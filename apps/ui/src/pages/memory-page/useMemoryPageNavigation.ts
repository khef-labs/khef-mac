import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import { getCollection, searchMemories } from '../../lib/api'
import {
  clearNavContext,
  getNavContext,
  getNextMemoryId,
  getPrevMemoryId,
  setNavContext,
  updateNavIndex,
} from '../../lib/navContext'
import type { Memory } from '../../types'

interface CollectionParams {
  collectionId: string
}

interface UseMemoryPageNavigationParams {
  id: string
  memory: Memory | null
  collectionParams: CollectionParams | null
  setLocation: (path: string) => void
}

export function useMemoryPageNavigation({
  id,
  memory,
  collectionParams,
  setLocation,
}: UseMemoryPageNavigationParams) {
  const [collectionName, setCollectionName] = useState<string | null>(null)
  const [navPosition, setNavPosition] = useState<{ current: number; total: number } | null>(null)
  const [hasInitializedFallbackNav, setHasInitializedFallbackNav] = useState(false)

  useEffect(() => {
    const context = getNavContext()
    if (!context) {
      setNavPosition(null)
      return
    }

    const currentIndex = context.ids.indexOf(id)
    if (currentIndex === -1) {
      clearNavContext()
      setNavPosition(null)
      return
    }

    if (currentIndex !== context.currentIndex) {
      updateNavIndex(currentIndex)
    }

    setNavPosition({
      current: currentIndex + 1,
      total: context.ids.length,
    })
  }, [id])

  useEffect(() => {
    if (!memory || hasInitializedFallbackNav) return

    const context = getNavContext()
    if (context && context.ids.includes(id)) {
      setHasInitializedFallbackNav(true)
      return
    }

    // Skip the fallback rebuild after a reload. main.tsx clears navContext
    // on reload to recover from stale state (e.g. wrong sort order); auto-
    // rebuilding here with sort=created_at would just reintroduce the same
    // stale state. Going back to the source list page rebuilds it with the
    // correct sort.
    const navEntry = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined
    if (navEntry?.type === 'reload') {
      setHasInitializedFallbackNav(true)
      return
    }

    const source = memory.project_id ? `/projects/${memory.project_id}` : '/search'

    const loadFallbackNav = async () => {
      try {
        const response = await searchMemories({
          project_id: memory.project_id || undefined,
          sort: 'created_at',
          compact: true,
          limit: 20,
          offset: 0,
        })

        const ids = response.memories.map((item) => item.id)
        if (!ids.includes(memory.id)) {
          ids.unshift(memory.id)
        }

        if (ids.length > 1) {
          setNavContext(ids, memory.id, source)
          setNavPosition({ current: ids.indexOf(memory.id) + 1, total: ids.length })
        }
      } catch {
        // Fallback navigation is best-effort.
      } finally {
        setHasInitializedFallbackNav(true)
      }
    }

    loadFallbackNav()
  }, [memory, id, hasInitializedFallbackNav])

  useEffect(() => {
    if (!collectionParams || !memory) {
      setCollectionName(null)
      return
    }
    let mounted = true
    getCollection(memory.project_id, collectionParams.collectionId)
      .then((res) => {
        if (mounted) setCollectionName(res.collection.name)
      })
      .catch(() => {
        if (mounted) setCollectionName(null)
      })
    return () => {
      mounted = false
    }
  }, [collectionParams?.collectionId, memory?.project_id])

  const collectionQs = useMemo(
    () => (collectionParams ? `?context=collection&contextId=${collectionParams.collectionId}` : ''),
    [collectionParams],
  )

  const navigatePrev = useCallback(() => {
    const prevId = getPrevMemoryId()
    if (prevId) {
      setLocation(`/memories/${prevId}${collectionQs}`)
    }
  }, [setLocation, collectionQs])

  const navigateNext = useCallback(() => {
    const nextId = getNextMemoryId()
    if (nextId) {
      setLocation(`/memories/${nextId}${collectionQs}`)
    }
  }, [setLocation, collectionQs])

  return {
    collectionName,
    navPosition,
    navigateNext,
    navigatePrev,
  }
}
