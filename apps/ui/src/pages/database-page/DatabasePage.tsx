import { useState, useEffect, useRef } from 'preact/hooks'
import { Table2, Eye, FileText, Plus, Play, Square, X, ChevronsDownUp, ChevronsUpDown, Search, GitBranch, Braces, Zap } from 'lucide-preact'
import clsx from 'clsx'
import {
  getConnections, getSchemas, getTables, getTableDetail, executeQuery, getTableData,
  getScripts, createScript, updateScript, deleteScript, getQueryHistory, getTableErd, getSchemaErd,
  getFunctions, getSchemaTriggers, getFunctionDetail,
  type DbxConnection, type DbxQueryResult, type DbxScript, type DbxQueryHistoryEntry,
} from '../../lib/dbx-api'
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
  const [pendingMutation, setPendingMutation] = useState<{ sql: string; type: string; connectionId: string; onSuccess?: () => void } | null>(null)
  const [editingRow, setEditingRow] = useState<{ tabId: string; rowIndex: number } | null>(null)
  const [dangerMode, setDangerMode] = useState(false)
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const getSelectedTextRef = useRef<(() => string | null) | null>(null)
  const foldActionsRef = useRef<{ foldAll: () => void; unfoldAll: () => void } | null>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const [scriptsHeight, setScriptsHeight] = useState(() => loadStore().dbx.scriptsHeight)
  const [sidebarWidth, setSidebarWidth] = useState(() => loadStore().dbx.sidebarWidth)

  // ─── Sidebar divider drag ───

  function onDividerMouseDown(e: MouseEvent) {
    e.preventDefault()
    const startY = e.clientY
    const sidebar = sidebarRef.current
    if (!sidebar) return
    const sidebarRect = sidebar.getBoundingClientRect()
    const scriptsEl = sidebar.querySelector('[data-scripts]') as HTMLElement
    const startHeight = scriptsHeight === -1 ? (scriptsEl?.offsetHeight || sidebarRect.height / 2) : scriptsHeight

    function onMouseMove(ev: MouseEvent) {
      const delta = startY - ev.clientY
      setScriptsHeight(Math.max(60, Math.min(sidebarRect.height - 100, startHeight + delta)))
    }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      setScriptsHeight(h => { saveStore({ dbx: { ...loadStore().dbx, scriptsHeight: h } }); return h })
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

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
    const active = getActiveSql()
    if (!active) return

    const mutationType = detectMutation(active.sql)
    if (mutationType && !dangerMode) {
      setPendingMutation({ sql: active.sql, type: mutationType, connectionId: active.connectionId })
      return
    }
    executeQueryNow(active.sql, active.connectionId)
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
      <div class={styles.sidebar} ref={sidebarRef} style={{ '--sidebar-width': `${sidebarWidth}px`, gridTemplateRows: scriptsHeight === -1 ? 'auto auto 1fr auto 1fr' : `auto auto 1fr auto ${scriptsHeight}px` } as any}>
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

        <div class={styles.sidebarDivider} onMouseDown={onDividerMouseDown} />

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
              <button class={styles.btnRun} onClick={runQuery} disabled={isRunning}>
                {isRunning ? <><Square size={12} /> Running...</> : <><Play size={12} /> Run</>}
              </button>
              <span class={styles.shortcutHint}>⌘Enter</span>
              <button class={styles.btnIcon} onClick={() => foldActionsRef.current?.foldAll()} title="Fold all"><ChevronsDownUp size={13} /></button>
              <button class={styles.btnIcon} onClick={() => foldActionsRef.current?.unfoldAll()} title="Unfold all"><ChevronsUpDown size={13} /></button>
              <div class={styles.spacer} />
              <button class={styles.btnAdd} onClick={saveCurrentTab}>Save</button>
              <button
                class={clsx(styles.envLabel, dangerMode ? styles.envLabelDanger : styles.envLabelRw)}
                onClick={() => setDangerMode(!dangerMode)}
                title={dangerMode ? 'Danger mode: mutation confirmations disabled. Click to re-enable.' : 'Safe mode: mutations require confirmation. Click to disable.'}
              >
                {dangerMode ? 'DANGER' : 'SAFE'}
              </button>
            </div>

            <div class={styles.editorArea}>
              <SqlEditor
                value={activeSqlTab.content}
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
