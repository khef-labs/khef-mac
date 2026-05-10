import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import Fuse from 'fuse.js'
import clsx from 'clsx'
import { FileCode, Search, Terminal } from 'lucide-preact'
import { fsFind } from '../../lib/api'
import type { FsFindFile } from '../../types/api'
import styles from './QuickOpen.module.css'

export interface PaletteCommand {
  id: string
  label: string
  shortcut?: string
  action: () => void
}

type QuickOpenScope = 'commands' | 'project' | 'global'

interface QuickOpenProps {
  visible: boolean
  rootPath: string
  onClose: () => void
  onSelect: (absolutePath: string) => void | Promise<void>
  commands?: PaletteCommand[]
  showHidden?: boolean
  initialScope?: QuickOpenScope
}

interface QuickOpenResult {
  item: FsFindFile
  score?: number
  relativePathIndices: ReadonlyArray<readonly [number, number]>
}

const MAX_RESULTS = 20
const GLOBAL_SEARCH_ROOT = '~/'
const CLIENT_IGNORED_SEGMENTS = new Set([
  'build',
  'dist',
  'target',
  'out',
  '.vite',
  '.svelte-kit',
])

function isClientIgnoredPath(file: FsFindFile): boolean {
  const segments = file.relativePath.split('/').filter(Boolean)
  return segments.some((segment) => CLIENT_IGNORED_SEGMENTS.has(segment))
}

function normalizeIndices(indices: ReadonlyArray<readonly number[]> | undefined): ReadonlyArray<readonly [number, number]> {
  if (!indices) return []
  const output: Array<readonly [number, number]> = []
  for (const pair of indices) {
    if (pair.length < 2) continue
    output.push([pair[0], pair[1]])
  }
  return output
}

function highlightText(
  text: string,
  indices: ReadonlyArray<readonly [number, number]>
) {
  if (indices.length === 0) return text

  const parts: ComponentChildren[] = []
  let cursor = 0

  for (let i = 0; i < indices.length; i += 1) {
    const [start, end] = indices[i]
    if (start > cursor) {
      parts.push(<span key={`t-${i}-${cursor}`}>{text.slice(cursor, start)}</span>)
    }
    parts.push(
      <mark key={`m-${i}-${start}`} class={styles.match}>
        {text.slice(start, end + 1)}
      </mark>
    )
    cursor = end + 1
  }

  if (cursor < text.length) {
    parts.push(<span key={`t-end-${cursor}`}>{text.slice(cursor)}</span>)
  }

  return parts
}

export function QuickOpen({ visible, rootPath, onClose, onSelect, commands = [], showHidden, initialScope }: QuickOpenProps) {
  const [scope, setScope] = useState<QuickOpenScope>(initialScope ?? 'commands')
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<FsFindFile[]>([])
  const [loadedRootPath, setLoadedRootPath] = useState('')
  const [loadedQuery, setLoadedQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [results, setResults] = useState<QuickOpenResult[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [filteredCommands, setFilteredCommands] = useState<PaletteCommand[]>([])
  const focusInput = () => {
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }
  const effectiveRootPath = scope === 'project' ? rootPath : GLOBAL_SEARCH_ROOT
  const normalizedQuery = query.trim()

  useEffect(() => {
    if (scope === 'commands') {
      setFiles([])
      setResults([])
      setActiveIndex(0)
      setQuery('')
      setError(null)
      return
    }
    if (scope !== 'project') return
    setFiles([])
    setLoadedRootPath('')
    setLoadedQuery('')
    setError(null)
    setResults([])
    setActiveIndex(0)
    setQuery('')
  }, [rootPath, scope])

  useEffect(() => {
    if (!visible) return
    // Refresh index on each open so backend filtering/ranking changes are picked up immediately.
    setLoadedRootPath('')
    setLoadedQuery('')
    setFiles([])
    setQuery('')
    setActiveIndex(0)
    setError(null)
    setScope(initialScope ?? 'commands')
    setFilteredCommands(commands)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [visible])

  useEffect(() => {
    if (!visible) return
    if (scope === 'commands') return
    if (scope === 'project' && !rootPath) return
    if (scope === 'global' && normalizedQuery.length < 2) {
      setFiles([])
      setLoadedRootPath(effectiveRootPath)
      setLoadedQuery('')
      setLoading(false)
      setError(null)
      return
    }
    if (loadedRootPath === effectiveRootPath && loadedQuery === normalizedQuery) return

    let cancelled = false
    const timeout = setTimeout(() => {
      setLoading(true)
      setError(null)

      fsFind(
        effectiveRootPath,
        scope === 'project' ? 5000 : 250,
        scope === 'global' ? normalizedQuery : undefined,
        showHidden
      )
        .then((response) => {
          if (cancelled) return
          setFiles(response.files.filter((file) => !isClientIgnoredPath(file)))
          // Cache by requested root + query (requested root may differ from expanded root)
          setLoadedRootPath(effectiveRootPath)
          setLoadedQuery(normalizedQuery)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setFiles([])
          setLoadedRootPath(effectiveRootPath)
          setLoadedQuery(normalizedQuery)
          setError(err instanceof Error ? err.message : 'Failed to load file index')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, scope === 'global' ? 180 : 0)

    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [visible, scope, rootPath, effectiveRootPath, normalizedQuery, loadedRootPath, loadedQuery, showHidden])

  // Invalidate cache when showHidden changes so files are re-fetched
  useEffect(() => {
    setLoadedRootPath('')
    setLoadedQuery('')
  }, [showHidden])

  // Filter commands when in commands scope
  useEffect(() => {
    if (!visible || scope !== 'commands') return
    const trimmed = normalizedQuery.toLowerCase()
    if (!trimmed) {
      setFilteredCommands(commands)
    } else {
      setFilteredCommands(
        commands.filter((cmd) =>
          cmd.label.toLowerCase().includes(trimmed) ||
          cmd.id.toLowerCase().includes(trimmed)
        )
      )
    }
    setActiveIndex(0)
  }, [visible, scope, normalizedQuery, commands])

  useEffect(() => {
    itemRefs.current = []

    if (!visible) {
      setResults([])
      setActiveIndex(0)
      return
    }

    if (scope === 'commands') {
      setResults([])
      return
    }

    const trimmed = normalizedQuery
    if (!trimmed) {
      setResults([])
      setActiveIndex(0)
      return
    }

    const lowerQuery = trimmed.toLowerCase()
    const seen = new Set<string>()
    const prioritized: QuickOpenResult[] = []

    const pushMatches = (predicate: (file: FsFindFile) => boolean) => {
      for (const file of files) {
        if (prioritized.length >= MAX_RESULTS) break
        if (seen.has(file.path)) continue
        if (!predicate(file)) continue
        seen.add(file.path)
        prioritized.push({
          item: file,
          score: 0,
          relativePathIndices: [],
        })
      }
    }

    // Strong filename-first ranking before fuzzy path search.
    pushMatches((file) => file.name.toLowerCase() === lowerQuery)
    pushMatches((file) => file.name.toLowerCase().startsWith(lowerQuery))
    pushMatches((file) => file.name.toLowerCase().includes(lowerQuery))

    if (prioritized.length >= MAX_RESULTS) {
      setResults(prioritized.slice(0, MAX_RESULTS))
      setActiveIndex(0)
      return
    }

    const fuse = new Fuse(files, {
      includeScore: true,
      includeMatches: true,
      threshold: 0.28,
      ignoreLocation: true,
      keys: [
        { name: 'name', weight: 1.0 },
        { name: 'relativePath', weight: 0.45 },
      ],
    })

    const next = [
      ...prioritized,
      ...fuse.search(trimmed, { limit: MAX_RESULTS * 2 })
        .filter((result) => !seen.has(result.item.path))
        .slice(0, Math.max(0, MAX_RESULTS - prioritized.length))
        .map((result) => {
          const relativePathMatch = result.matches?.find((match) => match.key === 'relativePath')
          return {
            item: result.item,
            score: result.score,
            relativePathIndices: normalizeIndices(relativePathMatch?.indices),
          }
        }),
    ]
    setResults(next)
    setActiveIndex(0)
  }, [visible, normalizedQuery, files])

  useEffect(() => {
    if (!visible) return
    const target = itemRefs.current[activeIndex]
    target?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, visible, results])

  if (!visible) return null

  const submitSelection = (item: FsFindFile) => {
    void Promise.resolve(onSelect(item.path)).finally(onClose)
  }

  const submitCommand = (cmd: PaletteCommand) => {
    onClose()
    cmd.action()
  }

  const activeItemCount = scope === 'commands' ? filteredCommands.length : results.length

  return (
    <div class={styles.overlay} onClick={onClose}>
      <div class={styles.modal} onClick={(e: Event) => e.stopPropagation()}>
        <div class={styles.header}>
          <Search size={14} />
          <span class={styles.title}>{scope === 'commands' ? 'Command Palette' : 'Find File'}</span>
          <div class={styles.scopeToggle} role="tablist" aria-label="Search scope">
            <button
              class={clsx(styles.scopeButton, scope === 'commands' && styles.scopeButtonActive)}
              onClick={() => {
                setScope('commands')
                focusInput()
              }}
              role="tab"
              aria-selected={scope === 'commands'}
            >
              Commands
            </button>
            <button
              class={clsx(styles.scopeButton, scope === 'project' && styles.scopeButtonActive)}
              onClick={() => {
                setScope('project')
                focusInput()
              }}
              role="tab"
              aria-selected={scope === 'project'}
            >
              Project
            </button>
            <button
              class={clsx(styles.scopeButton, scope === 'global' && styles.scopeButtonActive)}
              onClick={() => {
                setScope('global')
                focusInput()
              }}
              role="tab"
              aria-selected={scope === 'global'}
            >
              Global
            </button>
          </div>
        </div>

        <input
          ref={inputRef}
          class={styles.input}
          type="text"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActiveIndex((idx) => Math.min(idx + 1, Math.max(activeItemCount - 1, 0)))
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActiveIndex((idx) => Math.max(idx - 1, 0))
              return
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              if (scope === 'commands') {
                if (filteredCommands[activeIndex]) {
                  submitCommand(filteredCommands[activeIndex])
                }
                return
              }
              if (results[activeIndex]) {
                submitSelection(results[activeIndex].item)
                return
              }
              if (scope === 'global' && (normalizedQuery.startsWith('/') || normalizedQuery.startsWith('~/'))) {
                void Promise.resolve(onSelect(normalizedQuery)).finally(onClose)
              }
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
          placeholder={scope === 'commands'
            ? 'Type a command...'
            : scope === 'project'
            ? 'Type a file name or path...'
            : 'Search any file (or enter an absolute path)...'}
          autoFocus
        />

        {scope !== 'commands' && (
          <div class={styles.statusLine}>
            <span class={styles.statusRoot} title={effectiveRootPath}>{effectiveRootPath}</span>
            <span class={styles.statusSep} aria-hidden="true">·</span>
            <span class={styles.statusInfo}>
              {scope === 'project'
                ? (loading
                  ? 'Indexing project files…'
                  : `${files.length.toLocaleString()} files indexed`)
                : (loading
                  ? 'Searching…'
                  : normalizedQuery.length >= 2
                    ? `${files.length.toLocaleString()} matches`
                    : 'Type at least 2 characters to search')}
            </span>
          </div>
        )}

        {scope === 'commands' ? (
          <div class={styles.results} role="listbox" aria-label="Command palette results">
            {filteredCommands.length === 0 ? (
              <div class={styles.message}>No matching commands</div>
            ) : (
              filteredCommands.map((cmd, index) => (
                <button
                  key={cmd.id}
                  ref={(el) => { itemRefs.current[index] = el }}
                  class={clsx(styles.resultItem, index === activeIndex && styles.resultItemActive)}
                  onClick={() => submitCommand(cmd)}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                >
                  <Terminal size={14} class={styles.resultIcon} />
                  <div class={styles.resultText}>
                    <div class={styles.resultPath}>{cmd.label}</div>
                  </div>
                  {cmd.shortcut && (
                    <span class={styles.shortcutBadge}>{cmd.shortcut}</span>
                  )}
                </button>
              ))
            )}
          </div>
        ) : (loading || error || query.trim()) && (
          <div class={styles.results} role="listbox" aria-label="Quick open results">
            {loading ? (
              <div class={styles.message}>
                {scope === 'project' ? 'Indexing project files...' : `Searching ${effectiveRootPath}...`}
              </div>
            ) : error ? (
              <div class={clsx(styles.message, styles.messageError)}>{error}</div>
            ) : scope === 'global' && normalizedQuery.length < 2 ? (
              <div class={styles.message}>Type at least 2 characters to search home</div>
            ) : results.length === 0 ? (
              <div class={styles.message}>
                {scope === 'project' && files.length === 0
                  ? 'No files found under this folder'
                  : 'No matching files'}
              </div>
            ) : (
              results.map((result, index) => (
                <button
                  key={result.item.path}
                  ref={(el) => { itemRefs.current[index] = el }}
                  class={clsx(styles.resultItem, index === activeIndex && styles.resultItemActive)}
                  onClick={() => submitSelection(result.item)}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  title={result.item.path}
                >
                  <FileCode size={14} class={styles.resultIcon} />
                  <div class={styles.resultText}>
                    <div class={styles.resultPath}>
                      {highlightText(result.item.relativePath, result.relativePathIndices)}
                    </div>
                    <div class={styles.resultMeta}>
                      <span class={styles.resultName}>{result.item.name}</span>
                      <span class={styles.resultAbsolutePath}>{result.item.path}</span>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        )}

        <div class={styles.footer}>
          <span class={styles.footerHint}>
            <kbd class={styles.kbd}>↵</kbd> Open
          </span>
          <span class={styles.footerHint}>
            <kbd class={styles.kbd}>↑</kbd>
            <kbd class={styles.kbd}>↓</kbd> Navigate
          </span>
          <span class={styles.footerHint}>
            <kbd class={styles.kbd}>Esc</kbd> Close
          </span>
        </div>
      </div>
    </div>
  )
}
