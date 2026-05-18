import { Fragment } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { ChevronRight, Folder, FolderOpen, Home, FileText, Star, X } from 'lucide-preact'
import clsx from 'clsx'
import { fsCompletions, fsTree } from '../../lib/api'
import type { FsCompletion } from '../../types'
import styles from './FolderPicker.module.css'

export interface FolderPickerSuggestion {
  path: string
  label: string
  icon?: 'home' | 'folder' | 'document'
}

export interface FolderPickerProps {
  visible: boolean
  onClose: () => void
  /** Called when the user confirms a folder. The component closes itself after. */
  onSelect: (path: string) => void
  initialPath?: string
  title?: string
  /** Starred paths, persisted by the caller. */
  favorites: string[]
  onFavoritesChange: (next: string[]) => void
  /** Recents are optional — supply both to enable recents UI + auto-recording. */
  recents?: string[]
  onRecentsChange?: (next: string[]) => void
  recentsMax?: number
  suggestedPaths?: FolderPickerSuggestion[]
  /** Show hidden folders inside the Browse… modal. */
  showHiddenFiles?: boolean
}

const DEFAULT_SUGGESTIONS: FolderPickerSuggestion[] = [
  { path: '~/projects', label: '~/projects', icon: 'folder' },
  { path: '~', label: 'Home', icon: 'home' },
  { path: '~/Documents', label: 'Documents', icon: 'document' },
]

function normalizeFolderPath(p: string): string {
  const trimmed = p.trim()
  if (trimmed.length <= 1) return trimmed
  return trimmed.replace(/\/+$/, '')
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || p
}

function suggestionIcon(kind?: FolderPickerSuggestion['icon']) {
  if (kind === 'home') return <Home size={12} />
  if (kind === 'document') return <FileText size={12} />
  return <Folder size={12} />
}

interface BrowserEntry {
  name: string
  path: string
}

export function FolderPicker(props: FolderPickerProps) {
  const {
    visible,
    onClose,
    onSelect,
    initialPath,
    title = 'Open Folder',
    favorites,
    onFavoritesChange,
    recents,
    onRecentsChange,
    recentsMax = 10,
    suggestedPaths = DEFAULT_SUGGESTIONS,
    showHiddenFiles = false,
  } = props

  const [pathValue, setPathValue] = useState(initialPath ?? '~/')
  const [completions, setCompletions] = useState<FsCompletion[]>([])
  const [completionIndex, setCompletionIndex] = useState(-1)
  const [shimmerPath, setShimmerPath] = useState<string | null>(null)

  const [showBrowse, setShowBrowse] = useState(false)
  const [browserCwd, setBrowserCwd] = useState('')
  const [browserEntries, setBrowserEntries] = useState<BrowserEntry[]>([])
  const [browserLoading, setBrowserLoading] = useState(false)
  const [browserError, setBrowserError] = useState<string | null>(null)
  /** "Show all" toggle in the Browse modal — reveals dotfile dirs (.git, .Trash)
   *  AND normally-filtered dirs (node_modules, dist, .next, .cache). */
  const [showAll, setShowAll] = useState(false)

  const completionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Reset on each open
  useEffect(() => {
    if (!visible) return
    setPathValue(initialPath ?? '~/')
    setCompletions([])
    setCompletionIndex(-1)
    setShowBrowse(false)
    setBrowserError(null)
    requestAnimationFrame(() => inputRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const fetchCompletions = useCallback((prefix: string) => {
    if (completionTimer.current) clearTimeout(completionTimer.current)
    if (!prefix || prefix.length < 2) {
      setCompletions([])
      setCompletionIndex(-1)
      return
    }
    completionTimer.current = setTimeout(async () => {
      try {
        const result = await fsCompletions(prefix)
        setCompletions(result.completions)
        setCompletionIndex(-1)
      } catch {
        setCompletions([])
      }
    }, 150)
  }, [])

  const isFavorite = useCallback(
    (path: string) => favorites.includes(normalizeFolderPath(path)),
    [favorites]
  )

  const toggleFavorite = useCallback(
    (path: string) => {
      const normalized = normalizeFolderPath(path)
      if (!normalized) return
      const has = favorites.includes(normalized)
      const next = has ? favorites.filter((p) => p !== normalized) : [normalized, ...favorites]
      onFavoritesChange(next)
      if (!has) {
        setShimmerPath(normalized)
        window.setTimeout(() => setShimmerPath((curr) => (curr === normalized ? null : curr)), 900)
      }
    },
    [favorites, onFavoritesChange]
  )

  const recordRecent = useCallback(
    (path: string) => {
      if (!onRecentsChange) return
      const normalized = normalizeFolderPath(path)
      if (!normalized) return
      const list = recents ?? []
      const next = [normalized, ...list.filter((f) => f !== normalized)].slice(0, recentsMax)
      onRecentsChange(next)
    },
    [recents, onRecentsChange, recentsMax]
  )

  const handleSubmit = useCallback(
    (raw: string) => {
      if (!raw.trim()) return
      const trimmed = normalizeFolderPath(raw)
      recordRecent(trimmed)
      onSelect(trimmed)
      onClose()
    },
    [recordRecent, onSelect, onClose]
  )

  const handlePathInputChange = useCallback(
    (value: string) => {
      setPathValue(value)
      fetchCompletions(value)
    },
    [fetchCompletions]
  )

  const acceptCompletion = useCallback(
    (completion: FsCompletion | { path: string; name: string }) => {
      const newValue = completion.path + '/'
      setPathValue(newValue)
      setCompletions([])
      setCompletionIndex(-1)
      fetchCompletions(newValue)
    },
    [fetchCompletions]
  )

  const loadBrowserDir = useCallback(
    async (dir: string) => {
      setBrowserLoading(true)
      setBrowserError(null)
      try {
        const tree = await fsTree(dir, 1, showHiddenFiles || showAll, showAll)
        const dirs = (tree.entries || [])
          .filter((e: any) => e.type === 'directory')
          .map((e: any) => ({ name: e.name, path: e.path }))
          .sort((a: BrowserEntry, b: BrowserEntry) => a.name.localeCompare(b.name))
        setBrowserCwd(tree.path)
        setBrowserEntries(dirs)
      } catch (err) {
        setBrowserError(err instanceof Error ? err.message : 'Failed to load directory')
        setBrowserEntries([])
      } finally {
        setBrowserLoading(false)
      }
    },
    [showHiddenFiles, showAll]
  )

  // Refresh the browse listing whenever the showAll toggle flips while open.
  useEffect(() => {
    if (showBrowse && browserCwd) {
      void loadBrowserDir(browserCwd)
    }
    // loadBrowserDir is intentionally NOT in deps — we only want this to fire
    // when the toggle changes, not on every callback identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll])

  const openBrowse = useCallback(() => {
    const v = pathValue.trim()
    let start = '~/'
    if (v) {
      if (v.endsWith('/')) {
        start = v.length > 1 ? v.slice(0, -1) : v
      } else if (v.includes('/')) {
        const idx = v.lastIndexOf('/')
        start = v.slice(0, idx) || '/'
      } else {
        start = v
      }
    }
    if (start === '~') start = '~/'
    setShowBrowse(true)
    void loadBrowserDir(start)
  }, [pathValue, loadBrowserDir])

  const closeBrowse = useCallback(() => setShowBrowse(false), [])
  const confirmBrowse = useCallback(() => {
    if (!browserCwd) return
    setShowBrowse(false)
    handleSubmit(browserCwd)
  }, [browserCwd, handleSubmit])

  const filteredRecents = useMemo(() => {
    if (!recents) return []
    return recents.filter((r) => !favorites.includes(normalizeFolderPath(r)))
  }, [recents, favorites])

  if (!visible) return null

  const showCompletions = completions.length > 0
  const hasFavorites = favorites.length > 0
  const hasRecents = filteredRecents.length > 0

  return (
    <>
      {!showBrowse && (
        <div class={styles.overlay} onClick={onClose} data-testid="folder-picker">
          <div class={styles.modal} onClick={(e: Event) => e.stopPropagation()}>
            <div class={styles.modalHeader}>
              <label class={styles.label}>{title}</label>
              <button
                type="button"
                class={styles.closeBtn}
                onClick={onClose}
                title="Close (Esc)"
                aria-label="Close"
                data-testid="folder-picker--close"
              >
                <X size={16} />
              </button>
            </div>
            <div class={styles.row}>
              <input
                ref={(el) => { inputRef.current = el }}
                class={styles.field}
                type="text"
                value={pathValue}
                onInput={(e) => handlePathInputChange((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setCompletionIndex((i) => Math.min(i + 1, completions.length - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setCompletionIndex((i) => Math.max(i - 1, -1))
                  } else if (e.key === 'Tab') {
                    // Always preventDefault so focus never escapes to the
                    // Browse button. Accept the active completion if there
                    // is one; otherwise do nothing (leaves the user's typed
                    // path intact). Use the Browse button for explicit
                    // navigation — Tab never teleports anywhere unexpected.
                    e.preventDefault()
                    if (completions.length > 0) {
                      const idx = completionIndex >= 0 ? completionIndex : 0
                      acceptCompletion(completions[idx])
                    }
                  } else if (e.key === 'ArrowRight' && completions.length > 0 && completionIndex >= 0) {
                    e.preventDefault()
                    acceptCompletion(completions[completionIndex])
                  } else if (e.key === 'Enter') {
                    if (completionIndex >= 0 && completions[completionIndex]) {
                      handleSubmit(completions[completionIndex].path)
                    } else {
                      handleSubmit(pathValue)
                    }
                  } else if (e.key === 'Escape') {
                    if (completions.length > 0) {
                      setCompletions([])
                      setCompletionIndex(-1)
                    } else {
                      onClose()
                    }
                  }
                }}
                placeholder="/path/to/folder"
                spellcheck={false}
                data-testid="folder-picker--input"
              />
              <button
                type="button"
                class={styles.btn}
                onClick={openBrowse}
                title="Browse for a folder"
              >
                <FolderOpen size={13} />
                <span>Browse…</span>
              </button>
              {pathValue.trim().length > 0 && (
                <button
                  type="button"
                  class={clsx(styles.btn, styles.starBtn, isFavorite(pathValue) && styles.starBtnActive)}
                  onClick={() => toggleFavorite(pathValue)}
                  title={isFavorite(pathValue) ? 'Unstar this path' : 'Star this path'}
                  aria-pressed={isFavorite(pathValue)}
                >
                  <Star size={13} />
                  <span>{isFavorite(pathValue) ? 'Starred' : 'Star path'}</span>
                </button>
              )}
            </div>

            {showCompletions && (
              <div class={styles.completions}>
                {completions.map((c, i) => (
                  <div
                    key={c.path}
                    class={clsx(styles.completionItem, i === completionIndex && styles.completionItemActive)}
                    onMouseEnter={() => setCompletionIndex(i)}
                  >
                    <button
                      type="button"
                      class={styles.completionOpen}
                      onClick={() => handleSubmit(c.path)}
                      title={`Open ${c.path}`}
                    >
                      <Folder size={14} />
                      <span class={styles.completionName}>{c.name}</span>
                      <span class={styles.completionPath}>{c.path}</span>
                    </button>
                    <button
                      type="button"
                      class={styles.completionDrill}
                      onClick={(e: Event) => { e.stopPropagation(); acceptCompletion(c) }}
                      title="Browse inside"
                      aria-label={`Browse inside ${c.name}`}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!showCompletions && !hasFavorites && !hasRecents && (
              <div class={styles.empty}>
                <div class={styles.emptyGlyph}><Star size={26} /></div>
                <h3 class={styles.emptyTitle}>Open your first folder</h3>
                <p class={styles.emptyBody}>
                  Type a path above or click <kbd class={styles.kbd}>Browse…</kbd> to navigate.
                  Folders you open will show up as recents; star any you want pinned.
                </p>
                <div class={styles.suggest}>
                  {suggestedPaths.map((s) => (
                    <button
                      key={s.path}
                      type="button"
                      class={styles.suggestChip}
                      onClick={() => {
                        setPathValue(s.path + '/')
                        fetchCompletions(s.path + '/')
                      }}
                    >
                      {suggestionIcon(s.icon)}
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!showCompletions && hasFavorites && (
              <>
                <span class={styles.sectionLabel}>Favorites</span>
                <div class={styles.rows}>
                  {favorites.map((folder) => (
                    <div
                      key={folder}
                      class={clsx(styles.rowEntry, shimmerPath === folder && styles.rowShimmer)}
                      data-testid={`folder-picker--favorite-${folder}`}
                    >
                      <span class={styles.rowIcon}><FolderOpen size={14} /></span>
                      <button
                        type="button"
                        class={styles.rowOpen}
                        onClick={() => handleSubmit(folder)}
                        title={`Open ${folder}`}
                      >
                        <span class={styles.rowName}>{basename(folder)}</span>
                        <span class={styles.rowPath}>{folder}</span>
                      </button>
                      <button
                        type="button"
                        class={clsx(styles.rowStar, styles.rowStarActive)}
                        onClick={(e: Event) => { e.stopPropagation(); toggleFavorite(folder) }}
                        title="Unstar"
                        aria-pressed="true"
                      >
                        <Star size={13} fill="currentColor" />
                      </button>
                      <button
                        type="button"
                        class={styles.rowDrill}
                        onClick={(e: Event) => { e.stopPropagation(); acceptCompletion({ name: basename(folder), path: folder }) }}
                        title="Browse inside"
                        aria-label={`Browse inside ${folder}`}
                      >
                        <ChevronRight size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {!showCompletions && hasRecents && (
              <>
                <span class={styles.sectionLabel}>Recent</span>
                <div class={styles.rows}>
                  {filteredRecents.map((folder) => (
                    <div key={folder} class={clsx(styles.rowEntry, styles.rowRecent)}>
                      <span class={styles.rowIcon}><Folder size={14} /></span>
                      <button
                        type="button"
                        class={styles.rowOpen}
                        onClick={() => handleSubmit(folder)}
                        title={`Open ${folder}`}
                      >
                        <span class={styles.rowName}>{basename(folder)}</span>
                        <span class={styles.rowPath}>{folder}</span>
                      </button>
                      <button
                        type="button"
                        class={styles.rowStar}
                        onClick={(e: Event) => { e.stopPropagation(); toggleFavorite(folder) }}
                        title="Star"
                        aria-pressed="false"
                      >
                        <Star size={13} />
                      </button>
                      <button
                        type="button"
                        class={styles.rowDrill}
                        onClick={(e: Event) => { e.stopPropagation(); acceptCompletion({ name: basename(folder), path: folder }) }}
                        title="Browse inside"
                        aria-label={`Browse inside ${folder}`}
                      >
                        <ChevronRight size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showBrowse && (
        <div class={styles.overlay} onClick={closeBrowse}>
          <div class={clsx(styles.modal, styles.modalWide)} onClick={(e: Event) => e.stopPropagation()}>
            <div class={styles.browseHeader}>
              <label class={styles.label}>Browse folders</label>
              <div class={styles.browseHeaderRight}>
                <label class={styles.showAllToggle} title="Show .git, node_modules, dist, .cache, dotfile directories, etc.">
                  <input
                    type="checkbox"
                    checked={showAll}
                    onChange={(e) => setShowAll((e.target as HTMLInputElement).checked)}
                  />
                  Show all
                </label>
                <button
                  type="button"
                  class={styles.closeBtn}
                  onClick={closeBrowse}
                  title="Close (Esc)"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div class={styles.crumbs}>
              {(() => {
                const isAbsolute = browserCwd.startsWith('/')
                const isHome = browserCwd === '~' || browserCwd.startsWith('~/')
                const segments = browserCwd.split('/').filter(Boolean)
                const items: { label: string; path: string }[] = []
                if (isAbsolute) {
                  items.push({ label: '/', path: '/' })
                  let acc = ''
                  for (const seg of segments) {
                    acc = `${acc}/${seg}`
                    items.push({ label: seg, path: acc })
                  }
                } else if (isHome) {
                  items.push({ label: '~', path: '~' })
                  let acc = '~'
                  for (let i = 1; i < segments.length; i++) {
                    acc = `${acc}/${segments[i]}`
                    items.push({ label: segments[i], path: acc })
                  }
                } else {
                  let acc = ''
                  segments.forEach((seg, i) => {
                    acc = i === 0 ? seg : `${acc}/${seg}`
                    items.push({ label: seg, path: acc })
                  })
                }
                return items.map((it, i) => {
                  // The root crumb is rendered as "/" already, so suppress the
                  // separator that would otherwise sit between it and the first
                  // segment (avoids the visual "/  /  Users" double slash).
                  const prevWasRoot = i > 0 && items[i - 1].label === '/'
                  return (
                    <Fragment key={`${it.path}-${i}`}>
                      {i > 0 && !prevWasRoot && <span class={styles.crumbSep}>/</span>}
                      <button
                        type="button"
                        class={clsx(styles.crumbBtn, i === items.length - 1 && styles.crumbCurrent)}
                        onClick={() => loadBrowserDir(it.path)}
                        title={it.path}
                      >
                        {it.label}
                      </button>
                    </Fragment>
                  )
                })
              })()}
            </div>
            <div class={styles.browseList}>
              {browserLoading && <div class={styles.browseStatus}>Loading…</div>}
              {browserError && <div class={styles.browseError}>{browserError}</div>}
              {!browserLoading && !browserError && browserEntries.length === 0 && (
                <div class={styles.browseStatus}>No subfolders</div>
              )}
              {!browserLoading && !browserError && browserEntries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  class={styles.browseItem}
                  onClick={() => loadBrowserDir(entry.path)}
                  title={entry.path}
                >
                  <Folder size={14} />
                  <span class={styles.browseItemName}>{entry.name}</span>
                  <ChevronRight size={14} class={styles.browseItemChevron} />
                </button>
              ))}
            </div>
            <div class={styles.browseActions}>
              <button type="button" class={styles.modalBtn} onClick={closeBrowse}>
                Cancel
              </button>
              <button
                type="button"
                class={styles.modalBtnPrimary}
                onClick={confirmBrowse}
                disabled={!browserCwd}
              >
                Open this folder
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
