import { Loader, Square, Trash2 } from 'lucide-preact'
import type { EmbedJob } from '../../types'
import { estimateEta, formatTimeAgo } from './kvec-utils'
import styles from './KvecEmbedJobList.module.css'

const STATUS_STYLES: Record<string, string> = {
  running: styles.statusRunning,
  queued: styles.statusQueued,
  completed: styles.statusCompleted,
  failed: styles.statusFailed,
  cancelled: styles.statusCancelled,
}

interface Props {
  activeJobs: EmbedJob[]
  jobHistory: EmbedJob[]
  onCancel: (jobId: string) => void
  onDelete: (jobId: string) => void
}

export function KvecEmbedJobList({ activeJobs, jobHistory, onCancel, onDelete }: Props) {
  return (
    <>
      {activeJobs.map((job) => (
        <div key={job.id} class={styles.jobCard}>
          <div class={styles.jobCardHeader}>
            <div class={styles.jobCardTitle}>
              <Loader size={14} />
              {job.status === 'queued' ? 'Queued' : job.jobType === 'commits' ? 'Indexing commits' : 'Embedding in progress'}
            </div>
            <span class={STATUS_STYLES[job.status] || styles.statusBadge}>
              {job.status}
            </span>
          </div>
          <div class={styles.jobPath}>{job.path}</div>
          {job.status === 'running' && job.progress.totalFiles > 0 && (() => {
            const done = job.progress.filesProcessed + job.progress.filesSkipped + job.progress.filesErrored
            const pct = Math.round((done / job.progress.totalFiles) * 100)
            const eta = estimateEta(job)
            return (
              <div class={styles.progressRow}>
                <div class={styles.progressBarTrack}>
                  <div class={styles.progressBarFill} style={{ width: `${pct}%` }} />
                </div>
                <span class={styles.progressMeta}>
                  {pct}%{eta && ` — ${eta} left`}
                </span>
              </div>
            )
          })()}
          {job.status === 'running' && (
            <div class={styles.jobStats}>
              {job.jobType === 'commits' ? (
                <>
                  <span>Indexed: <strong>{job.progress.filesProcessed}</strong></span>
                  <span>Unchanged: <strong>{job.progress.filesSkipped}</strong></span>
                  <span>Errors: <strong>{job.progress.filesErrored}</strong></span>
                  <span>Chunks: <strong>{job.progress.chunksCreated}</strong></span>
                  {job.progress.totalFiles > 0 && (
                    <span>Total commits: <strong>{job.progress.totalFiles}</strong></span>
                  )}
                </>
              ) : (
                <>
                  <span>Processed: <strong>{job.progress.filesProcessed}</strong></span>
                  <span>Skipped: <strong>{job.progress.filesSkipped}</strong></span>
                  <span>Errors: <strong>{job.progress.filesErrored}</strong></span>
                  <span>Chunks: <strong>{job.progress.chunksCreated}</strong></span>
                  {job.progress.totalFiles > 0 && (
                    <span>Total: <strong>{job.progress.totalFiles}</strong></span>
                  )}
                </>
              )}
            </div>
          )}
          <div class={styles.jobMeta}>
            <span>{job.startedAt ? `Started ${formatTimeAgo(job.startedAt)}` : 'Waiting...'}</span>
            <button
              type="button"
              class={styles.cancelButton}
              onClick={() => onCancel(job.id)}
            >
              <Square size={12} />
              Cancel
            </button>
          </div>
        </div>
      ))}

      {jobHistory.length > 0 && (
        <div class={styles.jobHistory}>
          <div class={styles.jobHistoryTitle}>Recent jobs</div>
          {jobHistory.map((job) => (
            <div key={job.id} class={styles.jobCard}>
              <div class={styles.jobCardHeader}>
                <div class={styles.jobPath}>{job.path}</div>
                <span class={STATUS_STYLES[job.status] || styles.statusBadge}>
                  {job.status}
                </span>
              </div>
              <div class={styles.jobStats}>
                {job.jobType === 'commits' ? (
                  <>
                    <span>Indexed: <strong>{job.progress.filesProcessed}</strong></span>
                    <span>Unchanged: <strong>{job.progress.filesSkipped}</strong></span>
                    <span>Errors: <strong>{job.progress.filesErrored}</strong></span>
                    <span>Chunks: <strong>{job.progress.chunksCreated}</strong></span>
                  </>
                ) : (
                  <>
                    <span>Processed: <strong>{job.progress.filesProcessed}</strong></span>
                    <span>Skipped: <strong>{job.progress.filesSkipped}</strong></span>
                    <span>Errors: <strong>{job.progress.filesErrored}</strong></span>
                    <span>Chunks: <strong>{job.progress.chunksCreated}</strong></span>
                  </>
                )}
              </div>
              {job.error && <div class={styles.jobError}>{job.error}</div>}
              <div class={styles.jobMeta}>
                <span>
                  {job.completedAt ? formatTimeAgo(job.completedAt) : job.startedAt ? formatTimeAgo(job.startedAt) : ''}
                </span>
                <button
                  type="button"
                  class={styles.jobDeleteButton}
                  title="Remove from history"
                  onClick={() => onDelete(job.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
