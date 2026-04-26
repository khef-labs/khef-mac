/**
 * Consolidated state store for khef UI.
 *
 * Editor workspace state (rootPath, open tabs, groups) uses sessionStorage
 * so each browser tab gets its own independent workspace — like VS Code windows.
 *
 * Shared preferences (font size, TTS, export) use localStorage so they're
 * consistent across all tabs.
 */

const STORAGE_KEY = 'khef-state'
const SESSION_EDITOR_KEY = 'khef-editor'

export interface EditorGroupState {
  id: string
  openPaths: string[]
  activeIndex: number
}

/** Per-tab editor workspace state (sessionStorage) */
export interface EditorWorkspaceState {
  rootPath: string
  openPaths: string[]     // legacy: used as fallback when groups is empty
  activeIndex: number     // legacy: used as fallback when groups is empty
  groups: EditorGroupState[]
  activeGroupId: string
  recentFolders: string[]
}

/** Shared editor preferences (localStorage, merged into EditorState) */
export interface EditorPrefsState {
  explorerWidth: number
  fontSize: number
  lineWrapping: boolean
  autoSave: boolean
  favoriteFolders: string[]
}

/** Combined editor state exposed to consumers */
export type EditorState = EditorWorkspaceState & EditorPrefsState

export interface KhefState {
  // Editor (combined workspace + prefs)
  editor: EditorState
  // TTS
  tts: {
    rate: number
    voiceUri: string | null
  }
  // Export preferences
  export: {
    diagramTheme: string
    diagramScale: number
    highQualityRendering: boolean
    imageQuality: number
    displaySize: number
  }
  // MCP
  mcpDismissedServers: string[]
  // Splash
  splashSeen: boolean
  // Database explorer
  dbx: {
    scriptsHeight: number
    resultsHeight: number
    sidebarWidth: number
    openNodes: string[]
    activeNodeKey: string | null
    tabs: any[]
    activeTabId: string | null
    treeFilter: string
  }
  // kapi (built-in API tool)
  kapi: {
    requestPaneHeight: number
    preScriptHeight: number
    sidebarWidth: number
    /** Active collection (handle or id). Restored on /kapi entry. */
    activeCollectionId: string | null
    /** Per-collection last-selected definition + request for restore on revisit. */
    selectionByCollection: Record<
      string,
      { definitionId: string | null; requestId: string | null }
    >
  }
  // Diff page (project diff sidebar width)
  diff: {
    sidebarWidth: number
  }
}

const WORKSPACE_DEFAULTS: EditorWorkspaceState = {
  rootPath: '',
  openPaths: [],
  activeIndex: -1,
  groups: [],
  activeGroupId: '',
  recentFolders: [],
}

const PREFS_DEFAULTS: EditorPrefsState = {
  explorerWidth: 260,
  fontSize: 14,
  lineWrapping: true,
  autoSave: false,
  favoriteFolders: [],
}

const EDITOR_DEFAULTS: EditorState = { ...WORKSPACE_DEFAULTS, ...PREFS_DEFAULTS }

const DEFAULTS: KhefState = {
  editor: EDITOR_DEFAULTS,
  tts: {
    rate: 1.0,
    voiceUri: null,
  },
  export: {
    diagramTheme: 'neutral',
    diagramScale: 2,
    highQualityRendering: true,
    imageQuality: 2,
    displaySize: 100,
  },
  mcpDismissedServers: [],
  splashSeen: false,
  dbx: {
    scriptsHeight: -1, // -1 = 50/50 split
    resultsHeight: 280,
    sidebarWidth: 260,
    openNodes: [],
    activeNodeKey: null,
    tabs: [],
    activeTabId: null,
    treeFilter: '',
  },
  kapi: {
    requestPaneHeight: 360,
    preScriptHeight: 220,
    sidebarWidth: 260,
    activeCollectionId: null,
    selectionByCollection: {},
  },
  diff: {
    sidebarWidth: 360,
  },
}

function loadSessionEditor(): Partial<EditorWorkspaceState> {
  try {
    const raw = sessionStorage.getItem(SESSION_EDITOR_KEY)
    if (!raw) return {}
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function loadLocalState(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function loadStore(): KhefState {
  const local = loadLocalState()
  const sessionEditor = loadSessionEditor()

  // Editor prefs come from localStorage, workspace from sessionStorage
  const localEditor = (local.editor ?? {}) as Partial<EditorState>
  const prefs: EditorPrefsState = {
    explorerWidth: localEditor.explorerWidth ?? PREFS_DEFAULTS.explorerWidth,
    fontSize: localEditor.fontSize ?? PREFS_DEFAULTS.fontSize,
    lineWrapping: localEditor.lineWrapping ?? PREFS_DEFAULTS.lineWrapping,
    autoSave: localEditor.autoSave ?? PREFS_DEFAULTS.autoSave,
    favoriteFolders: Array.isArray(localEditor.favoriteFolders) ? localEditor.favoriteFolders : PREFS_DEFAULTS.favoriteFolders,
  }

  // Workspace state: sessionStorage first, fall back to localStorage for migration
  const workspace: EditorWorkspaceState = {
    rootPath: sessionEditor.rootPath ?? localEditor.rootPath ?? WORKSPACE_DEFAULTS.rootPath,
    openPaths: sessionEditor.openPaths ?? localEditor.openPaths ?? WORKSPACE_DEFAULTS.openPaths,
    activeIndex: sessionEditor.activeIndex ?? localEditor.activeIndex ?? WORKSPACE_DEFAULTS.activeIndex,
    groups: sessionEditor.groups ?? localEditor.groups ?? WORKSPACE_DEFAULTS.groups,
    activeGroupId: sessionEditor.activeGroupId ?? localEditor.activeGroupId ?? WORKSPACE_DEFAULTS.activeGroupId,
    recentFolders: sessionEditor.recentFolders ?? localEditor.recentFolders ?? WORKSPACE_DEFAULTS.recentFolders,
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const l = local as any

  return {
    editor: { ...workspace, ...prefs },
    tts: { ...DEFAULTS.tts, ...(l.tts ?? {}) },
    export: { ...DEFAULTS.export, ...(l.export ?? {}) },
    mcpDismissedServers: (l.mcpDismissedServers as string[] | undefined) ?? DEFAULTS.mcpDismissedServers,
    splashSeen: (l.splashSeen as boolean | undefined) ?? DEFAULTS.splashSeen,
    dbx: { ...DEFAULTS.dbx, ...(l.dbx ?? {}) },
    kapi: { ...DEFAULTS.kapi, ...(l.kapi ?? {}) },
    diff: { ...DEFAULTS.diff, ...migrateLegacyDiff(l.diff) },
  }
}

/**
 * One-time migration: pull a legacy `diff.sidebarWidth` localStorage entry
 * into the consolidated store. Removes the orphan key once copied so it
 * doesn't pollute the dev tools storage panel.
 */
function migrateLegacyDiff(existing: unknown): Partial<KhefState['diff']> {
  const out: Partial<KhefState['diff']> = (existing as Partial<KhefState['diff']>) ?? {}
  if (out.sidebarWidth !== undefined) return out
  try {
    const legacy = localStorage.getItem('diff.sidebarWidth')
    if (legacy === null) return out
    const parsed = parseInt(legacy, 10)
    if (!Number.isNaN(parsed)) {
      out.sidebarWidth = parsed
    }
    localStorage.removeItem('diff.sidebarWidth')
  } catch {
    /* ignore */
  }
  return out
}

export function saveStore(patch: Partial<KhefState>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const current = loadLocalState() as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const merged: any = { ...current, ...patch }

  if (patch.editor) {
    const currentEditor = (current.editor ?? {}) as Partial<EditorState>
    const pe = patch.editor

    // Only persist prefs to localStorage (not workspace state)
    const localEditor: Partial<EditorPrefsState> = {
      explorerWidth: 'explorerWidth' in pe ? pe.explorerWidth : currentEditor.explorerWidth,
      fontSize: 'fontSize' in pe ? pe.fontSize : currentEditor.fontSize,
      lineWrapping: 'lineWrapping' in pe ? pe.lineWrapping : currentEditor.lineWrapping,
      autoSave: 'autoSave' in pe ? pe.autoSave : currentEditor.autoSave,
      favoriteFolders: 'favoriteFolders' in pe ? pe.favoriteFolders : currentEditor.favoriteFolders,
    }
    merged.editor = localEditor

    // Save workspace state to sessionStorage
    const currentSession = loadSessionEditor()
    const sessionPatch: Partial<EditorWorkspaceState> = { ...currentSession }
    let hasWorkspaceChange = false
    const workspaceKeys: (keyof EditorWorkspaceState)[] = ['rootPath', 'openPaths', 'activeIndex', 'groups', 'activeGroupId', 'recentFolders']
    for (const key of workspaceKeys) {
      if (key in pe) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(sessionPatch as any)[key] = (pe as any)[key]
        hasWorkspaceChange = true
      }
    }
    if (hasWorkspaceChange) {
      sessionStorage.setItem(SESSION_EDITOR_KEY, JSON.stringify(sessionPatch))
    }
  }

  if (patch.tts) merged.tts = { ...(current.tts ?? {}), ...patch.tts }
  if (patch.export) merged.export = { ...(current.export ?? {}), ...patch.export }
  if (patch.dbx) merged.dbx = { ...(current.dbx ?? {}), ...patch.dbx }
  if (patch.kapi) merged.kapi = { ...(current.kapi ?? {}), ...patch.kapi }
  if (patch.diff) merged.diff = { ...(current.diff ?? {}), ...patch.diff }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
}
