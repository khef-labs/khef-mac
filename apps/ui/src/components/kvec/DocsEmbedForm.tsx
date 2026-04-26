import { useState, useEffect } from 'preact/hooks'
import { X, FolderOpen, Upload, Loader } from 'lucide-preact'
import clsx from 'clsx'
import { startDocEmbedJob, getProjects } from '../../lib/api'
import { formatTimeAgo } from './kvec-utils'
import type { EmbedHealth, EmbedJob, Project, KvecDocPath } from '../../types'
import styles from './EmbedForm.module.css'

interface Props {
  docPaths: KvecDocPath[]
  embedHealth: EmbedHealth | null
  onJobStarted: (job: EmbedJob) => void
  onError: (message: string) => void
  defaultPath?: string
}

export function DocsEmbedForm({ docPaths, embedHealth, onJobStarted, onError, defaultPath = '' }: Props) {
  const [embedPath, setEmbedPath] = useState(defaultPath)
  const [embedExtensions, setEmbedExtensions] = useState('')
  const [projectHandle, setProjectHandle] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [embedDelay, setEmbedDelay] = useState(500)
  const [embedStarting, setEmbedStarting] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    getProjects().then(setProjects).catch(() => {})
  }, [])

  useEffect(() => {
    if (defaultPath) setEmbedPath(defaultPath)
  }, [defaultPath])

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
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      const data = await startDocEmbedJob({
        path: embedPath.trim(),
        extensions: exts.length > 0 ? exts : undefined,
        project_handle: projectHandle || undefined,
        tags: tags.length > 0 ? tags : undefined,
        batchSize: embedDelay > 0 ? 5 : 0,
        batchDelayMs: embedDelay,
      })
      onJobStarted(data.job)
    } catch (err: any) {
      onError(err?.message || 'Failed to start doc embed job')
    } finally {
      setEmbedStarting(false)
    }
  }

  /** Extract a short display name from a directory path */
  const dirName = (dirPath: string) => {
    const parts = dirPath.split('/')
    return parts.length > 1 ? parts.slice(-2).join('/') : parts[parts.length - 1]
  }

  return (
    <div class={styles.embedForm}>
      <div class={styles.embedFormField}>
        <label>File or directory path</label>
        <div class={styles.pathInputWrap}>
          <input
            type="text"
            placeholder="/path/to/document.md or /path/to/docs/"
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

      {docPaths.length > 0 && (
        <div class={styles.recentPaths}>
          <div class={styles.recentPathsTitle}>Recently indexed</div>
          {docPaths.map((p) => (
            <button
              key={p.dir_path}
              type="button"
              class={clsx(styles.recentPathItem, embedPath === p.dir_path && styles.recentPathItemActive)}
              onClick={() => setEmbedPath(p.dir_path)}
            >
              <FolderOpen size={12} class={styles.recentPathIcon} />
              <span class={styles.recentPathName}>{dirName(p.dir_path)}</span>
              <span class={styles.recentPathMeta}>
                {p.file_count} {p.file_count === 1 ? 'file' : 'files'}
              </span>
              {p.last_upload && (
                <span class={styles.recentPathMeta}>{formatTimeAgo(p.last_upload)}</span>
              )}
            </button>
          ))}
        </div>
      )}

      <div class={styles.embedFormGrid}>
        <div class={styles.embedFormField}>
          <label>File types</label>
          <input
            type="text"
            placeholder=".md, .pdf, .txt (blank = all)"
            value={embedExtensions}
            onInput={(e) => setEmbedExtensions((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class={styles.embedFormField}>
          <label>Project</label>
          <select
            value={projectHandle}
            onChange={(e) => setProjectHandle((e.target as HTMLSelectElement).value)}
          >
            <option value="">None</option>
            {projects.map((p) => (
              <option key={p.id} value={p.handle}>{p.display_name || p.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div class={styles.embedFormGrid}>
        <div class={styles.embedFormField}>
          <label>Tags</label>
          <input
            type="text"
            placeholder="docs, spec, reference (comma-separated)"
            value={tagsInput}
            onInput={(e) => setTagsInput((e.target as HTMLInputElement).value)}
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
          <span class={`${styles.healthDot} ${embedHealth?.available ? styles.healthOnline : styles.healthOffline}`} />
          {embedHealth?.available ? `Embed server online (${embedHealth.model})` : 'Embed server offline'}
        </span>
      </div>
    </div>
  )
}
