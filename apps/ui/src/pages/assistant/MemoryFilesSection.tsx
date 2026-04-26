import { useState, useEffect, useCallback } from 'preact/hooks'
import { Link } from 'wouter-preact'
import clsx from 'clsx'
import { Brain } from 'lucide-preact'
import { getMemoryProjects } from '../../lib/api'
import type { MemoryProject } from '../../types'
import { cardStyles } from '../../components/ui'
import styles from '../AssistantPage.module.css'

interface Props {
  handle: string
}

export function MemoryFilesSection({ handle }: Props) {
  const [memoryProjects, setMemoryProjects] = useState<MemoryProject[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const loadProjects = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await getMemoryProjects(handle)
      setMemoryProjects(res.projects)
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false)
    }
  }, [handle])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  if (isLoading) return <div class={styles.loading}>Loading...</div>

  return (
    <div class={styles.memoryProjectList}>
      {memoryProjects.length === 0 ? (
        <div class={styles.empty}>No memory files found.</div>
      ) : (
        memoryProjects.map((project) =>
          project.matched_project ? (
            <Link
              key={project.dir_name}
              href={`/projects/${project.matched_project.id}/memory-files`}
              class={clsx(cardStyles.card, cardStyles.interactive, styles.memoryProjectCard)}
            >
              <Brain size={14} class={styles.memoryProjectIcon} />
              <div class={styles.memoryProjectInfo}>
                <span class={styles.memoryProjectName}>
                  {project.matched_project.name}
                </span>
                <span class={styles.memoryProjectMeta}>
                  {project.file_count} {project.file_count === 1 ? 'file' : 'files'}
                  {project.total_size > 0 && ` · ${(project.total_size / 1024).toFixed(1)} KB`}
                </span>
              </div>
            </Link>
          ) : (
            <div
              key={project.dir_name}
              class={clsx(cardStyles.card, styles.memoryProjectCard, styles.memoryProjectOrphan)}
              title="Not linked to a khef project"
            >
              <Brain size={14} class={styles.memoryProjectIcon} />
              <div class={styles.memoryProjectInfo}>
                <span class={styles.memoryProjectName}>
                  {project.decoded_path}
                </span>
                <span class={styles.memoryProjectMeta}>
                  {project.file_count} {project.file_count === 1 ? 'file' : 'files'}
                  {project.total_size > 0 && ` · ${(project.total_size / 1024).toFixed(1)} KB`}
                </span>
              </div>
            </div>
          )
        )
      )}
    </div>
  )
}
