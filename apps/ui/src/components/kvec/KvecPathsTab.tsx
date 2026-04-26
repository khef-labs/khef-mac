import { GitFork, Info } from 'lucide-preact'
import styles from './KvecPathsTab.module.css'

interface PathPrefix {
  prefix: string
  count: number
}

interface Props {
  pathPrefixes: PathPrefix[]
  onFilterByPath: (path: string) => void
}

export function KvecPathsTab({ pathPrefixes, onFilterByPath }: Props) {
  return (
    <div class={styles.tabContent}>
      <div class={styles.pathsInfo}>
        <Info size={14} />
        Files grouped by directory prefix. Click a group to filter the Files tab.
      </div>
      {pathPrefixes.length === 0 ? (
        <div class={styles.emptyTab}>No path groups found</div>
      ) : (
        <div class={styles.pathList}>
          {pathPrefixes.map((p) => (
            <div
              key={p.prefix}
              class={styles.pathCard}
              role="button"
              tabIndex={0}
              data-testid="path-group-card"
              onClick={() => onFilterByPath(p.prefix)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onFilterByPath(p.prefix)
                }
              }}
            >
              <div class={styles.pathHeader}>
                <GitFork size={16} class={styles.pathIcon} />
                <span class={styles.pathName}>{p.prefix}</span>
                <span class={styles.pathFileCount}>{p.count} file{p.count !== 1 ? 's' : ''}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
