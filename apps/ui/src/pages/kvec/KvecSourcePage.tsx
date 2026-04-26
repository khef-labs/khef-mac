import { useState, useEffect } from 'preact/hooks'
import { File, GitFork, Upload } from 'lucide-preact'

import { getKvecRepos } from '../../lib/api'
import type { KvecCollection, KvecRepo } from '../../types'
import {
  KvecCollectionHeader,
  KvecFilesTab,
  KvecReposTab,
  KvecEmbedJobList,
  SourceEmbedForm,
  AutoEmbedSection,
} from '../../components/kvec'
import { TabBar } from '../../components/ui'
import type { Tab } from '../../components/ui'
import { PageHeader } from '../../components/layout'
import { useEmbedJobs } from '../../components/kvec/useEmbedJobs'
import styles from './KvecVariantPage.module.css'

type TabKey = 'files' | 'repos' | 'embed'

interface Props {
  collection: KvecCollection
  onCollectionRefresh: (collection: KvecCollection) => void
}

export function KvecSourcePage({ collection, onCollectionRefresh }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('files')
  const [repos, setRepos] = useState<KvecRepo[]>([])
  const [error, setError] = useState<string | null>(null)
  const showReposTab = collection.repo_count ? collection.repo_count > 0 : false

  const embedJobs = useEmbedJobs({
    collectionName: collection.name,
    isEmbedTabActive: activeTab === 'embed',
    onCollectionRefresh,
  })

  // Load repos for embed tab quick-picks
  useEffect(() => {
    if (activeTab !== 'embed') return
    getKvecRepos(collection.name).then((data) => setRepos(data.repos)).catch(() => {})
  }, [activeTab, collection.name])

  // Pre-fill embed path from known repos
  const defaultPath = repos.length === 1 ? repos[0].root_path
    : repos.find((r) => r.name === 'khef' || r.root_path.endsWith('/khef'))?.root_path || ''

  const combinedError = error || embedJobs.error
  const clearError = () => { setError(null); embedJobs.setError(null) }

  return (
    <div class={styles.page}>
      <PageHeader
        title={collection.name}
        breadcrumbs={[{ label: 'Kvec', href: '/kvec' }]}
      />

      <KvecCollectionHeader collection={collection} fileLabel="Files" showRepos={showReposTab} />

      {combinedError && <div class={styles.error} onClick={clearError}>{combinedError}</div>}

      <TabBar
        tabs={[
          { key: 'files', label: 'Files', icon: File },
          { key: 'repos', label: 'Repos', icon: GitFork, hidden: !showReposTab },
          { key: 'embed', label: 'Embed', icon: Upload },
        ] satisfies Tab[]}
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as TabKey)}
      />

      {activeTab === 'files' && (
        <KvecFilesTab
          collectionName={collection.name}
          repos={repos}
          showReposTab={showReposTab}
          pathPrefixes={[]}
          onFilterByRepo={() => { setActiveTab('files') }}
          onFilterByPath={() => {}}
          onCollectionRefresh={onCollectionRefresh}
        />
      )}

      {activeTab === 'repos' && (
        <KvecReposTab
          collectionName={collection.name}
          onFilterByRepo={() => { setActiveTab('files') }}
          onReposLoaded={setRepos}
          onCollectionRefresh={onCollectionRefresh}
        />
      )}

      {activeTab === 'embed' && (
        <div class={styles.tabContent}>
          <div class={styles.embedPanel}>
            <SourceEmbedForm
              repos={repos}
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
            <AutoEmbedSection repos={repos} jobType="source" onJobsChanged={embedJobs.refreshJobs} />
          </div>
        </div>
      )}
    </div>
  )
}
