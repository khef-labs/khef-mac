import { useEffect, useState, useRef, useCallback } from 'preact/hooks'
import {
  checkEmbedHealth,
  listEmbedJobs,
  cancelEmbedJob,
  deleteEmbedJob,
  getKvecCollection,
} from '../../lib/api'
import type { KvecCollection, EmbedHealth, EmbedJob } from '../../types'

interface UseEmbedJobsOptions {
  collectionName: string
  isEmbedTabActive: boolean
  onCollectionRefresh: (collection: KvecCollection) => void
}

export function useEmbedJobs({ collectionName, isEmbedTabActive, onCollectionRefresh }: UseEmbedJobsOptions) {
  const [embedHealth, setEmbedHealth] = useState<EmbedHealth | null>(null)
  const [activeJobs, setActiveJobs] = useState<EmbedJob[]>([])
  const [jobHistory, setJobHistory] = useState<EmbedJob[]>([])
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Check health and load jobs when embed tab opens
  useEffect(() => {
    if (!isEmbedTabActive) return
    checkEmbedHealth().then(setEmbedHealth).catch(() => setEmbedHealth({ available: false }))
    listEmbedJobs().then((data) => {
      const active = data.jobs.filter((j) => j.status === 'running' || j.status === 'queued')
      setActiveJobs(active)
      setJobHistory(data.jobs.filter((j) => j.status !== 'running' && j.status !== 'queued'))
    }).catch(() => {})
  }, [isEmbedTabActive])

  // Poll active jobs every 2s
  useEffect(() => {
    if (activeJobs.length === 0) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    pollRef.current = setInterval(() => {
      listEmbedJobs().then((data) => {
        const active = data.jobs.filter((j) => j.status === 'running' || j.status === 'queued')
        const finished = data.jobs.filter((j) => j.status !== 'running' && j.status !== 'queued')
        setActiveJobs(active)
        setJobHistory(finished)
        // Refresh collection stats if something just finished
        if (active.length < activeJobs.length) {
          getKvecCollection(collectionName).then((d) => onCollectionRefresh(d.collection)).catch(() => {})
        }
      }).catch(() => {})
    }, 2000)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [activeJobs.length, collectionName])

  const handleJobStarted = useCallback((job: EmbedJob) => {
    setActiveJobs((prev) => [...prev, job])
  }, [])

  const handleCancelJob = useCallback(async (jobId: string) => {
    try {
      const data = await cancelEmbedJob(jobId)
      if (data.job.status === 'cancelled') {
        setActiveJobs((prev) => prev.filter((j) => j.id !== jobId))
        setJobHistory((prev) => [data.job, ...prev])
      }
    } catch {
      setError('Failed to cancel job')
    }
  }, [])

  const handleDeleteJob = useCallback(async (jobId: string) => {
    try {
      await deleteEmbedJob(jobId)
      setJobHistory((prev) => prev.filter((j) => j.id !== jobId))
    } catch {
      setError('Failed to delete job')
    }
  }, [])

  const handleError = useCallback((message: string) => {
    setError(message)
  }, [])

  const refreshJobs = useCallback(() => {
    listEmbedJobs().then((data) => {
      const active = data.jobs.filter((j) => j.status === 'running' || j.status === 'queued')
      setActiveJobs(active)
      setJobHistory(data.jobs.filter((j) => j.status !== 'running' && j.status !== 'queued'))
    }).catch(() => {})
  }, [])

  return {
    embedHealth,
    activeJobs,
    jobHistory,
    error,
    setError,
    handleJobStarted,
    handleCancelJob,
    handleDeleteJob,
    handleError,
    refreshJobs,
  }
}
