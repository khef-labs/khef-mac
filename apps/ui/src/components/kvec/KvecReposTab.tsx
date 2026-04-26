import { useEffect, useState } from 'preact/hooks'
import { GitFork, Trash2 } from 'lucide-preact'
import {
  getKvecCollection,
  getKvecRepos,
  deleteKvecRepo,
} from '../../lib/api'
import type { KvecCollection, KvecRepo } from '../../types'
import { ConfirmModal } from '../ui'
import { formatTimeAgo } from './kvec-utils'
import styles from './KvecReposTab.module.css'

interface Props {
  collectionName: string
  onFilterByRepo: (repoName: string) => void
  onReposLoaded?: (repos: KvecRepo[]) => void
  onCollectionRefresh: (collection: KvecCollection) => void
}

export function KvecReposTab({
  collectionName,
  onFilterByRepo,
  onReposLoaded,
  onCollectionRefresh,
}: Props) {
  const [repos, setRepos] = useState<KvecRepo[]>([])
  const [reposLoading, setReposLoading] = useState(false)
  const [deleteRepoId, setDeleteRepoId] = useState<string | null>(null)

  useEffect(() => {
    setReposLoading(true)
    getKvecRepos(collectionName)
      .then((data) => {
        setRepos(data.repos)
        onReposLoaded?.(data.repos)
      })
      .catch(() => {})
      .finally(() => setReposLoading(false))
  }, [collectionName])

  const handleDeleteRepo = async () => {
    if (!deleteRepoId) return
    try {
      await deleteKvecRepo(collectionName, deleteRepoId)
      setDeleteRepoId(null)
      getKvecRepos(collectionName).then((data) => {
        setRepos(data.repos)
        onReposLoaded?.(data.repos)
      }).catch(() => {})
      getKvecCollection(collectionName).then((data) => onCollectionRefresh(data.collection)).catch(() => {})
    } catch {
      // error handled by parent
    }
  }

  if (reposLoading) {
    return <div class={styles.tabContent}><div class={styles.loading}>Loading repos...</div></div>
  }

  if (repos.length === 0) {
    return <div class={styles.tabContent}><div class={styles.emptyTab}>No repositories in this collection</div></div>
  }

  return (
    <div class={styles.tabContent}>
      <div class={styles.repoList}>
        {repos.map((r) => (
          <div
            key={r.id}
            class={styles.repoCard}
            role="button"
            tabIndex={0}
            data-testid="repo-card"
            onClick={() => onFilterByRepo(r.name)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onFilterByRepo(r.name)
              }
            }}
          >
            <div class={styles.repoHeader}>
              <GitFork size={16} class={styles.repoIcon} />
              <span class={styles.repoName} data-testid="repo-card--name">{r.name}</span>
              <span class={styles.repoFileCount} data-testid="repo-card--file-count">{r.file_count} file{r.file_count !== 1 ? 's' : ''}</span>
            </div>
            <div class={styles.repoDetails}>
              <span class={styles.repoPath}>{r.root_path}</span>
              {r.remote_url && (
                <span class={styles.repoRemote}>{r.remote_url}</span>
              )}
            </div>
            <div class={styles.repoFooter}>
              <span>{r.snapshot_count} snapshot{r.snapshot_count !== 1 ? 's' : ''}</span>
              {r.last_upload && <span>Last upload {formatTimeAgo(r.last_upload)}</span>}
              <button
                type="button"
                class={styles.repoDeleteButton}
                title="Delete repo and all its files"
                onClick={(e) => { e.stopPropagation(); setDeleteRepoId(r.id) }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {deleteRepoId && (
        <ConfirmModal
          title="Delete Repository"
          message={`Delete this repository and all its tracked files? This action cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDeleteRepo}
          onCancel={() => setDeleteRepoId(null)}
        />
      )}
    </div>
  )
}
