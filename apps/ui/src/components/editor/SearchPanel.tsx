import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import { FileCode, ChevronRight, ChevronDown } from 'lucide-preact'
import clsx from 'clsx'
import { fsSearch } from '../../lib/api'
import type { FsSearchFileResult, FsSearchMatch } from '../../types/api'
import styles from './SearchPanel.module.css'

interface SearchPanelProps {
  rootPath: string
  visible: boolean
  onOpenFile: (path: string, line?: number) => void
}

export function SearchPanel({ rootPath, visible, onOpenFile }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [results, setResults] = useState<FsSearchFileResult[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement | null>(null)
  const searchIdRef = useRef(0)

  // Focus input when panel becomes visible
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [visible])

  // Debounced search
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed || !rootPath) {
      setResults([])
      setTruncated(false)
      setError(null)
      setLoading(false)
      return
    }

    if (trimmed.length < 2) {
      setResults([])
      setTruncated(false)
      return
    }

    setLoading(true)
    setError(null)
    const id = ++searchIdRef.current

    const timer = setTimeout(() => {
      fsSearch(rootPath, trimmed, { caseSensitive, regex: useRegex })
        .then((res) => {
          if (searchIdRef.current !== id) return
          setResults(res.results)
          setTruncated(res.truncated)
          setCollapsedFiles(new Set())
        })
        .catch((err: unknown) => {
          if (searchIdRef.current !== id) return
          setResults([])
          setError(err instanceof Error ? err.message : 'Search failed')
        })
        .finally(() => {
          if (searchIdRef.current !== id) return
          setLoading(false)
        })
    }, 300)

    return () => clearTimeout(timer)
  }, [query, rootPath, caseSensitive, useRegex])

  const toggleFileCollapse = useCallback((filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) {
        next.delete(filePath)
      } else {
        next.add(filePath)
      }
      return next
    })
  }, [])

  const totalMatches = results.reduce((sum, f) => sum + f.matches.length, 0)

  if (!visible) return null

  return (
    <div class={styles.panel}>
      <div class={styles.searchHeader}>
        <div class={styles.searchRow}>
          <input
            ref={inputRef}
            class={styles.searchInput}
            type="text"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            placeholder="Search files..."
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
              }
            }}
          />
          <button
            class={clsx(styles.toggleButton, caseSensitive && styles.toggleButtonActive)}
            onClick={() => setCaseSensitive((v) => !v)}
            title="Match Case"
          >
            Aa
          </button>
          <button
            class={clsx(styles.toggleButton, useRegex && styles.toggleButtonActive)}
            onClick={() => setUseRegex((v) => !v)}
            title="Use Regular Expression"
          >
            .*
          </button>
        </div>
        {query.trim().length >= 2 && (
          <div class={styles.summary}>
            {loading
              ? 'Searching...'
              : `${totalMatches} result${totalMatches !== 1 ? 's' : ''} in ${results.length} file${results.length !== 1 ? 's' : ''}${truncated ? ' (truncated)' : ''}`}
          </div>
        )}
      </div>

      <div class={styles.results}>
        {error && <div class={styles.errorMessage}>{error}</div>}
        {!loading && !error && query.trim().length >= 2 && results.length === 0 && (
          <div class={styles.emptyMessage}>No results found</div>
        )}
        {results.map((file) => {
          const collapsed = collapsedFiles.has(file.path)
          return (
            <div key={file.path} class={styles.fileGroup}>
              <button
                class={styles.fileHeader}
                onClick={() => toggleFileCollapse(file.path)}
                title={file.path}
              >
                {collapsed
                  ? <ChevronRight size={12} class={styles.fileHeaderIcon} />
                  : <ChevronDown size={12} class={styles.fileHeaderIcon} />}
                <FileCode size={12} class={styles.fileHeaderIcon} />
                <span class={styles.filePath}>{file.relativePath}</span>
                <span class={styles.matchCount}>{file.matches.length}</span>
              </button>
              {!collapsed && file.matches.map((match, mi) => (
                <MatchLine
                  key={`${file.path}:${match.lineNumber}:${mi}`}
                  match={match}
                  onClick={() => onOpenFile(file.path, match.lineNumber)}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MatchLine({ match, onClick }: { match: FsSearchMatch; onClick: () => void }) {
  const { lineText, lineNumber, matchStart, matchEnd } = match
  const before = lineText.slice(0, matchStart)
  const highlighted = lineText.slice(matchStart, matchEnd)
  const after = lineText.slice(matchEnd)

  return (
    <button class={styles.matchItem} onClick={onClick}>
      <span class={styles.matchLineNum}>{lineNumber}</span>
      <span class={styles.matchText}>
        {before}
        <span class={styles.highlight}>{highlighted}</span>
        {after}
      </span>
    </button>
  )
}
