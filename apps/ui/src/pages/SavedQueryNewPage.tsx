import { useLocation } from 'wouter-preact'
import { useDocumentTitle } from '../hooks'
import { PageHeader } from '../components/layout'
import { SavedQueryForm } from '../components/dbx/SavedQueryForm'
import styles from './SavedQueryNewPage.module.css'

const CRUMBS = [
  { label: 'Dbx', href: '/dbx' },
  { label: 'Saved queries', href: '/dbx/saved-queries' },
]

export function SavedQueryNewPage() {
  useDocumentTitle('New saved query')
  const [, setLocation] = useLocation()

  return (
    <div class={styles.page}>
      <PageHeader title="New saved query" breadcrumbs={CRUMBS} />
      <SavedQueryForm
        mode="create"
        onSaved={q => setLocation(`/dbx/saved-queries/${q.id}`)}
        onCancel={() => setLocation('/dbx/saved-queries')}
      />
    </div>
  )
}
