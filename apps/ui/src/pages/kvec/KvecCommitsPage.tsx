import { useState, useEffect } from 'preact/hooks'
import { File, GitFork, Upload } from 'lucide-preact'
import { getKvecRepos } from '../../lib/api'
import type { KvecCollection, KvecRepo } from '../../types'
import {
  KvecCollectionHeader,
  KvecFilesTab,
  KvecReposTab,
  KvecEmbedJobList,
  CommitsEmbedForm,
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

export function KvecCommitsPage({ collection, onCollectionRefresh }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('files')
  const [repos, setRepos] = useState<KvecRepo[]>([])
  const showReposTab = collection.repo_count ? collection.repo_count > 0 : false

  const embedJobs = useEmbedJobs({
    collectionName: collection.name,
    isEmbedTabActive: activeTab === 'embed',
    onCollectionRefresh,
  })

  // Load repos for embed tab quick-picks — include kvec-source repos as path suggestions
  useEffect(() => {
    if (activeTab !== 'embed') return
    Promise.all([
      getKvecRepos(collection.name).then((d) => d.repos).catch(() => [] as KvecRepo[]),
      getKvecRepos('kvec-source').then((d) => d.repos).catch(() => [] as KvecRepo[]),
    ]).then(([commitRepos, sourceRepos]) => {
      const byPath = new Map<string, KvecRepo>()
      // Source repos first so commit repos override when both exist
      for (const r of sourceRepos) byPath.set(r.root_path, r)
      for (const r of commitRepos) byPath.set(r.root_path, r)
      setRepos(Array.from(byPath.values()))
    })
  }, [activeTab, collection.name])

  const defaultPath = repos.length === 1 ? repos[0].root_path
    : repos.find((r) => r.name === 'khef' || r.root_path.endsWith('/khef'))?.root_path || ''

  const combinedError = embedJobs.error

  return (
    <div class={styles.page}>
      <PageHeader
        title={collection.name}
        breadcrumbs={[{ label: 'Kvec', href: '/kvec' }]}
      />

      <KvecCollectionHeader collection={collection} fileLabel="Commits" showRepos={showReposTab} />

      {combinedError && <div class={styles.error} onClick={() => embedJobs.setError(null)}>{combinedError}</div>}

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
            <CommitsEmbedForm
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
            <AutoEmbedSection repos={repos} jobType="commits" onJobsChanged={embedJobs.refreshJobs} />
          </div>
        </div>
      )}
    </div>
  )
}
