import { useState, useEffect } from 'preact/hooks'
import { Link } from 'wouter-preact'
import { FileText, Trash2 } from 'lucide-preact'
import { getPlans, deletePlan } from '../lib/api'
import type { PlanSummary } from '../types'
import { cardStyles, ConfirmModal, useToast } from '../components/ui'
import { useDocumentTitle } from '../hooks'
import styles from './PlansPage.module.css'

interface Props {
  handle: string
  embedded?: boolean
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

export function PlansPage({ handle, embedded }: Props) {
  const { showToast } = useToast()
  useDocumentTitle('Plans')
  const [plans, setPlans] = useState<PlanSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<'date' | 'name'>('date')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [deleteTarget, setDeleteTarget] = useState<PlanSummary | null>(null)

  useEffect(() => {
    async function load() {
      setIsLoading(true)
      setError(null)
      try {
        const res = await getPlans(handle, { sort: sortBy, order: sortOrder })
        setPlans(res.plans)
      } catch (err) {
        console.warn('Failed to load plans:', err)
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [handle, sortBy, sortOrder])

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await deletePlan(handle, deleteTarget.filename)
      setPlans((prev) => prev.filter((p) => p.filename !== deleteTarget.filename))
      showToast('Plan deleted')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete plan')
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <div class={embedded ? undefined : styles.page}>
      {!embedded && (
        <header class={styles.header}>
          <h1>Plans</h1>
          <p class={styles.subtitle}>Implementation plans created during planning sessions</p>
        </header>
      )}

      <div class={styles.toolbar}>
        <div class={styles.sortGroup}>
          <label>Sort by:</label>
          <select
            value={sortBy}
            onChange={(e) => setSortBy((e.target as HTMLSelectElement).value as 'date' | 'name')}
          >
            <option value="date">Date</option>
            <option value="name">Title</option>
          </select>
          <select
            value={sortOrder}
            onChange={(e) => setSortOrder((e.target as HTMLSelectElement).value as 'asc' | 'desc')}
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </div>
      </div>

      {isLoading ? (
        <div class={styles.loading}>Loading plans...</div>
      ) : error ? (
        <div class={styles.error}>{error}</div>
      ) : plans.length === 0 ? (
        <div class={styles.empty}>
          <FileText size={48} />
          <p>No plans found</p>
          <p class={styles.hint}>Plans are created when Claude enters planning mode</p>
        </div>
      ) : (
        <div class={styles.plansList}>
          {plans.map((plan) => (
            <Link
              key={plan.filename}
              href={`/assistants/${handle}/plans/${encodeURIComponent(plan.filename)}`}
              class={`${cardStyles.card} ${styles.planCard}`}
            >
              <h3 class={styles.planTitle}>{plan.title}</h3>
              <span class={styles.planHandle}>{plan.filename.replace(/\.md$/, '')}</span>
              {plan.file_path && (
                <span class={styles.planPath}>{plan.file_path}</span>
              )}
              <div class={styles.planMeta}>
                {plan.project_name && (
                  <span class={styles.projectBadge}>{plan.project_name}</span>
                )}
                <span class={styles.metaItem}>v{plan.current_version}</span>
                <span class={styles.metaItem}>{formatSize(plan.size)}</span>
                {formatDate(plan.updated_at) && (
                  <span class={styles.metaItem}>{formatDate(plan.updated_at)}</span>
                )}
              </div>
              <button
                class={styles.deleteButton}
                title="Delete plan"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setDeleteTarget(plan)
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
          title="Delete Plan"
          message={`Delete "${deleteTarget.title}"? This cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
