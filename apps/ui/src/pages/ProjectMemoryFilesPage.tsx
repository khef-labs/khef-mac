import { useState, useEffect } from 'preact/hooks'
import { Link } from 'wouter-preact'
import { Brain, Trash2 } from 'lucide-preact'
import { getProject, getMemoryFiles, deleteMemoryFile } from '../lib/api'
import type { Project, MemoryFileSummary } from '../types'
import { cardStyles, ConfirmModal, useToast } from '../components/ui'
import { PageHeader } from '../components/layout'
import styles from './PlansPage.module.css'

interface Props {
  projectId: string
}

function formatDate(dateString: string | undefined): string {
  if (!dateString) return ''
  const date = new Date(dateString)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ProjectMemoryFilesPage({ projectId }: Props) {
  const { showToast } = useToast()
  const [project, setProject] = useState<Project | null>(null)
  const [files, setFiles] = useState<MemoryFileSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<MemoryFileSummary | null>(null)

  useEffect(() => {
    async function load() {
      setIsLoading(true)
      setError(null)
      try {
        const proj = await getProject(projectId)
        setProject(proj)
        const res = await getMemoryFiles('claude-code', proj.handle)
        setFiles(res.files)
      } catch (err) {
        console.warn('Failed to load memory files:', err)
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [projectId])

  const handleDelete = async () => {
    if (!deleteTarget || !project) return
    try {
      await deleteMemoryFile('claude-code', project.handle, deleteTarget.filename)
      setFiles((prev) => prev.filter((f) => f.filename !== deleteTarget.filename))
      showToast('Memory file deleted')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete memory file')
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <div class={styles.page}>
      <header class={styles.header}>
        <PageHeader
          title="Memory Files"
          subtitle="Claude Code auto-memory files for this project"
          breadcrumbs={[{ label: 'Projects', href: '/projects' }, { label: project?.display_name || project?.name || projectId, href: `/projects/${projectId}` }]}
        />
      </header>

      {isLoading ? (
        <div class={styles.loading}>Loading memory files...</div>
      ) : error ? (
        <div class={styles.error}>{error}</div>
      ) : files.length === 0 ? (
        <div class={styles.empty}>
          <Brain size={48} />
          <p>No memory files found</p>
          <p class={styles.hint}>
            Memory files are created automatically by Claude Code sessions
          </p>
        </div>
      ) : (
        <div class={styles.plansList}>
          {files.map((file) => (
            <Link
              key={file.filename}
              href={`/projects/${projectId}/memory-files/${encodeURIComponent(file.filename)}`}
              class={`${cardStyles.card} ${styles.planCard}`}
            >
              <h3 class={styles.planTitle}>
                {file.filename}
                {file.is_main && (
                  <span style={{
                    fontSize: 'var(--text-xs)',
                    color: 'var(--accent)',
                    background: 'var(--primary-muted)',
                    padding: '2px 6px',
                    borderRadius: 'var(--radius-sm)',
                    marginLeft: 'var(--space-2)',
                    fontWeight: 500,
                  }}>
                    main
                  </span>
                )}
              </h3>
              {file.file_path && (
                <span class={styles.planPath}>{file.file_path}</span>
              )}
              <div class={styles.planMeta}>
                <span class={styles.metaItem}>#{file.current_snapshot}</span>
                <span class={styles.metaItem}>{formatSize(file.size)}</span>
                {!file.has_file && (
                  <span class={styles.metaItem} style={{ color: 'var(--warning)' }}>deleted from disk</span>
                )}
                {formatDate(file.updated_at) && (
                  <span class={styles.metaItem}>{formatDate(file.updated_at)}</span>
                )}
              </div>
              <button
                class={styles.deleteButton}
                title="Delete memory file"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setDeleteTarget(file)
                }}
              >
                <Trash2 size={14} />
              </button>
            </Link>
          ))}
        </div>
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete Memory File"
          message={`Delete "${deleteTarget.filename}"? This cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
