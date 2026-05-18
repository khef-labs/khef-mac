import { useEffect, useMemo, useRef, useState, useCallback } from 'preact/hooks'
import {
  fsReveal,
  getImageBrowserMetadata,
  imageBrowserFileUrl,
  listImageBrowserImages,
  saveImageAsMemory,
  type ListedImage,
  type ImageMetadata,
} from '../../lib/api'
import { fsDelete } from '../../lib/api'
import { loadStore, saveStore } from '../../lib/store'
import { LoadingMessage, useToast } from '../../components/ui'
import { FolderPicker } from '../../components/folder-picker/FolderPicker'
import { isDesktopApp } from '../../lib/settings'
import { Star, ChevronLeft, ChevronRight, FolderOpen, FolderTree, Copy, Trash2, ImagePlus, FolderInput, Clock, X } from 'lucide-preact'
import clsx from 'clsx'
import styles from './ImageBrowserPage.module.css'

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || p
}

function normalizeFolderPath(p: string): string {
  const trimmed = p.trim()
  if (trimmed.length <= 1) return trimmed
  return trimmed.replace(/\/+$/, '')
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
}

export function ImageBrowserPage() {
  const initial = useMemo(() => loadStore().imageBrowser, [])
  const [loadedPath, setLoadedPath] = useState(initial.currentPath)
  const [recursive, setRecursive] = useState(initial.recursive)
  const [view, setView] = useState<'grid' | 'single'>(initial.view)
  const [metaOpen, setMetaOpen] = useState(initial.metaOpen)
  const [folderFavorites, setFolderFavorites] = useState<string[]>(initial.folderFavorites)
  const [folderRecents, setFolderRecents] = useState<string[]>(initial.folderRecents)
  const [imageFavorites, setImageFavorites] = useState(new Set(initial.imageFavorites))
  const [saveProject] = useState(initial.saveProject)
  const [sidebarWidth, setSidebarWidth] = useState(initial.sidebarWidth)
  const [favoritesHeight, setFavoritesHeight] = useState(initial.favoritesHeight)
  const [dragging, setDragging] = useState(false)
  const [draggingRow, setDraggingRow] = useState(false)
  const sidebarRef = useRef<HTMLElement | null>(null)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [images, setImages] = useState<ListedImage[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [metadata, setMetadata] = useState<ImageMetadata | null>(null)
  const [busy, setBusy] = useState(false)

  const filmstripRef = useRef<HTMLDivElement | null>(null)
  const { showToast } = useToast()

  const current: ListedImage | null = images[selectedIdx] ?? null

  // Persist preferences whenever they change
  useEffect(() => {
    saveStore({ imageBrowser: { ...loadStore().imageBrowser, recursive, view, metaOpen } })
  }, [recursive, view, metaOpen])

  const loadDir = useCallback(async (dir: string) => {
    if (!dir.trim()) return
    setLoading(true)
    setError(null)
    try {
      const result = await listImageBrowserImages(dir, recursive)
      setImages(result.images)
      setSelectedIdx(0)
      setLoadedPath(result.root)
      saveStore({ imageBrowser: { ...loadStore().imageBrowser, currentPath: result.root } })
    } catch (err: any) {
      const status = err?.response?.status
      const body = await err?.response?.json?.().catch(() => null)
      setImages([])
      setError(body?.error ?? (status ? `HTTP ${status}` : (err?.message ?? 'Failed to load directory')))
    } finally {
      setLoading(false)
    }
  }, [recursive])

  // Hydrate on first mount
  useEffect(() => {
    if (initial.currentPath) loadDir(initial.currentPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-list when recursive flips and a path is already loaded
  useEffect(() => {
    if (loadedPath) loadDir(loadedPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recursive])

  // Fetch metadata when selection changes
  useEffect(() => {
    if (!current) { setMetadata(null); return }
    let cancelled = false
    getImageBrowserMetadata(current.path)
      .then((m) => { if (!cancelled) setMetadata(m) })
      .catch(() => { if (!cancelled) setMetadata(null) })
    return () => { cancelled = true }
  }, [current?.path])

  // Auto-scroll filmstrip to current
  useEffect(() => {
    if (view !== 'single') return
    const el = filmstripRef.current?.querySelector('img.' + styles.current) as HTMLImageElement | null
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [view, selectedIdx])

  // Keyboard nav
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return
      if (pickerOpen) return
      if (!images.length) return
      const k = e.key.toLowerCase()
      if (e.key === 'ArrowLeft') { e.preventDefault(); setSelectedIdx((i) => (i - 1 + images.length) % images.length) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setSelectedIdx((i) => (i + 1) % images.length) }
      else if (k === 'f') toggleImageFavorite(images[selectedIdx])
      else if (k === 'm') setMetaOpen((v) => !v)
      else if (k === 'g') setView('grid')
      else if (k === 's') setView('single')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, selectedIdx, pickerOpen])

  // --- favorites (per-image) ---

  function toggleImageFavorite(img: ListedImage | null) {
    if (!img) return
    setImageFavorites((prev) => {
      const next = new Set(prev)
      if (next.has(img.path)) next.delete(img.path)
      else next.add(img.path)
      saveStore({ imageBrowser: { ...loadStore().imageBrowser, imageFavorites: Array.from(next) } })
      return next
    })
  }

  // --- folder picker glue ---

  function handleFolderSelected(path: string) {
    setPickerOpen(false)
    loadDir(path)
  }

  function handleFolderFavoritesChange(next: string[]) {
    setFolderFavorites(next)
    saveStore({ imageBrowser: { ...loadStore().imageBrowser, folderFavorites: next } })
  }

  function handleFolderRecentsChange(next: string[]) {
    setFolderRecents(next)
    saveStore({ imageBrowser: { ...loadStore().imageBrowser, folderRecents: next } })
  }

  const normalizedLoaded = loadedPath ? normalizeFolderPath(loadedPath) : ''
  const currentIsFavorite = !!normalizedLoaded && folderFavorites.includes(normalizedLoaded)

  function toggleCurrentFavorite() {
    if (!normalizedLoaded) return
    const next = currentIsFavorite
      ? folderFavorites.filter((p) => p !== normalizedLoaded)
      : [normalizedLoaded, ...folderFavorites]
    handleFolderFavoritesChange(next)
  }

  function openSidebarFolder(path: string) {
    loadDir(path)
    setFolderRecents((prev) => {
      const normalized = normalizeFolderPath(path)
      const next = [normalized, ...prev.filter((p) => p !== normalized)].slice(0, 10)
      saveStore({ imageBrowser: { ...loadStore().imageBrowser, folderRecents: next } })
      return next
    })
  }

  function removeFavorite(path: string) {
    handleFolderFavoritesChange(folderFavorites.filter((p) => p !== path))
  }

  function removeRecent(path: string) {
    handleFolderRecentsChange(folderRecents.filter((p) => p !== path))
  }

  const filteredRecents = folderRecents.filter((p) => !folderFavorites.includes(p))

  function handleSidebarResizeMouseDown(e: MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidth
    setDragging(true)
    function onMouseMove(ev: MouseEvent) {
      const next = Math.max(180, Math.min(500, startWidth + ev.clientX - startX))
      setSidebarWidth(next)
    }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      setDragging(false)
      setSidebarWidth((w) => {
        saveStore({ imageBrowser: { ...loadStore().imageBrowser, sidebarWidth: w } })
        return w
      })
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  function handleSectionResizeMouseDown(e: MouseEvent) {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = favoritesHeight
    const sidebarRect = sidebarRef.current?.getBoundingClientRect()
    // Leave at least ~100px for the Recents pane below.
    const maxHeight = sidebarRect ? sidebarRect.height - 120 : 800
    setDraggingRow(true)
    function onMouseMove(ev: MouseEvent) {
      const next = Math.max(80, Math.min(maxHeight, startHeight + ev.clientY - startY))
      setFavoritesHeight(next)
    }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      setDraggingRow(false)
      setFavoritesHeight((h) => {
        saveStore({ imageBrowser: { ...loadStore().imageBrowser, favoritesHeight: h } })
        return h
      })
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  // --- single-image actions ---

  async function handleReveal() {
    if (!current) return
    setBusy(true)
    try {
      await fsReveal(current.path)
      showToast('Revealed in Finder')
    } catch (err: any) {
      showToast(err?.message ?? 'Failed to reveal', undefined, { variant: 'error' })
    } finally { setBusy(false) }
  }

  async function handleCopyPath() {
    if (!current) return
    try {
      await navigator.clipboard.writeText(current.path)
      showToast('Path copied')
    } catch {
      showToast('Clipboard unavailable', undefined, { variant: 'error' })
    }
  }

  async function handleDelete() {
    if (!current) return
    if (!confirm(`Delete ${current.name}?\n\nThis removes the file from disk.`)) return
    setBusy(true)
    try {
      await fsDelete(current.path)
      const removedIdx = selectedIdx
      setImages((prev) => prev.filter((_, i) => i !== removedIdx))
      setSelectedIdx((i) => Math.max(0, Math.min(i, images.length - 2)))
      showToast(`Deleted ${current.name}`)
    } catch (err: any) {
      showToast(err?.message ?? 'Delete failed', undefined, { variant: 'error' })
    } finally { setBusy(false) }
  }

  async function handleSaveAsMemory() {
    if (!current) return
    setBusy(true)
    try {
      const result = await saveImageAsMemory(current.path, saveProject)
      showToast(`Saved to ${saveProject} as memory`, { label: 'Open', href: `/memories/${result.memory.id}` })
    } catch (err: any) {
      const status = err?.response?.status
      const body = await err?.response?.json?.().catch(() => null)
      showToast(body?.error ?? (status ? `HTTP ${status}` : 'Save failed'), undefined, { variant: 'error' })
    } finally { setBusy(false) }
  }

  // --- render ---

  const wrapperStyle: any = { '--kpic-sidebar': `${sidebarWidth}px` }
  if (isDesktopApp()) wrapperStyle['--ib-bottom'] = '0px'

  return (
    <div class={styles.wrapper} style={wrapperStyle} data-testid="image-browser-page">
      <aside
        class={styles.sidebar}
        ref={(el) => { sidebarRef.current = el }}
        style={{ '--kpic-favs': `${favoritesHeight}px` } as any}
      >
        <div class={styles.sidebarSection}>
          <div class={styles.sidebarHead}>
            <span>Favorites</span>
            <span class={styles.count}>{folderFavorites.length || ''}</span>
          </div>
          {folderFavorites.length === 0 ? (
            <div class={styles.sidebarEmpty}>Star a folder to pin it here.</div>
          ) : (
            <div class={styles.sidebarList} data-testid="kpic-sidebar--favorites">
              {folderFavorites.map((path) => (
                <div
                  key={path}
                  class={clsx(styles.sidebarItem, path === normalizedLoaded && styles.active)}
                  onClick={() => openSidebarFolder(path)}
                  title={path}
                  data-testid={`kpic-sidebar--favorite-${path}`}
                >
                  <span class={styles.icon}><Star size={13} fill="currentColor" /></span>
                  <span class={styles.label}>
                    <span class={styles.name}>{basename(path)}</span>
                    <span class={styles.path}>{path}</span>
                  </span>
                  <button
                    class={styles.removeBtn}
                    onClick={(e) => { e.stopPropagation(); removeFavorite(path) }}
                    title="Unstar"
                    aria-label={`Unstar ${path}`}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div
          class={clsx(styles.sectionDivider, draggingRow && styles.dragging)}
          onMouseDown={handleSectionResizeMouseDown}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize favorites section"
          data-testid="kpic--favorites-divider"
        />

        <div class={styles.sidebarSection}>
          <div class={styles.sidebarHead}>
            <span>Recents</span>
            <span class={styles.count}>{filteredRecents.length || ''}</span>
          </div>
          {filteredRecents.length === 0 ? (
            <div class={styles.sidebarEmpty}>Folders you open will show up here.</div>
          ) : (
            <div class={styles.sidebarList} data-testid="kpic-sidebar--recents">
              {filteredRecents.map((path) => (
                <div
                  key={path}
                  class={clsx(styles.sidebarItem, styles.recentItem, path === normalizedLoaded && styles.active)}
                  onClick={() => openSidebarFolder(path)}
                  title={path}
                >
                  <span class={styles.icon}><Clock size={13} /></span>
                  <span class={styles.label}>
                    <span class={styles.name}>{basename(path)}</span>
                    <span class={styles.path}>{path}</span>
                  </span>
                  <button
                    class={styles.removeBtn}
                    onClick={(e) => { e.stopPropagation(); removeRecent(path) }}
                    title="Remove from recents"
                    aria-label={`Remove ${path} from recents`}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      <div
        class={clsx(styles.resizeHandle, dragging && styles.dragging)}
        onMouseDown={handleSidebarResizeMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        data-testid="kpic--resize-handle"
      />

      <main class={styles.main}>
        <div class={styles.toolbar}>
          <button class={styles.changeFolderBtn} onClick={() => setPickerOpen(true)} data-testid="image-browser--open-folder">
            <FolderInput size={14} />
            {loadedPath ? 'Change folder…' : 'Open folder…'}
          </button>
          <div class={styles.currentPath} title={loadedPath || ''}>
            {loadedPath ? <span class={styles.pathText}>{loadedPath}</span> : <span class={styles.pathPlaceholder}>No folder open</span>}
          </div>
          <button
            class={clsx(styles.starToolbarBtn, currentIsFavorite && styles.on)}
            onClick={toggleCurrentFavorite}
            disabled={!loadedPath}
            title={currentIsFavorite ? 'Unstar this folder' : 'Star this folder'}
            aria-pressed={currentIsFavorite}
            data-testid="kpic--star-toggle"
          >
            <Star size={14} fill={currentIsFavorite ? 'currentColor' : 'none'} />
          </button>
          <button
            class={clsx(styles.toggleBtn, recursive && styles.on)}
            onClick={() => setRecursive(!recursive)}
            aria-pressed={recursive}
            title={recursive ? 'Hide images from subfolders' : 'Include images from subfolders'}
            data-testid="image-browser--recursive-toggle"
          >
            <FolderTree size={13} />
            Subfolders
          </button>
          <div class={styles.toggleGroup}>
            <button class={clsx(view === 'grid' && styles.active)} onClick={() => setView('grid')} data-testid="image-browser--view-grid">Grid</button>
            <button class={clsx(view === 'single' && styles.active)} onClick={() => setView('single')} data-testid="image-browser--view-single">Single</button>
          </div>
        </div>

        <div class={styles.status}>
          <span data-testid="image-browser--count">
            {loading ? 'Loading…' : `${images.length} image${images.length === 1 ? '' : 's'}${recursive ? ' (incl. subfolders)' : ''}`}
          </span>
          <span>
            <span class={styles.kbd}>←</span><span class={styles.kbd}>→</span> nav &nbsp;·&nbsp;
            <span class={styles.kbd}>F</span> fav &nbsp;·&nbsp;
            <span class={styles.kbd}>M</span> meta &nbsp;·&nbsp;
            <span class={styles.kbd}>G</span>/<span class={styles.kbd}>S</span> view
          </span>
        </div>

        <div class={styles.content}>
          {loading && !images.length ? (
            <LoadingMessage />
          ) : error ? (
            <div class={clsx(styles.emptyState, styles.errorState)}>{error}</div>
          ) : !loadedPath ? (
            <div class={styles.emptyState}>
              <p>Open a folder to start browsing images.</p>
              <button class={styles.openFolderCta} onClick={() => setPickerOpen(true)}>
                <FolderInput size={14} />
                Open folder…
              </button>
            </div>
          ) : !images.length ? (
            <div class={styles.emptyState}>No images in this folder.</div>
          ) : view === 'grid' ? (
            <div class={styles.grid} data-testid="image-browser--grid">
              {images.map((im, i) => (
                <div
                  key={im.path}
                  class={clsx(styles.tile, i === selectedIdx && styles.selected)}
                  onClick={() => { setSelectedIdx(i); setView('single') }}
                  data-testid={`image-browser--tile-${i}`}
                >
                  <img class={styles.thumb} src={imageBrowserFileUrl(im.path)} alt={im.name} loading="lazy" />
                  <div class={styles.tileCaption}>
                    <span class={styles.fn} title={im.name}>{im.name}</span>
                    <button
                      class={clsx(styles.starBtn, imageFavorites.has(im.path) && styles.on)}
                      onClick={(e) => { e.stopPropagation(); toggleImageFavorite(im) }}
                      title="Toggle favorite"
                    >★</button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div class={styles.single} data-testid="image-browser--single">
              <div class={styles.canvas}>
                {images.length > 1 && (
                  <button class={clsx(styles.navArrow, styles.navPrev)} onClick={() => setSelectedIdx((i) => (i - 1 + images.length) % images.length)} title="Previous (←)">
                    <ChevronLeft size={20} />
                  </button>
                )}
                {current && <img src={imageBrowserFileUrl(current.path)} alt={current.name} />}
                {images.length > 1 && (
                  <button class={clsx(styles.navArrow, styles.navNext)} onClick={() => setSelectedIdx((i) => (i + 1) % images.length)} title="Next (→)">
                    <ChevronRight size={20} />
                  </button>
                )}
              </div>
              <div class={styles.filmstrip} ref={filmstripRef}>
                {images.map((im, i) => (
                  <img
                    key={im.path}
                    src={imageBrowserFileUrl(im.path)}
                    class={clsx(i === selectedIdx && styles.current)}
                    onClick={() => setSelectedIdx(i)}
                    title={im.name}
                    loading="lazy"
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div class={clsx(styles.metaPanel, metaOpen && styles.open)}>
          {current && (
            <>
              <div class={styles.kv}><span class={styles.k}>Name</span><span class={styles.v}>{current.name}</span></div>
              <div class={styles.kv}><span class={styles.k}>Path</span><span class={styles.v}>{current.path}</span></div>
              <div class={styles.kv}><span class={styles.k}>Size</span><span class={styles.v}>{formatBytes(current.size)}</span></div>
              <div class={styles.kv}><span class={styles.k}>Dimensions</span><span class={styles.v}>{metadata?.width ?? '—'} × {metadata?.height ?? '—'}</span></div>
              <div class={styles.kv}><span class={styles.k}>Modified</span><span class={styles.v}>{formatDate(current.modified)}</span></div>
              <div class={styles.kv}><span class={styles.k}>MIME</span><span class={styles.v}>{current.mime}</span></div>
              <div class={styles.kv}><span class={styles.k}>Favorited</span><span class={styles.v}>{imageFavorites.has(current.path) ? 'yes' : 'no'}</span></div>
            </>
          )}
        </div>

        <div class={styles.actionbar}>
          <button onClick={() => toggleImageFavorite(current)} disabled={!current || busy} title="Favorite (F)">
            <Star size={14} />
            {current && imageFavorites.has(current.path) ? 'Unfavorite' : 'Favorite'}
          </button>
          <button onClick={handleSaveAsMemory} disabled={!current || busy} data-testid="image-browser--save-as-memory">
            <ImagePlus size={14} />
            Save as memory
          </button>
          <button onClick={handleReveal} disabled={!current || busy}>
            <FolderOpen size={14} />
            Reveal
          </button>
          <button onClick={handleCopyPath} disabled={!current || busy}>
            <Copy size={14} />
            Copy path
          </button>
          <div class={styles.spacer} />
          <button class={styles.metaToggle} onClick={() => setMetaOpen((v) => !v)}>
            {metaOpen ? 'Hide metadata' : 'Show metadata'}
          </button>
          <button onClick={handleDelete} disabled={!current || busy} class={styles.danger}>
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      </main>

      <FolderPicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handleFolderSelected}
        initialPath={loadedPath || '~/'}
        title="Open image folder"
        favorites={folderFavorites}
        onFavoritesChange={handleFolderFavoritesChange}
        recents={folderRecents}
        onRecentsChange={handleFolderRecentsChange}
        suggestedPaths={[
          { path: '~/Pictures', label: '~/Pictures', icon: 'folder' },
          { path: '~/Downloads', label: '~/Downloads', icon: 'folder' },
          { path: '~/Desktop', label: '~/Desktop', icon: 'folder' },
        ]}
      />
    </div>
  )
}
