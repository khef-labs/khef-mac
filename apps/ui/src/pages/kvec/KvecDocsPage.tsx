import { useState, useEffect } from 'preact/hooks'
import { File, Upload } from 'lucide-preact'
import { getKvecDocPaths } from '../../lib/api'
import type { KvecCollection, KvecDocPath } from '../../types'
import {
  KvecCollectionHeader,
  KvecFilesTab,
  KvecEmbedJobList,
  DocsEmbedForm,
} from '../../components/kvec'
import { TabBar } from '../../components/ui'
import type { Tab } from '../../components/ui'
import { PageHeader } from '../../components/layout'
import { useDocEmbedJobs } from '../../components/kvec/useDocEmbedJobs'
import styles from './KvecVariantPage.module.css'

type TabKey = 'files' | 'embed'

interface Props {
  collection: KvecCollection
  onCollectionRefresh: (collection: KvecCollection) => void
}

export function KvecDocsPage({ collection, onCollectionRefresh }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('files')
  const [docPaths, setDocPaths] = useState<KvecDocPath[]>([])

  const embedJobs = useDocEmbedJobs({
    collectionName: collection.name,
    isEmbedTabActive: activeTab === 'embed',
    onCollectionRefresh,
  })

  // Load doc paths for embed tab quick-picks
  useEffect(() => {
    if (activeTab !== 'embed') return
    getKvecDocPaths(collection.name).then((data) => setDocPaths(data.paths)).catch(() => {})
  }, [activeTab, collection.name])

  // Pre-fill embed path from known doc paths
  const defaultPath = docPaths.length === 1 ? docPaths[0].dir_path : ''

  const combinedError = embedJobs.error
  const clearError = () => { embedJobs.setError(null) }

  return (
    <div class={styles.page}>
      <PageHeader
        title={collection.name}
        breadcrumbs={[{ label: 'Kvec', href: '/kvec' }]}
      />

      <KvecCollectionHeader collection={collection} fileLabel="Documents" showRepos={false} />

      {combinedError && <div class={styles.error} onClick={clearError}>{combinedError}</div>}

      <TabBar
        tabs={[
          { key: 'files', label: 'Documents', icon: File },
          { key: 'embed', label: 'Embed', icon: Upload },
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
            <DocsEmbedForm
              docPaths={docPaths}
              embedHealth={embedJobs.embedHealth}
              onJobStarted={embedJobs.handleJobStarted}
              onError={embedJobs.handleError}
              defaultPath={defaultPath}
            />
            <KvecEmbedJobList
              activeJobs={embedJobs.activeJobs}
              jobHistory={embedJobs.jobHistory}
              onCancel={embedJobs.handleCancelJob}
              onDelete={embedJobs.handleDeleteJob}
            />
          </div>
        </div>
      )}
    </div>
  )
}
