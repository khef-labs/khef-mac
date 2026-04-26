import { useState } from 'preact/hooks'
import { X, Upload, Loader } from 'lucide-preact'
import clsx from 'clsx'
import { startEmbedJob } from '../../lib/api'
import type { EmbedHealth, EmbedJob } from '../../types'
import styles from './EmbedForm.module.css'

interface Props {
  embedHealth: EmbedHealth | null
  onJobStarted: (job: EmbedJob) => void
  onError: (message: string) => void
}

export function GenericEmbedForm({ embedHealth, onJobStarted, onError }: Props) {
  const [embedPath, setEmbedPath] = useState('')
  const [embedExtensions, setEmbedExtensions] = useState('')
  const [embedDelay, setEmbedDelay] = useState(500)
  const [embedStarting, setEmbedStarting] = useState(false)

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

  return (
    <div class={styles.embedForm}>
      <div class={styles.embedFormField}>
        <label>Directory path</label>
        <div class={styles.pathInputWrap}>
          <input
            type="text"
            placeholder="/path/to/directory"
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
