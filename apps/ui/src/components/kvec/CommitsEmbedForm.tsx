import { useState, useEffect, useRef } from 'preact/hooks'
import { X, GitFork, Upload, Loader } from 'lucide-preact'
import clsx from 'clsx'
import { startCommitEmbedJob, getEmbedGitInfo } from '../../lib/api'
import { formatTimeAgo } from './kvec-utils'
import type { KvecRepo, EmbedHealth, EmbedJob } from '../../types'
import styles from './EmbedForm.module.css'

interface Props {
  repos: KvecRepo[]
  embedHealth: EmbedHealth | null
  onJobStarted: (job: EmbedJob) => void
  onError: (message: string) => void
  defaultPath?: string
}

export function CommitsEmbedForm({ repos, embedHealth, onJobStarted, onError, defaultPath = '' }: Props) {
  const [embedPath, setEmbedPath] = useState(defaultPath)
  const [embedDelay, setEmbedDelay] = useState(500)
  const [embedStarting, setEmbedStarting] = useState(false)
  const [commitBranch, setCommitBranch] = useState('')
  const [branchFilter, setBranchFilter] = useState('')
  const [localBranches, setLocalBranches] = useState<string[]>([])
  const [remoteBranches, setRemoteBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const branchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fetch branches when path changes (debounced)
  useEffect(() => {
    if (!embedPath.trim()) {
      setLocalBranches([])
      setRemoteBranches([])
      setCommitBranch('')
      return
    }
    if (branchDebounceRef.current) clearTimeout(branchDebounceRef.current)
    branchDebounceRef.current = setTimeout(() => {
      setBranchesLoading(true)
      getEmbedGitInfo(embedPath.trim())
        .then((info) => {
          setLocalBranches(info.localBranches)
          setRemoteBranches(info.remoteBranches)
          if (!commitBranch || !info.localBranches.includes(commitBranch)) {
            setCommitBranch(info.currentBranch)
          }
        })
        .catch(() => {
          setLocalBranches([])
          setRemoteBranches([])
        })
        .finally(() => setBranchesLoading(false))
    }, 400)
    return () => { if (branchDebounceRef.current) clearTimeout(branchDebounceRef.current) }
  }, [embedPath])

  const handleStart = async () => {
    if (!embedPath.trim()) return
    setEmbedStarting(true)
    try {
      const data = await startCommitEmbedJob({
        path: embedPath.trim(),
        branch: commitBranch || undefined,
        batchSize: embedDelay > 0 ? 20 : 0,
        batchDelayMs: embedDelay,
      })
      onJobStarted(data.job)
    } catch (err: any) {
      onError(err?.message || 'Failed to start embed job')
    } finally {
      setEmbedStarting(false)
    }
  }

  const q = branchFilter.toLowerCase()
  const filteredLocal = localBranches.filter((b) => !q || b.toLowerCase().includes(q))
  const filteredRemote = remoteBranches.filter((b) => !q || b.toLowerCase().includes(q))
  const hasBranches = (localBranches.length > 0 || remoteBranches.length > 0)
    && (filteredLocal.length > 0 || filteredRemote.length > 0)

  return (
    <div class={styles.embedForm}>
      <div class={styles.embedFormField}>
        <label>Repository path</label>
        <div class={styles.pathInputWrap}>
          <input
            type="text"
            placeholder="/path/to/git/repo"
            value={embedPath}
            onInput={(e) => setEmbedPath((e.target as HTMLInputElement).value)}
          />
          {embedPath && (
            <button type="button" class={styles.pathClear} title="Clear path" onClick={() => setEmbedPath('')}>
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {repos.length > 0 && (
        <div class={styles.recentPaths}>
          <div class={styles.recentPathsTitle}>Recently indexed</div>
          {[...repos]
            .sort((a, b) => {
              if (!a.last_upload && !b.last_upload) return 0
              if (!a.last_upload) return 1
              if (!b.last_upload) return -1
              return new Date(b.last_upload).getTime() - new Date(a.last_upload).getTime()
            })
            .map((r) => (
              <button
                key={r.id}
                type="button"
                class={clsx(styles.recentPathItem, embedPath === r.root_path && styles.recentPathItemActive)}
                onClick={() => setEmbedPath(r.root_path)}
              >
                <GitFork size={12} class={styles.recentPathIcon} />
                <span class={styles.recentPathName}>{r.name}</span>
                <span class={styles.recentPathMeta}>
                  {r.file_count} {r.file_count === 1 ? 'commit' : 'commits'}
                </span>
                {r.last_upload && (
                  <span class={styles.recentPathMeta}>{formatTimeAgo(r.last_upload)}</span>
                )}
              </button>
            ))}
        </div>
      )}

      <div class={styles.embedFormGrid}>
        <div class={styles.embedFormField}>
          <label>Branch {branchesLoading && <span class={styles.branchLoading}>(detecting...)</span>}</label>
          <div class={styles.branchSelect}>
            <input
              type="text"
              placeholder={commitBranch || 'All branches'}
              value={branchFilter}
              onInput={(e) => setBranchFilter((e.target as HTMLInputElement).value)}
              onFocus={() => setBranchFilter('')}
            />
            {commitBranch && (
              <button
                type="button"
                class={styles.branchClear}
                title="Clear — index all branches"
                onClick={() => { setCommitBranch(''); setBranchFilter('') }}
              >
                <X size={14} />
              </button>
            )}
          </div>
          {hasBranches && (
            <>
              <label>Branches</label>
              <div class={styles.branchList}>
                {filteredLocal.length > 0 && (
                  <>
                    <div class={styles.branchGroupLabel}>Local</div>
                    {filteredLocal.map((b) => (
                      <button
                        key={b}
                        type="button"
                        class={clsx(styles.branchItem, b === commitBranch && styles.branchItemActive)}
                        onClick={() => { setCommitBranch(b); setBranchFilter('') }}
                      >
                        {b}
                      </button>
                    ))}
                  </>
                )}
                {filteredRemote.length > 0 && (
                  <>
                    <div class={styles.branchGroupLabel}>Remote</div>
                    {filteredRemote.map((b) => (
                      <button
                        key={b}
                        type="button"
                        class={clsx(styles.branchItem, b === commitBranch && styles.branchItemActive)}
                        onClick={() => { setCommitBranch(b); setBranchFilter('') }}
                      >
                        {b}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>
        <div class={styles.embedFormField}>
          <label>Pacing <span class={styles.paceValue}>{embedDelay === 0 ? 'Continuous' : `${(embedDelay / 1000).toFixed(1)}s`}</span></label>
          <input
            type="range"
            class={styles.paceSlider}
            min={0}
            max={2000}
            step={100}
            value={embedDelay}
            onInput={(e) => setEmbedDelay(Number((e.target as HTMLInputElement).value))}
          />
          <span class={styles.paceHint}>
            {embedDelay === 0
              ? 'Full speed — no pauses between batches'
              : `Pauses ${(embedDelay / 1000).toFixed(1)}s every 20 commits to ease system load`}
          </span>
        </div>
      </div>

      <div class={styles.embedActions}>
        <button
          type="button"
          class={styles.embedStartButton}
          disabled={!embedPath.trim() || !embedHealth?.available || embedStarting}
          onClick={handleStart}
        >
          {embedStarting ? <Loader size={14} /> : <Upload size={14} />}
          {embedStarting ? 'Starting...' : 'Index Commits'}
        </button>
        <span class={styles.healthLabel}>
          <span class={clsx(styles.healthDot, embedHealth?.available ? styles.healthOnline : styles.healthOffline)} />
          {embedHealth?.available ? `Embed server online (${embedHealth.model})` : 'Embed server offline'}
        </span>
      </div>
    </div>
  )
}
