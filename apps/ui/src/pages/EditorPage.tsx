import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks'
import { Fragment } from 'preact'
import { Folder, FolderOpen, FolderPlus, FilePlus, X, FileCode, PanelLeftClose, PanelLeft, Undo2, Eye, Columns2, SquarePen, Copy, Search, Minimize2, ChevronsDownUp, ChevronsUpDown, ChevronRight, Star, Home, FileText, ExternalLink } from 'lucide-preact'
import clsx from 'clsx'
import { CodeEditor, FileTree, QuickOpen, SearchPanel } from '../components/editor'
import { ChickenIcon } from '../components/editor/ChickenIcon'
import type { PaletteCommand } from '../components/editor'
import type { EditorLanguage } from '../components/editor'
import { fsRead, fsWrite, fsDelete, fsCompletions, fsReveal, getScratchHome, previewDiagram, getProjects, type DiagramType } from '../lib/api'
import { loadSettings } from '../lib/settings'
import type { Project } from '../types/api'
import { consumeEditorDeepLink } from '../lib/editorDeepLink'
import { markdownProcessor } from '../lib/markdown'
import { getDiagramTheme } from '../lib/exportPreferences'
import { loadStore, saveStore } from '../lib/store'
import type { FsCompletion } from '../types/api'
import { useDocumentTitle } from '../hooks'
import styles from './EditorPage.module.css'

interface EditorTab {
  path: string
  name: string
  content: string
  savedContent: string
  language: EditorLanguage
  lastModified: string // mtime from server for conflict detection
  size?: number
  isImage?: boolean
  mimeType?: string
  base64Content?: string
  isScratch?: boolean
}

const SCRATCH_DIR = '/tmp/khef-scratch'
let _scratchSeq = 0

type EditorViewMode = 'edit' | 'split' | 'preview'

interface EditorGroup {
  id: string
  tabs: EditorTab[]
  activeTabIndex: number
}

let _groupSeq = 0
function nextGroupId(): string {
  return `g${++_groupSeq}`
}

interface PendingJumpTarget {
  path: string
  line?: number
  col?: number
  needle?: string
}

const DIAGRAM_LANGUAGES: { regex: RegExp; type: DiagramType }[] = [
  { regex: /<pre><code class="[^"]*language-mermaid[^"]*">([\s\S]*?)<\/code><\/pre>/g, type: 'mermaid' },
  { regex: /<pre><code class="[^"]*language-d2[^"]*">([\s\S]*?)<\/code><\/pre>/g, type: 'd2' },
  { regex: /<pre><code class="[^"]*language-plantuml[^"]*">([\s\S]*?)<\/code><\/pre>/g, type: 'plantuml' },
  { regex: /<pre><code class="[^"]*language-graphviz[^"]*">([\s\S]*?)<\/code><\/pre>/g, type: 'graphviz' },
]

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;|&#60;|&#x3[Cc];/g, '<')
    .replace(/&gt;|&#62;|&#x3[Ee];/g, '>')
    .replace(/&amp;|&#38;|&#x26;/g, '&')
    .replace(/&quot;|&#34;|&#x22;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
}

async function renderMarkdownPreview(content: string): Promise<string> {
  const file = await markdownProcessor.process(content)
  let html = String(file)
  const theme = getDiagramTheme()

  for (const { regex, type } of DIAGRAM_LANGUAGES) {
    regex.lastIndex = 0
    const matches = [...html.matchAll(regex)]
    if (matches.length === 0) continue

    for (const match of matches) {
      const fullMatch = match[0]
      const chartCode = decodeHtmlEntities(match[1])
      try {
        const { svg } = await previewDiagram(type, chartCode, theme)
        html = html.replace(fullMatch, `<div class="mermaid-diagram" data-theme="${theme}">${svg}</div>`)
      } catch {
        // Keep source block if preview rendering fails
      }
    }
  }

  return html
}

function basename(filepath: string): string {
  return filepath.split('/').pop() || filepath
}

function relativeToRoot(root: string, fullPath: string): string | null {
  if (!root) return null
  if (fullPath === root) return ''
  if (!fullPath.startsWith(root)) return null

  const nextChar = fullPath.charAt(root.length)
  if (nextChar && nextChar !== '/') return null
  return fullPath.slice(root.length).replace(/^\/+/, '')
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(value)
}


function findNeedlePosition(content: string, needle: string): { line: number; col: number } | null {
  if (!needle) return null
  const idx = content.indexOf(needle)
  if (idx < 0) return null
  const before = content.slice(0, idx)
  const line = before.split('\n').length
  const lastBreak = before.lastIndexOf('\n')
  const col = idx - lastBreak
  return { line: Math.max(1, line), col: Math.max(1, col) }
}

export function EditorPage() {
  const initialEditor = useRef(loadStore().editor)
  const [rootPath, setRootPath] = useState(initialEditor.current.rootPath)
  const [favoriteFolders, setFavoriteFolders] = useState<string[]>(initialEditor.current.favoriteFolders ?? [])
  const [shimmerPath, setShimmerPath] = useState<string | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [isFolded, setIsFolded] = useState(false)
  const [showPathInput, setShowPathInput] = useState(false)
  const [pathInputMode, setPathInputMode] = useState<'open-folder' | 'save-as'>('open-folder')
  const [quickOpenVisible, setQuickOpenVisible] = useState(false)
  const [quickOpenInitialScope, setQuickOpenInitialScope] = useState<'commands' | 'project' | 'global'>('commands')
  const [rootCreateRequest, setRootCreateRequest] = useState<{ type: 'file' | 'directory'; parentPath: string; nonce: number } | null>(null)
  const [selectedDirectoryPath, setSelectedDirectoryPath] = useState<string | null>(null)
  const [revealPath, setRevealPath] = useState<string | null>(null)
  const [pathValue, setPathValue] = useState('')
  const [groups, setGroups] = useState<EditorGroup[]>(() => [{ id: nextGroupId(), tabs: [], activeTabIndex: -1 }])
  const [activeGroupId, setActiveGroupId] = useState(() => groups[0].id)
  const [explorerCollapsed, setExplorerCollapsed] = useState(false)
  const [showHiddenFiles, setShowHiddenFiles] = useState(false)
  const [sidebarMode, setSidebarMode] = useState<'explorer' | 'search' | 'scratches'>('explorer')
  const [scratchDrawerEnabled, setScratchDrawerEnabled] = useState(false)
  const [scratchHome, setScratchHome] = useState<string | null>(null)
  const [explorerWidth, setExplorerWidth] = useState(() =>
    Math.max(160, Math.min(500, initialEditor.current.explorerWidth))
  )
  const [fontSize, setFontSize] = useState(initialEditor.current.fontSize)
  const [lineWrapping, setLineWrapping] = useState(initialEditor.current.lineWrapping)
  const [autoSave, setAutoSave] = useState(initialEditor.current.autoSave)
  const [viewMode, setViewMode] = useState<EditorViewMode>('edit')
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 })
  const [previewHtml, setPreviewHtml] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [pendingCloseIndex, setPendingCloseIndex] = useState<number | null>(null)
  const [pendingRevert, setPendingRevert] = useState(false)
  const [pendingCloseAll, setPendingCloseAll] = useState(false)
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; index: number } | null>(null)
  const [tabDragState, setTabDragState] = useState<{ sourceGroupId: string; sourceIndex: number } | null>(null)
  const [tabDropTarget, setTabDropTarget] = useState<{ groupId: string; index: number } | null>(null)
  const [splitRatios, setSplitRatios] = useState<Record<string, number>>({})
  const [maximizedGroupId, setMaximizedGroupId] = useState<string | null>(null)
  const [completions, setCompletions] = useState<FsCompletion[]>([])
  const [completionIndex, setCompletionIndex] = useState(-1)
  const [pendingJump, setPendingJump] = useState<PendingJumpTarget | null>(null)
  const [cursorTarget, setCursorTarget] = useState<{ line: number; col: number; token: number } | null>(null)
  const completionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savingPathsRef = useRef<Set<string>>(new Set())
  const chordRef = useRef(false)
  const chordTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resizingRef = useRef(false)
  const restoredRef = useRef(false)
  const closeModalRef = useRef<HTMLDivElement | null>(null)
  const revertModalRef = useRef<HTMLDivElement | null>(null)
  const previewRenderIdRef = useRef(0)
  const rootCreateNonceRef = useRef(0)
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const foldActionsRef = useRef<{ foldAll: () => void; unfoldAll: () => void } | null>(null)
  const splitDraggingRef = useRef(false)
  const deepLinkConsumedRef = useRef(false)
  const cursorJumpTokenRef = useRef(0)

  const activeGroup = groups.find(g => g.id === activeGroupId) || groups[0]
  const isSplit = groups.length > 1
  const activeTab = activeGroup.activeTabIndex >= 0 && activeGroup.activeTabIndex < activeGroup.tabs.length
    ? activeGroup.tabs[activeGroup.activeTabIndex] : null
  const isDirty = activeTab ? activeTab.content !== activeTab.savedContent : false
  useDocumentTitle(activeTab ? `Editor - ${activeTab.name}${isDirty ? ' •' : ''}` : 'Editor')
  const isImageTab = Boolean(activeTab?.isImage && activeTab?.base64Content && activeTab?.mimeType)
  const isMarkdownTab = activeTab?.language === 'markdown'
  const effectiveViewMode: EditorViewMode = isMarkdownTab ? viewMode : 'edit'
  const showPreviewPane = Boolean(activeTab && isMarkdownTab && effectiveViewMode !== 'edit')
  const showEditorPane = Boolean(activeTab && effectiveViewMode !== 'preview')

  const modifiedPathsKey = groups
    .flatMap(g => g.tabs)
    .filter((t) => t.content !== t.savedContent)
    .map((t) => t.path)
    .join('\0')
  const modifiedPaths = useMemo(
    () => new Set(modifiedPathsKey ? modifiedPathsKey.split('\0') : []),
    [modifiedPathsKey]
  )

  // Load scratch drawer setting + scratch home path
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await loadSettings()
        if (cancelled) return
        setScratchDrawerEnabled(s.editor.scratchDrawer.enabled)
        if (s.editor.scratchDrawer.enabled) {
          const { path } = await getScratchHome()
          if (!cancelled) setScratchHome(path)
        }
      } catch {
        // ignore — scratches tab simply won't appear
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Restore open tabs from previous session (+ deep link if present)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true

    // Consume deep link early so restore and deep link are one atomic operation.
    // Check localStorage first, then URL query params (?file=, ?root=, ?line=).
    let link = consumeEditorDeepLink()
    if (!link) {
      const params = new URLSearchParams(window.location.search)
      const file = params.get('file')
      const root = params.get('root')
      const line = params.get('line')
      if (file || root) {
        link = {
          path: file || '',
          root: root || undefined,
          line: line ? parseInt(line, 10) : undefined,
        }
        window.history.replaceState({}, '', window.location.pathname)
      }
    }
    if (link) deepLinkConsumedRef.current = true

    const state = initialEditor.current

    const restoreTabs = async () => {
      // Collect all unique paths from groups (preferred) or legacy openPaths
      const allPaths: string[] = []
      const seen = new Set<string>()
      if (state.groups && state.groups.length > 0) {
        for (const g of state.groups) {
          for (const p of g.openPaths) {
            if (!seen.has(p)) { seen.add(p); allPaths.push(p) }
          }
        }
      }
      // Also include legacy openPaths for any files not in groups
      for (const p of state.openPaths) {
        if (!seen.has(p)) { seen.add(p); allPaths.push(p) }
      }

      const restored: EditorTab[] = []
      for (const filePath of allPaths) {
        try {
          const result = await fsRead(filePath)
          restored.push({
            path: filePath,
            name: basename(filePath),
            content: result.content,
            savedContent: result.content,
            language: result.language as EditorLanguage,
            lastModified: result.modified,
            size: result.size,
            isImage: result.isImage,
            mimeType: result.mimeType,
            base64Content: result.base64Content,
          })
        } catch {
          // File no longer exists — skip
        }
      }

      // Resolve deep link path and append if not already in restored tabs
      let deepLinkActiveIdx = -1
      if (link) {
        const rootHint = link.root || ''
        if (rootHint && rootHint !== state.rootPath) {
          setRootPath(rootHint)
        }
        let resolvedPath = link.path
        if (!isAbsolutePath(resolvedPath)) {
          const baseRoot = rootHint || state.rootPath
          if (baseRoot) {
            resolvedPath = `${baseRoot.replace(/\/+$/, '')}/${resolvedPath.replace(/^\/+/, '')}`
          }
        }
        const existingIdx = restored.findIndex(t => t.path === resolvedPath)
        if (existingIdx >= 0) {
          deepLinkActiveIdx = existingIdx
        } else {
          try {
            const result = await fsRead(resolvedPath)
            restored.push({
              path: resolvedPath,
              name: basename(resolvedPath),
              content: result.content,
              savedContent: result.content,
              language: result.language as EditorLanguage,
              lastModified: result.modified,
              size: result.size,
              isImage: result.isImage,
              mimeType: result.mimeType,
              base64Content: result.base64Content,
            })
            deepLinkActiveIdx = restored.length - 1
          } catch {
            // Deep link file doesn't exist — ignore
          }
        }
        if (deepLinkActiveIdx >= 0) {
          setPendingJump({ path: restored[deepLinkActiveIdx].path, line: link.line, col: link.col, needle: link.needle })
        }
      }

      if (restored.length > 0) {
        // If we have saved groups, restore each group with its own tabs
        if (state.groups && state.groups.length > 0) {
          const restoredGroups: EditorGroup[] = []
          const restoredByPath = new Map(restored.map(t => [t.path, t]))

          for (const savedGroup of state.groups) {
            const groupTabs: EditorTab[] = []
            for (const p of savedGroup.openPaths) {
              const tab = restoredByPath.get(p)
              if (tab) groupTabs.push(tab)
            }
            if (groupTabs.length > 0) {
              restoredGroups.push({
                id: savedGroup.id || nextGroupId(),
                tabs: groupTabs,
                activeTabIndex: Math.min(Math.max(0, savedGroup.activeIndex), groupTabs.length - 1),
              })
            }
          }

          if (restoredGroups.length > 0) {
            // Handle deep link — find which group has the deep link tab
            if (deepLinkActiveIdx >= 0) {
              const dlPath = restored[deepLinkActiveIdx].path
              let found = false
              for (const g of restoredGroups) {
                const idx = g.tabs.findIndex(t => t.path === dlPath)
                if (idx >= 0) {
                  g.activeTabIndex = idx
                  setActiveGroupId(g.id)
                  found = true
                  break
                }
              }
              if (!found) {
                // Deep link file not in any group — add to first group
                const dlTab = restoredByPath.get(dlPath)
                if (dlTab) {
                  restoredGroups[0].tabs.push(dlTab)
                  restoredGroups[0].activeTabIndex = restoredGroups[0].tabs.length - 1
                }
                setActiveGroupId(restoredGroups[0].id)
              }
            } else {
              const savedActiveId = state.activeGroupId
              const hasActive = restoredGroups.some(g => g.id === savedActiveId)
              setActiveGroupId(hasActive ? savedActiveId : restoredGroups[0].id)
            }
            setGroups(restoredGroups)
            return
          }
        }

        // Fallback: single group from legacy openPaths
        const activeIdx = deepLinkActiveIdx >= 0
          ? deepLinkActiveIdx
          : Math.min(state.activeIndex, restored.length - 1)
        const restoredGroupId = nextGroupId()
        setGroups([{ id: restoredGroupId, tabs: restored, activeTabIndex: activeIdx >= 0 ? activeIdx : 0 }])
        setActiveGroupId(restoredGroupId)
      }
    }

    const hasGroups = state.groups && state.groups.length > 0 && state.groups.some(g => g.openPaths.length > 0)
    if (state.openPaths.length === 0 && !hasGroups && !link) return
    restoreTabs()
  }, [])

  // Persist state on changes (debounced to avoid blocking keystrokes)
  useEffect(() => {
    const timer = setTimeout(() => {
      saveStore({
        editor: {
          ...loadStore().editor,
          rootPath,
          // Save all groups for full restore
          groups: groups.map(g => ({ id: g.id, openPaths: g.tabs.map(t => t.path), activeIndex: g.activeTabIndex })),
          activeGroupId,
          // Legacy fields for backwards compat
          openPaths: activeGroup.tabs.map((t) => t.path),
          activeIndex: activeGroup.activeTabIndex,
        },
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [rootPath, groups, activeGroupId])

  // Reset folder-local selection when switching roots.
  useEffect(() => {
    setSelectedDirectoryPath(null)
  }, [rootPath])

  // Load project list once so we can link from the editor to a matching project.
  useEffect(() => {
    let cancelled = false
    getProjects({ includeHidden: true })
      .then((rows) => { if (!cancelled) setProjects(rows) })
      .catch(() => { if (!cancelled) setProjects([]) })
    return () => { cancelled = true }
  }, [])

  const matchedProject = useMemo<Project | null>(() => {
    if (!rootPath || projects.length === 0) return null
    const norm = (p: string) => p.trim().replace(/\/+$/, '')
    const target = norm(rootPath)
    if (!target) return null
    return projects.find((p) => p.path && norm(p.path) === target) ?? null
  }, [rootPath, projects])

  useEffect(() => {
    if (!activeTab || !isMarkdownTab || effectiveViewMode === 'edit') {
      setPreviewLoading(false)
      setPreviewError(null)
      setPreviewHtml('')
      return
    }

    const renderId = ++previewRenderIdRef.current
    setPreviewLoading(true)
    setPreviewError(null)
    const timer = setTimeout(() => {
      renderMarkdownPreview(activeTab.content)
        .then((html) => {
          if (previewRenderIdRef.current !== renderId) return
          setPreviewHtml(html)
        })
        .catch((err) => {
          if (previewRenderIdRef.current !== renderId) return
          setPreviewError(err instanceof Error ? err.message : 'Failed to render preview')
        })
        .finally(() => {
          if (previewRenderIdRef.current !== renderId) return
          setPreviewLoading(false)
        })
    }, 120)

    return () => clearTimeout(timer)
  }, [activeTab, isMarkdownTab, effectiveViewMode])

  // Open a file in the active group's tabs
  const openFile = useCallback(async (filePath: string) => {
    try {
      const result = await fsRead(filePath)
      const newTab: EditorTab = {
        path: filePath,
        name: basename(filePath),
        content: result.content,
        savedContent: result.content,
        language: result.language as EditorLanguage,
        lastModified: result.modified,
        size: result.size,
        isImage: result.isImage,
        mimeType: result.mimeType,
        base64Content: result.base64Content,
      }

      setGroups(prev => prev.map(g => {
        if (g.id !== activeGroupId) return g
        const existingIdx = g.tabs.findIndex(t => t.path === filePath)
        if (existingIdx >= 0) {
          return { ...g, activeTabIndex: existingIdx }
        }
        return { ...g, tabs: [...g.tabs, newTab], activeTabIndex: g.tabs.length }
      }))
    } catch (err: any) {
      console.error('Failed to open file:', err)
    }
  }, [activeGroupId])

  // Open a scratch tab backed by a persistent scratch file when the drawer is
  // enabled, otherwise fall back to /tmp for the legacy ephemeral path.
  const openScratchTab = useCallback(async () => {
    _scratchSeq += 1
    const name = `scratch-${_scratchSeq}.md`
    const baseDir = scratchDrawerEnabled && scratchHome ? scratchHome : SCRATCH_DIR
    const scratchPath = `${baseDir}/${name}`
    try {
      const result = await fsWrite(scratchPath, '')
      const newTab: EditorTab = {
        path: scratchPath,
        name,
        content: '',
        savedContent: '',
        language: 'markdown',
        lastModified: result.modified,
        isScratch: true,
      }
      setGroups(prev => prev.map(g => {
        if (g.id !== activeGroupId) return g
        return { ...g, tabs: [...g.tabs, newTab], activeTabIndex: g.tabs.length }
      }))
      if (scratchDrawerEnabled && sidebarMode === 'scratches') {
        setRevealPath(scratchPath)
      }
    } catch (err: any) {
      console.error('Failed to create scratch file:', err)
    }
  }, [activeGroupId, scratchDrawerEnabled, scratchHome, sidebarMode])

  // Handle deep links via localStorage OR URL query params (?file=, ?root=, ?line=).
  useEffect(() => {
    if (deepLinkConsumedRef.current) return

    // Try localStorage first, then fall back to query params
    let link = consumeEditorDeepLink()
    if (!link) {
      const params = new URLSearchParams(window.location.search)
      const file = params.get('file')
      const root = params.get('root')
      const line = params.get('line')
      if (file || root) {
        link = {
          path: file || '',
          root: root || undefined,
          line: line ? parseInt(line, 10) : undefined,
        }
        // Clean query params from URL without reload
        window.history.replaceState({}, '', window.location.pathname)
      }
    }
    if (!link) return

    deepLinkConsumedRef.current = true
    const rootHint = link.root || ''

    if (rootHint && rootHint !== rootPath) {
      setRootPath(rootHint)
    }

    // root-only link: just set the root, don't open a file
    if (!link.path) return

    let resolvedPath = link.path
    if (!isAbsolutePath(resolvedPath)) {
      const baseRoot = rootHint || rootPath
      if (baseRoot) {
        resolvedPath = `${baseRoot.replace(/\/+$/, '')}/${resolvedPath.replace(/^\/+/, '')}`
      }
    }

    openFile(resolvedPath)
    setPendingJump({ path: resolvedPath, line: link.line, col: link.col, needle: link.needle })
  }, [openFile, rootPath])

  // Apply deep-link cursor jump once the target tab is active.
  useEffect(() => {
    if (!pendingJump || !activeTab || activeTab.path !== pendingJump.path) return

    let line = pendingJump.line ?? 1
    let col = pendingJump.col ?? 1

    if (!pendingJump.line && pendingJump.needle) {
      const found = findNeedlePosition(activeTab.content, pendingJump.needle)
      if (found) {
        line = found.line
        col = found.col
      }
    }

    cursorJumpTokenRef.current += 1
    setCursorTarget({ line, col, token: cursorJumpTokenRef.current })
    setPendingJump(null)
  }, [activeTab, pendingJump])

  // Update a tab across all groups by path (used after save to update savedContent/lastModified)
  const updateTabByPath = useCallback((path: string, updater: (t: EditorTab) => EditorTab) => {
    setGroups(prev => prev.map(g => ({
      ...g,
      tabs: g.tabs.map(t => t.path === path ? updater(t) : t),
    })))
  }, [])

  const saveTab = useCallback(async (tab: EditorTab, options: { promptOnConflict?: boolean } = {}) => {
    if (tab.isImage || tab.content === tab.savedContent) return
    const { promptOnConflict = true } = options
    if (savingPathsRef.current.has(tab.path)) return
    savingPathsRef.current.add(tab.path)

    try {
      const result = await fsWrite(tab.path, tab.content, tab.lastModified)
      updateTabByPath(tab.path, (t) => {
        if (t.content === tab.content) {
          return { ...t, savedContent: t.content, lastModified: result.modified }
        }
        return { ...t, lastModified: result.modified }
      })
    } catch (err: any) {
      if (err.message?.includes('modified externally')) {
        if (!promptOnConflict) return
        const overwrite = confirm(
          `"${tab.name}" has been modified outside the editor.\n\nOverwrite with your changes?`
        )
        if (overwrite) {
          try {
            const result = await fsWrite(tab.path, tab.content)
            updateTabByPath(tab.path, (t) => {
              if (t.content === tab.content) {
                return { ...t, savedContent: t.content, lastModified: result.modified }
              }
              return { ...t, lastModified: result.modified }
            })
          } catch (retryErr: any) {
            console.error('Failed to save file:', retryErr)
          }
        }
      } else {
        console.error('Failed to save file:', err)
      }
    } finally {
      savingPathsRef.current.delete(tab.path)
    }
  }, [updateTabByPath])

  // Save active tab with conflict detection
  const saveActiveTab = useCallback(async () => {
    if (!activeTab) return
    await saveTab(activeTab, { promptOnConflict: true })
  }, [activeTab, saveTab])

  // Save As: open path input overlay for choosing destination
  const saveTabAs = useCallback(() => {
    if (!activeTab) return
    const defaultPath = activeTab.isScratch
      ? (scratchHome
        ? `${scratchHome}/${activeTab.name}`
        : rootPath ? `${rootPath}/${activeTab.name}` : `~/${activeTab.name}`)
      : activeTab.path
    setPathValue(defaultPath)
    setCompletions([])
    setCompletionIndex(-1)
    setPathInputMode('save-as')
    setShowPathInput(true)
  }, [activeTab, rootPath, scratchHome])

  // Execute Save As after path is confirmed
  const executeSaveAs = useCallback(async (targetPath: string) => {
    if (!activeTab || !targetPath.trim()) return
    const trimmed = targetPath.trim()
    setShowPathInput(false)
    setCompletions([])
    setCompletionIndex(-1)
    try {
      const result = await fsWrite(trimmed, activeTab.content)
      const oldPath = activeTab.path
      const wasScratch = activeTab.isScratch
      updateTabByPath(oldPath, () => ({
        ...activeTab,
        path: trimmed,
        name: basename(trimmed),
        savedContent: activeTab.content,
        lastModified: result.modified,
        isScratch: false,
      }))
      if (wasScratch && oldPath.startsWith(SCRATCH_DIR)) {
        fsDelete(oldPath).catch(() => {})
      }
    } catch (err: any) {
      console.error('Failed to save as:', err)
    }
  }, [activeTab, updateTabByPath])

  // Autosave all dirty text tabs after a short idle period (when enabled).
  useEffect(() => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current)
      autosaveTimer.current = null
    }

    if (!autoSave) return

    const dirtyTextTabs = groups.flatMap(g => g.tabs).filter((tab) => !tab.isImage && tab.content !== tab.savedContent)
    if (dirtyTextTabs.length === 0) return

    autosaveTimer.current = setTimeout(() => {
      void (async () => {
        for (const tab of dirtyTextTabs) {
          await saveTab(tab, { promptOnConflict: false })
        }
      })()
    }, 900)

    return () => {
      if (autosaveTimer.current) {
        clearTimeout(autosaveTimer.current)
        autosaveTimer.current = null
      }
    }
  }, [groups, saveTab, autoSave])

  // Revert active tab to saved content from disk
  const executeRevertActiveTab = useCallback(async () => {
    if (!activeTab) return
    if (activeTab.content === activeTab.savedContent) return

    try {
      const result = await fsRead(activeTab.path)
      setGroups(prev => prev.map(g => {
        if (g.id !== activeGroupId) return g
        return {
          ...g,
          tabs: g.tabs.map((t, i) =>
            i === g.activeTabIndex
              ? {
                  ...t,
                  content: result.content,
                  savedContent: result.content,
                  lastModified: result.modified,
                  size: result.size,
                  isImage: result.isImage,
                  mimeType: result.mimeType,
                  base64Content: result.base64Content,
                }
              : t
          ),
        }
      }))
    } catch (err: any) {
      console.error('Failed to revert file:', err)
    }
  }, [activeTab, activeGroupId])

  // Revert active tab to saved content from disk (with modal confirmation)
  const revertActiveTab = useCallback(async () => {
    if (!activeTab) return
    if (activeTab.content === activeTab.savedContent) return
    setPendingRevert(true)
  }, [activeTab])

  // Revert a file by path — activates the tab first, then triggers the modal
  const revertFileByPath = useCallback((path: string) => {
    // Find and activate the tab, then trigger revert
    for (const g of groups) {
      const idx = g.tabs.findIndex(t => t.path === path)
      if (idx >= 0) {
        if (g.tabs[idx].content === g.tabs[idx].savedContent) return
        setActiveGroupId(g.id)
        setGroups(prev => prev.map(gr => gr.id === g.id ? { ...gr, activeTabIndex: idx } : gr))
        setPendingRevert(true)
        return
      }
    }
  }, [groups])

  const handleRevertCancel = useCallback(() => {
    setPendingRevert(false)
  }, [])

  const handleRevertConfirm = useCallback(async () => {
    setPendingRevert(false)
    await executeRevertActiveTab()
  }, [executeRevertActiveTab])

  useEffect(() => {
    const modalEl = pendingRevert ? revertModalRef.current : pendingCloseIndex !== null ? closeModalRef.current : null
    if (!modalEl) return

    const focusables = modalEl.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    const first = focusables[0]
    requestAnimationFrame(() => first?.focus())
  }, [pendingCloseIndex, pendingRevert])

  useEffect(() => {
    if (!tabContextMenu) return
    const close = () => setTabContextMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [tabContextMenu])

  // Close a tab in the specified group (defaults to active group) — shows save dialog if dirty
  const closeTab = useCallback((index: number, e?: Event, groupId?: string) => {
    e?.stopPropagation()
    const targetGroupId = groupId || activeGroupId
    const group = groups.find(g => g.id === targetGroupId) || activeGroup
    const tab = group.tabs[index]
    if (tab && tab.content !== tab.savedContent) {
      // Switch to the group so save dialog operates on the right group
      if (targetGroupId !== activeGroupId) setActiveGroupId(targetGroupId)
      setPendingCloseIndex(index)
      return
    }
    removeTab(index, targetGroupId)
  }, [activeGroup, activeGroupId, groups])

  const removeTab = useCallback((index: number, groupId?: string) => {
    const targetGroupId = groupId || activeGroupId
    // Clean up scratch temp file
    const group = groups.find(g => g.id === targetGroupId)
    const tab = group?.tabs[index]
    if (tab?.isScratch && tab.path.startsWith(SCRATCH_DIR)) {
      fsDelete(tab.path).catch(() => {})
    }
    setGroups(prev => {
      const updated = prev.map(g => {
        if (g.id !== targetGroupId) return g
        const newTabs = g.tabs.filter((_, i) => i !== index)
        let newActive = g.activeTabIndex
        if (index < newActive) newActive -= 1
        else if (index === newActive) newActive = Math.min(newActive, newTabs.length - 1)
        return { ...g, tabs: newTabs, activeTabIndex: newActive }
      })
      // Auto-collapse empty groups when split (keep at least one group)
      const nonEmpty = updated.filter(g => g.tabs.length > 0)
      if (nonEmpty.length > 0 && nonEmpty.length < updated.length) {
        // If the active group was removed, switch to the first remaining group
        if (!nonEmpty.some(g => g.id === activeGroupId)) {
          setActiveGroupId(nonEmpty[0].id)
        }
        return nonEmpty
      }
      // If all groups would be empty, keep just one
      if (nonEmpty.length === 0 && updated.length > 1) {
        setActiveGroupId(updated[0].id)
        return [updated[0]]
      }
      return updated
    })
  }, [activeGroupId, groups])

  // Move a tab within the same group (reorder) or to a different group (cross-pane).
  // targetIndex is the position before removal (i.e., "insert before the tab currently at this index").
  // For drop-on-end, pass targetIndex = group.tabs.length.
  const moveTab = useCallback((sourceGroupId: string, sourceIndex: number, targetGroupId: string, targetIndex: number) => {
    setGroups(prev => {
      const sourceGroup = prev.find(g => g.id === sourceGroupId)
      if (!sourceGroup) return prev
      const sourceTab = sourceGroup.tabs[sourceIndex]
      if (!sourceTab) return prev

      if (sourceGroupId === targetGroupId) {
        if (sourceIndex === targetIndex || sourceIndex + 1 === targetIndex) return prev
        return prev.map(g => {
          if (g.id !== sourceGroupId) return g
          const activePath = g.activeTabIndex >= 0 ? g.tabs[g.activeTabIndex]?.path ?? null : null
          const newTabs = g.tabs.slice()
          const [moved] = newTabs.splice(sourceIndex, 1)
          const insertAt = targetIndex > sourceIndex ? targetIndex - 1 : targetIndex
          newTabs.splice(insertAt, 0, moved)
          const newActive = activePath ? newTabs.findIndex(t => t.path === activePath) : -1
          return { ...g, tabs: newTabs, activeTabIndex: newActive }
        })
      }

      const targetGroup = prev.find(g => g.id === targetGroupId)
      if (!targetGroup) return prev
      const existingInTarget = targetGroup.tabs.findIndex(t => t.path === sourceTab.path)

      const updated = prev.map(g => {
        if (g.id === sourceGroupId) {
          const activePath = g.activeTabIndex >= 0 ? g.tabs[g.activeTabIndex]?.path ?? null : null
          const newTabs = g.tabs.filter((_, i) => i !== sourceIndex)
          let newActive = -1
          if (activePath && activePath !== sourceTab.path) {
            newActive = newTabs.findIndex(t => t.path === activePath)
          } else if (newTabs.length > 0) {
            newActive = Math.min(sourceIndex, newTabs.length - 1)
          }
          return { ...g, tabs: newTabs, activeTabIndex: newActive }
        }
        if (g.id === targetGroupId) {
          if (existingInTarget >= 0) {
            return { ...g, activeTabIndex: existingInTarget }
          }
          const newTabs = g.tabs.slice()
          const insertAt = Math.min(Math.max(0, targetIndex), newTabs.length)
          newTabs.splice(insertAt, 0, sourceTab)
          return { ...g, tabs: newTabs, activeTabIndex: insertAt }
        }
        return g
      })

      setActiveGroupId(targetGroupId)

      const nonEmpty = updated.filter(g => g.tabs.length > 0)
      if (nonEmpty.length > 0 && nonEmpty.length < updated.length) {
        return nonEmpty
      }
      return updated
    })
  }, [])

  const handleTabDragStart = useCallback((e: DragEvent, groupId: string, index: number) => {
    if (!e.dataTransfer) return
    e.dataTransfer.effectAllowed = 'move'
    const payload = JSON.stringify({ sourceGroupId: groupId, sourceIndex: index })
    try { e.dataTransfer.setData('application/x-khef-tab', payload) } catch { /* some browsers */ }
    e.dataTransfer.setData('text/plain', payload)
    setTabDragState({ sourceGroupId: groupId, sourceIndex: index })
  }, [])

  const handleTabDragEnd = useCallback(() => {
    setTabDragState(null)
    setTabDropTarget(null)
  }, [])

  const handleTabDragOver = useCallback((e: DragEvent, groupId: string, index: number) => {
    if (!tabDragState) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    setTabDropTarget(prev => (prev?.groupId === groupId && prev.index === index) ? prev : { groupId, index })
  }, [tabDragState])

  const handleTabDrop = useCallback((e: DragEvent, targetGroupId: string, targetIndex: number) => {
    if (!tabDragState) return
    e.preventDefault()
    e.stopPropagation()
    moveTab(tabDragState.sourceGroupId, tabDragState.sourceIndex, targetGroupId, targetIndex)
    setTabDragState(null)
    setTabDropTarget(null)
  }, [tabDragState, moveTab])

  const handleTabBarDragOver = useCallback((e: DragEvent, groupId: string) => {
    if (!tabDragState) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    setTabDropTarget(prev => (prev?.groupId === groupId && prev.index === -1) ? prev : { groupId, index: -1 })
  }, [tabDragState])

  const handleTabBarDrop = useCallback((e: DragEvent, targetGroupId: string) => {
    if (!tabDragState) return
    e.preventDefault()
    const targetGroup = groups.find(g => g.id === targetGroupId)
    const targetIndex = targetGroup?.tabs.length ?? 0
    moveTab(tabDragState.sourceGroupId, tabDragState.sourceIndex, targetGroupId, targetIndex)
    setTabDragState(null)
    setTabDropTarget(null)
  }, [tabDragState, groups, moveTab])

  const handleCloseSave = useCallback(async () => {
    if (pendingCloseIndex === null) return
    const tab = activeGroup.tabs[pendingCloseIndex]
    if (tab) {
      try {
        await fsWrite(tab.path, tab.content, tab.lastModified)
      } catch {
        // Save failed — still close
      }
    }
    removeTab(pendingCloseIndex)
    setPendingCloseIndex(null)
  }, [pendingCloseIndex, activeGroup, removeTab])

  const handleCloseDiscard = useCallback(() => {
    if (pendingCloseIndex === null) return
    removeTab(pendingCloseIndex)
    setPendingCloseIndex(null)
  }, [pendingCloseIndex, removeTab])

  const handleCloseCancel = useCallback(() => {
    setPendingCloseIndex(null)
  }, [])

  const copyTabPath = useCallback(async (index: number) => {
    const tab = activeGroup.tabs[index]
    setTabContextMenu(null)
    if (!tab) return
    try {
      await navigator.clipboard.writeText(tab.path)
    } catch (err) {
      console.error('Failed to copy tab path:', err)
    }
  }, [activeGroup])

  const copyTabRelativePath = useCallback(async (index: number) => {
    const tab = activeGroup.tabs[index]
    setTabContextMenu(null)
    if (!tab) return

    const relativePath = rootPath ? relativeToRoot(rootPath, tab.path) : null
    const text = relativePath !== null ? (relativePath || tab.name) : tab.path

    try {
      await navigator.clipboard.writeText(text)
    } catch (err) {
      console.error('Failed to copy relative tab path:', err)
    }
  }, [activeGroup, rootPath])

  const closeAllTabs = useCallback(() => {
    const allTabs = groups.flatMap(g => g.tabs)
    if (allTabs.length === 0) return

    const dirtyCount = allTabs.filter((t) => t.content !== t.savedContent).length
    if (dirtyCount > 0) {
      const confirmed = confirm(
        `${dirtyCount} tab${dirtyCount === 1 ? '' : 's'} have unsaved changes.\n\nClose all tabs and discard those changes?`
      )
      if (!confirmed) return
    }

    setPendingCloseIndex(null)
    setPendingRevert(false)
    const defaultId = nextGroupId()
    setGroups([{ id: defaultId, tabs: [], activeTabIndex: -1 }])
    setActiveGroupId(defaultId)
    setSplitRatios({})
    setMaximizedGroupId(null)
  }, [groups])

  // Open a file and jump to a specific line (used by search panel)
  const openFileAtLine = useCallback(async (filePath: string, line?: number) => {
    await openFile(filePath)
    if (line) {
      setPendingJump({ path: filePath, line, col: 1 })
    }
  }, [openFile])

  // Handle content change from any group's editor
  const makeContentChangeHandler = useCallback((groupId: string) => {
    return (newContent: string) => {
      setGroups(prev => prev.map(g => {
        if (g.id !== groupId) return g
        return {
          ...g,
          tabs: g.tabs.map((t, i) => i === g.activeTabIndex ? { ...t, content: newContent } : t),
        }
      }))
    }
  }, [])

  // Save handler for any group
  const makeSaveHandler = useCallback((groupId: string) => {
    return async () => {
      const group = groups.find(g => g.id === groupId)
      if (!group) return
      const tab = group.activeTabIndex >= 0 ? group.tabs[group.activeTabIndex] : null
      if (tab) await saveTab(tab, { promptOnConflict: true })
    }
  }, [groups, saveTab])

  // Shorthand for active group's content change
  const handleContentChange = useMemo(() => makeContentChangeHandler(activeGroupId), [makeContentChangeHandler, activeGroupId])

  // When a new file is created in the tree, open it
  const handleFileCreated = useCallback((filePath: string) => {
    openFile(filePath)
  }, [openFile])

  // When a file is deleted, close its tab in all groups
  const handleFileDeleted = useCallback((filePath: string) => {
    setGroups(prev => prev.map(g => {
      const tabIdx = g.tabs.findIndex(t => t.path === filePath)
      if (tabIdx < 0) return g
      const newTabs = g.tabs.filter((_, i) => i !== tabIdx)
      let newActive = g.activeTabIndex
      if (tabIdx < newActive) newActive -= 1
      else if (tabIdx === newActive) newActive = Math.min(newActive, newTabs.length - 1)
      return { ...g, tabs: newTabs, activeTabIndex: newActive }
    }))
  }, [])


  // Split pane resize by dragging divider
  const handleSplitDividerDrag = useCallback((e: MouseEvent, dividerIndex: number) => {
    e.preventDefault()
    splitDraggingRef.current = true
    const container = splitContainerRef.current
    if (!container) return

    const startX = e.clientX
    // Get current pane elements (every other child is a divider)
    const panes = Array.from(container.children).filter((_, i) => i % 2 === 0) as HTMLElement[]
    if (dividerIndex >= panes.length - 1) return

    const leftPane = panes[dividerIndex]
    const rightPane = panes[dividerIndex + 1]
    const leftStart = leftPane.getBoundingClientRect().width
    const rightStart = rightPane.getBoundingClientRect().width
    const totalWidth = leftStart + rightStart

    // Sum of the two adjacent panes' current flex values (default 1 each)
    const leftGroupId = groups[dividerIndex].id
    const rightGroupId = groups[dividerIndex + 1].id
    const leftFlex = splitRatios[leftGroupId] ?? 1
    const rightFlex = splitRatios[rightGroupId] ?? 1
    const combinedFlex = leftFlex + rightFlex

    const onMove = (ev: MouseEvent) => {
      if (!splitDraggingRef.current) return
      const delta = ev.clientX - startX
      const newLeft = Math.max(80, Math.min(totalWidth - 80, leftStart + delta))
      const fraction = newLeft / totalWidth

      setSplitRatios(prev => ({
        ...prev,
        [leftGroupId]: fraction * combinedFlex,
        [rightGroupId]: (1 - fraction) * combinedFlex,
      }))
    }

    const onUp = () => {
      splitDraggingRef.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [groups])

  const MIN_FONT = 10
  const MAX_FONT = 28
  const FONT_STEP = 2

  const zoomIn = useCallback(() => {
    setFontSize((s) => {
      const next = Math.min(s + FONT_STEP, MAX_FONT)
      saveStore({ editor: { ...loadStore().editor, fontSize: next } })
      return next
    })
  }, [])

  const zoomOut = useCallback(() => {
    setFontSize((s) => {
      const next = Math.max(s - FONT_STEP, MIN_FONT)
      saveStore({ editor: { ...loadStore().editor, fontSize: next } })
      return next
    })
  }, [])

  const zoomReset = useCallback(() => {
    setFontSize(14)
    saveStore({ editor: { ...loadStore().editor, fontSize: 14 } })
  }, [])

  // Keyboard shortcuts: zoom + Ctrl+X K chord
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        if (pendingRevert) {
          e.preventDefault()
          void handleRevertConfirm()
          return
        }
        if (pendingCloseIndex !== null) {
          e.preventDefault()
          void handleCloseSave()
          return
        }
      }

      if (e.key === 'Tab' && (pendingCloseIndex !== null || pendingRevert)) {
        const modalEl = pendingRevert ? revertModalRef.current : closeModalRef.current
        if (!modalEl) {
          e.preventDefault()
          return
        }
        const focusables = Array.from(
          modalEl.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => el.offsetParent !== null)
        if (focusables.length === 0) {
          e.preventDefault()
          return
        }
        const currentIndex = focusables.indexOf(document.activeElement as HTMLElement)
        const nextIndex = e.shiftKey
          ? (currentIndex <= 0 ? focusables.length - 1 : currentIndex - 1)
          : (currentIndex === -1 || currentIndex >= focusables.length - 1 ? 0 : currentIndex + 1)
        e.preventDefault()
        focusables[nextIndex]?.focus()
        return
      }

      // Escape dismisses path input modal
      if (e.key === 'Escape' && showPathInput) {
        e.preventDefault()
        setShowPathInput(false)
        return
      }

      // Escape dismisses save modal
      if (e.key === 'Escape' && (pendingCloseIndex !== null || pendingRevert || pendingCloseAll)) {
        e.preventDefault()
        if (pendingCloseIndex !== null) setPendingCloseIndex(null)
        if (pendingRevert) setPendingRevert(false)
        if (pendingCloseAll) setPendingCloseAll(false)
        return
      }

      // Block shortcuts while a confirmation modal is open
      if (pendingCloseIndex !== null || pendingRevert) return

      // Cmd/Ctrl+Shift+P : quick open file
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setQuickOpenInitialScope('commands')
        setQuickOpenVisible(true)
        return
      }

      // t : quick open project files (only when not typing in a field/editor)
      if (e.key === 't' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const ae = document.activeElement as HTMLElement | null
        const tag = ae?.tagName
        const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
          || ae?.isContentEditable
          || ae?.closest?.('.cm-content, .cm-editor') != null
        if (!isTyping && rootPath) {
          e.preventDefault()
          setQuickOpenInitialScope('project')
          setQuickOpenVisible(true)
          return
        }
      }

      // o : open folder dialog (only when not typing in a field/editor)
      if (e.key === 'o' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const ae = document.activeElement as HTMLElement | null
        const tag = ae?.tagName
        const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
          || ae?.isContentEditable
          || ae?.closest?.('.cm-content, .cm-editor') != null
        if (!isTyping) {
          e.preventDefault()
          handleOpenFolder()
          return
        }
      }

      // Cmd/Ctrl+Shift+O : open folder
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        setQuickOpenVisible(false)
        setPathValue(rootPath || '~/')
        setCompletions([])
        setCompletionIndex(-1)
        setPathInputMode('open-folder')
        setShowPathInput(true)
        return
      }

      // Cmd/Ctrl+Shift+. : toggle hidden files (like macOS Finder)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key === '.') {
        e.preventDefault()
        setShowHiddenFiles(prev => !prev)
        return
      }

      // Cmd/Ctrl+Shift+F : cross-file search
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSidebarMode('search')
        setExplorerCollapsed(false)
        return
      }

      // Cmd/Ctrl+Shift+\ : toggle split editor
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === 'Backslash') {
        e.preventDefault()
        if (isSplit) {
          // Merge: move second group's tabs into first, remove second group
          setGroups(prev => {
            if (prev.length < 2) return prev
            const keep = prev[0]
            const merge = prev[1]
            // Add any tabs from the second group that aren't already in the first
            const existingPaths = new Set(keep.tabs.map(t => t.path))
            const newTabs = merge.tabs.filter(t => !existingPaths.has(t.path))
            return [{ ...keep, tabs: [...keep.tabs, ...newTabs] }]
          })
          setActiveGroupId(groups[0].id)
          setMaximizedGroupId(null)
        } else if (activeTab) {
          // Split: create a new group. If multiple tabs, move the next tab to the new group.
          const newId = nextGroupId()
          if (activeGroup.tabs.length > 1) {
            const nextIdx = (activeGroup.activeTabIndex + 1) % activeGroup.tabs.length
            const tabToMove = activeGroup.tabs[nextIdx]
            setGroups(prev => {
              const updated = prev.map(g => {
                if (g.id !== activeGroupId) return g
                const newTabs = g.tabs.filter((_, i) => i !== nextIdx)
                let newActive = g.activeTabIndex
                if (nextIdx < newActive) newActive -= 1
                else if (nextIdx === newActive) newActive = Math.min(newActive, newTabs.length - 1)
                return { ...g, tabs: newTabs, activeTabIndex: newActive }
              })
              return [...updated, { id: newId, tabs: [tabToMove], activeTabIndex: 0 }]
            })
          } else {
            // Only one tab — duplicate it into the new group
            setGroups(prev => [...prev, { id: newId, tabs: [{ ...activeTab }], activeTabIndex: 0 }])
          }
          setActiveGroupId(newId)
        }
        return
      }

      // Alt+W : close active tab (Cmd+W is reserved by browser)
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyW') {
        e.preventDefault()
        if (activeGroup.activeTabIndex >= 0) closeTab(activeGroup.activeTabIndex)
        return
      }

      // Cmd+Shift+S : save as
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveTabAs()
        return
      }

      // Ctrl+Shift+N : new file in tree (requires folder)
      if (e.ctrlKey && !e.metaKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        requestRootCreate('file')
        return
      }

      // Ctrl+N : new scratch tab (skip when CodeMirror has focus — Ctrl+N is cursor down there)
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        if (e.defaultPrevented) return
        e.preventDefault()
        void openScratchTab()
        return
      }

      // Cmd/Ctrl+1..8 : focus group by position (only when split)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && isSplit) {
        const num = parseInt(e.key)
        if (num >= 1 && num <= 8) {
          const targetGroup = groups[num - 1]
          if (targetGroup) {
            e.preventDefault()
            setActiveGroupId(targetGroup.id)
            return
          }
        }
      }

      // Let quick-open consume keystrokes while open
      if (quickOpenVisible) return

      // Cmd/Ctrl += : zoom in
      if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        zoomIn()
        return
      }
      // Cmd/Ctrl+- : zoom out
      if ((e.metaKey || e.ctrlKey) && e.key === '-') {
        e.preventDefault()
        zoomOut()
        return
      }
      // Cmd/Ctrl+0 : reset zoom
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault()
        zoomReset()
        return
      }
      // Cmd/Ctrl+9 : revert active file to saved content
      if ((e.metaKey || e.ctrlKey) && e.key === '9') {
        e.preventDefault()
        void revertActiveTab()
        return
      }

      // Ctrl+X K chord: Ctrl+X starts chord, then K closes tab
      if (e.ctrlKey && e.key === 'x' && !e.metaKey && !e.altKey) {
        e.preventDefault()
        chordRef.current = true
        if (chordTimer.current) clearTimeout(chordTimer.current)
        chordTimer.current = setTimeout(() => { chordRef.current = false }, 1000)
        return
      }

      if (chordRef.current && e.key === 'k') {
        e.preventDefault()
        chordRef.current = false
        if (chordTimer.current) clearTimeout(chordTimer.current)
        if (activeGroup.activeTabIndex >= 0) closeTab(activeGroup.activeTabIndex)
        return
      }

      // Any other key cancels the chord
      if (chordRef.current && e.key !== 'Control') {
        chordRef.current = false
        if (chordTimer.current) clearTimeout(chordTimer.current)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeGroup, isSplit, groups, activeGroupId, activeTab, closeTab, zoomIn, zoomOut, zoomReset, revertActiveTab, pendingCloseIndex, pendingRevert, handleRevertConfirm, handleCloseSave, quickOpenVisible, rootPath, saveTabAs, openScratchTab, showPathInput])

  // Fetch directory completions (debounced)
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

  // Open folder handler
  const handleOpenFolder = useCallback(() => {
    setQuickOpenVisible(false)
    setPathValue(rootPath || '~/')
    setCompletions([])
    setCompletionIndex(-1)
    setPathInputMode('open-folder')
    setShowPathInput(true)
  }, [rootPath])

  const requestRootCreate = useCallback((type: 'file' | 'directory') => {
    if (!rootPath) return
    rootCreateNonceRef.current += 1
    const targetDir = selectedDirectoryPath || rootPath
    setRootCreateRequest({ type, nonce: rootCreateNonceRef.current, parentPath: targetDir })
  }, [rootPath, selectedDirectoryPath])

  const restoreEditorFocus = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const editorContent = document.querySelector<HTMLElement>(`.${styles.editorPane} .cm-content`)
        if (editorContent) {
          editorContent.focus()
          return
        }
        const editor = document.querySelector<HTMLElement>(`.${styles.editorPane} .cm-editor`)
        editor?.focus()
      })
    })
  }, [])

  const handleQuickOpenClose = useCallback(() => {
    setQuickOpenVisible(false)
    restoreEditorFocus()
  }, [restoreEditorFocus])

  const normalizeFolderPath = useCallback((p: string) => {
    const trimmed = p.trim()
    if (trimmed.length <= 1) return trimmed
    return trimmed.replace(/\/+$/, '')
  }, [])

  const toggleFavorite = useCallback((path: string) => {
    const normalized = normalizeFolderPath(path)
    if (!normalized) return
    setFavoriteFolders((prev) => {
      const has = prev.includes(normalized)
      const next = has ? prev.filter((p) => p !== normalized) : [normalized, ...prev]
      saveStore({ editor: { ...loadStore().editor, favoriteFolders: next } })
      if (!has) {
        setShimmerPath(normalized)
        window.setTimeout(() => setShimmerPath((curr) => (curr === normalized ? null : curr)), 900)
      }
      return next
    })
  }, [normalizeFolderPath])

  const isFavorite = useCallback((path: string) => {
    return favoriteFolders.includes(normalizeFolderPath(path))
  }, [favoriteFolders, normalizeFolderPath])

  const handlePathSubmit = useCallback((newPath: string) => {
    if (!newPath.trim()) return
    if (pathInputMode === 'save-as') {
      void executeSaveAs(newPath)
      return
    }
    let trimmed = newPath.trim()
    if (trimmed.length > 1) trimmed = trimmed.replace(/\/+$/, '')
    setRootPath(trimmed)
    const editor = loadStore().editor
    const recent = editor.recentFolders.filter((f) => f !== trimmed)
    recent.unshift(trimmed)
    saveStore({ editor: { ...editor, recentFolders: recent.slice(0, 10) } })
    setShowPathInput(false)
    setCompletions([])
    setCompletionIndex(-1)
  }, [pathInputMode, executeSaveAs])

  const handlePathInputChange = useCallback((value: string) => {
    setPathValue(value)
    fetchCompletions(value)
  }, [fetchCompletions])

  const acceptCompletion = useCallback((completion: FsCompletion) => {
    const newValue = completion.path + '/'
    setPathValue(newValue)
    setCompletions([])
    setCompletionIndex(-1)
    fetchCompletions(newValue)
  }, [fetchCompletions])

  // Toggle word wrap
  const toggleLineWrapping = useCallback(() => {
    setLineWrapping((v) => {
      const next = !v
      saveStore({ editor: { ...loadStore().editor, lineWrapping: next } })
      return next
    })
  }, [])

  // Toggle auto-save
  const toggleAutoSave = useCallback(() => {
    setAutoSave((v) => {
      const next = !v
      saveStore({ editor: { ...loadStore().editor, autoSave: next } })
      return next
    })
  }, [])

  // Build command palette commands
  const paletteCommands = useMemo<PaletteCommand[]>(() => [
    {
      id: 'toggle-word-wrap',
      label: lineWrapping ? 'Disable Word Wrap' : 'Enable Word Wrap',
      action: toggleLineWrapping,
    },
    {
      id: 'toggle-sidebar',
      label: explorerCollapsed ? 'Show Sidebar' : 'Hide Sidebar',
      action: () => setExplorerCollapsed((v) => !v),
    },
    {
      id: 'close-tab',
      label: 'Close Tab',
      shortcut: 'Alt+W',
      action: () => { if (activeGroup.activeTabIndex >= 0) closeTab(activeGroup.activeTabIndex) },
    },
    {
      id: 'close-all-tabs',
      label: 'Close All Tabs',
      action: closeAllTabs,
    },
    {
      id: 'revert-file',
      label: 'Revert File',
      shortcut: '\u2318+9',
      action: () => void revertActiveTab(),
    },
    {
      id: 'new-scratch',
      label: 'New Scratch File',
      shortcut: 'Ctrl+N',
      action: () => void openScratchTab(),
    },
    {
      id: 'new-file',
      label: 'New File in Tree',
      shortcut: 'Ctrl+Shift+N',
      action: () => requestRootCreate('file'),
    },
    {
      id: 'save-as',
      label: 'Save As\u2026',
      shortcut: '\u2318+Shift+S',
      action: () => void saveTabAs(),
    },
    {
      id: 'new-folder',
      label: 'New Folder',
      action: () => requestRootCreate('directory'),
    },
    {
      id: 'open-folder',
      label: 'Open Folder',
      shortcut: '\u2318+Shift+O',
      action: handleOpenFolder,
    },
    {
      id: 'cross-file-search',
      label: 'Search in Files',
      shortcut: '\u2318+Shift+F',
      action: () => { setSidebarMode('search'); setExplorerCollapsed(false) },
    },
    {
      id: 'toggle-split',
      label: isSplit ? 'Close Split Editor' : 'Split Editor',
      shortcut: '\u2318+Shift+\\',
      action: () => {
        // Trigger the keyboard shortcut handler logic via a synthetic keydown
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', metaKey: true, shiftKey: true }))
      },
    },
    {
      id: 'zoom-in',
      label: 'Zoom In',
      shortcut: '\u2318+=',
      action: zoomIn,
    },
    {
      id: 'zoom-out',
      label: 'Zoom Out',
      shortcut: '\u2318+-',
      action: zoomOut,
    },
    {
      id: 'zoom-reset',
      label: 'Reset Zoom',
      shortcut: '\u2318+0',
      action: zoomReset,
    },
  ], [lineWrapping, toggleLineWrapping, explorerCollapsed, activeGroup, isSplit, closeTab, closeAllTabs, revertActiveTab, requestRootCreate, handleOpenFolder, zoomIn, zoomOut, zoomReset, openScratchTab, saveTabAs, rootPath])

  // Explorer resize
  const handleResizeStart = useCallback((e: MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    const startX = e.clientX
    const startWidth = explorerWidth

    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return
      const newWidth = Math.max(160, Math.min(500, startWidth + e.clientX - startX))
      setExplorerWidth(newWidth)
    }

    const onUp = () => {
      resizingRef.current = false
      saveStore({ editor: { ...loadStore().editor, explorerWidth } })
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [explorerWidth])

  return (
    <Fragment>
    <div class={styles.page}>
      {/* Tab bar */}
      <div class={styles.topBar}>
        <div
          class={styles.tabs}
          onDragOver={(e: DragEvent) => handleTabBarDragOver(e, activeGroupId)}
          onDrop={(e: DragEvent) => handleTabBarDrop(e, activeGroupId)}
        >
          {explorerCollapsed && <div class={styles.tabsSpacer} />}
          {!isSplit && activeGroup.tabs.map((tab, i) => {
            const isDragging = tabDragState?.sourceGroupId === activeGroupId && tabDragState.sourceIndex === i
            const isDropTarget = tabDropTarget?.groupId === activeGroupId && tabDropTarget.index === i
            return (
              <button
                key={tab.path}
                draggable
                class={clsx(
                  styles.tab,
                  i === activeGroup.activeTabIndex && styles.tabActive,
                  tab.content !== tab.savedContent && styles.tabModified,
                  isDragging && styles.tabDragging,
                  isDropTarget && styles.tabDropTarget,
                )}
                onClick={() => setGroups(prev => prev.map(g => g.id === activeGroupId ? { ...g, activeTabIndex: i } : g))}
                onContextMenu={(e: MouseEvent) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setTabContextMenu({ x: e.clientX, y: e.clientY, index: i })
                  setGroups(prev => prev.map(g => g.id === activeGroupId ? { ...g, activeTabIndex: i } : g))
                }}
                onDragStart={(e: DragEvent) => handleTabDragStart(e, activeGroupId, i)}
                onDragOver={(e: DragEvent) => handleTabDragOver(e, activeGroupId, i)}
                onDrop={(e: DragEvent) => handleTabDrop(e, activeGroupId, i)}
                onDragEnd={handleTabDragEnd}
                title={tab.path}
              >
                <span class={clsx(styles.tabName, tab.isScratch && styles.tabScratch)}>{tab.name}</span>
                <span
                  class={styles.tabClose}
                  onClick={(e: Event) => closeTab(i, e)}
                  title="Close"
                >
                  <X size={12} />
                </span>
              </button>
            )
          })}
        </div>
        <div class={styles.topBarActions}>
          {matchedProject && (
            <a
              href={`/projects/${matchedProject.id}`}
              target="_blank"
              rel="noopener noreferrer"
              class={styles.projectLink}
              title={`Open project: ${matchedProject.display_name || matchedProject.name}`}
            >
              <span class={styles.projectLinkLabel}>Project</span>
              <ExternalLink size={11} />
            </a>
          )}
          {groups.some(g => g.tabs.length > 0) && (
            <button
              class={styles.foldButton}
              onClick={() => {
                if (isFolded) {
                  foldActionsRef.current?.unfoldAll()
                  setIsFolded(false)
                } else {
                  foldActionsRef.current?.foldAll()
                  setIsFolded(true)
                }
              }}
              title={isFolded ? 'Unfold all' : 'Fold all'}
              aria-pressed={isFolded}
            >
              {isFolded ? <ChevronsUpDown size={12} /> : <ChevronsDownUp size={12} />}
            </button>
          )}
          <div class={styles.viewModeGroup} aria-label="Editor view mode">
            <button
              class={clsx(styles.viewModeButton, effectiveViewMode === 'edit' && styles.viewModeButtonActive)}
              onClick={() => setViewMode('edit')}
              disabled={!isMarkdownTab}
              title={isMarkdownTab ? 'Editor only' : 'Markdown preview is available for markdown files'}
            >
              <SquarePen size={12} />
              Edit
            </button>
            <button
              class={clsx(styles.viewModeButton, effectiveViewMode === 'split' && styles.viewModeButtonActive)}
              onClick={() => setViewMode('split')}
              disabled={!isMarkdownTab}
              title={isMarkdownTab ? 'Split editor and preview' : 'Markdown preview is available for markdown files'}
            >
              <Columns2 size={12} />
              Split
            </button>
            <button
              class={clsx(styles.viewModeButton, effectiveViewMode === 'preview' && styles.viewModeButtonActive)}
              onClick={() => setViewMode('preview')}
              disabled={!isMarkdownTab}
              title={isMarkdownTab ? 'Preview only' : 'Markdown preview is available for markdown files'}
            >
              <Eye size={12} />
              Preview
            </button>
          </div>
          {groups.some(g => g.tabs.length > 0) && (
            <button
              class={styles.closeAllButton}
              onClick={() => setPendingCloseAll(true)}
              title="Close all open tabs"
            >
              <X size={12} />
              Close All
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div class={styles.body}>
        {/* Explorer sidebar */}
        <div
          class={clsx(styles.explorer, explorerCollapsed && styles.explorerCollapsed)}
          style={!explorerCollapsed ? { '--explorer-width': `${explorerWidth}px` } as any : undefined}
        >
          <div class={styles.explorerHeader}>
            <div class={styles.explorerModeTabs}>
              <button
                class={clsx(styles.explorerModeTab, sidebarMode === 'explorer' && styles.explorerModeTabActive)}
                onClick={() => setSidebarMode('explorer')}
                title="File Explorer"
              >
                <Folder size={14} />
              </button>
              <button
                class={clsx(styles.explorerModeTab, sidebarMode === 'search' && styles.explorerModeTabActive)}
                onClick={() => setSidebarMode('search')}
                title="Search (Cmd+Shift+F)"
              >
                <Search size={14} />
              </button>
              {scratchDrawerEnabled && (
                <button
                  class={clsx(styles.explorerModeTab, sidebarMode === 'scratches' && styles.explorerModeTabActive)}
                  onClick={() => { setSidebarMode('scratches'); setExplorerCollapsed(false) }}
                  title="Scratches"
                >
                  <ChickenIcon size={14} />
                </button>
              )}
            </div>
            <div class={styles.explorerActions}>
              {sidebarMode !== 'search' && (
                <>
                  <button
                    class={styles.explorerToggle}
                    onClick={handleOpenFolder}
                    title="Open Folder"
                  >
                    <FolderOpen size={14} />
                  </button>
                  <button
                    class={styles.explorerToggle}
                    onClick={() => void openScratchTab()}
                    title="New Scratch File"
                  >
                    <FilePlus size={14} />
                  </button>
                  <button
                    class={styles.explorerToggle}
                    onClick={() => requestRootCreate('directory')}
                    title={rootPath ? 'New Folder (root)' : 'Open a folder first'}
                    disabled={!rootPath}
                  >
                    <FolderPlus size={14} />
                  </button>
                </>
              )}
              <button
                class={styles.explorerToggle}
                onClick={() => setExplorerCollapsed(true)}
                title="Collapse sidebar"
              >
                <PanelLeftClose size={14} />
              </button>
            </div>
          </div>
          <div class={styles.explorerContent}>
            {sidebarMode === 'search' ? (
              <SearchPanel
                rootPath={rootPath}
                visible={!explorerCollapsed}
                onOpenFile={openFileAtLine}
              />
            ) : sidebarMode === 'scratches' ? (
              scratchHome ? (
                <FileTree
                  rootPath={scratchHome}
                  onFileSelect={(path) => { setRevealPath(null); openFile(path) }}
                  onDirectorySelect={setSelectedDirectoryPath}
                  onFileCreated={handleFileCreated}
                  onFileDeleted={handleFileDeleted}
                  selectedPath={activeTab?.path}
                  selectedDirectoryPath={selectedDirectoryPath || undefined}
                  modifiedPaths={modifiedPaths}
                  revealPath={revealPath}
                  showHidden={showHiddenFiles}
                  onRevertFile={revertFileByPath}
                />
              ) : (
                <div style={{ padding: 'var(--space-4)', color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>
                  Resolving scratch home…
                </div>
              )
            ) : rootPath ? (
              <FileTree
                rootPath={rootPath}
                onFileSelect={(path) => { setRevealPath(null); openFile(path) }}
                onDirectorySelect={setSelectedDirectoryPath}
                onFileCreated={handleFileCreated}
                onFileDeleted={handleFileDeleted}
                selectedPath={activeTab?.path}
                selectedDirectoryPath={selectedDirectoryPath || undefined}
                modifiedPaths={modifiedPaths}
                createRootRequest={rootCreateRequest}
                revealPath={revealPath}
                showHidden={showHiddenFiles}
                onRevertFile={revertFileByPath}
              />
            ) : (
              <div style={{ padding: 'var(--space-4)', color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>
                Open a folder to browse files
              </div>
            )}
          </div>
        </div>

        {/* Resize handle */}
        {!explorerCollapsed && (
          <div class={styles.resizeHandle} onMouseDown={handleResizeStart} />
        )}

        {/* Editor area */}
        <div class={styles.editorArea}>
          {explorerCollapsed && (
            <button
              class={styles.collapsedToggle}
              onClick={() => setExplorerCollapsed(false)}
              title="Show explorer"
            >
              <PanelLeft size={16} />
            </button>
          )}
          <div class={styles.editorContent}>
            {(activeTab || isSplit) ? (
              <div class={clsx(styles.workspace, showPreviewPane && effectiveViewMode === 'split' && styles.workspaceSplit)}>
                {isImageTab ? (
                  <div class={styles.imagePreviewPane}>
                    <div class={styles.previewHeader}>
                      <span>Image Preview</span>
                      <span class={styles.previewMeta}>{activeTab?.mimeType}</span>
                    </div>
                    <div class={styles.imagePreviewViewport}>
                      <img
                        class={styles.imagePreviewImage}
                        src={`data:${activeTab!.mimeType};base64,${activeTab!.base64Content}`}
                        alt={activeTab!.name}
                      />
                    </div>
                  </div>
                ) : isSplit ? (
                  <div class={styles.editorSplit} ref={splitContainerRef}>
                    {(maximizedGroupId ? groups.filter(g => g.id === maximizedGroupId) : groups).map((group, gi) => {
                      const gTab = group.activeTabIndex >= 0 && group.activeTabIndex < group.tabs.length
                        ? group.tabs[group.activeTabIndex] : null
                      const isActive = group.id === activeGroupId
                      return (
                        <Fragment key={group.id}>
                          {gi > 0 && <div class={styles.splitDivider} onMouseDown={(e: MouseEvent) => handleSplitDividerDrag(e, gi - 1)} />}
                          <div class={clsx(styles.splitPane, isActive && styles.splitPaneFocused)} style={splitRatios[group.id] ? { flex: splitRatios[group.id] } as any : undefined} onClickCapture={() => setActiveGroupId(group.id)}>
                            <div
                              class={styles.splitPaneTabs}
                              onDragOver={(e: DragEvent) => handleTabBarDragOver(e, group.id)}
                              onDrop={(e: DragEvent) => handleTabBarDrop(e, group.id)}
                            >
                              {group.tabs.map((tab, i) => {
                                const isDragging = tabDragState?.sourceGroupId === group.id && tabDragState.sourceIndex === i
                                const isDropTarget = tabDropTarget?.groupId === group.id && tabDropTarget.index === i
                                return (
                                  <button
                                    key={tab.path}
                                    draggable
                                    class={clsx(
                                      styles.splitPaneTab,
                                      i === group.activeTabIndex && styles.splitPaneTabActive,
                                      tab.content !== tab.savedContent && styles.tabModified,
                                      isDragging && styles.tabDragging,
                                      isDropTarget && styles.tabDropTarget,
                                    )}
                                    onClick={() => {
                                      setActiveGroupId(group.id)
                                      setGroups(prev => prev.map(g => g.id === group.id ? { ...g, activeTabIndex: i } : g))
                                    }}
                                    onContextMenu={(e: MouseEvent) => {
                                      e.preventDefault()
                                      e.stopPropagation()
                                      setActiveGroupId(group.id)
                                      setGroups(prev => prev.map(g => g.id === group.id ? { ...g, activeTabIndex: i } : g))
                                      setTabContextMenu({ x: e.clientX, y: e.clientY, index: i })
                                    }}
                                    onDragStart={(e: DragEvent) => handleTabDragStart(e, group.id, i)}
                                    onDragOver={(e: DragEvent) => handleTabDragOver(e, group.id, i)}
                                    onDrop={(e: DragEvent) => handleTabDrop(e, group.id, i)}
                                    onDragEnd={handleTabDragEnd}
                                    title={tab.path}
                                  >
                                    <span class={clsx(styles.tabName, tab.isScratch && styles.tabScratch)}>{tab.name}</span>
                                    <span
                                      class={styles.tabClose}
                                      onClick={(e: Event) => {
                                        e.stopPropagation()
                                        closeTab(i, e, group.id)
                                      }}
                                      title="Close"
                                    >
                                      <X size={12} />
                                    </span>
                                  </button>
                                )
                              })}
                              {maximizedGroupId && (
                                <button
                                  class={styles.splitPaneMaxBadge}
                                  onClick={() => setMaximizedGroupId(null)}
                                  title="Restore split layout"
                                >
                                  <Minimize2 size={11} />
                                  {groups.findIndex(g => g.id === group.id) + 1} / {groups.length}
                                </button>
                              )}
                            </div>
                            {gTab ? (
                              <div class={styles.editorPane}>
                                <CodeEditor
                                  fileId={`${group.id}:${gTab.path}`}
                                  value={gTab.content}
                                  onChange={makeContentChangeHandler(group.id)}
                                  language={gTab.language}
                                  fontSize={fontSize}
                                  lineWrapping={lineWrapping}
                                  onSave={makeSaveHandler(group.id)}
                                  onCursorChange={(line, col) => { if (isActive) setCursorPos({ line, col }) }}
                                  cursorTarget={isActive ? cursorTarget : null}
                                  autoFocus={isActive}
                                  onGetFoldActions={isActive ? actions => { foldActionsRef.current = actions } : undefined}
                                />
                              </div>
                            ) : (
                              <div class={styles.editorPane}>
                                <div class={styles.emptyState}>
                                  <span class={styles.emptyStateText}>Open a file in this pane</span>
                                </div>
                              </div>
                            )}
                          </div>
                        </Fragment>
                      )
                    })}
                  </div>
                ) : showEditorPane && (
                  <div class={styles.editorPane}>
                    <CodeEditor
                      fileId={activeTab!.path}
                      value={activeTab!.content}
                      onChange={handleContentChange}
                      language={activeTab!.language}
                      fontSize={fontSize}
                      lineWrapping={lineWrapping}
                      onSave={saveActiveTab}
                      onCursorChange={(line, col) => setCursorPos({ line, col })}
                      cursorTarget={cursorTarget}
                      autoFocus
                      onGetFoldActions={actions => { foldActionsRef.current = actions }}
                    />
                  </div>
                )}
                {showPreviewPane && effectiveViewMode === 'split' && (
                  <div class={styles.workspaceDivider} />
                )}
                {showPreviewPane && (
                  <div class={styles.previewPane}>
                    <div class={styles.previewHeader}>
                      <span>Preview</span>
                      {previewLoading && <span class={styles.previewMeta}>Rendering…</span>}
                    </div>
                    <div class={styles.previewScroll}>
                      {previewError ? (
                        <div class={styles.previewMessageError}>{previewError}</div>
                      ) : previewHtml ? (
                        <div
                          class={styles.previewContent}
                          dangerouslySetInnerHTML={{ __html: previewHtml }}
                        />
                      ) : (
                        <div class={styles.previewMessageMuted}>
                          {previewLoading ? 'Rendering preview…' : 'Nothing to preview'}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div class={styles.emptyState}>
                <FileCode size={48} class={styles.emptyStateIcon} />
                <span class={styles.emptyStateText}>
                  {rootPath ? 'Select a file to edit' : 'Open a folder to get started'}
                </span>
                <span class={styles.emptyStateHint}>
                  Cmd+Shift+P command palette &middot; Cmd+Shift+F search files &middot; Cmd+Shift+\ split editor
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div class={styles.statusBar}>
        {activeTab ? (
          <>
            <span class={styles.statusPath}>{activeTab.path}</span>
            {isDirty && !isImageTab && (
              <button
                class={styles.statusAction}
                onClick={revertActiveTab}
                title="Revert to saved"
              >
                <Undo2 size={12} />
                Revert
              </button>
            )}
            {!isImageTab && (
              <span class={styles.statusItem}>
                Ln {cursorPos.line}, Col {cursorPos.col}
              </span>
            )}
            <span class={styles.statusItem}>{activeTab.language}</span>
            {activeTab.isImage && activeTab.mimeType && (
              <span class={styles.statusItem}>{activeTab.mimeType}</span>
            )}
            {typeof activeTab.size === 'number' && (
              <span class={styles.statusItem}>{Math.round(activeTab.size / 1024)} KB</span>
            )}
            <button
              class={styles.statusAction}
              onClick={toggleLineWrapping}
              title="Toggle Word Wrap"
            >{lineWrapping ? 'Wrap' : 'No Wrap'}</button>
            <button
              class={styles.statusAction}
              onClick={toggleAutoSave}
              title="Toggle Auto Save"
            >{autoSave ? 'Auto Save: On' : 'Auto Save: Off'}</button>
            {isMarkdownTab && (
              <span class={styles.statusItem}>View: {effectiveViewMode}</span>
            )}
            <button
              class={styles.statusAction}
              onClick={zoomOut}
              title="Zoom out (Cmd+-)"
            >−</button>
            <span class={styles.statusItem}>{fontSize}px</span>
            <button
              class={styles.statusAction}
              onClick={zoomIn}
              title="Zoom in (Cmd+=)"
            >+</button>
            <button
              class={styles.statusAction}
              onClick={zoomReset}
              title="Reset zoom (Cmd+0)"
              disabled={fontSize === 14}
              style={fontSize === 14 ? { visibility: 'hidden' } : undefined}
              aria-hidden={fontSize === 14}
              tabIndex={fontSize === 14 ? -1 : undefined}
            >Reset</button>
            {isDirty && !isImageTab && (
              <span class={styles.statusItem} style={{ color: 'var(--warning)' }}>Modified</span>
            )}
          </>
        ) : (
          <span class={styles.statusPath}>{rootPath || 'No folder open'}</span>
        )}
      </div>

      {/* Save before close modal */}
      {pendingCloseIndex !== null && activeGroup.tabs[pendingCloseIndex] && (
        <div class={styles.modalOverlay} onClick={handleCloseCancel}>
          <div ref={closeModalRef} class={styles.modal} onClick={(e: Event) => e.stopPropagation()}>
            <h3 class={styles.modalTitle}>Unsaved Changes</h3>
            <p class={styles.modalMessage}>
              Save changes to "{activeGroup.tabs[pendingCloseIndex]?.name}" before closing?
            </p>
            <div class={styles.modalActions}>
              <button class={styles.modalBtn} onClick={handleCloseCancel}>Cancel</button>
              <button class={styles.modalBtnDanger} onClick={handleCloseDiscard}>Don't Save</button>
              <button class={styles.modalBtnPrimary} onClick={handleCloseSave} autoFocus>Save</button>
            </div>
          </div>
        </div>
      )}

      {tabContextMenu && activeGroup.tabs[tabContextMenu.index] && (
        <div
          class={styles.tabContextMenu}
          style={{ top: `${tabContextMenu.y}px`, left: `${tabContextMenu.x}px` }}
          onClick={(e: Event) => e.stopPropagation()}
          onMouseDown={(e: Event) => e.stopPropagation()}
        >
          <button class={styles.tabContextMenuItem} onClick={() => void copyTabPath(tabContextMenu.index)}>
            <Copy size={14} /> Copy Path
          </button>
          <button class={styles.tabContextMenuItem} onClick={() => void copyTabRelativePath(tabContextMenu.index)}>
            <Copy size={14} /> Copy Relative Path
          </button>
          {activeGroup.tabs[tabContextMenu.index] && !activeGroup.tabs[tabContextMenu.index].isScratch && (
            <>
              {rootPath && (
                <button class={styles.tabContextMenuItem} onClick={() => {
                  const tab = activeGroup.tabs[tabContextMenu.index]
                  if (tab) {
                    setExplorerCollapsed(false)
                    setSidebarMode('explorer')
                    setRevealPath(tab.path)
                  }
                  setTabContextMenu(null)
                }}>
                  <Folder size={14} /> Reveal in Sidebar
                </button>
              )}
              <button class={styles.tabContextMenuItem} onClick={() => {
                const tab = activeGroup.tabs[tabContextMenu.index]
                if (tab) void fsReveal(tab.path)
                setTabContextMenu(null)
              }}>
                <FolderOpen size={14} /> Reveal in Finder
              </button>
            </>
          )}
          <button class={styles.tabContextMenuItem} onClick={() => {
            setTabContextMenu(null)
            setGroups(prev => prev.map(g => g.id === activeGroupId ? { ...g, activeTabIndex: tabContextMenu.index } : g))
            void saveTabAs()
          }}>
            <FilePlus size={14} /> Save As...
          </button>
          {activeGroup.tabs[tabContextMenu.index] && activeGroup.tabs[tabContextMenu.index].content !== activeGroup.tabs[tabContextMenu.index].savedContent && (
            <button class={styles.tabContextMenuItem} onClick={() => {
              setTabContextMenu(null)
              setGroups(prev => prev.map(g => g.id === activeGroupId ? { ...g, activeTabIndex: tabContextMenu.index } : g))
              void revertActiveTab()
            }}>
              <Undo2 size={14} /> Revert
            </button>
          )}
          <div class={styles.tabContextMenuDivider} />
          <button class={styles.tabContextMenuItem} onClick={() => {
            const tab = activeGroup.tabs[tabContextMenu.index]
            if (tab) {
              const newId = nextGroupId()
              // Remove from current group, add to new group
              setGroups(prev => {
                const updated = prev.map(g => {
                  if (g.id !== activeGroupId) return g
                  const newTabs = g.tabs.filter((_, i) => i !== tabContextMenu.index)
                  let newActive = g.activeTabIndex
                  if (tabContextMenu.index < newActive) newActive -= 1
                  else if (tabContextMenu.index === newActive) newActive = Math.min(newActive, newTabs.length - 1)
                  return { ...g, tabs: newTabs, activeTabIndex: newActive }
                })
                return [...updated, { id: newId, tabs: [tab], activeTabIndex: 0 }]
              })
              setActiveGroupId(newId)
            }
            setTabContextMenu(null)
          }}>
            <Columns2 size={14} /> Open in Split
          </button>
          {isSplit && (
            <button class={styles.tabContextMenuItem} onClick={() => {
              setMaximizedGroupId(prev => prev === activeGroupId ? null : activeGroupId)
              setTabContextMenu(null)
            }}>
              <Columns2 size={14} /> {maximizedGroupId === activeGroupId ? 'Restore Pane' : 'Maximize Pane'}
            </button>
          )}
          <button class={styles.tabContextMenuItem} onClick={(e) => { setTabContextMenu(null); closeTab(tabContextMenu.index, e as any) }}>
            <X size={14} /> Close
          </button>
          {activeGroup.tabs.length > 1 && (
            <button class={styles.tabContextMenuItem} onClick={() => { setTabContextMenu(null); closeAllTabs() }}>
              <X size={14} /> Close All
            </button>
          )}
        </div>
      )}

      {/* Revert changes modal */}
      {pendingRevert && activeTab && (
        <div class={styles.modalOverlay} onClick={handleRevertCancel}>
          <div ref={revertModalRef} class={styles.modal} onClick={(e: Event) => e.stopPropagation()}>
            <h3 class={styles.modalTitle}>Revert Changes</h3>
            <p class={styles.modalMessage}>
              Revert "{activeTab.name}" to the last saved version? Unsaved changes will be lost.
            </p>
            <div class={styles.modalActions}>
              <button class={styles.modalBtn} onClick={handleRevertCancel}>Cancel</button>
              <button class={styles.modalBtnDanger} onClick={handleRevertConfirm} autoFocus>Revert</button>
            </div>
          </div>
        </div>
      )}

      {/* Close All tabs confirmation */}
      {pendingCloseAll && (() => {
        const openTabCount = groups.reduce((n, g) => n + g.tabs.length, 0)
        const unsavedCount = groups.reduce((n, g) => n + g.tabs.filter(t => t.content !== t.savedContent).length, 0)
        return (
          <div class={styles.modalOverlay} onClick={() => setPendingCloseAll(false)}>
            <div class={styles.modal} onClick={(e: Event) => e.stopPropagation()}>
              <h3 class={styles.modalTitle}>Close all tabs?</h3>
              <p class={styles.modalMessage}>
                {unsavedCount > 0
                  ? `${openTabCount} tab${openTabCount === 1 ? '' : 's'} open, ${unsavedCount} with unsaved changes. Close all and discard unsaved changes?`
                  : `Close all ${openTabCount} open tab${openTabCount === 1 ? '' : 's'}?`}
              </p>
              <div class={styles.modalActions}>
                <button class={styles.modalBtn} onClick={() => setPendingCloseAll(false)}>Cancel</button>
                <button
                  class={styles.modalBtnDanger}
                  onClick={() => { setPendingCloseAll(false); closeAllTabs() }}
                  autoFocus
                >
                  Close All
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      <QuickOpen
        visible={quickOpenVisible}
        rootPath={rootPath}
        onClose={handleQuickOpenClose}
        onSelect={openFile}
        commands={paletteCommands}
        showHidden={showHiddenFiles}
        initialScope={quickOpenInitialScope}
      />

      {/* Path input modal */}
      {showPathInput && (
        <div class={styles.pathInputOverlay} onClick={() => setShowPathInput(false)}>
          <div class={styles.pathInput} onClick={(e: Event) => e.stopPropagation()}>
            <label class={styles.pathInputLabel}>{pathInputMode === 'save-as' ? 'Save As' : 'Open Folder'}</label>
            <div class={styles.pathInputRow}>
              <input
                class={styles.pathInputField}
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
                  } else if (e.key === 'Tab' && completions.length > 0) {
                    e.preventDefault()
                    const idx = completionIndex >= 0 ? completionIndex : 0
                    acceptCompletion(completions[idx])
                  } else if (e.key === 'ArrowRight' && completions.length > 0 && completionIndex >= 0) {
                    e.preventDefault()
                    acceptCompletion(completions[completionIndex])
                  } else if (e.key === 'Enter') {
                    if (pathInputMode === 'open-folder' && completionIndex >= 0 && completions[completionIndex]) {
                      handlePathSubmit(completions[completionIndex].path)
                    } else if (completionIndex >= 0 && completions[completionIndex]) {
                      acceptCompletion(completions[completionIndex])
                    } else {
                      handlePathSubmit(pathValue)
                    }
                  } else if (e.key === 'Escape') {
                    if (completions.length > 0) {
                      setCompletions([])
                      setCompletionIndex(-1)
                    } else {
                      setShowPathInput(false)
                    }
                  }
                }}
                placeholder={pathInputMode === 'save-as' ? '/path/to/file.md' : '/path/to/folder'}
                autoFocus
              />
              {pathInputMode === 'open-folder' && pathValue.trim().length > 0 && (
                <button
                  type="button"
                  class={clsx(styles.starCurrent, isFavorite(pathValue) && styles.starCurrentActive)}
                  onClick={() => toggleFavorite(pathValue)}
                  title={isFavorite(pathValue) ? 'Unstar this path' : 'Add this path to favorites'}
                  aria-pressed={isFavorite(pathValue)}
                >
                  <Star size={13} />
                  <span>{isFavorite(pathValue) ? 'Starred' : 'Star path'}</span>
                </button>
              )}
            </div>
            {completions.length > 0 && (
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
                      onClick={() => {
                        if (pathInputMode === 'open-folder') {
                          handlePathSubmit(c.path)
                        } else {
                          acceptCompletion(c)
                        }
                      }}
                      title={pathInputMode === 'open-folder' ? `Open ${c.path}` : c.path}
                    >
                      <Folder size={14} />
                      <span class={styles.completionName}>{c.name}</span>
                      <span class={styles.completionPath}>{c.path}</span>
                    </button>
                    {pathInputMode === 'open-folder' && (
                      <button
                        type="button"
                        class={styles.completionDrill}
                        onClick={(e: Event) => { e.stopPropagation(); acceptCompletion(c) }}
                        title="Browse inside"
                        aria-label={`Browse inside ${c.name}`}
                      >
                        <ChevronRight size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {completions.length === 0 && pathInputMode === 'open-folder' && (() => {
              const recentFolders = loadStore().editor.recentFolders.filter((f) => !favoriteFolders.includes(normalizeFolderPath(f)))
              const hasFavorites = favoriteFolders.length > 0
              const hasRecents = recentFolders.length > 0

              if (!hasFavorites && !hasRecents) {
                return (
                  <div class={styles.folderEmpty}>
                    <div class={styles.folderEmptyGlyph}><Star size={26} /></div>
                    <h3 class={styles.folderEmptyTitle}>Open your first folder</h3>
                    <p class={styles.folderEmptyBody}>
                      Type a path above or press <kbd class={styles.folderKbd}>Tab</kbd> to browse.
                      Folders you open will show up as recents; star any you want pinned.
                    </p>
                    <div class={styles.folderSuggest}>
                      {[
                        { path: '~/projects', label: '~/projects', icon: <Folder size={12} /> },
                        { path: '~', label: 'Home', icon: <Home size={12} /> },
                        { path: '~/Documents', label: 'Documents', icon: <FileText size={12} /> },
                      ].map((s) => (
                        <button
                          key={s.path}
                          type="button"
                          class={styles.suggestChip}
                          onClick={() => {
                            setPathValue(s.path + '/')
                            fetchCompletions(s.path + '/')
                          }}
                        >
                          {s.icon}
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              }

              return (
                <>
                  {hasFavorites && (
                    <>
                      <span class={styles.recentLabel}>Favorites</span>
                      <div class={styles.folderRows}>
                        {favoriteFolders.map((folder) => {
                          const label = folder.split('/').filter(Boolean).pop() || folder
                          return (
                            <div
                              key={folder}
                              class={clsx(styles.folderRow, shimmerPath === folder && styles.folderRowShimmer)}
                            >
                              <span class={styles.folderRowIcon}><FolderOpen size={14} /></span>
                              <button
                                type="button"
                                class={styles.folderRowOpen}
                                onClick={() => handlePathSubmit(folder)}
                                title={`Open ${folder}`}
                              >
                                <span class={styles.folderRowName}>{label}</span>
                                <span class={styles.folderRowPath}>{folder}</span>
                              </button>
                              <button
                                type="button"
                                class={clsx(styles.folderRowStar, styles.folderRowStarActive)}
                                onClick={(e: Event) => { e.stopPropagation(); toggleFavorite(folder) }}
                                title="Unstar"
                                aria-pressed="true"
                              >
                                <Star size={13} fill="currentColor" />
                              </button>
                              <button
                                type="button"
                                class={styles.folderRowDrill}
                                onClick={(e: Event) => { e.stopPropagation(); acceptCompletion({ name: label, path: folder }) }}
                                title="Browse inside"
                                aria-label={`Browse inside ${folder}`}
                              >
                                <ChevronRight size={14} />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}
                  {hasRecents && (
                    <>
                      <span class={styles.recentLabel}>Recent</span>
                      <div class={styles.folderRows}>
                        {recentFolders.map((folder) => {
                          const label = folder.split('/').filter(Boolean).pop() || folder
                          return (
                            <div key={folder} class={clsx(styles.folderRow, styles.folderRowRecent)}>
                              <span class={styles.folderRowIcon}><Folder size={14} /></span>
                              <button
                                type="button"
                                class={styles.folderRowOpen}
                                onClick={() => handlePathSubmit(folder)}
                                title={`Open ${folder}`}
                              >
                                <span class={styles.folderRowName}>{label}</span>
                                <span class={styles.folderRowPath}>{folder}</span>
                              </button>
                              <button
                                type="button"
                                class={styles.folderRowStar}
                                onClick={(e: Event) => { e.stopPropagation(); toggleFavorite(folder) }}
                                title="Star"
                                aria-pressed="false"
                              >
                                <Star size={13} />
                              </button>
                              <button
                                type="button"
                                class={styles.folderRowDrill}
                                onClick={(e: Event) => { e.stopPropagation(); acceptCompletion({ name: label, path: folder }) }}
                                title="Browse inside"
                                aria-label={`Browse inside ${folder}`}
                              >
                                <ChevronRight size={14} />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}
                </>
              )
            })()}
          </div>
        </div>
      )}
    </div>
    <div class={styles.footerSpacer} />
    </Fragment>
  )
}
