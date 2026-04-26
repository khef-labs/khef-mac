import { useState, useEffect } from 'preact/hooks'
import { Link } from 'wouter-preact'
import { FileText, Trash2 } from 'lucide-preact'
import { getProject, getProjectPlans, deletePlan } from '../lib/api'
import type { Project, PlanSummary } from '../types'
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

export function ProjectPlansPage({ projectId }: Props) {
  const { showToast } = useToast()
  const [project, setProject] = useState<Project | null>(null)
  const [plans, setPlans] = useState<PlanSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<PlanSummary | null>(null)

  useEffect(() => {
    async function load() {
      setIsLoading(true)
      setError(null)
      try {
        const [proj, res] = await Promise.all([
          getProject(projectId),
          getProjectPlans(projectId),
        ])
        setProject(proj)
        setPlans(res.plans)
      } catch (err) {
        console.warn('Failed to load plans:', err)
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [projectId])

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      // Plans are deleted via assistant endpoint using filename
      await deletePlan('claude-code', deleteTarget.filename)
      setPlans((prev) => prev.filter((p) => p.filename !== deleteTarget.filename))
      showToast('Plan deleted')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete plan')
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <div class={styles.page}>
      <header class={styles.header}>
        <PageHeader
          title="Plans"
          subtitle="Implementation plans associated with this project"
          breadcrumbs={[{ label: 'Projects', href: '/projects' }, { label: project?.display_name || project?.name || projectId, href: `/projects/${projectId}` }]}
        />
      </header>

      {isLoading ? (
        <div class={styles.loading}>Loading plans...</div>
      ) : error ? (
        <div class={styles.error}>{error}</div>
      ) : plans.length === 0 ? (
        <div class={styles.empty}>
          <FileText size={48} />
          <p>No plans found</p>
          <p class={styles.hint}>
            Plans can be associated with this project from the plan detail page
          </p>
        </div>
      ) : (
        <div class={styles.plansList}>
          {plans.map((plan) => (
            <Link
              key={plan.filename}
              href={`/projects/${projectId}/plans/${encodeURIComponent(plan.filename)}`}
              class={`${cardStyles.card} ${styles.planCard}`}
            >
              <h3 class={styles.planTitle}>{plan.title}</h3>
              <span class={styles.planHandle}>{plan.filename.replace(/\.md$/, '')}</span>
              {plan.file_path && (
                <span class={styles.planPath}>{plan.file_path}</span>
              )}
              <div class={styles.planMeta}>
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
