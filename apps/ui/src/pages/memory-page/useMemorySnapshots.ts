import { useCallback, useEffect, useState } from 'preact/hooks'
import {
  deleteMemorySnapshot,
  getMemory,
  getMemorySnapshot,
  getMemorySnapshotDiff,
  getMemorySnapshots,
  restoreMemorySnapshot,
  updateMemory,
  type MemorySnapshotsResponse,
  type SnapshotDiffResponse,
} from '../../lib/api'
import type { Memory } from '../../types'

interface UseMemorySnapshotsParams {
  memory: Memory | null
  projectId?: string | null
  setError: (value: string | null) => void
  setMemory: (memory: Memory) => void
  setEditContent: (value: string) => void
  showToast: (message: string) => void
}

export function useMemorySnapshots({
  memory,
  projectId,
  setError,
  setMemory,
  setEditContent,
  showToast,
}: UseMemorySnapshotsParams) {
  const [snapshotsData, setSnapshotsData] = useState<MemorySnapshotsResponse | null>(null)
  const [viewingSnapshot, setViewingSnapshot] = useState<number | null>(null)
  const [snapshotContent, setSnapshotContent] = useState<string | null>(null)
  const [snapshotComments, setSnapshotComments] = useState<any[]>([])
  const [isLoadingSnapshot, setIsLoadingSnapshot] = useState(false)
  const [isDeletingSnapshot, setIsDeletingSnapshot] = useState(false)
  const [isRestoringSnapshot, setIsRestoringSnapshot] = useState(false)
  const [isCreatingSnapshot, setIsCreatingSnapshot] = useState(false)
  const [showSnapshotDiff, setShowSnapshotDiff] = useState(false)
  const [snapshotDiffData, setSnapshotDiffData] = useState<SnapshotDiffResponse | null>(null)
  const [isLoadingDiff, setIsLoadingDiff] = useState(false)

  const refreshSnapshots = useCallback(async () => {
    if (!memory) return null
    try {
      const data = await getMemorySnapshots(memory.id)
      setSnapshotsData(data)
      return data
    } catch {
      setSnapshotsData(null)
      return null
    }
  }, [memory])

  useEffect(() => {
    if (!memory) return
    let mounted = true

    const loadVersions = async () => {
      const data = await refreshSnapshots()
      if (mounted) {
        setSnapshotsData(data)
        setViewingSnapshot(null)
        setSnapshotContent(null)
      }
    }

    loadVersions()
    return () => {
      mounted = false
    }
  }, [memory?.id, refreshSnapshots])

  useEffect(() => {
    if (!memory || viewingSnapshot === null) {
      setSnapshotContent(null)
      setSnapshotComments([])
      return
    }

    let mounted = true
    setIsLoadingSnapshot(true)

    const loadSnapshotContent = async () => {
      try {
        const snapshotData = await getMemorySnapshot(memory.id, viewingSnapshot)
        if (mounted) {
          setSnapshotContent(snapshotData.content)
          setSnapshotComments(snapshotData.comments || [])
        }
      } catch (err: any) {
        if (mounted) {
          setError(err.message || 'Failed to load snapshot')
          setViewingSnapshot(null)
        }
      } finally {
        if (mounted) setIsLoadingSnapshot(false)
      }
    }

    loadSnapshotContent()
    return () => {
      mounted = false
    }
  }, [memory?.id, viewingSnapshot, setError])

  useEffect(() => {
    if (!memory || !showSnapshotDiff || viewingSnapshot === null) {
      setSnapshotDiffData(null)
      return
    }

    let mounted = true
    setIsLoadingDiff(true)

    getMemorySnapshotDiff(memory.id, viewingSnapshot, 'current')
      .then((data) => {
        if (mounted) setSnapshotDiffData(data)
      })
      .catch(() => {
        if (mounted) setSnapshotDiffData(null)
      })
      .finally(() => {
        if (mounted) setIsLoadingDiff(false)
      })

    return () => {
      mounted = false
    }
  }, [memory?.id, viewingSnapshot, showSnapshotDiff])

  const handleSnapshotChange = useCallback((version: number | null) => {
    setShowSnapshotDiff(false)
    setSnapshotDiffData(null)
    if (version === snapshotsData?.current_snapshot) {
      setViewingSnapshot(null)
    } else {
      setViewingSnapshot(version)
    }
  }, [snapshotsData?.current_snapshot])

  const handleDeleteSnapshot = useCallback(async () => {
    if (!memory || viewingSnapshot === null) return

    setIsDeletingSnapshot(true)
    setError(null)
    try {
      const result = await deleteMemorySnapshot(memory.id, viewingSnapshot)

      if (result.new_current_snapshot !== undefined) {
        const updated = await getMemory(memory.id, undefined, { comments: true })
        setMemory(updated)
        setEditContent(updated.content)
      }

      const newSnapshots = await refreshSnapshots()
      setSnapshotsData(newSnapshots)
      setViewingSnapshot(null)
      setSnapshotContent(null)
    } catch (err: any) {
      setError(err.message || 'Failed to delete snapshot')
    } finally {
      setIsDeletingSnapshot(false)
    }
  }, [memory, viewingSnapshot, refreshSnapshots, setEditContent, setError, setMemory])

  const handleRestoreSnapshot = useCallback(async (options?: { skipSnapshot?: boolean }) => {
    if (!memory || viewingSnapshot === null) return

    setIsRestoringSnapshot(true)
    setError(null)
    try {
      await restoreMemorySnapshot(memory.id, viewingSnapshot, options?.skipSnapshot ? { skip_snapshot: true } : undefined)

      const [updatedMemory, newSnapshots] = await Promise.all([
        getMemory(memory.id, undefined, { comments: true }),
        refreshSnapshots(),
      ])
      setMemory(updatedMemory)
      setEditContent(updatedMemory.content)
      setSnapshotsData(newSnapshots)
      setViewingSnapshot(null)
      setSnapshotContent(null)
      showToast(`Snapshot #${viewingSnapshot} restored`)
    } catch (err: any) {
      setError(err.message || 'Failed to restore snapshot')
    } finally {
      setIsRestoringSnapshot(false)
    }
  }, [memory, viewingSnapshot, refreshSnapshots, setEditContent, setError, setMemory, showToast])

  const handleCreateSnapshot = useCallback(async () => {
    if (!memory) return
    if (!projectId) {
      setError('Missing project ID')
      return
    }

    setIsCreatingSnapshot(true)
    setError(null)
    try {
      await updateMemory(projectId, memory.id, {}, { snapshot: true })

      const [updatedMemory, newSnapshots] = await Promise.all([
        getMemory(memory.id, projectId),
        refreshSnapshots(),
      ])
      setMemory(updatedMemory)
      setSnapshotsData(newSnapshots)
      showToast(`Snapshot #${(newSnapshots?.current_snapshot ?? 1) - 1} saved`)
    } catch (err: any) {
      setError(err.message || 'Failed to create snapshot')
    } finally {
      setIsCreatingSnapshot(false)
    }
  }, [memory, projectId, refreshSnapshots, setError, setMemory, showToast])

  return {
    handleCreateSnapshot,
    handleDeleteSnapshot,
    handleRestoreSnapshot,
    handleSnapshotChange,
    isCreatingSnapshot,
    isDeletingSnapshot,
    isLoadingDiff,
    isLoadingSnapshot,
    isRestoringSnapshot,
    refreshSnapshots,
    setShowSnapshotDiff,
    showSnapshotDiff,
    snapshotComments,
    snapshotContent,
    snapshotDiffData,
    snapshotsData,
    viewingSnapshot,
  }
}
