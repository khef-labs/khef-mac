/**
 * Consolidated state store for khef UI.
 *
 * Two roots:
 *
 *   localStorage['khef-state']    - durable, cross-tab preferences
 *                                   (editor prefs, TTS, export, MCP dismissals,
 *                                    splash, dbx, kapi, diff)
 *
 *   sessionStorage['khef-state']  - per-tab transient state, separate from
 *                                   localStorage even though it shares the same
 *                                   key name (different storage areas).
 *                                   (editor workspace, nav contexts, last URL,
 *                                    project filters, chat sidebar, stats tab,
 *                                    session back URL)
 *
 * Historically every transient piece had its own top-level sessionStorage key
 * (khefNavContext, khefLastLocation, khefProjectFilters:<id>, ...). They've
 * been folded under sessionStorage['khef-state'] so DevTools storage panels
 * stay readable. Legacy keys are migrated lazily on first load.
 */

const STORAGE_KEY = 'khef-state'
const LEGACY_SESSION_EDITOR_KEY = 'khef-editor'

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
    savedQueriesHeight: number
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
  // Chat sidebar (per-backend) — replaces khefChatCwd/Pinned/Hidden/Order:* keys.
  chat: Record<string, {
    cwd?: string
    pinned?: unknown[]
    hidden?: string[]
    order?: string[]
  }>
}

/** Generic ordered-list nav context shared by memory/project/session lists. */
export interface NavListContext {
  ids: string[]
  currentIndex: number
  source: string
}

/** Session-list nav adds a project pin so we can build URLs. */
export interface SessionListNavContext extends NavListContext {
  projectId: string
}

/** Per-tab transient state (sessionStorage). */
export interface SessionState {
  editor: EditorWorkspaceState
  /** Last URL the AppShell saw — used by some pages for fallback back-nav. */
  lastLocation: string | null
  /** Memory list nav (consumed by MemoryPage prev/next). */
  memoryNav: NavListContext | null
  /** Project list nav (consumed by ProjectPage prev/next). */
  projectNav: NavListContext | null
  /** Session list nav (consumed by SessionPage prev/next). */
  sessionNav: SessionListNavContext | null
  /** Per-project filter+query restore on /projects/:id return. */
  projectFilters: Record<string, unknown>
  /** Per-project flag set when leaving for memory detail and consumed on return. */
  projectReturn: Record<string, true>
  /** Back URL for session detail when entered from a sub-list. */
  sessionBackUrl: string | null
  /** Chat sidebar collapsed (per-tab UI). */
  chatSidebarCollapsed: boolean
  /** Stats page active tab. */
  statsTab: string | null
}

const WORKSPACE_DEFAULTS: EditorWorkspaceState = {
  rootPath: '',
  openPaths: [],
  activeIndex: -1,
  groups: [],
  activeGroupId: '',
  recentFolders: [],
}

const SESSION_DEFAULTS: SessionState = {
  editor: WORKSPACE_DEFAULTS,
  lastLocation: null,
  memoryNav: null,
  projectNav: null,
  sessionNav: null,
  projectFilters: {},
  projectReturn: {},
  sessionBackUrl: null,
  chatSidebarCollapsed: false,
  statsTab: null,
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
    // Section heights must stay >= the SECTION_HEIGHT_MIN enforced in
    // DbxPage.tsx (96px). Below that the section's filter + items get
    // clipped because each panel uses overflow-y: auto. Stale localStorage
    // values are migrated up via loadSectionHeight() on mount.
    scriptsHeight: 140,
    savedQueriesHeight: 140,
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
  chat: {},
}

let migratedLegacyChat = false
function migrateLegacyChatKeys(): KhefState['chat'] {
  if (typeof window === 'undefined') return {}
  if (migratedLegacyChat) return {}
  migratedLegacyChat = true

  const out: KhefState['chat'] = {}
  const prefixes: Array<[string, 'cwd' | 'pinned' | 'hidden' | 'order']> = [
    ['khefChatCwd:', 'cwd'],
    ['khefChatSidebarPinned:', 'pinned'],
    ['khefChatSidebarHidden:', 'hidden'],
    ['khefChatSidebarOrder:', 'order'],
  ]
  const toRemove: string[] = []
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (!k) continue
      for (const [prefix, slot] of prefixes) {
        if (!k.startsWith(prefix)) continue
        const backend = k.substring(prefix.length)
        const raw = window.localStorage.getItem(k)
        if (raw == null) break
        out[backend] = out[backend] || {}
        if (slot === 'cwd') {
          out[backend].cwd = raw
        } else {
          try {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) {
              ;(out[backend] as any)[slot] = parsed
            }
          } catch { /* ignore parse errors on legacy keys */ }
        }
        toRemove.push(k)
        break
      }
    }
    for (const k of toRemove) {
      try { window.localStorage.removeItem(k) } catch { /* ignore */ }
    }
  } catch { /* private-mode storage access failures */ }

  return out
}

// ---------- sessionStorage (per-tab transient) ----------

let migratedLegacySession = false

function readJsonSession<T>(key: string): T | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/**
 * One-time migration: fold every legacy top-level sessionStorage key into the
 * single 'khef-state' root. Runs once per tab; legacy keys are removed after
 * successful copy. New code reads/writes only via loadSession/saveSession.
 */
function migrateLegacySessionKeys(): Partial<SessionState> {
  if (typeof window === 'undefined') return {}
  if (migratedLegacySession) return {}
  migratedLegacySession = true

  const out: Partial<SessionState> = {}

  // Editor workspace state was previously under 'khef-editor'
  const legacyEditor = readJsonSession<Partial<EditorWorkspaceState>>(LEGACY_SESSION_EDITOR_KEY)
  if (legacyEditor) {
    out.editor = { ...WORKSPACE_DEFAULTS, ...legacyEditor }
  }

  const lastLocation = window.sessionStorage.getItem('khefLastLocation')
  if (lastLocation) out.lastLocation = lastLocation

  const memoryNav = readJsonSession<NavListContext>('khefNavContext')
  if (memoryNav) out.memoryNav = memoryNav

  const projectNav = readJsonSession<NavListContext>('khefProjectNavContext')
  if (projectNav) out.projectNav = projectNav

  const sessionNav = readJsonSession<SessionListNavContext>('khefSessionNavContext')
  if (sessionNav) out.sessionNav = sessionNav

  const sessionBackUrl = window.sessionStorage.getItem('khefSessionBackUrl')
  if (sessionBackUrl) out.sessionBackUrl = sessionBackUrl

  const sidebar = window.sessionStorage.getItem('khef-chat-sidebar-collapsed')
  if (sidebar !== null) out.chatSidebarCollapsed = sidebar === '1'

  const statsTab = window.sessionStorage.getItem('stats-tab')
  if (statsTab) out.statsTab = statsTab

  // Per-project keys: khefProjectFilters:<id> and khefProjectReturn:<id>
  const projectFilters: Record<string, unknown> = {}
  const projectReturn: Record<string, true> = {}
  const toRemove: string[] = []
  for (let i = 0; i < window.sessionStorage.length; i++) {
    const k = window.sessionStorage.key(i)
    if (!k) continue
    if (k.startsWith('khefProjectFilters:')) {
      const projectId = k.substring('khefProjectFilters:'.length)
      const val = readJsonSession<unknown>(k)
      if (val) projectFilters[projectId] = val
      toRemove.push(k)
    } else if (k.startsWith('khefProjectReturn:')) {
      const projectId = k.substring('khefProjectReturn:'.length)
      if (window.sessionStorage.getItem(k)) projectReturn[projectId] = true
      toRemove.push(k)
    }
  }
  if (Object.keys(projectFilters).length > 0) out.projectFilters = projectFilters
  if (Object.keys(projectReturn).length > 0) out.projectReturn = projectReturn

  // Remove legacy keys after copying so DevTools storage stays readable.
  const legacyKeys = [
    LEGACY_SESSION_EDITOR_KEY,
    'khefLastLocation',
    'khefNavContext',
    'khefProjectNavContext',
    'khefSessionNavContext',
    'khefSessionBackUrl',
    'khef-chat-sidebar-collapsed',
    'stats-tab',
  ]
  for (const k of legacyKeys) {
    try { window.sessionStorage.removeItem(k) } catch { /* ignore */ }
  }
  for (const k of toRemove) {
    try { window.sessionStorage.removeItem(k) } catch { /* ignore */ }
  }

  return out
}

function readSessionRoot(): Partial<SessionState> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) {
      // First read of the session — fold legacy keys.
      return migrateLegacySessionKeys()
    }
    const parsed = JSON.parse(raw) as Partial<SessionState>
    if (!migratedLegacySession) {
      // Even if the consolidated key exists, pick up any legacy stragglers
      // written by old tabs / partial migrations.
      const legacy = migrateLegacySessionKeys()
      if (Object.keys(legacy).length > 0) {
        const merged = { ...parsed, ...legacy }
        try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(merged)) } catch { /* ignore */ }
        return merged
      }
    }
    return parsed
  } catch {
    return {}
  }
}

function writeSessionRoot(state: Partial<SessionState>): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* quota or disabled */ }
}

export function loadSession(): SessionState {
  const root = readSessionRoot()
  return {
    ...SESSION_DEFAULTS,
    ...root,
    editor: { ...WORKSPACE_DEFAULTS, ...(root.editor ?? {}) },
    projectFilters: { ...SESSION_DEFAULTS.projectFilters, ...(root.projectFilters ?? {}) },
    projectReturn: { ...SESSION_DEFAULTS.projectReturn, ...(root.projectReturn ?? {}) },
  }
}

export function saveSession(patch: Partial<SessionState>): void {
  const current = readSessionRoot()
  const merged: Partial<SessionState> = { ...current, ...patch }
  // Per-project maps merge instead of replace so writers can patch a single id.
  if (patch.projectFilters) {
    merged.projectFilters = { ...(current.projectFilters ?? {}), ...patch.projectFilters }
  }
  if (patch.projectReturn) {
    merged.projectReturn = { ...(current.projectReturn ?? {}), ...patch.projectReturn }
  }
  if (patch.editor) {
    merged.editor = { ...(current.editor ?? {}), ...patch.editor }
  }
  writeSessionRoot(merged)
}

/** Functional update — read, transform, write. */
export function updateSession(updater: (s: SessionState) => Partial<SessionState>): void {
  const current = loadSession()
  const patch = updater(current)
  saveSession(patch)
}

// ---------- localStorage (durable, cross-tab) ----------

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
  const session = loadSession()

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
    rootPath: session.editor.rootPath || (localEditor.rootPath ?? WORKSPACE_DEFAULTS.rootPath),
    openPaths: session.editor.openPaths.length ? session.editor.openPaths : (localEditor.openPaths ?? WORKSPACE_DEFAULTS.openPaths),
    activeIndex: session.editor.activeIndex !== -1 ? session.editor.activeIndex : (localEditor.activeIndex ?? WORKSPACE_DEFAULTS.activeIndex),
    groups: session.editor.groups.length ? session.editor.groups : (localEditor.groups ?? WORKSPACE_DEFAULTS.groups),
    activeGroupId: session.editor.activeGroupId || (localEditor.activeGroupId ?? WORKSPACE_DEFAULTS.activeGroupId),
    recentFolders: session.editor.recentFolders.length ? session.editor.recentFolders : (localEditor.recentFolders ?? WORKSPACE_DEFAULTS.recentFolders),
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
    chat: { ...migrateLegacyChatKeys(), ...((l.chat as KhefState['chat'] | undefined) ?? {}) },
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

    // Save workspace state to sessionStorage via the consolidated session root
    const workspaceKeys: (keyof EditorWorkspaceState)[] = ['rootPath', 'openPaths', 'activeIndex', 'groups', 'activeGroupId', 'recentFolders']
    const workspacePatch: Partial<EditorWorkspaceState> = {}
    let hasWorkspaceChange = false
    for (const key of workspaceKeys) {
      if (key in pe) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(workspacePatch as any)[key] = (pe as any)[key]
        hasWorkspaceChange = true
      }
    }
    if (hasWorkspaceChange) {
      saveSession({ editor: { ...loadSession().editor, ...workspacePatch } })
    }
  }

  if (patch.tts) merged.tts = { ...(current.tts ?? {}), ...patch.tts }
  if (patch.export) merged.export = { ...(current.export ?? {}), ...patch.export }
  if (patch.dbx) merged.dbx = { ...(current.dbx ?? {}), ...patch.dbx }
  if (patch.kapi) merged.kapi = { ...(current.kapi ?? {}), ...patch.kapi }
  if (patch.diff) merged.diff = { ...(current.diff ?? {}), ...patch.diff }
  if (patch.chat) {
    const currentChat = (current.chat as KhefState['chat'] | undefined) ?? {}
    const nextChat: KhefState['chat'] = { ...currentChat }
    for (const [backend, slots] of Object.entries(patch.chat)) {
      nextChat[backend] = { ...(currentChat[backend] ?? {}), ...slots }
    }
    merged.chat = nextChat
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
}
