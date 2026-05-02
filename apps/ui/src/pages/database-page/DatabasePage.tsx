import { useState, useEffect, useRef } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { Table2, Eye, FileText, Plus, Play, Square, X, ChevronsDownUp, ChevronsUpDown, Search, GitBranch, Braces, Zap, Camera } from 'lucide-preact'
import clsx from 'clsx'
import {
  getConnections, getSchemas, getTables, getTableDetail, executeQuery, getTableData,
  getScripts, createScript, updateScript, deleteScript, getQueryHistory, getTableErd, getSchemaErd,
  getFunctions, getSchemaTriggers, getFunctionDetail,
  createSavedQuery, getSavedQuery, runSavedQuery, updateSavedQuery,
  listSavedQuerySnapshots, createSavedQuerySnapshot, restoreSavedQuerySnapshot,
  type DbxConnection, type DbxQueryResult, type DbxScript, type DbxQueryHistoryEntry,
  type DbxSavedQuery, type DbxSavedQuerySnapshot,
} from '../../lib/dbx-api'
import { SavedQueriesPanel } from './SavedQueriesPanel'
import { ParametersForm } from './ParametersForm'
import { SnapshotsModal } from './SnapshotsModal'

const UI_SESSION_ID = 'khef-ui'
import { ConfirmModal } from '../../components/ui'
import { loadStore, saveStore } from '../../lib/store'
import { isDesktopApp } from '../../lib/settings'
import { useDocumentTitle } from '../../hooks'
import type { TreeNode, SqlTab, DetailViewTab, CodeViewTab, SchemaErdTab, Tab, ResultTab, Message } from './types'
import { ResultGrid } from './ResultGrid'
import { ConnectionTree } from './ConnectionTree'
import { TableDetailPanel } from './TableDetailPanel'
import { ConnectionDialog } from './ConnectionDialog'
import { SaveScriptDialog } from './SaveScriptDialog'
import { SqlEditor } from './SqlEditor'
import { SchemaErdPanel } from './SchemaErdPanel'
import { EditRowDialog } from './EditRowDialog'
import styles from './DatabasePage.module.css'

// Minimum keeps header + ~1 row of content visible — going below this clips the
// section's filter input and items because each panel uses its own overflow-y:
// auto. Default lands users on a useful "showing content" view on first visit
// instead of a header-only stub. See pattern memory:
// pattern-page-meta-footer-and-resizable-sidebar-sections
const SECTION_HEIGHT_MIN = 96
const SECTION_HEIGHT_DEFAULT = 140

function loadSectionHeight(value: number | undefined): number {
  if (!value || value <= SECTION_HEIGHT_MIN) return SECTION_HEIGHT_DEFAULT
  return value
}

/**
 * Coerce stored param defaults (TEXT in dbx.saved_query_params.default_value)
 * into typed form values matching ParametersForm's expected shape:
 * number → Number, bool → true/false, text/enum → string. Skips params with
 * no default so the form renders empty for those.
 */
function defaultsForParams(params: { name: string; value_type: string; default_value: string | null }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of params) {
    if (p.default_value === null || p.default_value === undefined || p.default_value === '') continue
    switch (p.value_type) {
      case 'number': {
        const n = Number(p.default_value)
        out[p.name] = Number.isFinite(n) ? n : p.default_value
        break
      }
      case 'bool':
        out[p.name] = p.default_value === 'true' || p.default_value === '1'
        break
      default:
        out[p.name] = p.default_value
        break
    }
  }
  return out
}

function serializeTabs(tabs: Tab[]): any[] {
  return tabs.map(t => {
    if (t.kind === 'detail') {
      const { tableData, erdData, ...rest } = t as DetailViewTab
      return rest
    }
    if (t.kind === 'schema-erd') {
      const { erdData, ...rest } = t as SchemaErdTab
      return rest
    }
    return t
  })
}

export function DatabasePage() {
  useDocumentTitle('Database')
  const [, setLocation] = useLocation()
  const stored = useRef(loadStore().dbx)

  // Tree state
  const [connections, setConnections] = useState<DbxConnection[]>([])
  const [treeData, setTreeData] = useState<Map<string, TreeNode>>(new Map())
  const [openNodes, setOpenNodes] = useState<Set<string>>(() => new Set(stored.current.openNodes))
  const [activeNodeKey, setActiveNodeKey] = useState<string | null>(() => stored.current.activeNodeKey)
  const [treeFilter, setTreeFilter] = useState(() => stored.current.treeFilter || '')
  const [scriptFilter, setScriptFilter] = useState('')

  // Tab state
  const [tabs, setTabs] = useState<Tab[]>(() => (stored.current.tabs || []) as Tab[])
  const [activeTabId, setActiveTabId] = useState<string | null>(() => stored.current.activeTabId)

  // Results state (for SQL tabs)
  const [queryResult, setQueryResult] = useState<DbxQueryResult | null>(null)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [resultTab, setResultTab] = useState<ResultTab>('results')
  const [messages, setMessages] = useState<Message[]>([])
  const [history, setHistory] = useState<DbxQueryHistoryEntry[]>([])
  const [maxRows, setMaxRows] = useState(200)
  const [resultsHeight, setResultsHeight] = useState(() => loadStore().dbx.resultsHeight)
  const [resultViewMode, setResultViewMode] = useState<'grid' | 'record'>('grid')
  const [recordIndex, setRecordIndex] = useState(0)

  // Scripts
  const [scripts, setScripts] = useState<DbxScript[]>([])

  // Dialogs
  const [showConnDialog, setShowConnDialog] = useState(false)
  const [editingConnection, setEditingConnection] = useState<DbxConnection | null>(null)
  const [deletingScript, setDeletingScript] = useState<DbxScript | null>(null)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [showNewScriptDialog, setShowNewScriptDialog] = useState(false)
  const [showSnapshotsModal, setShowSnapshotsModal] = useState(false)
  // Snapshot list for the currently-active saved query, refreshed on save/restore.
  const [savedQuerySnapshots, setSavedQuerySnapshots] = useState<DbxSavedQuerySnapshot[]>([])
  const [isCapturingSnapshot, setIsCapturingSnapshot] = useState(false)
  const [pendingMutation, setPendingMutation] = useState<{ sql: string; type: string; connectionId: string; onSuccess?: () => void } | null>(null)
  const [editingRow, setEditingRow] = useState<{ tabId: string; rowIndex: number } | null>(null)
  const [dangerMode, setDangerMode] = useState(false)
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const getSelectedTextRef = useRef<(() => string | null) | null>(null)
  const foldActionsRef = useRef<{ foldAll: () => void; unfoldAll: () => void } | null>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const [scriptsHeight, setScriptsHeight] = useState(() => loadSectionHeight(loadStore().dbx.scriptsHeight))
  const [savedQueriesHeight, setSavedQueriesHeight] = useState(() => loadSectionHeight(loadStore().dbx.savedQueriesHeight))
  const [sidebarWidth, setSidebarWidth] = useState(() => loadStore().dbx.sidebarWidth)

  useEffect(() => {
    const store = loadStore().dbx
    const nextScriptsHeight = loadSectionHeight(store.scriptsHeight)
    const nextSavedQueriesHeight = loadSectionHeight(store.savedQueriesHeight)
    if (store.scriptsHeight !== nextScriptsHeight || store.savedQueriesHeight !== nextSavedQueriesHeight) {
      saveStore({
        dbx: {
          ...store,
          scriptsHeight: nextScriptsHeight,
          savedQueriesHeight: nextSavedQueriesHeight,
        },
      })
    }
  }, [])

  // Consume `/database?open=<saved-query-id>` once on mount: opens the query
  // in a fresh SQL tab and strips the param from the URL so a refresh doesn't
  // reopen it. Used by /database/saved-queries to hand off a click into the
  // existing editor flow.
  const openConsumedRef = useRef(false)
  useEffect(() => {
    if (openConsumedRef.current) return
    if (connections.length === 0) return // wait for connections to load
    const params = new URLSearchParams(window.location.search)
    const openId = params.get('open')
    if (!openId) { openConsumedRef.current = true; return }
    openConsumedRef.current = true
    getSavedQuery(openId, UI_SESSION_ID).then(({ saved_query }) => {
      openSavedQueryInTab(saved_query)
    }).catch(() => {})
    // Strip ?open= from the URL without adding a history entry.
    params.delete('open')
    const next = window.location.pathname + (params.toString() ? `?${params}` : '')
    window.history.replaceState(null, '', next)
  }, [connections])

  // Hydrate declared params for any saved-query tab missing them. The list
  // endpoint returns compact rows without params, and tabs restored from
  // sessionStorage that pre-date the params form lack savedQueryParams.
  useEffect(() => {
    const needsHydration = tabs.filter(t =>
      t.kind === 'sql' && (t as SqlTab).savedQueryId && (t as SqlTab).savedQueryParams === undefined
    ) as SqlTab[]
    if (needsHydration.length === 0) return
    for (const tab of needsHydration) {
      getSavedQuery(tab.savedQueryId!, UI_SESSION_ID).then(({ saved_query }) => {
        const params = saved_query.params || []
        setTabs(prev => prev.map(t =>
          t.id === tab.id && t.kind === 'sql'
            ? {
                ...t,
                savedQueryParams: params,
                // Seed defaults for any field the user hasn't filled yet.
                paramValues: { ...defaultsForParams(params), ...(t.paramValues || {}) },
              }
            : t
        ))
      }).catch(() => {})
    }
  }, [tabs])

  // ─── Saved-query snapshot helpers ───

  // Track the active tab's saved-query id specifically (not the whole tab
  // object) so editor keystrokes don't trigger snapshot refetches.
  const activeSavedQueryId = (() => {
    const tab = tabs.find(t => t.id === activeTabId && t.kind === 'sql') as SqlTab | undefined
    return tab?.savedQueryId ?? null
  })()

  // Reload the snapshot list (and server-side current_snapshot pointer)
  // whenever the active tab points at a different saved query.
  useEffect(() => {
    if (!activeSavedQueryId) {
      setSavedQuerySnapshots([])
      return
    }
    listSavedQuerySnapshots(activeSavedQueryId)
      .then(({ snapshots, current_snapshot }) => {
        setSavedQuerySnapshots(snapshots)
        setTabs(prev => prev.map(t =>
          t.kind === 'sql' && (t as SqlTab).savedQueryId === activeSavedQueryId
            ? { ...t, currentSnapshot: current_snapshot }
            : t
        ))
      })
      .catch(() => setSavedQuerySnapshots([]))
  }, [activeSavedQueryId])

  /**
   * Switch the active tab into snapshot-view mode (read-only display of a
   * historical snapshot's SQL) or back to live editing.
   *
   * Picking the same number as currentSnapshot exits view mode; picking
   * another loads that snapshot's SQL into viewingSnapshotSql so the editor
   * can render it read-only.
   */
  function pickSnapshotForView(num: number) {
    const tab = tabs.find(t => t.id === activeTabId && t.kind === 'sql') as SqlTab | undefined
    if (!tab) return
    if (num === tab.currentSnapshot) {
      // Back to live.
      setTabs(prev => prev.map(t =>
        t.id === tab.id && t.kind === 'sql' ? { ...t, viewingSnapshot: null, viewingSnapshotSql: null } : t
      ))
      return
    }
    const snap = savedQuerySnapshots.find(s => s.snapshot_number === num)
    if (!snap) return
    setTabs(prev => prev.map(t =>
      t.id === tab.id && t.kind === 'sql'
        ? { ...t, viewingSnapshot: num, viewingSnapshotSql: snap.sql }
        : t
    ))
  }

  async function captureCurrentSnapshot() {
    const tab = tabs.find(t => t.id === activeTabId && t.kind === 'sql') as SqlTab | undefined
    if (!tab?.savedQueryId || isCapturingSnapshot) return
    setIsCapturingSnapshot(true)
    try {
      // Persist any unsaved SQL edits first so the captured snapshot reflects
      // what's in the editor, not the stale server-side row.
      if (tab.isDirty) {
        await updateSavedQuery(tab.savedQueryId, { sql: tab.content, edited_by: UI_SESSION_ID })
        setTabs(prev => prev.map(t => t.id === tab.id && t.kind === 'sql' ? { ...t, isDirty: false } : t))
      }
      await createSavedQuerySnapshot(tab.savedQueryId, UI_SESSION_ID)
      const { snapshots, current_snapshot } = await listSavedQuerySnapshots(tab.savedQueryId)
      setSavedQuerySnapshots(snapshots)
      // Server bumped current_snapshot to the new capture; mirror it on the tab.
      setTabs(prev => prev.map(t =>
        t.id === tab.id && t.kind === 'sql' ? { ...t, currentSnapshot: current_snapshot } : t
      ))
    } catch (err: any) {
      alert(`Failed to capture snapshot: ${err?.message || err}`)
    } finally {
      setIsCapturingSnapshot(false)
    }
  }

  async function restoreSnapshotInActiveTab(num: number) {
    const tab = tabs.find(t => t.id === activeTabId && t.kind === 'sql') as SqlTab | undefined
    if (!tab?.savedQueryId) return
    try {
      const { saved_query } = await restoreSavedQuerySnapshot(tab.savedQueryId, num, UI_SESSION_ID)
      const { snapshots, current_snapshot } = await listSavedQuerySnapshots(tab.savedQueryId)
      setSavedQuerySnapshots(snapshots)
      setTabs(prev => prev.map(t =>
        t.id === tab.id && t.kind === 'sql'
          ? {
              ...t,
              content: saved_query.sql,
              savedQueryParams: saved_query.params || [],
              paramValues: { ...defaultsForParams(saved_query.params || []), ...(t.paramValues || {}) },
              currentSnapshot: current_snapshot,
              // Exit view mode — live SQL now matches the restored snapshot.
              viewingSnapshot: null,
              viewingSnapshotSql: null,
              isDirty: false,
            }
          : t
      ))
    } catch (err: any) {
      alert(`Failed to restore snapshot: ${err?.message || err}`)
    }
  }

  // ─── Sidebar divider drag ───

  function makeSectionResizer(
    storeKey: 'scriptsHeight' | 'savedQueriesHeight',
    setter: (h: number | ((prev: number) => number)) => void,
    currentHeight: number,
  ) {
    return (e: MouseEvent) => {
      e.preventDefault()
      const startY = e.clientY
      const sidebar = sidebarRef.current
      if (!sidebar) return
      const sidebarRect = sidebar.getBoundingClientRect()
      const startHeight = currentHeight

      function onMouseMove(ev: MouseEvent) {
        const delta = startY - ev.clientY
        setter(Math.max(SECTION_HEIGHT_MIN, Math.min(sidebarRect.height - 100, startHeight + delta)))
      }
      function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        setter((h: number) => {
          saveStore({ dbx: { ...loadStore().dbx, [storeKey]: h } })
          return h
        })
      }
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    }
  }

  const onScriptsDividerMouseDown = makeSectionResizer('scriptsHeight', setScriptsHeight, scriptsHeight)
  const onSavedQueriesDividerMouseDown = makeSectionResizer('savedQueriesHeight', setSavedQueriesHeight, savedQueriesHeight)

  // ─── Results resize drag ───

  function onResultsResizeMouseDown(e: MouseEvent) {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = resultsHeight

    function onMouseMove(ev: MouseEvent) {
      setResultsHeight(Math.max(80, Math.min(800, startHeight + (startY - ev.clientY))))
    }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      setResultsHeight(h => { saveStore({ dbx: { ...loadStore().dbx, resultsHeight: h } }); return h })
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  // ─── Sidebar width drag ───

  function onSidebarResizeMouseDown(e: MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidth

    function onMouseMove(ev: MouseEvent) {
      setSidebarWidth(Math.max(160, Math.min(500, startWidth + ev.clientX - startX)))
    }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      setSidebarWidth(w => { saveStore({ dbx: { ...loadStore().dbx, sidebarWidth: w } }); return w })
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  // ─── Persist tree/tab state ───

  useEffect(() => {
    const timer = setTimeout(() => {
      saveStore({ dbx: { ...loadStore().dbx, openNodes: Array.from(openNodes), activeNodeKey, tabs: serializeTabs(tabs), activeTabId, treeFilter } })
    }, 300)
    return () => clearTimeout(timer)
  }, [openNodes, activeNodeKey, tabs, activeTabId, treeFilter])

  // ─── Load initial data ───

  useEffect(() => { loadConnections(); loadScripts() }, [])

  async function loadConnections() {
    try {
      const { connections: conns } = await getConnections()
      setConnections(conns)
      const hasRestoredTabs = stored.current.tabs && stored.current.tabs.length > 0

      if (hasRestoredTabs) {
        // Restore tree data for all open nodes
        const savedNodes = stored.current.openNodes
        for (const conn of conns) {
          const connKey = `conn:${conn.id}`
          if (savedNodes.includes(connKey)) {
            await loadSchemas(conn.id, conn.name)
          }
        }
        // Load tables for open schema nodes (needs schemas loaded first)
        for (const nodeKey of savedNodes) {
          const schemaMatch = nodeKey.match(/^schema:([^:]+):(.+)$/)
          if (schemaMatch) {
            const [, connId, schemaName] = schemaMatch
            loadTables(connId, schemaName)
          }
        }
        // Re-fetch table detail for restored detail tabs (tableData/erdData not persisted)
        for (const tab of stored.current.tabs) {
          if (tab.kind === 'detail' && tab.schema && tab.tableName && tab.connectionId) {
            getTableDetail(tab.connectionId, tab.schema, tab.tableName)
              .then(({ table }) => setTabs(prev => prev.map(t => t.id === tab.id && t.kind === 'detail' ? { ...t, tableDetail: table } : t)))
              .catch(() => {})
          }
        }
      } else if (conns.length > 0) {
        // Fresh start: open first connection with a default query tab
        setOpenNodes(new Set([`conn:${conns[0].id}`]))
        loadSchemas(conns[0].id, conns[0].name)
        const tab: SqlTab = { kind: 'sql', id: crypto.randomUUID(), name: 'Query 1', content: '', connectionId: conns[0].id, isDirty: false }
        setTabs([tab])
        setActiveTabId(tab.id)
      }
    } catch (err) { console.error('Failed to load connections:', err) }
  }

  async function loadScripts() {
    try { const { scripts: s } = await getScripts(); setScripts(s) } catch {}
  }

  async function loadSchemas(connectionId: string, connName?: string) {
    try {
      const { schemas } = await getSchemas(connectionId)
      setTreeData(prev => {
        const next = new Map(prev)
        next.set(`conn:${connectionId}`, {
          type: 'connection', name: connName || connections.find(c => c.id === connectionId)?.name || connectionId,
          connectionId,
          children: schemas.map(s => ({ type: 'schema' as const, name: s.name, connectionId, badge: `${s.table_count + s.view_count}` })),
        })
        return next
      })
    } catch (err) { console.error('Failed to load schemas:', err) }
  }

  async function loadTables(connectionId: string, schema: string) {
    try {
      const [{ tables }, { functions }, { triggers }] = await Promise.all([
        getTables(connectionId, schema),
        getFunctions(connectionId, schema),
        getSchemaTriggers(connectionId, schema),
      ])
      const tableItems = tables.filter(t => t.type === 'table')
      const viewItems = tables.filter(t => t.type === 'view')
      setTreeData(prev => {
        const next = new Map(prev)
        next.set(`schema:${connectionId}:${schema}`, {
          type: 'schema', name: schema, connectionId,
          children: [
            { type: 'folder', name: 'Tables', connectionId, schema, badge: `${tableItems.length}`, children: tableItems.map(t => ({ type: 'table' as const, name: t.name, connectionId, schema, badge: t.row_estimate >= 0 ? `${t.row_estimate}` : '' })) },
            { type: 'folder', name: 'Views', connectionId, schema, badge: `${viewItems.length}`, children: viewItems.map(v => ({ type: 'view' as const, name: v.name, connectionId, schema })) },
            { type: 'folder', name: 'Functions', connectionId, schema, badge: `${functions.length}`, children: functions.map(f => ({ type: 'function' as const, name: f.name, connectionId, schema, badge: f.language })) },
            { type: 'folder', name: 'Triggers', connectionId, schema, badge: `${triggers.length}`, children: triggers.map(t => ({ type: 'trigger' as const, name: t.name, connectionId, schema, badge: t.table_name })) },
          ],
        })
        return next
      })
    } catch (err) { console.error('Failed to load tables:', err) }
  }

  // ─── Load all tree data for filtering ───

  const loadedAllRef = useRef(false)

  async function loadAllTreeData() {
    if (loadedAllRef.current) return
    loadedAllRef.current = true
    for (const conn of connections) {
      const connKey = `conn:${conn.id}`
      // Load schemas if not loaded
      let connNode = treeData.get(connKey)
      if (!connNode) {
        await loadSchemas(conn.id, conn.name)
        // Re-read from state via a short delay to let setState flush
        await new Promise(r => setTimeout(r, 50))
      }
    }
    // Second pass: load tables for all schemas (treeData now has schemas)
    setTreeData(current => {
      const schemasToLoad: { connectionId: string; schema: string }[] = []
      for (const conn of connections) {
        const connNode = current.get(`conn:${conn.id}`)
        if (connNode?.children) {
          for (const schema of connNode.children) {
            if (!current.has(`schema:${conn.id}:${schema.name}`)) {
              schemasToLoad.push({ connectionId: conn.id, schema: schema.name })
            }
          }
        }
      }
      // Fire off table loads outside setState
      schemasToLoad.forEach(({ connectionId, schema }) => loadTables(connectionId, schema))
      return current
    })
  }

  useEffect(() => {
    if (treeFilter && connections.length > 0) loadAllTreeData()
  }, [treeFilter, connections])

  // ─── Tree interactions ───

  function toggleNode(key: string) {
    setOpenNodes(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next })
  }

  async function onNodeClick(key: string, node: { type: string; connectionId?: string; schema?: string; name: string }) {
    setActiveNodeKey(key)
    if (node.type === 'connection' && node.connectionId) {
      const connKey = `conn:${node.connectionId}`
      if (!openNodes.has(connKey)) { toggleNode(connKey); loadSchemas(node.connectionId) }
    } else if (node.type === 'schema' && node.connectionId) {
      const schemaKey = `schema:${node.connectionId}:${node.name}`
      if (!openNodes.has(schemaKey)) {
        setOpenNodes(prev => {
          const next = new Set(prev)
          next.add(schemaKey)
          next.add(`folder:${node.connectionId}:${node.name}:Tables`)
          next.add(`folder:${node.connectionId}:${node.name}:Views`)
          return next
        })
        loadTables(node.connectionId, node.name)
      } else { toggleNode(schemaKey) }
    } else if ((node.type === 'table' || node.type === 'view') && node.connectionId && node.schema) {
      const detailKey = `detail:${node.connectionId}:${node.schema}:${node.name}`
      const existing = tabs.find(t => t.kind === 'detail' && t.id === detailKey)
      if (existing) { setActiveTabId(existing.id) } else {
        const newTab: DetailViewTab = { kind: 'detail', id: detailKey, name: node.name, connectionId: node.connectionId, schema: node.schema, tableName: node.name, tableDetail: null, tableData: null, erdData: null, detailTab: 'properties', propsSubtab: 'columns' }
        setTabs(prev => [...prev, newTab])
        setActiveTabId(detailKey)
        try {
          const { table } = await getTableDetail(node.connectionId, node.schema, node.name)
          setTabs(prev => prev.map(t => t.id === detailKey && t.kind === 'detail' ? { ...t, tableDetail: table } : t))
        } catch (err) { console.error('Failed to load table detail:', err) }
      }
    } else if (node.type === 'function' && node.connectionId && node.schema) {
      const tabId = `fn:${node.connectionId}:${node.schema}:${node.name}`
      const existing = tabs.find(t => t.id === tabId)
      if (existing) { setActiveTabId(tabId) } else {
        const newTab: CodeViewTab = { kind: 'code-view', id: tabId, name: `${node.name}()`, connectionId: node.connectionId, schema: node.schema, objectType: 'function', objectName: node.name, definition: null, metadata: {} }
        setTabs(prev => [...prev, newTab])
        setActiveTabId(tabId)
        try {
          const { function: fn } = await getFunctionDetail(node.connectionId, node.schema, node.name)
          setTabs(prev => prev.map(t => t.id === tabId && t.kind === 'code-view' ? { ...t, definition: fn.definition, metadata: { Kind: fn.kind, Language: fn.language, Returns: fn.return_type, Arguments: fn.arguments || '(none)', Volatility: fn.volatility, 'Security Definer': fn.security_definer ? 'Yes' : 'No', ...(fn.comment ? { Comment: fn.comment } : {}) } } : t))
        } catch (err) { console.error('Failed to load function detail:', err) }
      }
    } else if (node.type === 'trigger' && node.connectionId && node.schema) {
      // Triggers: show definition directly from the tree data (already loaded)
      const tabId = `trig:${node.connectionId}:${node.schema}:${node.name}`
      const existing = tabs.find(t => t.id === tabId)
      if (existing) { setActiveTabId(tabId) } else {
        // Find trigger info from the tree data
        const schemaData = treeData.get(`schema:${node.connectionId}:${node.schema}`)
        const triggersFolder = schemaData?.children?.find(c => c.name === 'Triggers')
        const trigNode = triggersFolder?.children?.find(c => c.name === node.name)
        const newTab: CodeViewTab = { kind: 'code-view', id: tabId, name: node.name, connectionId: node.connectionId, schema: node.schema, objectType: 'trigger', objectName: node.name, definition: null, metadata: { Table: trigNode?.badge || '' } }
        setTabs(prev => [...prev, newTab])
        setActiveTabId(tabId)
        // Fetch trigger definition from schema triggers
        try {
          const { triggers } = await getSchemaTriggers(node.connectionId, node.schema)
          const trig = triggers.find(t => t.name === node.name)
          if (trig) {
            setTabs(prev => prev.map(t => t.id === tabId && t.kind === 'code-view' ? { ...t, definition: trig.definition, metadata: { Table: trig.table_name, Timing: trig.timing, Events: trig.events, Function: trig.function_name, Enabled: trig.enabled === 'O' ? 'Yes' : trig.enabled === 'D' ? 'No' : trig.enabled } } : t))
          }
        } catch (err) { console.error('Failed to load trigger detail:', err) }
      }
    }
  }

  function onTableDoubleClick(connectionId: string, schema: string, name: string) {
    const sql = `SELECT *\nFROM "${schema}"."${name}"\nLIMIT 200;`
    const existingSql = tabs.find(t => t.kind === 'sql' && t.id === activeTabId)
    if (existingSql) {
      setTabs(prev => prev.map(t => t.id === activeTabId && t.kind === 'sql' ? { ...t, content: sql, connectionId, isDirty: true } : t))
    } else {
      const tab: SqlTab = { kind: 'sql', id: crypto.randomUUID(), name: `Query ${tabs.filter(t => t.kind === 'sql').length + 1}`, content: sql, connectionId, isDirty: true }
      setTabs(prev => [...prev, tab])
      setActiveTabId(tab.id)
    }
  }

  // ─── Mutation detection ───

  const MUTATION_RE = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i

  function detectMutation(sql: string): string | null {
    // Check each statement (split on semicolons, check first keyword)
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean)
    for (const stmt of statements) {
      const match = stmt.match(MUTATION_RE)
      if (match) return match[1].toUpperCase()
    }
    return null
  }

  // ─── Query execution ───

  function getActiveSql(): { sql: string; connectionId: string } | null {
    const sqlTab = tabs.find(t => t.id === activeTabId && t.kind === 'sql') as SqlTab | undefined
    if (!sqlTab) return null
    const selected = getSelectedTextRef.current?.()
    const sql = (selected || sqlTab.content).trim()
    return sql ? { sql, connectionId: sqlTab.connectionId } : null
  }

  function runQuery() {
    if (isRunning) return

    // Saved queries route through the /run endpoint so :name params get bound
    // and the call runs in a read-only transaction. Skips mutation detection
    // since the server enforces read-only for is_readonly saved queries.
    const sqlTab = tabs.find(t => t.id === activeTabId && t.kind === 'sql') as SqlTab | undefined
    if (sqlTab?.savedQueryId) {
      runSavedQueryNow(sqlTab)
      return
    }

    const active = getActiveSql()
    if (!active) return

    const mutationType = detectMutation(active.sql)
    if (mutationType && !dangerMode) {
      setPendingMutation({ sql: active.sql, type: mutationType, connectionId: active.connectionId })
      return
    }
    executeQueryNow(active.sql, active.connectionId)
  }

  async function runSavedQueryNow(tab: SqlTab) {
    if (!tab.savedQueryId) return
    setIsRunning(true); setQueryError(null); setResultTab('results')
    const ts = new Date().toLocaleTimeString()
    try {
      // Auto-persist SQL edits before running. The /run endpoint executes the
      // server-stored SQL, not the editor buffer, so unsaved edits would
      // silently run the prior version. Save-on-run keeps Cmd+Enter / the Run
      // button feeling immediate.
      if (tab.isDirty) {
        await updateSavedQuery(tab.savedQueryId, {
          sql: tab.content,
          edited_by: UI_SESSION_ID,
        })
        setTabs(prev => prev.map(t => t.id === tab.id && t.kind === 'sql' ? { ...t, isDirty: false } : t))
      }

      const result = await runSavedQuery(tab.savedQueryId, {
        params: tab.paramValues || {},
        session_id: UI_SESSION_ID,
        maxRows,
      })
      setQueryResult(result)
      setMessages(prev => [...prev, { text: `${result.rowCount} row(s) returned (${result.duration}ms)`, type: 'success', ts }])
    } catch (err: any) {
      const errorMsg = err.message || 'Query failed'
      setQueryError(errorMsg)
      setMessages(prev => [...prev, { text: errorMsg, type: 'error', ts }])
      setResultTab('messages')
    } finally { setIsRunning(false) }
  }

  async function executeQueryNow(sql: string, connectionId: string, onSuccess?: () => void) {
    setIsRunning(true); setQueryError(null); setResultTab('results')
    const ts = new Date().toLocaleTimeString()
    try {
      const result = await executeQuery(connectionId, sql, { maxRows })
      setQueryResult(result)
      if (result.affectedRows !== null) {
        setMessages(prev => [...prev, { text: `${result.affectedRows} row(s) affected (${result.duration}ms)`, type: 'success', ts }])
        setResultTab('messages')
      } else {
        setMessages(prev => [...prev, { text: `${result.rowCount} row(s) returned (${result.duration}ms)`, type: 'success', ts }])
      }
      onSuccess?.()
    } catch (err: any) {
      const errorMsg = err.message || 'Query failed'
      setQueryError(errorMsg)
      setMessages(prev => [...prev, { text: errorMsg, type: 'error', ts }])
      setResultTab('messages')
    } finally { setIsRunning(false) }
  }

  // ─── Tab management ───

  function addTab() {
    const tab: SqlTab = { kind: 'sql', id: crypto.randomUUID(), name: `Query ${tabs.filter(t => t.kind === 'sql').length + 1}`, content: '', connectionId: connections[0]?.id || '', isDirty: false }
    setTabs(prev => [...prev, tab]); setActiveTabId(tab.id)
  }

  function closeTab(tabId: string) {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId)
      if (activeTabId === tabId && next.length > 0) setActiveTabId(next[next.length - 1].id)
      return next
    })
  }

  // ─── Script management ───

  async function loadHistory() {
    const sqlTab = tabs.find(t => t.id === activeTabId && t.kind === 'sql') as SqlTab | undefined
    if (!sqlTab) return
    try { const { history: h } = await getQueryHistory(sqlTab.connectionId, { limit: 50 }); setHistory(h) } catch {}
  }

  async function saveCurrentTab() {
    const sqlTab = tabs.find(t => t.id === activeTabId && t.kind === 'sql') as SqlTab | undefined
    if (!sqlTab) return
    // Saved-query tabs PATCH the underlying dbx.saved_queries row (and bump
    // version + write a snapshot via the API). Script tabs go through the
    // legacy update path.
    if (sqlTab.savedQueryId) {
      try {
        await updateSavedQuery(sqlTab.savedQueryId, {
          sql: sqlTab.content,
          edited_by: UI_SESSION_ID,
        })
        setTabs(prev => prev.map(t => t.id === activeTabId && t.kind === 'sql' ? { ...t, isDirty: false } : t))
      } catch (err: any) {
        alert(`Failed to save: ${err?.message || err}`)
      }
      return
    }
    if (sqlTab.scriptId) {
      await updateScript(sqlTab.scriptId, { content: sqlTab.content, connection_id: sqlTab.connectionId || undefined })
      setTabs(prev => prev.map(t => t.id === activeTabId && t.kind === 'sql' ? { ...t, isDirty: false } : t))
      loadScripts()
    } else { setShowSaveDialog(true) }
  }

  async function saveNewScript(name: string) {
    const sqlTab = tabs.find(t => t.id === activeTabId && t.kind === 'sql') as SqlTab | undefined
    if (!sqlTab || !name) return
    const { script } = await createScript({ name, content: sqlTab.content, connection_id: sqlTab.connectionId })
    setTabs(prev => prev.map(t => t.id === activeTabId && t.kind === 'sql' ? { ...t, scriptId: script.id, name: script.name, isDirty: false } : t))
    setShowSaveDialog(false); loadScripts()
  }

  async function createNewScript(name: string) {
    if (!name) return
    const { script } = await createScript({ name, content: '', connection_id: connections[0]?.id })
    setShowNewScriptDialog(false)
    setScripts(prev => [...prev, script])
    openScriptInTab(script)
  }

  function openScriptInTab(script: DbxScript) {
    const existing = tabs.find(t => t.kind === 'sql' && (t as SqlTab).scriptId === script.id)
    if (existing) { setActiveTabId(existing.id); return }
    const tab: SqlTab = { kind: 'sql', id: crypto.randomUUID(), name: script.name, content: script.content, scriptId: script.id, connectionId: script.connection_id || connections[0]?.id || '', isDirty: false }
    setTabs(prev => [...prev, tab]); setActiveTabId(tab.id)
  }

  function openSavedQueryInTab(q: DbxSavedQuery) {
    const existing = tabs.find(t => t.kind === 'sql' && (t as SqlTab).savedQueryId === q.id)
    if (existing) { setActiveTabId(existing.id); return }
    const initialParams = q.params || []
    const tab: SqlTab = {
      kind: 'sql', id: crypto.randomUUID(),
      name: q.name, content: q.sql,
      savedQueryId: q.id,
      savedQueryParams: initialParams,
      paramValues: defaultsForParams(initialParams),
      connectionId: q.connection_id || connections[0]?.id || '',
      isDirty: false,
    }
    setTabs(prev => [...prev, tab]); setActiveTabId(tab.id)
    // The list endpoint may have returned a compact saved-query without params —
    // hydrate the declared param list so the form renders.
    if (!q.params) {
      getSavedQuery(q.id, UI_SESSION_ID).then(({ saved_query }) => {
        const params = saved_query.params || []
        setTabs(prev => prev.map(t =>
          t.id === tab.id && t.kind === 'sql'
            ? {
                ...t,
                savedQueryParams: params,
                content: saved_query.sql,
                // User may have started typing before hydration landed — keep
                // their values; only seed defaults for blank fields.
                paramValues: { ...defaultsForParams(params), ...(t.paramValues || {}) },
              }
            : t
        ))
      }).catch(() => {})
    }
  }

  async function createNewSavedQuery() {
    const name = prompt('Saved query name')
    if (!name) return
    const handle = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (!handle) { alert('Name must contain at least one letter or digit'); return }
    const activeTab = tabs.find(t => t.id === activeTabId)
    const conn = activeTab && 'connectionId' in activeTab
      ? activeTab.connectionId
      : connections[0]?.id || null
    try {
      const { saved_query } = await createSavedQuery({
        name,
        handle,
        connection_id: conn,
        owner_session_id: UI_SESSION_ID,
      })
      openSavedQueryInTab(saved_query)
    } catch (err: any) {
      alert(`Failed to create: ${err?.message || err}`)
    }
  }

  async function loadDetailData(tab: DetailViewTab, opts?: { limit?: number; sort?: string; order?: string; where?: string }) {
    if (!tab.tableDetail) return
    try {
      const result = await getTableData(tab.connectionId, tab.tableDetail.schema, tab.tableDetail.name, { limit: opts?.limit ?? maxRows, sort: opts?.sort, order: opts?.order, where: opts?.where })
      setTabs(prev => prev.map(t => t.id === tab.id && t.kind === 'detail' ? { ...t, tableData: result } : t))
    } catch (err) { console.error('Failed to load table data:', err) }
  }

  async function loadErdData(tab: DetailViewTab) {
    if (!tab.tableDetail) return
    try {
      const erd = await getTableErd(tab.connectionId, tab.tableDetail.schema, tab.tableDetail.name)
      setTabs(prev => prev.map(t => t.id === tab.id && t.kind === 'detail' ? { ...t, erdData: erd } : t))
    } catch (err) { console.error('Failed to load ERD data:', err) }
  }

  const [isRefreshing, setIsRefreshing] = useState(false)

  async function refreshCurrentView() {
    setIsRefreshing(true)
    try {
      const tab = tabs.find(t => t.id === activeTabId)
      if (!tab) return

      if (tab.kind === 'detail') {
        const dt = tab as DetailViewTab
        if (dt.tableDetail) {
          // Re-fetch table detail and data in parallel
          const [{ table }, dataResult] = await Promise.all([
            getTableDetail(dt.connectionId, dt.tableDetail.schema, dt.tableDetail.name),
            getTableData(dt.connectionId, dt.tableDetail.schema, dt.tableDetail.name, { limit: maxRows }),
          ])
          setTabs(prev => prev.map(t => t.id === tab.id && t.kind === 'detail' ? { ...t, tableDetail: table, tableData: dataResult, erdData: null } : t))
        }
      } else if (tab.kind === 'sql') {
        // Re-run the last query if there are results
        if (queryResult) runQuery()
      } else if (tab.kind === 'schema-erd') {
        const st = tab as SchemaErdTab
        const erd = await getSchemaErd(st.connectionId, st.schema)
        setTabs(prev => prev.map(t => t.id === tab.id && t.kind === 'schema-erd' ? { ...t, erdData: erd } : t))
      }
    } catch (err) { console.error('Refresh failed:', err) }
    finally { setIsRefreshing(false) }
  }

  async function openSchemaErd(connectionId: string, schema: string) {
    const tabId = `schema-erd:${connectionId}:${schema}`
    const existing = tabs.find(t => t.id === tabId)
    if (existing) { setActiveTabId(tabId); return }
    const connName = connections.find(c => c.id === connectionId)?.name || ''
    const newTab: SchemaErdTab = { kind: 'schema-erd', id: tabId, name: `${connName}/${schema} ERD`, connectionId, schema, erdData: null }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(tabId)
    try {
      const erd = await getSchemaErd(connectionId, schema)
      setTabs(prev => prev.map(t => t.id === tabId && t.kind === 'schema-erd' ? { ...t, erdData: erd } : t))
    } catch (err) { console.error('Failed to load schema ERD:', err) }
  }

  // ─── Derived state ───

  const activeTab = tabs.find(t => t.id === activeTabId)
  const activeSqlTab = activeTab?.kind === 'sql' ? activeTab as SqlTab : null
  const activeDetailTab = activeTab?.kind === 'detail' ? activeTab as DetailViewTab : null
  const activeSchemaErdTab = activeTab?.kind === 'schema-erd' ? activeTab as SchemaErdTab : null
  const activeCodeViewTab = activeTab?.kind === 'code-view' ? activeTab as CodeViewTab : null
  const tableDetail = activeDetailTab?.tableDetail || null
  const tableData = activeDetailTab?.tableData || null

  // ─── Render ───

  return (
    <div class={styles.wrapper} style={isDesktopApp() ? { '--dbx-bottom': '0px' } as any : undefined}>
      {/* Sidebar */}
      <div
        class={styles.sidebar}
        ref={sidebarRef}
        style={{
          '--sidebar-width': `${sidebarWidth}px`,
          // 7-row grid: header / filter / tree(1fr) / drag1 / saved-queries /
          // drag2 / scripts. Each section gets its own pixel track and divider
          // above it so they resize independently. Adding a child without
          // adding a row produces a misaligned divider (looks like a small
          // floating blue rectangle on the sidebar's left edge).
          gridTemplateRows: `auto auto minmax(0, 1fr) auto minmax(${SECTION_HEIGHT_MIN}px, ${savedQueriesHeight}px) auto minmax(${SECTION_HEIGHT_MIN}px, ${scriptsHeight}px)`,
        } as any}
      >
        <div class={styles.sidebarHeader}>
          <span class={styles.sidebarTitle}>Connections</span>
          <button class={styles.btnAdd} onClick={() => setShowConnDialog(true)}><Plus size={12} /> New</button>
        </div>
        <div class={styles.treeFilter}>
          <Search size={12} />
          <input
            type="text"
            class={styles.treeFilterInput}
            placeholder="Filter objects..."
            value={treeFilter}
            onInput={e => setTreeFilter((e.target as HTMLInputElement).value)}
          />
          {treeFilter && <button class={styles.treeFilterClear} onClick={() => setTreeFilter('')}><X size={10} /></button>}
        </div>

        <div class={styles.treeSection}>
          <ConnectionTree
            connections={connections}
            treeData={treeData}
            openNodes={openNodes}
            activeNodeKey={activeNodeKey}
            filter={treeFilter}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onTableDoubleClick}
            onToggleNode={toggleNode}
            onEditConnection={(conn) => { setEditingConnection(conn); setShowConnDialog(true) }}
            onConnectionDeleted={loadConnections}
            onGenerateSchemaErd={openSchemaErd}
          />
        </div>

        <div class={styles.sidebarDivider} onMouseDown={onSavedQueriesDividerMouseDown} />

        <SavedQueriesPanel
          sessionId={UI_SESSION_ID}
          activeConnectionId={(() => {
            const t = tabs.find(t => t.id === activeTabId)
            return t && 'connectionId' in t ? t.connectionId : connections[0]?.id || null
          })()}
          onOpen={openSavedQueryInTab}
          onNew={createNewSavedQuery}
          onManageAll={() => setLocation('/database/saved-queries')}
        />

        <div class={styles.sidebarDivider} onMouseDown={onScriptsDividerMouseDown} />

        <div class={styles.scriptsSection} data-scripts>
          <div class={styles.sidebarHeader}>
            <span class={styles.sidebarTitle}>Scripts</span>
            <button class={styles.btnAdd} onClick={() => setShowNewScriptDialog(true)} title="New script"><Plus size={12} /> New</button>
          </div>
          {scripts.length > 0 && (
            <div class={styles.scriptFilterBar}>
              <Search size={11} />
              <input
                class={styles.scriptFilterInput}
                value={scriptFilter}
                onInput={e => setScriptFilter((e.target as HTMLInputElement).value)}
                placeholder="Filter scripts..."
              />
              {scriptFilter && <button class={styles.treeFilterClear} onClick={() => setScriptFilter('')}><X size={10} /></button>}
            </div>
          )}
          <div class={styles.scriptsList}>
            {(() => {
              const lf = scriptFilter.toLowerCase()
              const filtered = scripts.filter(s => !lf || s.name.toLowerCase().includes(lf))
              const grouped = new Map<string, DbxScript[]>()
              for (const s of filtered) {
                const key = s.connection_id || '__unlinked__'
                if (!grouped.has(key)) grouped.set(key, [])
                grouped.get(key)!.push(s)
              }
              if (filtered.length === 0) {
                return <div style={{ padding: '8px 14px', fontSize: '11px', color: 'var(--muted)' }}>{scripts.length > 0 ? 'No matching scripts' : 'No saved scripts'}</div>
              }
              return Array.from(grouped.entries()).map(([connId, items]) => {
                const connName = connId === '__unlinked__' ? 'Unlinked' : connections.find(c => c.id === connId)?.name || 'Unknown'
                return (
                  <div key={connId}>
                    {grouped.size > 1 && <div class={styles.scriptGroupLabel}>{connName}</div>}
                    {items.map(s => (
                      <div key={s.id} class={styles.scriptItem} onClick={() => openScriptInTab(s)}>
                        <FileText size={12} />
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                        <button class={styles.scriptDelete} onClick={(e) => { e.stopPropagation(); setDeletingScript(s) }} title="Delete script">
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )
              })
            })()}
          </div>
        </div>
      </div>

      <div class={styles.sidebarResizeHandle} onMouseDown={onSidebarResizeMouseDown} />

      {/* Main area */}
      <div class={styles.main}>
        {/* Unified tab bar */}
        <div class={styles.editorTabsRow}>
          <button class={styles.tabAdd} onClick={addTab} title="New SQL tab"><Plus size={14} /></button>
          <div class={styles.editorTabs} onClick={() => setTabContextMenu(null)}>
            {tabs.map(tab => (
            <div
              key={tab.id}
              class={clsx(styles.tab, tab.id === activeTabId && styles.active)}
              onClick={() => { setActiveTabId(tab.id); setTabContextMenu(null) }}
              onContextMenu={(e) => { e.preventDefault(); setActiveTabId(tab.id); setTabContextMenu({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY, tabId: tab.id }) }}
            >
              {tab.kind === 'detail'
                ? <>{(tab as DetailViewTab).tableDetail?.type === 'view' ? <Eye size={11} /> : <Table2 size={11} />} {tab.name}</>
                : tab.kind === 'schema-erd'
                ? <><GitBranch size={11} /> {tab.name}</>
                : tab.kind === 'code-view'
                ? <>{(tab as CodeViewTab).objectType === 'function' ? <Braces size={11} /> : <Zap size={11} />} {tab.name}</>
                : renamingTabId === tab.id
                ? <input
                    class={styles.tabRenameInput}
                    value={renameValue}
                    onInput={e => setRenameValue((e.target as HTMLInputElement).value)}
                    onBlur={() => {
                      const newName = renameValue.trim()
                      if (newName) {
                        setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, name: newName } : t))
                        const sqlTab = tab as SqlTab
                        if (sqlTab.scriptId) {
                          updateScript(sqlTab.scriptId, { name: newName }).then(() => loadScripts()).catch(() => {})
                        }
                      }
                      setRenamingTabId(null)
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { (e.target as HTMLInputElement).blur() }
                      if (e.key === 'Escape') { setRenamingTabId(null) }
                    }}
                    onClick={e => e.stopPropagation()}
                    autoFocus
                  />
                : <span>{tab.name}{(tab as SqlTab).isDirty ? ' *' : ''}</span>}
              <button class={styles.tabClose} onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}><X size={12} /></button>
            </div>
          ))}
          </div>
        </div>

        {/* Tab context menu */}
        {tabContextMenu && (
          <div class={styles.contextOverlay} onClick={() => setTabContextMenu(null)} onContextMenu={e => { e.preventDefault(); setTabContextMenu(null) }}>
            <div class={styles.contextMenu} style={{ left: `${tabContextMenu.x}px`, top: `${tabContextMenu.y}px` }} onClick={e => e.stopPropagation()}>
              <button class={styles.contextMenuItem} onClick={() => {
                const tab = tabs.find(t => t.id === tabContextMenu.tabId)
                if (tab) { setRenameValue(tab.name); setRenamingTabId(tab.id) }
                setTabContextMenu(null)
              }}>Rename</button>
              <button class={styles.contextMenuItem} onClick={() => { closeTab(tabContextMenu.tabId); setTabContextMenu(null) }}>Close</button>
              <button class={styles.contextMenuItem} onClick={() => {
                tabs.filter(t => t.id !== tabContextMenu.tabId).forEach(t => closeTab(t.id))
                setTabContextMenu(null)
              }}>Close Others</button>
              <button class={styles.contextMenuItem} onClick={() => {
                tabs.forEach(t => closeTab(t.id))
                setTabContextMenu(null)
              }}>Close All</button>
            </div>
          </div>
        )}

        {/* SQL editor view */}
        {activeSqlTab && (
          <>
            <div class={styles.editorToolbar}>
              <select class={styles.connSelect} value={activeSqlTab.connectionId} onChange={e => {
                const val = (e.target as HTMLSelectElement).value
                setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, connectionId: val } : t))
                if (activeSqlTab.scriptId) {
                  updateScript(activeSqlTab.scriptId, { connection_id: val }).catch(() => {})
                }
              }}>
                {connections.map(c => <option key={c.id} value={c.id}>{c.name} ({c.config.host}:{c.config.port})</option>)}
              </select>
              <button
                class={styles.btnRun}
                onClick={runQuery}
                disabled={isRunning || activeSqlTab.viewingSnapshot != null}
                title={activeSqlTab.viewingSnapshot != null ? 'Exit snapshot view to run' : undefined}
              >
                {isRunning ? <><Square size={12} /> Running...</> : <><Play size={12} /> Run</>}
              </button>
              <span class={styles.shortcutHint}>⌘Enter</span>
              <button class={styles.btnIcon} onClick={() => foldActionsRef.current?.foldAll()} title="Fold all"><ChevronsDownUp size={13} /></button>
              <button class={styles.btnIcon} onClick={() => foldActionsRef.current?.unfoldAll()} title="Unfold all"><ChevronsUpDown size={13} /></button>
              <div class={styles.spacer} />
              {activeSqlTab.savedQueryId && (
                <>
                  <select
                    class={styles.snapshotSelect}
                    value={
                      activeSqlTab.viewingSnapshot != null
                        ? String(activeSqlTab.viewingSnapshot)
                        : activeSqlTab.currentSnapshot != null
                          ? String(activeSqlTab.currentSnapshot)
                          : ''
                    }
                    onChange={(e) => {
                      const val = (e.target as HTMLSelectElement).value
                      if (val === '__manage__') {
                        setShowSnapshotsModal(true)
                        return
                      }
                      if (!val) return
                      pickSnapshotForView(parseInt(val, 10))
                    }}
                    disabled={isCapturingSnapshot}
                    title="Snapshots — picking one shows it read-only; use Restore to make it live"
                  >
                    {savedQuerySnapshots.length === 0 ? (
                      <option value="">No snapshots</option>
                    ) : (
                      savedQuerySnapshots.map(s => (
                        <option key={s.snapshot_number} value={String(s.snapshot_number)}>
                          #{s.snapshot_number}{s.snapshot_number === activeSqlTab.currentSnapshot ? ' current' : ''}
                        </option>
                      ))
                    )}
                    {savedQuerySnapshots.length > 0 && (
                      <option value="__manage__">— Manage snapshots…</option>
                    )}
                  </select>
                  <button
                    class={styles.btnIcon}
                    onClick={captureCurrentSnapshot}
                    disabled={isCapturingSnapshot || activeSqlTab.viewingSnapshot != null}
                    title={activeSqlTab.viewingSnapshot != null
                      ? 'Exit snapshot view to capture'
                      : 'Save a snapshot of the current SQL'}
                  >
                    <Camera size={13} />
                  </button>
                </>
              )}
              <button
                class={styles.btnAdd}
                onClick={saveCurrentTab}
                disabled={activeSqlTab.viewingSnapshot != null}
                title={activeSqlTab.viewingSnapshot != null ? 'Exit snapshot view to save' : undefined}
              >Save</button>
              <button
                class={clsx(styles.envLabel, dangerMode ? styles.envLabelDanger : styles.envLabelRw)}
                onClick={() => setDangerMode(!dangerMode)}
                title={dangerMode ? 'Danger mode: mutation confirmations disabled. Click to re-enable.' : 'Safe mode: mutations require confirmation. Click to disable.'}
              >
                {dangerMode ? 'DANGER' : 'SAFE'}
              </button>
            </div>

            {activeSqlTab.viewingSnapshot != null && (
              <div class={styles.snapshotViewBanner}>
                <span>
                  Viewing snapshot <strong>#{activeSqlTab.viewingSnapshot}</strong> — read-only
                </span>
                <div class={styles.snapshotViewActions}>
                  <button
                    class={styles.btnAdd}
                    onClick={() => restoreSnapshotInActiveTab(activeSqlTab.viewingSnapshot!)}
                    title="Make this snapshot live. Current SQL will be saved as a pre-restore safety snapshot first."
                  >
                    Restore
                  </button>
                  <button
                    class={styles.btnIcon}
                    onClick={() => setTabs(prev => prev.map(t =>
                      t.id === activeTabId && t.kind === 'sql'
                        ? { ...t, viewingSnapshot: null, viewingSnapshotSql: null }
                        : t
                    ))}
                    title="Exit snapshot view"
                  >
                    Exit view
                  </button>
                </div>
              </div>
            )}

            {activeSqlTab.savedQueryId && activeSqlTab.savedQueryParams && activeSqlTab.savedQueryParams.length > 0 && (
              <ParametersForm
                params={activeSqlTab.savedQueryParams}
                values={activeSqlTab.paramValues || {}}
                disabled={isRunning || activeSqlTab.viewingSnapshot != null}
                onChange={(next) => setTabs(prev => prev.map(t =>
                  t.id === activeTabId && t.kind === 'sql' ? { ...t, paramValues: next } : t
                ))}
              />
            )}

            <div class={styles.editorArea}>
              <SqlEditor
                value={
                  activeSqlTab.viewingSnapshot != null && activeSqlTab.viewingSnapshotSql != null
                    ? activeSqlTab.viewingSnapshotSql
                    : activeSqlTab.content
                }
                readOnly={activeSqlTab.viewingSnapshot != null}
                onChange={val => setTabs(prev => prev.map(t => t.id === activeTabId && t.kind === 'sql' ? { ...t, content: val, isDirty: true } : t))}
                onRun={runQuery}
                onSave={saveCurrentTab}
                onCloseTab={() => activeTabId && closeTab(activeTabId)}
                onGetSelectedText={getter => { getSelectedTextRef.current = getter }}
                onGetFoldActions={actions => { foldActionsRef.current = actions }}
              />
            </div>

            <div class={styles.resizeHandle} onMouseDown={onResultsResizeMouseDown} />

            <div class={styles.resultsArea} style={{ height: `${resultsHeight}px` }}>
              <div class={styles.resultsTabs}>
                <button class={clsx(styles.resultsTab, resultTab === 'results' && styles.active)} onClick={() => setResultTab('results')}>Results</button>
                <button class={clsx(styles.resultsTab, resultTab === 'messages' && styles.active)} onClick={() => setResultTab('messages')}>Messages</button>
                <button class={clsx(styles.resultsTab, resultTab === 'history' && styles.active)} onClick={() => { setResultTab('history'); loadHistory() }}>History</button>
              </div>

              {resultTab === 'results' && queryResult && (
                <ResultGrid result={queryResult} queryError={queryError} maxRows={maxRows} onMaxRowsChange={setMaxRows}
                  viewMode={resultViewMode} onViewModeChange={setResultViewMode} recordIndex={recordIndex} onRecordIndexChange={setRecordIndex} />
              )}
              {resultTab === 'results' && !queryResult && <div class={styles.empty}>Run a query to see results</div>}

              {resultTab === 'messages' && (
                <div class={styles.messagesPanel}>
                  {messages.map((msg, i) => (
                    <div key={i} class={styles.messageEntry}>
                      <span class={styles.messageTs}>{msg.ts}</span>
                      <span class={msg.type === 'error' ? styles.messageError : styles.messageSuccess}>{msg.text}</span>
                    </div>
                  ))}
                  {messages.length === 0 && <div class={styles.empty}>No messages</div>}
                </div>
              )}

              {resultTab === 'history' && (
                <div class={styles.historyPanel}>
                  {history.map(h => (
                    <div key={h.id} class={styles.historyEntry} onClick={() => {
                      if (activeSqlTab) {
                        setTabs(prev => prev.map(t => t.id === activeTabId && t.kind === 'sql' ? { ...t, content: h.sql, isDirty: true } : t))
                        setResultTab('results')
                      }
                    }}>
                      <span class={styles.historySql}>{h.sql}</span>
                      <span class={styles.historyMeta}>
                        {h.duration_ms !== null && <span>{h.duration_ms}ms</span>}
                        {h.row_count !== null && <span>{h.row_count} rows</span>}
                        {h.error && <span class={styles.statusError}>error</span>}
                      </span>
                    </div>
                  ))}
                  {history.length === 0 && <div class={styles.empty}>No query history</div>}
                </div>
              )}
            </div>
          </>
        )}

        {/* Detail view */}
        {/* Schema ERD view */}
        {activeSchemaErdTab && (
          <SchemaErdPanel tab={activeSchemaErdTab} connectionName={connections.find(c => c.id === activeSchemaErdTab.connectionId)?.name || ''} />
        )}

        {/* Code view (functions/triggers) */}
        {activeCodeViewTab && (
          <div class={styles.codeViewPanel}>
            <div class={styles.codeViewHeader}>
              <span class={styles.codeViewTitle}>
                {activeCodeViewTab.objectType === 'function' ? <Braces size={16} /> : <Zap size={16} />}
                {activeCodeViewTab.objectName}
              </span>
              <span class={styles.codeViewBadge}>{activeCodeViewTab.objectType}</span>
              <div class={styles.spacer} />
              {activeCodeViewTab.objectType === 'function' && (
                <button class={styles.btnAdd} onClick={() => {
                  const raw = activeCodeViewTab.metadata.Arguments
                  let argList = ''
                  if (raw && raw !== '(none)') {
                    // Parse "name type DEFAULT val, name2 type2" into placeholder values
                    argList = raw.split(',').map(a => {
                      const trimmed = a.trim()
                      const defMatch = trimmed.match(/DEFAULT\s+(.+?)(?:::[\w]+)?$/i)
                      if (defMatch) return defMatch[1].trim()
                      // No default — extract just the type for a placeholder comment
                      const parts = trimmed.split(/\s+/)
                      const typeName = parts.length > 1 ? parts.slice(1).join(' ').replace(/::.*/, '') : parts[0]
                      return `/* ${typeName} */`
                    }).join(', ')
                  }
                  const sql = `SELECT "${activeCodeViewTab.schema}"."${activeCodeViewTab.objectName}"(${argList});`
                  const tab: SqlTab = { kind: 'sql', id: crypto.randomUUID(), name: `${activeCodeViewTab.objectName}()`, content: sql, connectionId: activeCodeViewTab.connectionId, isDirty: true }
                  setTabs(prev => [...prev, tab])
                  setActiveTabId(tab.id)
                }}>Open in SQL</button>
              )}
            </div>
            {Object.keys(activeCodeViewTab.metadata).length > 0 && (
              <div class={styles.codeViewMeta}>
                {Object.entries(activeCodeViewTab.metadata).map(([k, v]) => (
                  <div key={k} class={styles.codeViewMetaItem}>
                    <span class={styles.codeViewMetaLabel}>{k}</span>
                    <span>{v}</span>
                  </div>
                ))}
              </div>
            )}
            <div class={styles.codeViewBody}>
              {activeCodeViewTab.definition
                ? <pre class={styles.codeViewDef}>{activeCodeViewTab.definition}</pre>
                : <div class={styles.empty}>Loading definition...</div>}
            </div>
          </div>
        )}

        {activeDetailTab && tableDetail && (
          <TableDetailPanel
            tab={activeDetailTab}
            tableDetail={tableDetail}
            tableData={tableData}
            connectionName={connections.find(c => c.id === activeDetailTab.connectionId)?.name || ''}
            maxRows={maxRows}
            onMaxRowsChange={(n) => { setMaxRows(n); const dt = tabs.find(t => t.id === activeTabId && t.kind === 'detail') as DetailViewTab | undefined; if (dt) loadDetailData(dt, { limit: n }) }}
            resultViewMode={resultViewMode}
            onResultViewModeChange={setResultViewMode}
            recordIndex={recordIndex}
            onRecordIndexChange={setRecordIndex}
            onUpdateTab={updater => setTabs(updater)}
            onLoadData={loadDetailData}
            onLoadErd={loadErdData}
            onRefresh={refreshCurrentView}
            isRefreshing={isRefreshing}
            onOpenInSql={() => { if (tableDetail) onTableDoubleClick(activeDetailTab.connectionId, tableDetail.schema, tableDetail.name) }}
            onEditRow={(rowIndex) => setEditingRow({ tabId: activeDetailTab.id, rowIndex })}
          />
        )}
      </div>

      {/* Dialogs */}
      {showConnDialog && (
        <ConnectionDialog existing={editingConnection} onClose={() => { setShowConnDialog(false); setEditingConnection(null) }} onSaved={() => { setShowConnDialog(false); setEditingConnection(null); loadConnections() }} />
      )}
      {showSaveDialog && (
        <SaveScriptDialog onSave={saveNewScript} onCancel={() => setShowSaveDialog(false)} />
      )}
      {showNewScriptDialog && (
        <SaveScriptDialog title="New Script" onSave={createNewScript} onCancel={() => setShowNewScriptDialog(false)} />
      )}
      {deletingScript && (
        <ConfirmModal title="Delete Script" message={`Delete "${deletingScript.name}"? This cannot be undone.`} confirmLabel="Delete" variant="danger"
          onConfirm={async () => { await deleteScript(deletingScript.id); setDeletingScript(null); loadScripts() }} onCancel={() => setDeletingScript(null)} />
      )}
      {showSnapshotsModal && activeSqlTab?.savedQueryId && (
        <SnapshotsModal
          savedQueryId={activeSqlTab.savedQueryId}
          savedQueryName={activeSqlTab.name}
          sessionId={UI_SESSION_ID}
          onClose={() => setShowSnapshotsModal(false)}
          onRestored={(saved) => {
            setTabs(prev => prev.map(t =>
              t.id === activeSqlTab.id && t.kind === 'sql'
                ? {
                    ...t,
                    content: saved.sql,
                    savedQueryParams: saved.params || [],
                    paramValues: { ...defaultsForParams(saved.params || []), ...(t.paramValues || {}) },
                    isDirty: false,
                  }
                : t
            ))
            // Restore changes the snapshot list (adds a pre-restore safety net),
            // so refresh the toolbar dropdown.
            listSavedQuerySnapshots(activeSqlTab.savedQueryId!)
              .then(({ snapshots }) => setSavedQuerySnapshots(snapshots))
              .catch(() => {})
          }}
          onChanged={async () => {
            const { snapshots } = await listSavedQuerySnapshots(activeSqlTab.savedQueryId!)
            setSavedQuerySnapshots(snapshots)
          }}
        />
      )}
      {pendingMutation && (
        <ConfirmModal
          title={`${pendingMutation.type} Statement`}
          message={`This will execute a ${pendingMutation.type} statement against the database. Continue?`}
          confirmLabel={`Run ${pendingMutation.type}`}
          variant="danger"
          onConfirm={() => {
            const { sql, connectionId, onSuccess } = pendingMutation
            setPendingMutation(null)
            executeQueryNow(sql, connectionId, onSuccess)
          }}
          onCancel={() => setPendingMutation(null)}
        />
      )}
      {editingRow && (() => {
        const tab = tabs.find(t => t.id === editingRow.tabId && t.kind === 'detail') as DetailViewTab | undefined
        if (!tab || !tab.tableDetail || !tab.tableData) { return null }
        const row = tab.tableData.rows[editingRow.rowIndex]
        if (!row) { return null }
        return (
          <EditRowDialog
            tableDetail={tab.tableDetail}
            columns={tab.tableData.columns}
            row={row}
            onCancel={() => setEditingRow(null)}
            onSubmit={(updates, whereClause) => {
              const detail = tab.tableDetail!
              const setParts = updates.map(u => {
                if (u.isNull) return `"${u.col}" = NULL`
                // Numeric types don't need quoting; detect by column type name
                const colMeta = detail.columns.find(c => c.name === u.col)
                const rawType = colMeta?.data_type?.toLowerCase() || ''
                const isNumeric = /int|numeric|decimal|real|double|float|serial/.test(rawType)
                const isBool = rawType.includes('bool')
                if (isNumeric && u.rawValue.trim() !== '') return `"${u.col}" = ${u.rawValue}`
                if (isBool) return `"${u.col}" = ${u.rawValue.toLowerCase() === 'true' ? 'TRUE' : 'FALSE'}`
                return `"${u.col}" = '${u.rawValue.replace(/'/g, "''")}'`
              }).join(', ')
              const sql = `UPDATE "${detail.schema}"."${detail.name}" SET ${setParts} WHERE ${whereClause};`
              setEditingRow(null)
              const refresh = () => {
                const dt = tab
                if (dt.kind === 'detail') loadDetailData(dt)
              }
              if (dangerMode) {
                executeQueryNow(sql, tab.connectionId, refresh)
              } else {
                setPendingMutation({ sql, type: 'UPDATE', connectionId: tab.connectionId, onSuccess: refresh })
              }
            }}
          />
        )
      })()}
    </div>
  )
}
