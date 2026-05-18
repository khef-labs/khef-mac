import { useEffect, useState } from 'preact/hooks'
import { useSearch } from 'wouter-preact'
import { FileCode } from 'lucide-preact'
import { PageHeader } from '../components/layout'
import { SnapshotDiffViewer } from '../components/diff/SnapshotDiffViewer'
import { CopyButton } from '../components/ui/CopyButton'
import { fsDiff, type FsDiffResponse } from '../lib/api'
import { setEditorDeepLink } from '../lib/editorDeepLink'
import styles from './DiffFilesPage.module.css'

function basename(p: string): string {
  if (!p) return ''
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

function openInEditor(filePath: string): void {
  if (!filePath) return
  setEditorDeepLink({ path: filePath })
  window.open('/editor', '_blank')
}

export function DiffFilesPage() {
  const search = useSearch()
  const params = new URLSearchParams(search)
  const a = params.get('a') ?? ''
  const b = params.get('b') ?? ''

  const [data, setData] = useState<FsDiffResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!a || !b) {
      setError('Both "a" and "b" query parameters are required (file paths to compare).')
      setLoading(false)
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fsDiff(a, b)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((err) => {
        if (cancelled) return
        const msg =
          err?.response?.status === 404
            ? 'One of the files was not found.'
            : err?.message ?? 'Failed to load diff.'
        setError(msg)
        setData(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [a, b])

  const labelA = a ? basename(a) || 'A' : 'A'
  const labelB = b ? basename(b) || 'B' : 'B'

  return (
    <div class={styles.wrapper}>
      <PageHeader title="Compare Files" subtitle="Line-level diff between two files on disk" />
      <div class={styles.paths}>
        <div class={styles.pathRow}>
          <span class={styles.pathLabel}>A</span>
          <code class={styles.pathValue}>{a || '(missing)'}</code>
          {a && (
            <>
              <CopyButton text={a} title="Copy path" size={13} className={styles.iconBtn} />
              <span
                class={styles.iconBtn}
                onClick={() => openInEditor(a)}
                title="Open in Editor"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') openInEditor(a) }}
              >
                <FileCode size={13} />
              </span>
            </>
          )}
        </div>
        <div class={styles.pathRow}>
          <span class={styles.pathLabel}>B</span>
          <code class={styles.pathValue}>{b || '(missing)'}</code>
          {b && (
            <>
              <CopyButton text={b} title="Copy path" size={13} className={styles.iconBtn} />
              <span
                class={styles.iconBtn}
                onClick={() => openInEditor(b)}
                title="Open in Editor"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') openInEditor(b) }}
              >
                <FileCode size={13} />
              </span>
            </>
          )}
        </div>
      </div>
      <SnapshotDiffViewer
        changes={data?.changes ?? []}
        stats={data?.stats ?? { additions: 0, deletions: 0, unchanged: 0 }}
        isLoading={loading}
        error={error}
        fromLabel={labelA}
        toLabel={labelB}
      />
    </div>
  )
}
