import type { EmbedJob } from '../../types'

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return formatDate(iso)
}

export function estimateEta(job: EmbedJob): string | null {
  if (!job.startedAt || job.progress.totalFiles === 0) return null
  const done = job.progress.filesProcessed + job.progress.filesSkipped + job.progress.filesErrored
  // Wait until 10% done (or at least 5 files) so the rate stabilizes past startup overhead
  if (done < Math.max(5, Math.ceil(job.progress.totalFiles * 0.1))) return null
  const elapsed = (Date.now() - new Date(job.startedAt).getTime()) / 1000
  const rate = done / elapsed
  const remaining = (job.progress.totalFiles - done) / rate
  if (remaining < 1) return '< 1s'
  if (remaining < 60) return `~${Math.round(remaining)}s`
  const mins = Math.floor(remaining / 60)
  const secs = Math.round(remaining % 60)
  return `~${mins}m ${secs}s`
}
