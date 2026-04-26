import { useState, useEffect } from 'preact/hooks'
import { File, Upload, Hash } from 'lucide-preact'
import { checkEmbedHealth, getKvecCollection } from '../../lib/api'
import type { KvecCollection, EmbedHealth } from '../../types'
import {
  KvecCollectionHeader,
  KvecFilesTab,
  SlackEmbedForm,
  SlackChannelsTab,
} from '../../components/kvec'
import { TabBar } from '../../components/ui'
import type { Tab } from '../../components/ui'
import { PageHeader } from '../../components/layout'
import styles from './KvecVariantPage.module.css'

type TabKey = 'files' | 'embed' | 'channels'

interface Props {
  collection: KvecCollection
  onCollectionRefresh: (collection: KvecCollection) => void
}

export function KvecSlackPage({ collection, onCollectionRefresh }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('files')
  const [embedHealth, setEmbedHealth] = useState<EmbedHealth | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (activeTab !== 'embed') return
    checkEmbedHealth().then(setEmbedHealth).catch(() => setEmbedHealth({ available: false }))
  }, [activeTab])

  const handleIngested = () => {
    getKvecCollection(collection.name)
      .then((data) => onCollectionRefresh(data.collection))
      .catch(() => {})
  }

  return (
    <div class={styles.page}>
      <PageHeader
        title={collection.name}
        breadcrumbs={[{ label: 'Kvec', href: '/kvec' }]}
      />

      <KvecCollectionHeader collection={collection} fileLabel="Documents" showRepos={false} />

      {error && <div class={styles.error} onClick={() => setError(null)}>{error}</div>}

      <TabBar
        tabs={[
          { key: 'files', label: 'Files', icon: File },
          { key: 'embed', label: 'Embed', icon: Upload },
          { key: 'channels', label: 'Channels', icon: Hash },
        ] satisfies Tab[]}
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as TabKey)}
      />

      {activeTab === 'files' && (
        <KvecFilesTab
          collectionName={collection.name}
          repos={[]}
          showReposTab={false}
          pathPrefixes={[]}
          onFilterByRepo={() => {}}
          onFilterByPath={() => {}}
          onCollectionRefresh={onCollectionRefresh}
        />
      )}

      {activeTab === 'embed' && (
        <div class={styles.tabContent}>
          <div class={styles.embedPanel}>
            <SlackEmbedForm
              embedHealth={embedHealth}
              onError={setError}
              onIngested={handleIngested}
            />
          </div>
        </div>
      )}

      {activeTab === 'channels' && (
        <SlackChannelsTab onCollectionRefresh={onCollectionRefresh} />
      )}
    </div>
  )
}
