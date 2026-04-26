import { useEffect, useState, useCallback } from 'preact/hooks'
import { getKvecCollection } from '../lib/api'
import type { KvecCollection } from '../types'
import { KvecSourcePage } from './kvec/KvecSourcePage'
import { KvecCommitsPage } from './kvec/KvecCommitsPage'
import { KvecSlackPage } from './kvec/KvecSlackPage'
import { KvecDocsPage } from './kvec/KvecDocsPage'
import { KvecGenericPage } from './kvec/KvecGenericPage'
import { PageHeader } from '../components/layout'
import { useDocumentTitle } from '../hooks'
import styles from './KvecCollectionPage.module.css'

interface Props {
  name: string
}

export function KvecCollectionPage({ name }: Props) {
  const [collection, setCollection] = useState<KvecCollection | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useDocumentTitle(collection?.name ? `Kvec - ${collection.name}` : 'Kvec - Loading')

  useEffect(() => {
    let mounted = true
    setLoading(true)
    setError(null)
    getKvecCollection(name)
      .then((data) => {
        if (mounted) setCollection(data.collection)
      })
      .catch(() => {
        if (mounted) setError('Collection not found')
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => { mounted = false }
  }, [name])

  const handleCollectionRefresh = useCallback((updated: KvecCollection) => {
    setCollection(updated)
  }, [])

  if (loading) {
    return (
      <div class={styles.page}>
        <div class={styles.loading}>Loading collection...</div>
      </div>
    )
  }

  if (error && !collection) {
    return (
      <div class={styles.page}>
        <PageHeader
          title={name}
          breadcrumbs={[{ label: 'Kvec', href: '/kvec' }]}
        />
        <div class={styles.error}>{error}</div>
      </div>
    )
  }

  if (!collection) return null

  switch (collection.name) {
    case 'kvec-source':
      return <KvecSourcePage collection={collection} onCollectionRefresh={handleCollectionRefresh} />
    case 'kvec-commits':
      return <KvecCommitsPage collection={collection} onCollectionRefresh={handleCollectionRefresh} />
    case 'slack-messages':
      return <KvecSlackPage collection={collection} onCollectionRefresh={handleCollectionRefresh} />
    case 'kvec-docs':
      return <KvecDocsPage collection={collection} onCollectionRefresh={handleCollectionRefresh} />
    case 'khef-memories':
    case 'khef-sessions':
      return <KvecGenericPage collection={collection} onCollectionRefresh={handleCollectionRefresh} showEmbed={false} showPaths={false} />
    default:
      return <KvecGenericPage collection={collection} onCollectionRefresh={handleCollectionRefresh} />
  }
}
