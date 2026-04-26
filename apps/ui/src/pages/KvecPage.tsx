import { useEffect, useState } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { Database, File, Box, GitFork, Clock, Info } from 'lucide-preact'
import clsx from 'clsx'
import { getKvecCollections, checkEmbedHealth } from '../lib/api'
import type { KvecCollection } from '../types'
import { cardStyles } from '../components/ui'
import { useDocumentTitle } from '../hooks'
import styles from './KvecPage.module.css'

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function KvecPage() {
  useDocumentTitle('Kvec')
  const [, setLocation] = useLocation()
  const [collections, setCollections] = useState<KvecCollection[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [embedOnline, setEmbedOnline] = useState<boolean | null>(null)

  useEffect(() => {
    checkEmbedHealth()
      .then((h) => setEmbedOnline(h.available))
      .catch(() => setEmbedOnline(false))
  }, [])

  useEffect(() => {
    let mounted = true
    setError(null)
    setLoaded(false)
    getKvecCollections()
      .then((data) => {
        if (mounted) setCollections(data.collections)
      })
      .catch((err) => {
        if (mounted) console.warn('Failed to load collections:', err)
      })
      .finally(() => {
        if (mounted) setLoaded(true)
      })
    return () => { mounted = false }
  }, [])

  return (
    <div class={styles.page}>
      <div class={styles.header}>
        <div class={styles.headerIntro}>
          <h1 class={styles.title}>
            Kvec
            {embedOnline !== null && (
              embedOnline ? (
                <span
                  class={clsx(styles.embedDot, styles.embedDotOnline)}
                  title="Embed server online"
                />
              ) : (
                <span class={styles.embedOfflineIcon} title="Embed server offline — try restarting the API server">
                  <Info size={18} />
                </span>
              )
            )}
          </h1>
          <p class={styles.subtitle}>Browse kvec collections and embedded data</p>
        </div>
        {loaded && collections.length > 0 && (
          <div class={styles.count}>{collections.length} collection{collections.length !== 1 ? 's' : ''}</div>
        )}
      </div>

      {error && <div class={styles.error}>{error}</div>}

      <div class={styles.grid}>
        {collections.length > 0 ? (
          collections.map((col) => (
            <div
              key={col.id}
              class={clsx(cardStyles.card, cardStyles.interactive, styles.collectionCard)}
              role="link"
              tabIndex={0}
              data-testid="collection-card"
              data-collection-name={col.name}
              onClick={() => setLocation(`/kvec/${encodeURIComponent(col.name)}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setLocation(`/kvec/${encodeURIComponent(col.name)}`)
                }
              }}
            >
              <div class={styles.cardHeader}>
                <div class={styles.cardTitle} data-testid="collection-card--title">
                  <Database size={16} class={styles.cardIcon} />
                  {col.name}
                </div>
                <span class={styles.storeTypeBadge} data-testid="collection-card--store-type">{col.store_type}</span>
              </div>

              {col.description && (
                <p class={styles.cardDescription}>{col.description}</p>
              )}

              <div class={styles.cardModel}>
                {col.embedding_model} &middot; {col.dimensions}d
              </div>

              <div class={styles.statRow}>
                <div class={styles.stat}>
                  <File size={13} />
                  <span class={styles.statValue}>{formatCount(col.file_count)}</span>
                  <span class={styles.statLabel}>files</span>
                </div>
                <div class={styles.stat}>
                  <Box size={13} />
                  <span class={styles.statValue}>{formatCount(col.total_chunks)}</span>
                  <span class={styles.statLabel}>chunks</span>
                </div>
                <div class={styles.stat}>
                  <GitFork size={13} />
                  <span class={styles.statValue}>{col.repo_count}</span>
                  <span class={styles.statLabel}>{col.repo_count === 1 ? 'repo' : 'repos'}</span>
                </div>
              </div>

              <div class={styles.cardFooter}>
                <span class={styles.sizeLabel}>{formatBytes(col.total_bytes)}</span>
                {col.last_upload && (
                  <span class={styles.lastUpload}>
                    <Clock size={12} />
                    {formatTimeAgo(col.last_upload)}
                  </span>
                )}
              </div>
            </div>
          ))
        ) : (
          <div class={styles.empty}>
            {!loaded
              ? 'Loading collections...'
              : 'No vector collections found. Run kvec:embed to index a repository.'}
          </div>
        )}
      </div>
    </div>
  )
}
