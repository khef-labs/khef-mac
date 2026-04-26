import { Database, Clock } from 'lucide-preact'
import type { KvecCollection } from '../../types'
import { formatCount, formatBytes, formatDate, formatTimeAgo } from './kvec-utils'
import styles from './KvecCollectionHeader.module.css'

interface Props {
  collection: KvecCollection
  fileLabel?: string
  showRepos?: boolean
}

export function KvecCollectionHeader({ collection, fileLabel = 'Files', showRepos = false }: Props) {
  return (
    <>
      <div class={styles.header}>
        <div class={styles.headerMain}>
          <div class={styles.titleRow}>
            <Database size={20} class={styles.titleIcon} />
            <h1 class={styles.title}>{collection.name}</h1>
            <span class={styles.storeTypeBadge} data-testid="kvec-header--store-type">{collection.store_type}</span>
          </div>
          <div class={styles.headerMeta} data-testid="kvec-header--meta">
            <span>{collection.embedding_model} &middot; {collection.dimensions}d</span>
            <span>Created {formatDate(collection.created_at)}</span>
            {collection.last_upload && (
              <span><Clock size={12} /> Last upload {formatTimeAgo(collection.last_upload)}</span>
            )}
          </div>
        </div>
      </div>

      <div class={styles.statsRow}>
        <div class={styles.statCard}>
          <span class={styles.statLabel}>{fileLabel}</span>
          <span class={styles.statValue}>{formatCount(collection.file_count)}</span>
        </div>
        <div class={styles.statCard}>
          <span class={styles.statLabel}>Chunks</span>
          <span class={styles.statValue}>{formatCount(collection.total_chunks)}</span>
        </div>
        {showRepos && (
          <div class={styles.statCard}>
            <span class={styles.statLabel}>Repos</span>
            <span class={styles.statValue}>{collection.repo_count}</span>
          </div>
        )}
        <div class={styles.statCard}>
          <span class={styles.statLabel}>Size</span>
          <span class={styles.statValue}>{formatBytes(collection.total_bytes)}</span>
        </div>
      </div>
    </>
  )
}
