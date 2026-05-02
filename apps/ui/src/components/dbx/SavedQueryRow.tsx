import { Star } from 'lucide-preact'
import type { DbxSavedQuery, DbxConnection } from '../../lib/dbx-api'
import styles from './SavedQueryRow.module.css'

interface Props {
  query: DbxSavedQuery
  connections: DbxConnection[]
  selected?: boolean
  onClick: () => void
  onContextMenu?: (e: MouseEvent) => void
}

export function SavedQueryRow({ query, connections, selected, onClick, onContextMenu }: Props) {
  const isBuiltin = query.owner_session_id === null
  const connName = query.connection_id
    ? connections.find(c => c.id === query.connection_id)?.name ?? '(unknown)'
    : '(unbound)'
  const params = paramSummary(query)
  return (
    <div
      class={selected ? `${styles.row} ${styles.rowSelected}` : styles.row}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={query.description || query.handle}
    >
      <div class={styles.body}>
        <div class={styles.name}>{query.name}</div>
        <pre
          class={styles.snippet}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: highlightSnippet(query.sql) }}
        />
        <div class={styles.meta}>
          <span class={styles.handleGroup}>
            <span class={styles.handle}>{query.handle}</span>
            {query.is_favorite && (
              <Star size={11} class={styles.starOn} fill="currentColor" aria-label="Favorite" />
            )}
            {isBuiltin && <span class={styles.systemBadge}>System</span>}
          </span>
          {params && <><span class={styles.dot}>·</span><span>{params}</span></>}
          <span class={styles.dot}>·</span><span>{connName}</span>
        </div>
      </div>
    </div>
  )
}

function paramSummary(q: DbxSavedQuery): string {
  if (!q.params) return ''
  if (q.params.length === 0) return 'no params'
  return `${q.params.length} param${q.params.length === 1 ? '' : 's'}`
}

const SQL_KEYWORDS = /\b(SELECT|FROM|JOIN|LEFT|RIGHT|INNER|OUTER|WHERE|AND|OR|ORDER\s+BY|LIMIT|GROUP\s+BY|HAVING|AS|ON|IS|NULL|NOT|DESC|ASC|INSERT|UPDATE|DELETE|INTO|VALUES|WITH|RETURNING|COALESCE|FILTER|CASE|WHEN|THEN|ELSE|END)\b/gi

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Collapse the SQL into a single line — first non-empty line plus a hint of
 * what follows, joined with spaces so the row stays compact. */
function oneLine(sql: string): string {
  return sql
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join(' ')
}

function highlightSnippet(sql: string): string {
  if (!sql || sql.trim().length === 0) return '<span class="com">-- empty</span>'
  let s = escapeHtml(oneLine(sql))
  s = s.replace(/('[^']*')/g, m => `<span class="str">${m}</span>`)
  s = s.replace(/(--[^\n]*)/g, m => `<span class="com">${m}</span>`)
  s = s.replace(SQL_KEYWORDS, m => `<span class="kw">${m}</span>`)
  s = s.replace(/(:\w+)/g, m => `<span class="par">${m}</span>`)
  return s
}
