import { useState, useEffect } from 'preact/hooks'
import { File, GitFork, FolderTree, Upload } from 'lucide-preact'
import { getKvecFiles, getKvecRepos } from '../../lib/api'
import type { KvecCollection, KvecRepo } from '../../types'
import {
  KvecCollectionHeader,
  KvecFilesTab,
  KvecReposTab,
  KvecPathsTab,
  KvecEmbedJobList,
  GenericEmbedForm,
} from '../../components/kvec'
import { TabBar } from '../../components/ui'
import type { Tab } from '../../components/ui'
import { PageHeader } from '../../components/layout'
import { useEmbedJobs } from '../../components/kvec/useEmbedJobs'
import styles from './KvecVariantPage.module.css'

type TabKey = 'files' | 'repos' | 'paths' | 'embed'

interface Props {
  collection: KvecCollection
  onCollectionRefresh: (collection: KvecCollection) => void
  showEmbed?: boolean
  showPaths?: boolean
}

export function KvecGenericPage({ collection, onCollectionRefresh, showEmbed = true, showPaths = true }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('files')
  const [repos, setRepos] = useState<KvecRepo[]>([])
  const [pathPrefixes, setPathPrefixes] = useState<Array<{ prefix: string; count: number }>>([])
  const showReposTab = collection.repo_count ? collection.repo_count > 0 : false

  const embedJobs = useEmbedJobs({
    collectionName: collection.name,
    isEmbedTabActive: activeTab === 'embed',
    onCollectionRefresh,
  })

  // Load repos for embed tab
  useEffect(() => {
    if (activeTab !== 'embed' && activeTab !== 'repos') return
    getKvecRepos(collection.name).then((data) => setRepos(data.repos)).catch(() => {})
  }, [activeTab, collection.name])

  // Load path prefixes for non-repo collections
  useEffect(() => {
    if (showReposTab) return
    getKvecFiles(collection.name, { limit: 200, offset: 0 })
      .then((data) => {
        const counts: Record<string, number> = {}
        for (const f of data.files) {
          const dir = f.file_path.includes('/') ? f.file_path.slice(0, f.file_path.lastIndexOf('/')) : '(root)'
          counts[dir] = (counts[dir] || 0) + 1
        }
        setPathPrefixes(
          Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([prefix, count]) => ({ prefix, count }))
        )
      })
      .catch(() => {})
  }, [collection.name, showReposTab])

  const combinedError = embedJobs.error

  return (
    <div class={styles.page}>
      <PageHeader
        title={collection.name}
        breadcrumbs={[{ label: 'Kvec', href: '/kvec' }]}
      />

      <KvecCollectionHeader collection={collection} fileLabel="Files" showRepos={showReposTab} />

      {combinedError && <div class={styles.error} onClick={() => embedJobs.setError(null)}>{combinedError}</div>}

      <TabBar
        tabs={[
          { key: 'files', label: 'Files', icon: File },
          { key: 'repos', label: 'Repos', icon: GitFork, hidden: !showReposTab },
          { key: 'paths', label: 'Paths', icon: FolderTree, hidden: showReposTab || !showPaths },
          { key: 'embed', label: 'Embed', icon: Upload, hidden: !showEmbed },
        ] satisfies Tab[]}
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as TabKey)}
      />

      {activeTab === 'files' && (
        <KvecFilesTab
          collectionName={collection.name}
          repos={repos}
          showReposTab={showReposTab}
          pathPrefixes={pathPrefixes}
          onFilterByRepo={() => { setActiveTab('files') }}
          onFilterByPath={() => { setActiveTab('files') }}
          onCollectionRefresh={onCollectionRefresh}
        />
      )}

      {activeTab === 'repos' && showReposTab && (
        <KvecReposTab
          collectionName={collection.name}
          onFilterByRepo={() => { setActiveTab('files') }}
          onReposLoaded={setRepos}
          onCollectionRefresh={onCollectionRefresh}
        />
      )}

      {showPaths && activeTab === 'paths' && !showReposTab && (
        <KvecPathsTab
          pathPrefixes={pathPrefixes}
          onFilterByPath={() => { setActiveTab('files') }}
        />
      )}

      {showEmbed && activeTab === 'embed' && (
        <div class={styles.tabContent}>
          <div class={styles.embedPanel}>
            <GenericEmbedForm
              embedHealth={embedJobs.embedHealth}
              onJobStarted={embedJobs.handleJobStarted}
              onError={embedJobs.handleError}
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
