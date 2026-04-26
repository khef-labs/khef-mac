import { useState, useEffect, useRef } from 'preact/hooks'
import { X, GitFork, GitBranch, Upload, Loader, ChevronDown, Check } from 'lucide-preact'
import clsx from 'clsx'
import { startEmbedJob, getEmbedGitInfo, checkoutEmbedRepo } from '../../lib/api'
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

export function SourceEmbedForm({ repos, embedHealth, onJobStarted, onError, defaultPath = '' }: Props) {
  const [embedPath, setEmbedPath] = useState(defaultPath)
  const [embedExtensions, setEmbedExtensions] = useState('')
  const [embedDelay, setEmbedDelay] = useState(500)
  const [embedStarting, setEmbedStarting] = useState(false)

  // Branch state
  const [currentBranch, setCurrentBranch] = useState('')
  const [localBranches, setLocalBranches] = useState<string[]>([])
  const [remoteBranches, setRemoteBranches] = useState<string[]>([])
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchSwitcherOpen, setBranchSwitcherOpen] = useState(false)
  const [checkoutLoading, setCheckoutLoading] = useState(false)
  const branchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const branchDropdownRef = useRef<HTMLDivElement>(null)

  // Detect branches when path changes
  useEffect(() => {
    if (!embedPath.trim()) {
      setCurrentBranch('')
      setLocalBranches([])
      setRemoteBranches([])
      return
    }
    if (branchDebounceRef.current) clearTimeout(branchDebounceRef.current)
    branchDebounceRef.current = setTimeout(() => {
      setBranchLoading(true)
      getEmbedGitInfo(embedPath.trim())
        .then((info) => {
          setCurrentBranch(info.currentBranch)
          setLocalBranches(info.localBranches)
          setRemoteBranches(info.remoteBranches)
        })
        .catch(() => {
          setCurrentBranch('')
          setLocalBranches([])
          setRemoteBranches([])
        })
        .finally(() => setBranchLoading(false))
    }, 400)
    return () => { if (branchDebounceRef.current) clearTimeout(branchDebounceRef.current) }
  }, [embedPath])

  // Close branch dropdown on outside click
  useEffect(() => {
    if (!branchSwitcherOpen) return
    const handleClick = (e: MouseEvent) => {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setBranchSwitcherOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [branchSwitcherOpen])

  const handleCheckout = async (branch: string) => {
    if (branch === currentBranch || !embedPath.trim()) return
    setCheckoutLoading(true)
    try {
      const result = await checkoutEmbedRepo(embedPath.trim(), branch)
      setCurrentBranch(result.current)
      setBranchSwitcherOpen(false)
    } catch (err: any) {
      const message = err?.response?.json
        ? (await err.response.json().catch(() => ({})))?.error || err.message
        : err?.message || 'Checkout failed'
      onError(message)
    } finally {
      setCheckoutLoading(false)
    }
  }

  const handleStart = async () => {
    if (!embedPath.trim()) return
    setEmbedStarting(true)
    try {
      const exts = embedExtensions
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean)
        .map((e) => e.toLowerCase())
        .map((e) => e.startsWith('.') ? e : `.${e}`)
      const data = await startEmbedJob({
        path: embedPath.trim(),
        extensions: exts.length > 0 ? exts : undefined,
        batchSize: embedDelay > 0 ? 5 : 0,
        batchDelayMs: embedDelay,
      })
      onJobStarted(data.job)
    } catch (err: any) {
      onError(err?.message || 'Failed to start embed job')
    } finally {
      setEmbedStarting(false)
    }
  }

  const hasBranches = localBranches.length > 0 || remoteBranches.length > 0

  return (
    <div class={styles.embedForm}>
      <div class={styles.embedFormField}>
        <label>Directory path</label>
        <div class={styles.pathInputWrap}>
          <input
            type="text"
            placeholder="/path/to/your/project"
            value={embedPath}
            onInput={(e) => setEmbedPath((e.target as HTMLInputElement).value)}
          />
          {embedPath && (
            <button type="button" class={styles.pathClear} title="Clear path" onClick={() => setEmbedPath('')}>
              <X size={14} />
            </button>
          )}
        </div>
        {(currentBranch || branchLoading) && (
          <div class={styles.branchSwitcher} ref={branchDropdownRef}>
            <button
              type="button"
              class={styles.branchSwitcherButton}
              onClick={() => hasBranches && setBranchSwitcherOpen((v) => !v)}
              disabled={checkoutLoading || branchLoading || !hasBranches}
            >
              <GitBranch size={12} />
              <span>{branchLoading ? 'detecting...' : currentBranch}</span>
              {hasBranches && !branchLoading && <ChevronDown size={10} />}
            </button>
            {branchSwitcherOpen && (
              <div class={styles.branchDropdown}>
                {localBranches.length > 0 && (
                  <>
                    {remoteBranches.length > 0 && <div class={styles.branchGroupLabel}>Local</div>}
                    {localBranches.map((b) => (
                      <button
                        key={b}
                        type="button"
                        class={clsx(styles.branchDropdownItem, b === currentBranch && styles.branchDropdownItemActive)}
                        onClick={() => handleCheckout(b)}
                        disabled={b === currentBranch || checkoutLoading}
                      >
                        {b}
                        {b === currentBranch && <Check size={12} />}
                      </button>
                    ))}
                  </>
                )}
                {remoteBranches.length > 0 && (
                  <>
                    <div class={styles.branchGroupLabel}>Remote</div>
                    {remoteBranches.map((b) => (
                      <button
                        key={b}
                        type="button"
                        class={clsx(styles.branchDropdownItem, b === currentBranch && styles.branchDropdownItemActive)}
                        onClick={() => handleCheckout(b)}
                        disabled={b === currentBranch || checkoutLoading}
                      >
                        {b}
                        {b === currentBranch && <Check size={12} />}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}
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
                  {r.file_count} {r.file_count === 1 ? 'file' : 'files'}
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
          <label>Only include extensions</label>
          <input
            type="text"
            placeholder=".ts, .tsx, .js, .py (blank = all)"
            value={embedExtensions}
            onInput={(e) => setEmbedExtensions((e.target as HTMLInputElement).value)}
          />
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
              : `Pauses ${(embedDelay / 1000).toFixed(1)}s every 5 files to ease system load`}
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
          {embedStarting ? 'Starting...' : 'Start Embedding'}
        </button>
        <span class={styles.healthLabel}>
          <span class={clsx(styles.healthDot, embedHealth?.available ? styles.healthOnline : styles.healthOffline)} />
          {embedHealth?.available ? `Embed server online (${embedHealth.model})` : 'Embed server offline'}
        </span>
      </div>
    </div>
  )
}
