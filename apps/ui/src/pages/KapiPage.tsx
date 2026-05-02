import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  Copy,
  Download,
  FileText,
  MessageSquareText,
  Search,
  Settings2,
  ShieldOff,
  Terminal,
  Trash2,
  X,
} from 'lucide-preact'
import {
  activateKapiEnvironment,
  createKapiCollection,
  createKapiDefinition,
  createKapiEnvironment,
  createKapiRequest,
  deleteKapiCollection,
  deleteKapiDefinition,
  deleteKapiEnvVar,
  deleteKapiEnvironment,
  deleteKapiRequest,
  listKapiCollections,
  listKapiDefinitions,
  listKapiEnvVars,
  listKapiEnvironments,
  listKapiRequests,
  renameKapiEnvVar,
  runKapiRequest,
  updateKapiCollection,
  updateKapiDefinition,
  updateKapiRequest,
  upsertKapiEnvVar,
} from '../lib/kapi-api'
import type {
  KapiCollection,
  KapiDefinition,
  KapiEnvVar,
  KapiEnvironment,
  KapiHttpMethod,
  KapiKeyValue,
  KapiRequest,
  KapiRun,
} from '../types/kapi'
import { CodeEditor } from '../components/editor/CodeEditor'
import { useDocumentTitle } from '../hooks'
import { loadStore, saveStore } from '../lib/store'
import styles from './KapiPage.module.css'

const METHODS: KapiHttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]

type Tab = 'headers' | 'params' | 'body' | 'scripts' | 'env'
type ResponseTab = 'body' | 'tests'

interface Props {
  /** Optional collection handle from /kapi/:handle. Selects + persists on load. */
  initialCollectionHandle?: string
}

function statusClass(status: number | null): string {
  if (status === null) return styles.statusError
  if (status >= 200 && status < 300) return styles.statusOk
  if (status >= 300 && status < 400) return styles.statusRedirect
  return styles.statusError
}

function statusLabel(status: number | null, error: string | null): string {
  if (error) return 'Error'
  if (status === null) return '—'
  const labels: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    500: 'Internal Server Error',
  }
  return `${status} ${labels[status] ?? ''}`.trim()
}

function bodyLanguageFor(bodyLanguage: string | undefined): string {
  switch (bodyLanguage) {
    case 'json':
      return 'json'
    case 'yaml':
      return 'yaml'
    case 'html':
    case 'xml':
      return 'html'
    case 'graphql':
      return 'javascript'
    default:
      return 'plain'
  }
}

function tryFormatJson(text: string | null): string {
  if (!text) return ''
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

interface CreateModalState {
  kind: 'definition' | 'request'
  definitionId?: string
  /** When set, modal is in edit mode. The id targets the existing row. */
  editing?: { id: string; initial: Record<string, string> }
}

interface ContextMenuState {
  kind: 'definition' | 'request'
  id: string
  x: number
  y: number
}

export function KapiPage({ initialCollectionHandle }: Props) {
  const [, setLocation] = useLocation()

  // Collections
  const [collections, setCollections] = useState<KapiCollection[]>([])
  const [activeCollection, setActiveCollection] = useState<KapiCollection | null>(null)
  const [collectionsModalOpen, setCollectionsModalOpen] = useState(false)
  const [bootstrapping, setBootstrapping] = useState(true)

  // Definitions / requests
  const [definitions, setDefinitions] = useState<KapiDefinition[]>([])
  const [requestsByDef, setRequestsByDef] = useState<Record<string, KapiRequest[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [activeRequest, setActiveRequest] = useState<KapiRequest | null>(null)
  const [activeDefinition, setActiveDefinition] = useState<KapiDefinition | null>(null)
  const [treeFilter, setTreeFilter] = useState('')
  const [tab, setTab] = useState<Tab>('headers')
  const [run, setRun] = useState<KapiRun | null>(null)
  const [sending, setSending] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const [createModal, setCreateModal] = useState<CreateModalState | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Environments + vars
  const [environments, setEnvironments] = useState<KapiEnvironment[]>([])
  const [envVars, setEnvVars] = useState<KapiEnvVar[]>([])
  const [envModalOpen, setEnvModalOpen] = useState(false)
  const activeEnv = useMemo(
    () => environments.find((e) => e.is_active) ?? null,
    [environments]
  )

  // Scripts live directly on the request row — content is in
  // pre_script_content / test_script_content. No separate scripts table.

  // Splitter-driven sizes (persisted to khef-state, like DBX).
  const [sidebarWidth, setSidebarWidth] = useState(
    () => loadStore().kapi.sidebarWidth
  )
  const [requestPaneHeight, setRequestPaneHeight] = useState(
    () => loadStore().kapi.requestPaneHeight
  )
  const [preScriptHeight, setPreScriptHeight] = useState(
    () => loadStore().kapi.preScriptHeight
  )
  const allowInsecureTls = !!activeCollection?.allow_insecure_tls

  // Pending restore — set when persisted selection exists, cleared once the
  // matching request finishes loading.
  const [pendingRestore, setPendingRestore] = useState<{
    definitionId: string
    requestId: string | null
  } | null>(null)

  // Local edits to the active request (persist on Send or save)
  const [draftMethod, setDraftMethod] = useState<KapiHttpMethod>('GET')
  const [draftUrl, setDraftUrl] = useState('')
  const [draftHeaders, setDraftHeaders] = useState<KapiKeyValue[]>([])
  const [draftQuery, setDraftQuery] = useState<KapiKeyValue[]>([])
  const [draftBody, setDraftBody] = useState('')

  useDocumentTitle(
    activeRequest && activeCollection
      ? `Kapi · ${activeCollection.name} · ${activeRequest.name}`
      : activeCollection
      ? `Kapi · ${activeCollection.name}`
      : 'Kapi'
  )

  // Bootstrap: load collections, then resolve active one (URL > store > first).
  useEffect(() => {
    let cancelled = false
    listKapiCollections()
      .then((cols) => {
        if (cancelled) return
        setCollections(cols)
        const persistedId = loadStore().kapi.activeCollectionId
        const target =
          (initialCollectionHandle &&
            cols.find((c) => c.handle === initialCollectionHandle)) ||
          cols.find((c) => c.id === persistedId) ||
          cols[0] ||
          null
        setActiveCollection(target)
        setBootstrapping(false)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(err.message)
        setBootstrapping(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCollectionHandle])

  // Persist active collection
  useEffect(() => {
    if (!activeCollection) return
    const store = loadStore()
    saveStore({
      kapi: { ...store.kapi, activeCollectionId: activeCollection.id },
    })
  }, [activeCollection?.id])

  // Reset child state when the active collection changes
  useEffect(() => {
    setDefinitions([])
    setRequestsByDef({})
    setExpanded({})
    setActiveRequest(null)
    setActiveDefinition(null)
    setEnvironments([])
    setEnvVars([])
    setRun(null)
    setRunError(null)
  }, [activeCollection?.id])

  // Load definitions when active collection is known
  useEffect(() => {
    if (!activeCollection) return
    let cancelled = false
    const collectionId = activeCollection.id
    const persisted = loadStore().kapi.selectionByCollection[collectionId]
    listKapiDefinitions(collectionId)
      .then((defs) => {
        if (cancelled) return
        setDefinitions(defs)
        const restoredDef = persisted?.definitionId
          ? defs.find((d) => d.id === persisted.definitionId)
          : null
        const expandTarget = restoredDef ?? defs[0]
        if (expandTarget) setExpanded((m) => ({ ...m, [expandTarget.id]: true }))
        if (restoredDef) {
          setPendingRestore({
            definitionId: restoredDef.id,
            requestId: persisted?.requestId ?? null,
          })
        }
      })
      .catch((err) => !cancelled && setLoadError(err.message))
    return () => {
      cancelled = true
    }
  }, [activeCollection?.id])

  // Activate the persisted request once its definition's children have loaded.
  useEffect(() => {
    if (!pendingRestore) return
    const list = requestsByDef[pendingRestore.definitionId]
    if (!list) return
    if (pendingRestore.requestId) {
      const req = list.find((r) => r.id === pendingRestore.requestId)
      if (req) setActiveRequest(req)
    }
    setPendingRestore(null)
  }, [pendingRestore, requestsByDef])

  // Persist selection (def + request) per collection whenever it changes.
  useEffect(() => {
    if (!activeCollection) return
    const store = loadStore()
    saveStore({
      kapi: {
        ...store.kapi,
        selectionByCollection: {
          ...store.kapi.selectionByCollection,
          [activeCollection.id]: {
            definitionId: activeDefinition?.id ?? null,
            requestId: activeRequest?.id ?? null,
          },
        },
      },
    })
  }, [activeCollection?.id, activeDefinition?.id, activeRequest?.id])

  // Load environments when active collection changes
  useEffect(() => {
    if (!activeCollection) return
    let cancelled = false
    listKapiEnvironments(activeCollection.id)
      .then((envs) => !cancelled && setEnvironments(envs))
      .catch((err) => !cancelled && setLoadError(err.message))
    return () => {
      cancelled = true
    }
  }, [activeCollection?.id])

  // Load vars whenever the active env changes
  useEffect(() => {
    let cancelled = false
    if (!activeEnv) {
      setEnvVars([])
      return
    }
    listKapiEnvVars(activeEnv.id)
      .then((vars) => !cancelled && setEnvVars(vars))
      .catch((err) => !cancelled && setLoadError(err.message))
    return () => {
      cancelled = true
    }
  }, [activeEnv?.id])


  // Load requests for any expanded definition we haven't fetched yet
  useEffect(() => {
    const pending = Object.keys(expanded).filter(
      (defId) => expanded[defId] && !requestsByDef[defId]
    )
    if (pending.length === 0) return
    pending.forEach((defId) => {
      listKapiRequests(defId)
        .then((reqs) => setRequestsByDef((m) => ({ ...m, [defId]: reqs })))
        .catch((err) => setLoadError(err.message))
    })
  }, [expanded, requestsByDef])

  // When active request changes, seed the draft
  useEffect(() => {
    if (!activeRequest) return
    setDraftMethod(activeRequest.method)
    const def = definitions.find((d) => d.id === activeRequest.definition_id) ?? null
    setActiveDefinition(def)
    const isAbsolute = /^https?:\/\//i.test(activeRequest.path)
    setDraftUrl(isAbsolute ? activeRequest.path : (def?.base_url ?? '') + activeRequest.path)
    setDraftHeaders(
      activeRequest.headers.length
        ? [...activeRequest.headers]
        : [{ key: '', value: '', enabled: true }]
    )
    setDraftQuery(
      activeRequest.query_params.length
        ? [...activeRequest.query_params]
        : [{ key: '', value: '', enabled: true }]
    )
    setDraftBody(activeRequest.body_content)
    setRun(null)
    setRunError(null)
  }, [activeRequest, definitions])

  const onSelectRequest = (req: KapiRequest) => setActiveRequest(req)

  const onSelectCollection = (id: string) => {
    const next = collections.find((c) => c.id === id)
    if (!next) return
    setActiveCollection(next)
    // Update URL to reflect the choice (deep-linkable but without forcing a remount).
    setLocation(`/kapi/${next.handle}`, { replace: true })
  }

  const onSend = async () => {
    if (!activeRequest) return
    // Abort any in-flight request before starting the next one.
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setSending(true)
    setRunError(null)
    setElapsedMs(0)
    const startedAt = Date.now()
    const tick = setInterval(() => {
      setElapsedMs(Date.now() - startedAt)
    }, 50)
    try {
      const cleanHeaders = draftHeaders.filter((h) => h.key.trim())
      const cleanQuery = draftQuery.filter((q) => q.key.trim())
      const baseUrl = activeDefinition?.base_url ?? ''
      const storedPath =
        baseUrl && draftUrl.startsWith(baseUrl)
          ? draftUrl.slice(baseUrl.length)
          : draftUrl
      const updated = await updateKapiRequest(activeRequest.id, {
        method: draftMethod,
        path: storedPath,
        headers: cleanHeaders,
        query_params: cleanQuery,
        body_content: draftBody,
        body_type: draftBody.trim() ? 'raw' : 'none',
      })
      setActiveRequest(updated)
      setRequestsByDef((m) => ({
        ...m,
        [updated.definition_id]: (m[updated.definition_id] ?? []).map((r) =>
          r.id === updated.id ? updated : r
        ),
      }))
      // Runner falls back to collection.allow_insecure_tls when the option
      // is omitted, so no need to pass it here explicitly.
      const result = await runKapiRequest(updated.id, undefined, ctrl.signal)
      setRun(result)
    } catch (err: unknown) {
      if (ctrl.signal.aborted) {
        setRunError('Canceled')
      } else {
        setRunError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      clearInterval(tick)
      setSending(false)
      if (abortRef.current === ctrl) abortRef.current = null
    }
  }

  const onCancel = () => {
    abortRef.current?.abort()
  }

  const onCreate = async (input: Record<string, string>) => {
    if (!createModal || !activeCollection) return
    const editingId = createModal.editing?.id
    if (createModal.kind === 'definition') {
      if (editingId) {
        const updated = await updateKapiDefinition(editingId, {
          handle: input.handle,
          name: input.name,
          base_url: input.base_url || null,
        })
        setDefinitions((prev) =>
          prev.map((d) => (d.id === editingId ? updated : d))
        )
      } else {
        const def = await createKapiDefinition(activeCollection.id, {
          handle: input.handle,
          name: input.name,
          base_url: input.base_url || null,
        })
        setDefinitions((prev) => [def, ...prev])
        setExpanded((m) => ({ ...m, [def.id]: true }))
      }
    } else if (createModal.kind === 'request') {
      if (editingId) {
        const updated = await updateKapiRequest(editingId, {
          name: input.name,
          method: (input.method as KapiHttpMethod) || 'GET',
          path: input.path || '',
        })
        setRequestsByDef((m) => ({
          ...m,
          [updated.definition_id]: (m[updated.definition_id] ?? []).map((r) =>
            r.id === editingId ? updated : r
          ),
        }))
        if (activeRequest?.id === editingId) setActiveRequest(updated)
      } else if (createModal.definitionId) {
        const req = await createKapiRequest(createModal.definitionId, {
          name: input.name,
          method: (input.method as KapiHttpMethod) || 'GET',
          path: input.path || '',
        })
        setRequestsByDef((m) => ({
          ...m,
          [req.definition_id]: [...(m[req.definition_id] ?? []), req],
        }))
        setActiveRequest(req)
      }
    }
    setCreateModal(null)
  }

  const onDelete = async (menu: ContextMenuState) => {
    if (menu.kind === 'definition') {
      const def = definitions.find((d) => d.id === menu.id)
      if (!def) return
      if (
        !window.confirm(
          `Delete definition "${def.name}"? This also removes all its requests.`
        )
      )
        return
      await deleteKapiDefinition(menu.id)
      setDefinitions((prev) => prev.filter((d) => d.id !== menu.id))
      setRequestsByDef((m) => {
        const next = { ...m }
        delete next[menu.id]
        return next
      })
      if (activeRequest?.definition_id === menu.id) {
        setActiveRequest(null)
        setActiveDefinition(null)
      }
    } else {
      const req = Object.values(requestsByDef)
        .flat()
        .find((r) => r.id === menu.id)
      if (!req) return
      if (!window.confirm(`Delete request "${req.name}"?`)) return
      await deleteKapiRequest(menu.id)
      setRequestsByDef((m) => ({
        ...m,
        [req.definition_id]: (m[req.definition_id] ?? []).filter(
          (r) => r.id !== menu.id
        ),
      }))
      if (activeRequest?.id === menu.id) setActiveRequest(null)
    }
  }

  const onEdit = (menu: ContextMenuState) => {
    if (menu.kind === 'definition') {
      const def = definitions.find((d) => d.id === menu.id)
      if (!def) return
      setCreateModal({
        kind: 'definition',
        editing: {
          id: def.id,
          initial: {
            handle: def.handle,
            name: def.name,
            base_url: def.base_url ?? '',
          },
        },
      })
    } else {
      const req = Object.values(requestsByDef)
        .flat()
        .find((r) => r.id === menu.id)
      if (!req) return
      setCreateModal({
        kind: 'request',
        definitionId: req.definition_id,
        editing: {
          id: req.id,
          initial: {
            name: req.name,
            method: req.method,
            path: req.path,
          },
        },
      })
    }
  }

  // Close context menu on outside click / scroll / Escape
  useEffect(() => {
    if (!contextMenu) return
    const handleDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      setContextMenu(null)
    }
    const handleScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return
      setContextMenu(null)
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('mousedown', handleDown)
    document.addEventListener('scroll', handleScroll, true)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      document.removeEventListener('scroll', handleScroll, true)
      document.removeEventListener('keydown', handleKey)
    }
  }, [contextMenu])

  // --- Collection handlers ---
  const onCreateCollection = async (input: {
    handle: string
    name: string
    description: string
  }) => {
    const created = await createKapiCollection({
      handle: input.handle,
      name: input.name,
      description: input.description || null,
    })
    setCollections((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
    setActiveCollection(created)
    setLocation(`/kapi/${created.handle}`, { replace: true })
  }

  const onUpdateCollection = async (
    id: string,
    input: { handle?: string; name?: string; description?: string | null }
  ) => {
    const updated = await updateKapiCollection(id, input)
    setCollections((prev) =>
      prev.map((c) => (c.id === id ? updated : c)).sort((a, b) => a.name.localeCompare(b.name))
    )
    if (activeCollection?.id === id) {
      setActiveCollection(updated)
      setLocation(`/kapi/${updated.handle}`, { replace: true })
    }
  }

  const onDeleteCollection = async (id: string) => {
    const col = collections.find((c) => c.id === id)
    if (!col) return
    if (
      !window.confirm(
        `Delete collection "${col.name}"? This also removes all its definitions, environments, scripts, and run history.`
      )
    )
      return
    await deleteKapiCollection(id)
    const remaining = collections.filter((c) => c.id !== id)
    setCollections(remaining)
    if (activeCollection?.id === id) {
      const next = remaining[0] ?? null
      setActiveCollection(next)
      if (next) setLocation(`/kapi/${next.handle}`, { replace: true })
      else setLocation('/kapi', { replace: true })
    }
  }

  // --- Environment handlers ---
  const onSelectEnv = async (id: string) => {
    if (!id) return
    try {
      await activateKapiEnvironment(id)
      setEnvironments((prev) =>
        prev.map((e) => ({ ...e, is_active: e.id === id }))
      )
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }

  const onCreateEnv = async (input: {
    handle: string
    name: string
    activate: boolean
    copyFromActive: boolean
  }): Promise<void> => {
    if (!activeCollection) return
    const env = await createKapiEnvironment(activeCollection.id, {
      handle: input.handle,
      name: input.name,
      is_active: input.activate,
      copy_from_environment_id:
        input.copyFromActive && activeEnv ? activeEnv.id : undefined,
    })
    setEnvironments((prev) =>
      input.activate
        ? [env, ...prev.map((e) => ({ ...e, is_active: false }))]
        : [env, ...prev]
    )
  }

  const onDeleteEnv = async (id: string) => {
    const env = environments.find((e) => e.id === id)
    if (!env) return
    if (!window.confirm(`Delete environment "${env.name}" and all its vars?`)) return
    await deleteKapiEnvironment(id)
    setEnvironments((prev) => prev.filter((e) => e.id !== id))
  }

  const onUpsertVar = async (input: {
    key: string
    value: string
    is_secret: boolean
  }): Promise<void> => {
    if (!activeEnv) return
    const saved = await upsertKapiEnvVar(activeEnv.id, input)
    setEnvVars((prev) => {
      const idx = prev.findIndex((v) => v.key === input.key)
      return idx === -1
        ? [...prev, saved]
        : prev.map((v) => (v.key === input.key ? saved : v))
    })
  }

  const onDeleteVar = async (key: string) => {
    if (!activeEnv) return
    if (!window.confirm(`Delete variable "${key}"?`)) return
    await deleteKapiEnvVar(activeEnv.id, key)
    setEnvVars((prev) => prev.filter((v) => v.key !== key))
  }

  const onRenameVar = async (oldKey: string, newKey: string): Promise<void> => {
    if (!activeEnv) return
    const renamed = await renameKapiEnvVar(activeEnv.id, oldKey, newKey)
    setEnvVars((prev) => prev.map((v) => (v.key === oldKey ? renamed : v)))
  }

  // --- Script handlers ---
  // Single save path: every request has its own pre and test script. There
  // is no shared / reusable script concept in the UI.
  //   - no script attached → create inline + attach
  // Scripts now live directly on the request row as plain text columns.
  // Save = PATCH the request with the new content. No attach, no separate
  // scripts table, no cross-request sharing possible.
  const onSaveScript = async (
    kind: 'pre-request' | 'test',
    content: string
  ) => {
    if (!activeRequest) return
    const field =
      kind === 'pre-request' ? 'pre_script_content' : 'test_script_content'
    const updatedReq = await updateKapiRequest(activeRequest.id, {
      [field]: content,
    } as Partial<KapiRequest>)
    setActiveRequest(updatedReq)
    setRequestsByDef((m) => ({
      ...m,
      [updatedReq.definition_id]: (m[updatedReq.definition_id] ?? []).map((r) =>
        r.id === updatedReq.id ? updatedReq : r
      ),
    }))
  }

  // --- Splitter drag handlers ---
  const onSidebarResize = (e: MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidth
    const onMouseMove = (ev: MouseEvent) => {
      setSidebarWidth(Math.max(160, Math.min(600, startWidth + ev.clientX - startX)))
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      setSidebarWidth((w) => {
        saveStore({ kapi: { ...loadStore().kapi, sidebarWidth: w } })
        return w
      })
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  const onRequestPaneResize = (e: MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = requestPaneHeight
    const onMouseMove = (ev: MouseEvent) => {
      const next = startHeight + ev.clientY - startY
      setRequestPaneHeight(Math.max(80, Math.min(window.innerHeight - 200, next)))
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      setRequestPaneHeight((h) => {
        saveStore({ kapi: { ...loadStore().kapi, requestPaneHeight: h } })
        return h
      })
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  const onPreScriptResize = (e: MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = preScriptHeight
    const onMouseMove = (ev: MouseEvent) => {
      const next = startHeight + ev.clientY - startY
      const cap = Math.max(120, requestPaneHeight - 160)
      setPreScriptHeight(Math.max(80, Math.min(cap, next)))
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      setPreScriptHeight((h) => {
        saveStore({ kapi: { ...loadStore().kapi, preScriptHeight: h } })
        return h
      })
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  const headerCount = useMemo(
    () => draftHeaders.filter((h) => h.key.trim()).length,
    [draftHeaders]
  )
  const queryCount = useMemo(
    () => draftQuery.filter((q) => q.key.trim()).length,
    [draftQuery]
  )

  const allExpanded =
    definitions.length > 0 && definitions.every((d) => expanded[d.id])

  // Filter: match against definition name/handle and each request's
  // name/method/path. When a def's name matches, show all its requests.
  // When only some requests match, show just those. When the filter is
  // non-empty, treat every shown def as expanded so matches are visible
  // without extra clicks.
  const lowerFilter = treeFilter.trim().toLowerCase()
  const defMatches = (d: KapiDefinition) =>
    d.name.toLowerCase().includes(lowerFilter) ||
    d.handle.toLowerCase().includes(lowerFilter)
  const reqMatches = (r: KapiRequest) =>
    r.name.toLowerCase().includes(lowerFilter) ||
    r.path.toLowerCase().includes(lowerFilter) ||
    r.method.toLowerCase().includes(lowerFilter)
  const filteredDefs = !lowerFilter
    ? definitions
    : definitions.filter((def) => {
        if (defMatches(def)) return true
        const reqs = requestsByDef[def.id] ?? []
        return reqs.some(reqMatches)
      })
  const requestsFor = (defId: string): KapiRequest[] => {
    const reqs = requestsByDef[defId] ?? []
    if (!lowerFilter) return reqs
    const def = definitions.find((d) => d.id === defId)
    if (def && defMatches(def)) return reqs
    return reqs.filter(reqMatches)
  }
  const isExpanded = (defId: string) =>
    lowerFilter ? true : !!expanded[defId]

  // When the user starts filtering, eagerly load any defs whose requests
  // we haven't fetched yet so the filter can find matches beyond the
  // currently-expanded defs.
  useEffect(() => {
    if (!lowerFilter) return
    const missing = definitions.filter((d) => !requestsByDef[d.id])
    if (missing.length === 0) return
    missing.forEach((def) => {
      listKapiRequests(def.id)
        .then((reqs) => setRequestsByDef((m) => ({ ...m, [def.id]: reqs })))
        .catch((err) => setLoadError(err.message))
    })
  }, [lowerFilter, definitions])

  // Inspect drawer (collapsible section in the response pane for errors,
  // env writes, and script logs). Auto-opens when the run has any script
  // error so failures are visible without an extra click.
  const preWritesCount = run?.pre_script_env_writes
    ? Object.keys(run.pre_script_env_writes).length
    : 0
  const testWritesCount = run?.test_script_env_writes
    ? Object.keys(run.test_script_env_writes).length
    : 0
  const inspectCount =
    (run?.pre_script_error ? 1 : 0) +
    (run?.test_script_error ? 1 : 0) +
    (preWritesCount > 0 ? 1 : 0) +
    (testWritesCount > 0 ? 1 : 0) +
    (run?.pre_script_log ? 1 : 0) +
    (run?.test_script_log ? 1 : 0)
  const hasScriptError = !!(run?.pre_script_error || run?.test_script_error)
  const [inspectOpen, setInspectOpen] = useState(false)
  useEffect(() => {
    if (hasScriptError) setInspectOpen(true)
  }, [run?.id, hasScriptError])

  const testPass = run?.test_results?.filter((t) => t.pass).length ?? 0
  const testTotal = run?.test_results?.length ?? 0
  const testFail = testTotal - testPass
  const [responseTab, setResponseTab] = useState<ResponseTab>('body')
  // Reset response tab to Body whenever a new run lands. If that run has
  // failing tests, flip to the Tests tab automatically so failures surface.
  useEffect(() => {
    if (!run) return
    if (testFail > 0) setResponseTab('tests')
    else setResponseTab('body')
  }, [run?.id])

  const onToggleExpandAll = () => {
    if (allExpanded) {
      setExpanded({})
    } else {
      const next: Record<string, boolean> = {}
      for (const d of definitions) next[d.id] = true
      setExpanded(next)
    }
  }

  // --- Response copy / export helpers ---
  // Mirrors the pattern on JobPage: a primary action button (Copy / Export)
  // with a hover-revealed row of alternate formats. Keeps buttons disabled
  // when the response body is empty (transport error or early cancel).
  const responseBaseName = () => {
    const method = run?.resolved_method ?? activeRequest?.method ?? 'GET'
    const reqName = activeRequest?.name || 'ad-hoc'
    const status = run?.response_status ?? 0
    // Local timestamp — YYYYMMDD-HHMMSS — appended to avoid the browser's
    // "(1)", "(2)" suffixes when re-exporting the same request repeatedly.
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    return `${method.toLowerCase()}-${reqName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')}-${status}-${stamp}`
  }
  const responseBody = run?.response_body ?? ''
  const responseJson = useMemo(() => {
    if (!responseBody) return null
    const trimmed = responseBody.trimStart()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
    try {
      return JSON.parse(trimmed)
    } catch {
      return null
    }
  }, [responseBody])

  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  const [openActionMenu, setOpenActionMenu] = useState<
    'copy' | 'export' | null
  >(null)

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard denied — no-op */
    } finally {
      setOpenActionMenu(null)
    }
  }

  const copyResponseBody = () => copyText(responseBody)

  const copyAsMarkdown = () => {
    if (!run) return
    const method = run.resolved_method
    const url = run.resolved_url
    const status = run.response_status ?? 'n/a'
    const lang = responseJson ? 'json' : ''
    const md = [
      `# ${method} ${url}`,
      '',
      `Status: ${status} · ${run.response_time_ms ?? 0}ms`,
      '',
      '```' + lang,
      responseBody,
      '```',
    ].join('\n')
    copyText(md)
  }

  const copyAsSlack = () => {
    if (!run) return
    const title = `${run.resolved_method} ${run.resolved_url} · ${run.response_status ?? 'error'}`
    copyText(`*${title}*\n\`\`\`\n${responseBody}\n\`\`\``)
  }

  const copyAsCurl = () => {
    if (!run) return
    const headers = (run.resolved_headers ?? [])
      .filter((h) => h.enabled && h.key)
      .map(
        (h) =>
          `  -H ${JSON.stringify(`${h.key}: ${h.value ?? ''}`)}`,
      )
    const parts = [`curl -X ${run.resolved_method} ${JSON.stringify(run.resolved_url)}`]
    if (headers.length) parts.push(headers.join(' \\\n'))
    if (run.resolved_body) {
      parts.push(`  --data ${JSON.stringify(run.resolved_body)}`)
    }
    copyText(parts.join(' \\\n'))
  }

  const downloadResponse = () => {
    setOpenActionMenu(null)
    if (!responseBody) return
    const trimmed = responseBody.trimStart()
    let ext = 'txt'
    let mime = 'text/plain'
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed)
        ext = 'json'
        mime = 'application/json'
      } catch {
        /* not JSON */
      }
    } else if (/^<\?xml|^<!doctype html|^<html/i.test(trimmed)) {
      ext = trimmed.toLowerCase().includes('<html') ? 'html' : 'xml'
      mime = ext === 'html' ? 'text/html' : 'application/xml'
    }
    const blob = new Blob([responseBody], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${responseBaseName()}.${ext}`
    a.click()
    URL.revokeObjectURL(url)
  }

  // If a body is stored as text but is actually JSON, embed it as a nested
  // object so the downloaded run is pretty-printable and greppable instead
  // of `"body": "{\"k\":...}"` with escape-hell.
  const maybeParseJson = (text: string | null | undefined): unknown => {
    if (text == null || text === '') return text ?? null
    const trimmed = text.trimStart()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
    try {
      return JSON.parse(trimmed)
    } catch {
      return text
    }
  }

  const downloadResponseAsRun = () => {
    setOpenActionMenu(null)
    if (!run) return
    const payload = {
      request: {
        method: run.resolved_method,
        url: run.resolved_url,
        headers: run.resolved_headers,
        body: maybeParseJson(run.resolved_body),
      },
      response: {
        status: run.response_status,
        headers: run.response_headers,
        body: maybeParseJson(run.response_body),
        time_ms: run.response_time_ms,
      },
      error: run.error,
      executed_at: run.executed_at,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${responseBaseName()}-run.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const responseActionsDisabled = !run || !responseBody

  return (
    <div class={styles.app}>
      <aside class={styles.sidebar} style={`width: ${sidebarWidth}px`}>
        <div class={styles.sidebarHeader}>
          <span class={styles.envLabel}>Col</span>
          <ComboSelect
            value={activeCollection?.id ?? null}
            placeholder={collections.length === 0 ? 'No collections' : 'Select…'}
            disabled={collections.length === 0}
            options={collections.map((c) => ({ value: c.id, label: c.name }))}
            onChange={onSelectCollection}
            className={styles.collectionSelect}
            testId="kapi--collection-select"
          />
          <button
            class={styles.iconBtn}
            title="Manage collections"
            onClick={() => setCollectionsModalOpen(true)}
            data-testid="kapi--collection-manage"
          >
            <Settings2 size={14} />
          </button>
        </div>

        <div class={styles.envBar}>
          <span class={styles.envLabel}>Env</span>
          <ComboSelect
            value={activeEnv?.id ?? null}
            placeholder={
              environments.length === 0 ? 'No environments' : 'No environment'
            }
            disabled={environments.length === 0}
            options={environments.map((env) => ({ value: env.id, label: env.name }))}
            onChange={(id) => {
              void onSelectEnv(id)
            }}
            className={styles.envSelect}
            testId="kapi--env-select"
          />
          <button
            class={styles.iconBtn}
            title="Manage environments & vars"
            onClick={() => setEnvModalOpen(true)}
            disabled={!activeCollection}
            data-testid="kapi--env-manage"
          >
            <Settings2 size={14} />
          </button>
        </div>

        <div class={styles.defsBar}>
          <span class={styles.envLabel}>Defs</span>
          <span class={styles.defsBarSpacer} />
          <button
            class={styles.iconBtn}
            title={allExpanded ? 'Collapse all definitions' : 'Expand all definitions'}
            onClick={onToggleExpandAll}
            disabled={definitions.length === 0}
            data-testid="kapi--expand-all"
          >
            {allExpanded ? (
              <ChevronsDownUp size={14} />
            ) : (
              <ChevronsUpDown size={14} />
            )}
          </button>
          <button
            class={styles.iconBtn}
            title="New definition"
            onClick={() => setCreateModal({ kind: 'definition' })}
            disabled={!activeCollection}
            data-testid="kapi--new-definition"
          >
            +
          </button>
        </div>

        <div class={styles.filterRow}>
          <Search size={12} class={styles.filterIcon} />
          <input
            type="text"
            class={styles.filterInput}
            value={treeFilter}
            onInput={(e) => setTreeFilter(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setTreeFilter('')
            }}
            placeholder="Filter defs & requests"
            disabled={!activeCollection}
            data-testid="kapi--tree-filter"
          />
          {treeFilter && (
            <button
              class={styles.filterClear}
              onClick={() => setTreeFilter('')}
              title="Clear filter (Esc)"
            >
              <X size={11} />
            </button>
          )}
        </div>

        <div class={styles.tree}>
          {bootstrapping ? (
            <div class={styles.empty}>Loading…</div>
          ) : loadError ? (
            <div class={styles.empty}>{loadError}</div>
          ) : !activeCollection ? (
            <div class={styles.empty}>
              No collections yet.
              <br />
              <button
                class={styles.inlineBtn}
                style="margin-top: 8px"
                onClick={() => setCollectionsModalOpen(true)}
              >
                Create one
              </button>
            </div>
          ) : definitions.length === 0 ? (
            <div class={styles.empty}>
              No definitions yet.
              <br />
              <button
                class={styles.inlineBtn}
                style="margin-top: 8px"
                onClick={() => setCreateModal({ kind: 'definition' })}
              >
                Create one
              </button>
            </div>
          ) : filteredDefs.length === 0 ? (
            <div class={styles.empty}>No matches for "{treeFilter}"</div>
          ) : (
            filteredDefs.map((def) => (
              <div key={def.id} class={styles.defGroup}>
                <div
                  class={styles.defHeader}
                  onClick={() =>
                    setExpanded((m) => ({ ...m, [def.id]: !m[def.id] }))
                  }
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setContextMenu({
                      kind: 'definition',
                      id: def.id,
                      x: e.clientX,
                      y: e.clientY,
                    })
                  }}
                >
                  <span class={styles.caret}>
                    {isExpanded(def.id) ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </span>
                  <span style="flex: 1">{def.name}</span>
                  <button
                    class={styles.iconBtn}
                    title="New request"
                    onClick={(e) => {
                      e.stopPropagation()
                      setCreateModal({ kind: 'request', definitionId: def.id })
                      setExpanded((m) => ({ ...m, [def.id]: true }))
                    }}
                  >
                    +
                  </button>
                </div>
                {isExpanded(def.id) &&
                  requestsFor(def.id).map((req) => (
                    <div
                      key={req.id}
                      class={`${styles.req} ${
                        activeRequest?.id === req.id ? styles.active : ''
                      }`}
                      onClick={() => onSelectRequest(req)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setContextMenu({
                          kind: 'request',
                          id: req.id,
                          x: e.clientX,
                          y: e.clientY,
                        })
                      }}
                    >
                      <span class={`${styles.method} ${styles[req.method]}`}>
                        {req.method}
                      </span>
                      <span>{req.name}</span>
                    </div>
                  ))}
              </div>
            ))
          )}
        </div>
      </aside>

      <div
        class={styles.sidebarSplitter}
        onMouseDown={onSidebarResize}
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize sidebar"
      />

      <main class={styles.main}>
        {!activeRequest ? (
          <div class={styles.emptyState}>
            <h2>Select or create a request</h2>
            <div>Build and send HTTP requests against your saved definitions.</div>
          </div>
        ) : (
          <>
            <div class={styles.breadcrumb}>
              <span>{activeDefinition?.name}</span>
              <span>/</span>
              <b>{activeRequest.name}</b>
            </div>

            <div class={styles.requestBar}>
              <select
                class={styles.methodSelect}
                value={draftMethod}
                onChange={(e) =>
                  setDraftMethod((e.currentTarget.value as KapiHttpMethod))
                }
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <input
                class={styles.urlInput}
                type="text"
                value={draftUrl}
                onInput={(e) => setDraftUrl(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !sending) {
                    e.preventDefault()
                    onSend()
                  }
                }}
                placeholder="https://api.example.com/resource"
              />
              <button
                class={`${styles.iconBtn} ${allowInsecureTls ? styles.iconBtnWarn : ''}`}
                onClick={async () => {
                  if (!activeCollection) return
                  const next = !activeCollection.allow_insecure_tls
                  const updated = await updateKapiCollection(activeCollection.id, {
                    allow_insecure_tls: next,
                  })
                  setCollections((prev) =>
                    prev.map((c) => (c.id === updated.id ? updated : c))
                  )
                  setActiveCollection(updated)
                }}
                disabled={!activeCollection}
                title={
                  allowInsecureTls
                    ? 'Insecure TLS is ON for this collection — self-signed certs accepted. Click to disable.'
                    : 'Strict TLS (default). Click to allow self-signed certs for this collection.'
                }
                data-testid="kapi--insecure-tls-toggle"
              >
                <ShieldOff size={14} />
              </button>
              {sending ? (
                <button
                  class={`${styles.sendBtn} ${styles.cancelBtn}`}
                  onClick={onCancel}
                  data-testid="kapi--cancel"
                >
                  Cancel
                </button>
              ) : (
                <button
                  class={styles.sendBtn}
                  onClick={onSend}
                >
                  Send →
                </button>
              )}
            </div>

            <div class={styles.tabs}>
              <div
                class={`${styles.tab} ${tab === 'headers' ? styles.active : ''}`}
                onClick={() => setTab('headers')}
              >
                Headers<span class={styles.count}>{headerCount}</span>
              </div>
              <div
                class={`${styles.tab} ${tab === 'params' ? styles.active : ''}`}
                onClick={() => setTab('params')}
              >
                Params<span class={styles.count}>{queryCount}</span>
              </div>
              <div
                class={`${styles.tab} ${tab === 'body' ? styles.active : ''}`}
                onClick={() => setTab('body')}
              >
                Body
              </div>
              <div
                class={`${styles.tab} ${tab === 'scripts' ? styles.active : ''}`}
                onClick={() => setTab('scripts')}
                data-testid="kapi--tab-scripts"
              >
                Scripts
                {(() => {
                  const n = [
                    activeRequest?.pre_script_content,
                    activeRequest?.test_script_content,
                  ].filter((c) => c && c.trim().length > 0).length
                  return n > 0 ? <span class={styles.count}>{n}</span> : null
                })()}
              </div>
              <div
                class={`${styles.tab} ${tab === 'env' ? styles.active : ''}`}
                onClick={() => setTab('env')}
                data-testid="kapi--tab-env"
                title={activeEnv ? `Active: ${activeEnv.name}` : 'No active environment'}
              >
                Env
                <span class={styles.count}>{envVars.length}</span>
              </div>
            </div>

            <div class={styles.panes}>
              <div
                class={styles.pane}
                style={`height: ${requestPaneHeight}px`}
              >
                <div class={styles.paneContent}>
                  {tab === 'headers' && (
                    <KvEditor rows={draftHeaders} setRows={setDraftHeaders} />
                  )}
                  {tab === 'params' && (
                    <KvEditor rows={draftQuery} setRows={setDraftQuery} />
                  )}
                  {tab === 'body' && (
                    <div class={styles.bodyPane}>
                      <div class={styles.bodyToolbar}>
                        <button
                          class={styles.btnSecondary}
                          onClick={() => {
                            try {
                              const parsed = JSON.parse(draftBody)
                              setDraftBody(JSON.stringify(parsed, null, 2))
                            } catch (err) {
                              setRunError(
                                err instanceof Error
                                  ? `Format JSON: ${err.message}`
                                  : 'Format JSON: invalid JSON'
                              )
                            }
                          }}
                          disabled={!draftBody.trim()}
                          title="Pretty-print JSON body"
                          data-testid="kapi--body-format"
                        >
                          Format JSON
                        </button>
                      </div>
                      <div class={styles.bodyEditorWrap}>
                        <CodeEditor
                          value={draftBody}
                          onChange={setDraftBody}
                          language={bodyLanguageFor(activeRequest?.body_language)}
                          placeholder='{"key": "value"}'
                          lineWrapping
                        />
                      </div>
                    </div>
                  )}
                  {tab === 'scripts' && (
                    <div class={styles.scriptsPane}>
                      <ScriptSection
                        kind="pre-request"
                        title="Pre-request"
                        content={activeRequest?.pre_script_content ?? ''}
                        editorHeight={preScriptHeight}
                        onSave={(content) => onSaveScript('pre-request', content)}
                      />
                      <div
                        class={styles.scriptSplitter}
                        onMouseDown={onPreScriptResize}
                        role="separator"
                        aria-orientation="horizontal"
                        title="Drag to resize"
                      />
                      <ScriptSection
                        kind="test"
                        title="Test"
                        content={activeRequest?.test_script_content ?? ''}
                        onSave={(content) => onSaveScript('test', content)}
                      />
                    </div>
                  )}
                  {tab === 'env' && (
                    <div class={styles.envPane}>
                      <div class={styles.envPaneHeader}>
                        <span>
                          {activeEnv
                            ? `${activeEnv.name} · ${envVars.length} variable${envVars.length === 1 ? '' : 's'}`
                            : 'No active environment'}
                        </span>
                        <button
                          class={styles.btnSecondary}
                          onClick={() => setEnvModalOpen(true)}
                          title="Manage environments"
                        >
                          Manage
                        </button>
                      </div>
                      {!activeEnv ? (
                        <div class={styles.varEmpty}>
                          Activate or create an environment via Manage.
                        </div>
                      ) : (
                        <EnvVariablesTable
                          vars={envVars}
                          onUpsertVar={onUpsertVar}
                          onDeleteVar={onDeleteVar}
                          onRenameVar={onRenameVar}
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div
                class={styles.paneSplitter}
                onMouseDown={onRequestPaneResize}
                role="separator"
                aria-orientation="horizontal"
                title="Drag to resize"
              />

              <div class={styles.pane}>
                {sending ? (
                  <div class={styles.respLoading}>
                    <div class={styles.respLoadingBar}>
                      <div class={styles.respLoadingBarFill} />
                    </div>
                    <div class={styles.respLoadingMeta}>
                      <span class={styles.respLoadingDot} />
                      <span>Sending…</span>
                      <span class={styles.respLoadingTimer}>
                        {(elapsedMs / 1000).toFixed(1)}s
                      </span>
                      <button
                        type="button"
                        class={styles.btnSecondary}
                        onClick={onCancel}
                        style="margin-left: auto; padding: 4px 10px; font-size: 11px"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : run || runError ? (
                  <>
                    <div class={styles.responseMeta}>
                      <div>
                        <span class={styles.responseLabel}>Status</span>
                        <span class={`${styles.statusChip} ${statusClass(run?.response_status ?? null)}`}>
                          {runError
                            ? 'Transport error'
                            : statusLabel(run?.response_status ?? null, run?.error ?? null)}
                        </span>
                      </div>
                      <div>
                        <span class={styles.responseLabel}>Time</span>
                        <b>{run?.response_time_ms ?? 0} ms</b>
                      </div>
                      <div>
                        <span class={styles.responseLabel}>Size</span>
                        <b>{run?.response_body?.length ?? 0} bytes</b>
                      </div>
                      <div class={styles.responseActions}>
                        <div
                          class={`${styles.actionMenuContainer} ${openActionMenu === 'copy' ? styles.actionMenuOpen : ''}`}
                          onMouseEnter={() => setOpenActionMenu('copy')}
                          onMouseLeave={() => setOpenActionMenu(null)}
                        >
                          <button
                            type="button"
                            class={styles.actionBtn}
                            onClick={copyResponseBody}
                            disabled={responseActionsDisabled}
                            title="Copy response body"
                            data-testid="kapi--response-copy"
                          >
                            {copied ? (
                              <>
                                <Check size={12} /> Copied
                              </>
                            ) : (
                              <>
                                <Copy size={12} /> Copy
                              </>
                            )}
                          </button>
                          <div class={styles.actionMenuOptions}>
                            <button
                              class={styles.actionOption}
                              onClick={copyAsMarkdown}
                              disabled={responseActionsDisabled}
                            >
                              <FileText size={10} /> Markdown
                            </button>
                            <button
                              class={styles.actionOption}
                              onClick={copyAsCurl}
                              disabled={!run}
                            >
                              <Terminal size={10} /> cURL
                            </button>
                            <button
                              class={styles.actionOption}
                              onClick={copyAsSlack}
                              disabled={responseActionsDisabled}
                            >
                              <MessageSquareText size={10} /> Slack
                            </button>
                          </div>
                        </div>
                        <div
                          class={`${styles.actionMenuContainer} ${openActionMenu === 'export' ? styles.actionMenuOpen : ''}`}
                          onMouseEnter={() => setOpenActionMenu('export')}
                          onMouseLeave={() => setOpenActionMenu(null)}
                        >
                          <button
                            type="button"
                            class={styles.actionBtn}
                            onClick={downloadResponse}
                            disabled={responseActionsDisabled}
                            title="Download response body"
                            data-testid="kapi--response-export"
                          >
                            <Download size={12} /> Export
                          </button>
                          <div class={styles.actionMenuOptions}>
                            <button
                              class={styles.actionOption}
                              onClick={downloadResponseAsRun}
                              disabled={!run}
                            >
                              <Download size={10} /> Full run (JSON)
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div class={styles.responseTabs}>
                      <button
                        type="button"
                        class={`${styles.responseTab} ${responseTab === 'body' ? styles.active : ''}`}
                        onClick={() => setResponseTab('body')}
                        data-testid="kapi--response-tab-body"
                      >
                        Body
                      </button>
                      <button
                        type="button"
                        class={`${styles.responseTab} ${responseTab === 'tests' ? styles.active : ''}`}
                        onClick={() => setResponseTab('tests')}
                        disabled={testTotal === 0}
                        data-testid="kapi--response-tab-tests"
                      >
                        Tests
                        {testTotal > 0 && (
                          <span
                            class={`${styles.responseTabBadge} ${
                              testFail > 0 ? styles.responseTabBadgeFail : ''
                            }`}
                          >
                            {testPass}/{testTotal}
                          </span>
                        )}
                      </button>
                    </div>
                    {responseTab === 'body' && (
                      <div class={styles.respBody}>
                        {runError ? (
                          <span class={styles.error}>{runError}</span>
                        ) : run?.error ? (
                          <span class={styles.error}>{run.error}</span>
                        ) : (
                          tryFormatJson(run?.response_body ?? '')
                        )}
                      </div>
                    )}
                    {responseTab === 'tests' && (
                      <div class={styles.respTests}>
                        {testTotal === 0 ? (
                          <div class={styles.respTestsEmpty}>
                            No tests recorded. Write assertions in the request's
                            Test script using <code>khef.expect(cond, name)</code>.
                          </div>
                        ) : (
                          <>
                            <div class={styles.respTestsSummary}>
                              {testPass}/{testTotal} passed
                              {testFail > 0 && (
                                <span class={styles.respTestsFail}>
                                  {' · '}
                                  {testFail} failed
                                </span>
                              )}
                            </div>
                            <ul class={styles.testList}>
                              {run!.test_results!.map((t, i) => (
                                <li
                                  key={i}
                                  class={t.pass ? styles.testPass : styles.testFail}
                                >
                                  <span class={styles.testIcon}>
                                    {t.pass ? '✓' : '✗'}
                                  </span>
                                  <span>{t.name}</span>
                                  {t.error && (
                                    <span class={styles.testError}> — {t.error}</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                    {inspectCount > 0 && (
                      <div class={styles.inspectDrawer}>
                        <button
                          type="button"
                          class={styles.inspectToggle}
                          onClick={() => setInspectOpen((o) => !o)}
                          data-testid="kapi--inspect-toggle"
                        >
                          {inspectOpen ? (
                            <ChevronDown size={12} />
                          ) : (
                            <ChevronUp size={12} />
                          )}
                          <span>Inspect</span>
                          <span class={styles.inspectCount}>({inspectCount})</span>
                          {hasScriptError && !inspectOpen && (
                            <span class={styles.inspectErrorDot} title="Script error">
                              !
                            </span>
                          )}
                        </button>
                        {inspectOpen && (
                          <div class={styles.inspectContent}>
                            {run?.pre_script_error && (
                              <div class={`${styles.scriptOutput} ${styles.scriptError}`}>
                                <div class={styles.scriptOutputLabel}>Pre-script error</div>
                                <pre class={styles.scriptLog}>{run.pre_script_error}</pre>
                              </div>
                            )}
                            {run?.test_script_error && (
                              <div class={`${styles.scriptOutput} ${styles.scriptError}`}>
                                <div class={styles.scriptOutputLabel}>Test-script error</div>
                                <pre class={styles.scriptLog}>{run.test_script_error}</pre>
                              </div>
                            )}
                            {run?.pre_script_env_writes &&
                              Object.keys(run.pre_script_env_writes).length > 0 && (
                                <EnvWritesBlock
                                  label="Pre-script env writes"
                                  writes={run.pre_script_env_writes}
                                />
                              )}
                            {run?.test_script_env_writes &&
                              Object.keys(run.test_script_env_writes).length > 0 && (
                                <EnvWritesBlock
                                  label="Test-script env writes"
                                  writes={run.test_script_env_writes}
                                />
                              )}
                            {run?.pre_script_log && (
                              <div class={styles.scriptOutput}>
                                <div class={styles.scriptOutputLabel}>Pre-script log</div>
                                <pre class={styles.scriptLog}>{run.pre_script_log}</pre>
                              </div>
                            )}
                            {run?.test_script_log && (
                              <div class={styles.scriptOutput}>
                                <div class={styles.scriptOutputLabel}>Test-script log</div>
                                <pre class={styles.scriptLog}>{run.test_script_log}</pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div class={styles.emptyState}>
                    <div>Press <b>Send</b> to execute this request.</div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      {createModal && (
        <CreateModal
          state={createModal}
          onCancel={() => setCreateModal(null)}
          onSubmit={onCreate}
        />
      )}

      {envModalOpen && (
        <EnvModal
          environments={environments}
          activeEnv={activeEnv}
          vars={envVars}
          onClose={() => setEnvModalOpen(false)}
          onSelectEnv={onSelectEnv}
          onCreateEnv={onCreateEnv}
          onDeleteEnv={onDeleteEnv}
          onUpsertVar={onUpsertVar}
          onDeleteVar={onDeleteVar}
          onRenameVar={onRenameVar}
        />
      )}

      {collectionsModalOpen && (
        <CollectionsModal
          collections={collections}
          activeCollection={activeCollection}
          onClose={() => setCollectionsModalOpen(false)}
          onSelect={onSelectCollection}
          onCreate={onCreateCollection}
          onUpdate={onUpdateCollection}
          onDelete={onDeleteCollection}
        />
      )}

      {contextMenu && (
        <div
          ref={menuRef}
          class={styles.contextMenu}
          style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            class={styles.contextItem}
            onClick={() => {
              const menu = contextMenu
              setContextMenu(null)
              onEdit(menu)
            }}
          >
            Edit
          </button>
          <button
            class={`${styles.contextItem} ${styles.contextItemDanger}`}
            onClick={async () => {
              const menu = contextMenu
              setContextMenu(null)
              try {
                await onDelete(menu)
              } catch (err: unknown) {
                setLoadError(err instanceof Error ? err.message : String(err))
              }
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

// -------------------- subcomponents --------------------

/** Compact display of what a script wrote to the active environment.
 *  Shows the key and a preview of the value (empty values rendered as
 *  "<empty>" so "I wrote '' to token" is visible at a glance). */
function EnvWritesBlock({
  label,
  writes,
}: {
  label: string
  writes: Record<string, string>
}) {
  const entries = Object.entries(writes)
  const format = (v: string) => {
    if (v === '') return <em class={styles.envWriteEmpty}>&lt;empty&gt;</em>
    if (v.length > 64) return <span>{v.slice(0, 64)}… <span class={styles.envWriteLen}>({v.length} chars)</span></span>
    return <span>{v}</span>
  }
  return (
    <div class={styles.scriptOutput}>
      <div class={styles.scriptOutputLabel}>
        {label} ({entries.length})
      </div>
      <table class={styles.envWritesTable}>
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td class={styles.envWriteKey}>{k}</td>
              <td class={styles.envWriteValue}>{format(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface ComboOption {
  value: string
  label: string
}

interface ComboSelectProps {
  value: string | null
  options: ComboOption[]
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  testId?: string
}

/** Custom select-like control. Replaces native <select> so the active-item
 *  checkmark can be sized and aligned consistently with the rest of the UI. */
function ComboSelect({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  disabled,
  className,
  testId,
}: ComboSelectProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const active = options.find((o) => o.value === value) ?? null

  useEffect(() => {
    if (!open) return
    const handleDown = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  return (
    <div
      class={`${styles.combo} ${className ?? ''}`}
      ref={wrapRef}
      data-testid={testId}
    >
      <button
        type="button"
        class={styles.comboButton}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span class={styles.comboLabel}>{active?.label ?? placeholder}</span>
        <ChevronDown size={12} class={styles.comboCaret} />
      </button>
      {open && options.length > 0 && (
        <ul class={styles.comboMenu} role="listbox">
          {options.map((opt) => {
            const isActive = opt.value === value
            return (
              <li
                key={opt.value}
                class={`${styles.comboItem} ${isActive ? styles.comboItemActive : ''}`}
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
              >
                <span class={styles.comboCheck}>
                  {isActive && <Check size={12} />}
                </span>
                <span>{opt.label}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

interface KvEditorProps {
  rows: KapiKeyValue[]
  setRows: (next: KapiKeyValue[]) => void
}

function KvEditor({ rows, setRows }: KvEditorProps) {
  const padded = rows.length === 0
    ? [{ key: '', value: '', enabled: true }]
    : rows
  const displayed =
    padded.length === 0 || padded[padded.length - 1].key !== '' || padded[padded.length - 1].value !== ''
      ? [...padded, { key: '', value: '', enabled: true }]
      : padded

  const update = (idx: number, patch: Partial<KapiKeyValue>) => {
    const next = displayed.map((r, i) => (i === idx ? { ...r, ...patch } : r))
    setRows(next.filter((r, i) => i < next.length - 1 || r.key || r.value))
  }

  return (
    <table class={styles.kvTable}>
      <thead>
        <tr>
          <th style="width: 28px"></th>
          <th>Key</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {displayed.map((row, idx) => (
          <tr key={idx}>
            <td>
              <input
                type="checkbox"
                checked={row.enabled}
                onChange={(e) => update(idx, { enabled: e.currentTarget.checked })}
              />
            </td>
            <td>
              <input
                type="text"
                value={row.key}
                placeholder="key"
                onInput={(e) => update(idx, { key: e.currentTarget.value })}
              />
            </td>
            <td>
              <input
                type="text"
                value={row.value}
                placeholder="value"
                onInput={(e) => update(idx, { value: e.currentTarget.value })}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface CreateModalProps {
  state: CreateModalState
  onCancel: () => void
  onSubmit: (input: Record<string, string>) => Promise<void>
}

interface ModalField {
  key: string
  label: string
  required?: boolean
  placeholder?: string
  type?: 'text' | 'select'
  options?: string[]
  default?: string
}

function CreateModal({ state, onCancel, onSubmit }: CreateModalProps) {
  const fields: ModalField[] =
    state.kind === 'definition'
      ? [
          { key: 'handle', label: 'Handle (kebab-case)', required: true },
          { key: 'name', label: 'Name', required: true },
          { key: 'base_url', label: 'Base URL (optional)' },
        ]
      : [
          { key: 'name', label: 'Name', required: true },
          {
            key: 'method',
            label: 'Method',
            type: 'select',
            options: METHODS,
            default: 'GET',
          },
          { key: 'path', label: 'Path (optional)' },
        ]

  const isEditing = !!state.editing
  const [values, setValues] = useState<Record<string, string>>(() => {
    if (state.editing?.initial) return { ...state.editing.initial }
    const init: Record<string, string> = {}
    for (const f of fields) if (f.default) init[f.key] = f.default
    return init
  })

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onCancel])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    setError(null)
    for (const f of fields) {
      if (f.required && !values[f.key]?.trim()) {
        setError(`${f.label} is required`)
        return
      }
    }
    setSubmitting(true)
    try {
      await onSubmit(values)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <div class={styles.modalBackdrop} onClick={onCancel}>
      <form
        class={styles.modal}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h3>
          {isEditing
            ? state.kind === 'definition'
              ? 'Edit definition'
              : 'Edit request'
            : state.kind === 'definition'
            ? 'New definition'
            : 'New request'}
        </h3>
        {fields.map((f, idx) => (
          <div class={styles.field} key={f.key}>
            <label>{f.label}</label>
            {f.type === 'select' ? (
              <select
                value={values[f.key] ?? f.default ?? ''}
                onChange={(e) =>
                  setValues({ ...values, [f.key]: e.currentTarget.value })
                }
              >
                {f.options?.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={values[f.key] ?? ''}
                onInput={(e) =>
                  setValues({ ...values, [f.key]: e.currentTarget.value })
                }
                placeholder={f.placeholder ?? ''}
                autoFocus={idx === 0}
              />
            )}
          </div>
        ))}
        {error && <div class={styles.modalError}>{error}</div>}
        <div class={styles.modalActions}>
          <button
            type="button"
            class={styles.btnSecondary}
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button type="submit" class={styles.btnPrimary} disabled={submitting}>
            {submitting
              ? isEditing
                ? 'Saving…'
                : 'Creating…'
              : isEditing
              ? 'Save'
              : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}

// -------------------- CollectionsModal --------------------

interface CollectionsModalProps {
  collections: KapiCollection[]
  activeCollection: KapiCollection | null
  onClose: () => void
  onSelect: (id: string) => void
  onCreate: (input: { handle: string; name: string; description: string }) => Promise<void>
  onUpdate: (
    id: string,
    input: { handle?: string; name?: string; description?: string | null }
  ) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

function CollectionsModal({
  collections,
  activeCollection,
  onClose,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
}: CollectionsModalProps) {
  const [draft, setDraft] = useState({ handle: '', name: '', description: '' })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const submit = async (e: Event) => {
    e.preventDefault()
    setError(null)
    if (!draft.handle.trim() || !draft.name.trim()) {
      setError('Handle and name are required')
      return
    }
    try {
      await onCreate({
        handle: draft.handle.trim(),
        name: draft.name.trim(),
        description: draft.description.trim(),
      })
      setDraft({ handle: '', name: '', description: '' })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div class={styles.modalBackdrop} onClick={onClose}>
      <div
        class={styles.envModal}
        onClick={(e) => e.stopPropagation()}
        data-testid="kapi--collections-modal"
      >
        <div class={styles.envModalHeader}>
          <h3>Collections</h3>
          <button class={styles.envModalClose} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div class={styles.envModalSection}>
          <div class={styles.envModalSectionHeader}>
            <span>Existing ({collections.length})</span>
          </div>
          {collections.length === 0 ? (
            <div class={styles.varEmpty}>No collections yet.</div>
          ) : (
            <div class={styles.envList}>
              {collections.map((c) => (
                <CollectionRow
                  key={c.id}
                  collection={c}
                  active={activeCollection?.id === c.id}
                  onSelect={() => onSelect(c.id)}
                  onUpdate={(patch) => onUpdate(c.id, patch)}
                  onDelete={() => onDelete(c.id)}
                />
              ))}
            </div>
          )}

          <form onSubmit={submit} style="display: grid; grid-template-columns: 1fr 1fr 2fr auto; gap: 6px; margin-top: 8px">
            <input
              type="text"
              value={draft.handle}
              placeholder="handle (kebab-case)"
              onInput={(e) => setDraft({ ...draft, handle: e.currentTarget.value })}
              style="background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 5px 8px; border-radius: 5px; font-size: 12px"
            />
            <input
              type="text"
              value={draft.name}
              placeholder="Display name"
              onInput={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
              style="background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 5px 8px; border-radius: 5px; font-size: 12px"
            />
            <input
              type="text"
              value={draft.description}
              placeholder="Description (optional)"
              onInput={(e) => setDraft({ ...draft, description: e.currentTarget.value })}
              style="background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 5px 8px; border-radius: 5px; font-size: 12px"
            />
            <button type="submit" class={styles.btnPrimary}>
              Create
            </button>
          </form>
          {error && <div class={styles.modalError}>{error}</div>}
        </div>
      </div>
    </div>
  )
}

function CollectionRow({
  collection,
  active,
  onSelect,
  onUpdate,
  onDelete,
}: {
  collection: KapiCollection
  active: boolean
  onSelect: () => void
  onUpdate: (patch: { name?: string; handle?: string }) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(collection.name)

  useEffect(() => {
    if (!editing) setDraftName(collection.name)
  }, [collection.name, editing])

  const save = async () => {
    if (draftName.trim() === collection.name) {
      setEditing(false)
      return
    }
    try {
      await onUpdate({ name: draftName.trim() })
    } finally {
      setEditing(false)
    }
  }

  return (
    <div
      class={`${styles.envListItem} ${active ? styles.envListItemActive : ''}`}
    >
      {editing ? (
        <input
          type="text"
          value={draftName}
          onInput={(e) => setDraftName(e.currentTarget.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.currentTarget as HTMLInputElement).blur()
            } else if (e.key === 'Escape') {
              setDraftName(collection.name)
              setEditing(false)
              ;(e.currentTarget as HTMLInputElement).blur()
            }
          }}
          autoFocus
          style="flex: 1; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 3px 6px; border-radius: 4px; font-size: 12px"
        />
      ) : (
        <span
          class={styles.envListItemName}
          onDblClick={() => setEditing(true)}
          title="Double-click to rename"
        >
          {collection.name}
        </span>
      )}
      <span class={styles.envListItemHandle}>{collection.handle}</span>
      {active ? (
        <span class={styles.envListItemBadge}>Active</span>
      ) : (
        <button
          class={styles.btnSecondary}
          style="padding: 2px 8px; font-size: 11px"
          onClick={onSelect}
        >
          Switch
        </button>
      )}
      <button
        class={styles.varDeleteBtn}
        title="Delete collection"
        onClick={onDelete}
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

// -------------------- EnvModal --------------------

interface EnvModalProps {
  environments: KapiEnvironment[]
  activeEnv: KapiEnvironment | null
  vars: KapiEnvVar[]
  onClose: () => void
  onSelectEnv: (id: string) => Promise<void>
  onCreateEnv: (input: {
    handle: string
    name: string
    activate: boolean
    copyFromActive: boolean
  }) => Promise<void>
  onDeleteEnv: (id: string) => Promise<void>
  onUpsertVar: (input: {
    key: string
    value: string
    is_secret: boolean
  }) => Promise<void>
  onDeleteVar: (key: string) => Promise<void>
  onRenameVar: (oldKey: string, newKey: string) => Promise<void>
}

function EnvModal({
  environments,
  activeEnv,
  vars,
  onClose,
  onSelectEnv,
  onCreateEnv,
  onDeleteEnv,
  onUpsertVar,
  onDeleteVar,
  onRenameVar,
}: EnvModalProps) {
  const [newEnv, setNewEnv] = useState({ handle: '', name: '' })
  const [newEnvError, setNewEnvError] = useState<string | null>(null)
  const [copyFromActive, setCopyFromActive] = useState(true)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const submitNewEnv = async (e: Event) => {
    e.preventDefault()
    setNewEnvError(null)
    if (!newEnv.handle.trim() || !newEnv.name.trim()) {
      setNewEnvError('Handle and name are required')
      return
    }
    try {
      await onCreateEnv({
        handle: newEnv.handle.trim(),
        name: newEnv.name.trim(),
        activate: environments.length === 0,
        copyFromActive: copyFromActive && !!activeEnv,
      })
      setNewEnv({ handle: '', name: '' })
    } catch (err: unknown) {
      setNewEnvError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div class={styles.modalBackdrop} onClick={onClose}>
      <div
        class={styles.envModal}
        onClick={(e) => e.stopPropagation()}
        data-testid="kapi--env-modal"
      >
        <div class={styles.envModalHeader}>
          <h3>Environments & variables</h3>
          <button
            class={styles.envModalClose}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div class={styles.envModalSection}>
          <div class={styles.envModalSectionHeader}>
            <span>Environments ({environments.length})</span>
          </div>
          {environments.length === 0 ? (
            <div class={styles.varEmpty}>No environments yet.</div>
          ) : (
            <div class={styles.envList}>
              {environments.map((env) => (
                <div
                  key={env.id}
                  class={`${styles.envListItem} ${
                    env.is_active ? styles.envListItemActive : ''
                  }`}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (!env.is_active) onSelectEnv(env.id)
                  }}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && !env.is_active) {
                      e.preventDefault()
                      onSelectEnv(env.id)
                    }
                  }}
                  title={env.is_active ? 'Active environment' : 'Click to activate'}
                  style={env.is_active ? '' : 'cursor: pointer'}
                >
                  <span class={styles.envListItemName}>{env.name}</span>
                  <span class={styles.envListItemHandle}>{env.handle}</span>
                  {env.is_active && (
                    <span class={styles.envListItemBadge}>Active</span>
                  )}
                  <button
                    class={styles.varDeleteBtn}
                    title="Delete environment"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteEnv(env.id)
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <form
            onSubmit={submitNewEnv}
            style="display: flex; flex-direction: column; gap: 6px; margin-top: 4px"
          >
            <div style="display: flex; gap: 6px">
              <input
                type="text"
                value={newEnv.handle}
                placeholder="handle (kebab-case)"
                onInput={(e) =>
                  setNewEnv({ ...newEnv, handle: e.currentTarget.value })
                }
                style="flex: 1; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 5px 8px; border-radius: 5px; font-size: 12px"
              />
              <input
                type="text"
                value={newEnv.name}
                placeholder="Display name"
                onInput={(e) =>
                  setNewEnv({ ...newEnv, name: e.currentTarget.value })
                }
                style="flex: 1; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 5px 8px; border-radius: 5px; font-size: 12px"
              />
              <button type="submit" class={styles.btnPrimary}>
                Add environment
              </button>
            </div>
            {activeEnv && (
              <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); user-select: none">
                <input
                  type="checkbox"
                  checked={copyFromActive}
                  onChange={(e) =>
                    setCopyFromActive(e.currentTarget.checked)
                  }
                  data-testid="kapi--env-copy-vars"
                />
                Copy variables from <b>{activeEnv.name}</b>
              </label>
            )}
          </form>
          {newEnvError && <div class={styles.modalError}>{newEnvError}</div>}
        </div>

        <div class={styles.envModalSection} style="min-height: 0; flex: 1">
          <div class={styles.envModalSectionHeader}>
            <span>
              Variables{activeEnv ? ` · ${activeEnv.name}` : ''} ({vars.length})
            </span>
          </div>
          {!activeEnv ? (
            <div class={styles.varEmpty}>
              Activate an environment above to edit its variables.
            </div>
          ) : (
            <EnvVariablesTable
              vars={vars}
              onUpsertVar={onUpsertVar}
              onDeleteVar={onDeleteVar}
              onRenameVar={onRenameVar}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// -------------------- EnvVariablesTable --------------------

/** Shared variables table + add-row form used by EnvModal and the Env tab. */
function EnvVariablesTable({
  vars,
  onUpsertVar,
  onDeleteVar,
  onRenameVar,
}: {
  vars: KapiEnvVar[]
  onUpsertVar: (input: {
    key: string
    value: string
    is_secret: boolean
  }) => Promise<void>
  onDeleteVar: (key: string) => Promise<void>
  onRenameVar: (oldKey: string, newKey: string) => Promise<void>
}) {
  const [newVar, setNewVar] = useState<{
    key: string
    value: string
    is_secret: boolean
  }>({ key: '', value: '', is_secret: false })
  const [varError, setVarError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const filteredVars = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return vars
    // Match against key always, and value for non-secrets (secrets show as
    // ***redacted*** in the UI, so matching their value text wouldn't work
    // and leaking the plaintext into a client-side filter is a non-goal).
    return vars.filter((v) => {
      if (v.key.toLowerCase().includes(q)) return true
      if (!v.is_secret && (v.value ?? '').toLowerCase().includes(q)) return true
      return false
    })
  }, [vars, filter])

  const submitNewVar = async (e: Event) => {
    e.preventDefault()
    setVarError(null)
    if (!newVar.key.trim()) {
      setVarError('Key is required')
      return
    }
    try {
      await onUpsertVar({
        key: newVar.key.trim(),
        value: newVar.value,
        is_secret: newVar.is_secret,
      })
      setNewVar({ key: '', value: '', is_secret: false })
    } catch (err: unknown) {
      setVarError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <form
        onSubmit={submitNewVar}
        style="display: grid; grid-template-columns: 30% 1fr 70px auto; gap: 6px; margin-bottom: 6px; align-items: center; flex-shrink: 0"
      >
        <input
          type="text"
          value={newVar.key}
          placeholder="new key"
          onInput={(e) =>
            setNewVar({ ...newVar, key: e.currentTarget.value })
          }
          style="background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 5px 8px; border-radius: 5px; font-size: 12px; font-family: var(--font-mono, ui-monospace, monospace)"
        />
        <input
          type={newVar.is_secret ? 'password' : 'text'}
          value={newVar.value}
          placeholder="value"
          onInput={(e) =>
            setNewVar({ ...newVar, value: e.currentTarget.value })
          }
          style="background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 5px 8px; border-radius: 5px; font-size: 12px; font-family: var(--font-mono, ui-monospace, monospace)"
        />
        <label
          style="display: flex; align-items: center; justify-content: center; gap: 4px; font-size: 11px; color: var(--muted)"
        >
          <input
            type="checkbox"
            checked={newVar.is_secret}
            onChange={(e) =>
              setNewVar({
                ...newVar,
                is_secret: e.currentTarget.checked,
              })
            }
          />
          🔒
        </label>
        <button type="submit" class={styles.btnPrimary}>
          Add
        </button>
      </form>
      {varError && <div class={styles.modalError}>{varError}</div>}
      {vars.length > 0 && (
        <div class={styles.varFilterRow}>
          <Search size={12} class={styles.varFilterIcon} />
          <input
            type="text"
            class={styles.varFilterInput}
            value={filter}
            placeholder="Filter variables…"
            onInput={(e) => setFilter(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setFilter('')
                ;(e.currentTarget as HTMLInputElement).blur()
              }
            }}
          />
          {filter && (
            <button
              type="button"
              class={styles.varFilterClear}
              onClick={() => setFilter('')}
              aria-label="Clear filter"
              title="Clear filter"
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}
      <div class={styles.varScroll}>
        <table class={styles.varTable}>
          <thead>
            <tr>
              <th style="width: 30%">Key</th>
              <th>Value</th>
              <th style="width: 70px; text-align: center">Secret</th>
              <th style="width: 36px"></th>
            </tr>
          </thead>
          <tbody>
            {vars.length === 0 && (
              <tr>
                <td colSpan={4} class={styles.varEmpty}>
                  No variables yet — add one above.
                </td>
              </tr>
            )}
            {vars.length > 0 && filteredVars.length === 0 && (
              <tr>
                <td colSpan={4} class={styles.varEmpty}>
                  No variables match "{filter}".
                </td>
              </tr>
            )}
            {filteredVars.map((v) => (
              <VarRow
                key={v.id}
                varItem={v}
                onUpsert={onUpsertVar}
                onDelete={() => onDeleteVar(v.key)}
                onRename={onRenameVar}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// -------------------- VarRow --------------------

function VarRow({
  varItem,
  onUpsert,
  onDelete,
  onRename,
}: {
  varItem: KapiEnvVar
  onUpsert: (input: {
    key: string
    value: string
    is_secret: boolean
  }) => Promise<void>
  onDelete: () => Promise<void>
  onRename: (oldKey: string, newKey: string) => Promise<void>
}) {
  // Always drive the inputs from local draft state. The earlier
  // value={editing ? draft : varItem.value} shape left the input read-only
  // on first render — onFocus and the first onInput would race, and any
  // keystroke that arrived before React committed editing=true was
  // dropped. Single source of truth + useEffect re-seed on prop change
  // is simpler and more robust.
  const [keyDraft, setKeyDraft] = useState(varItem.key)
  const [valueDraft, setValueDraft] = useState(varItem.value ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setKeyDraft(varItem.key)
  }, [varItem.key])

  useEffect(() => {
    setValueDraft(varItem.value ?? '')
  }, [varItem.value])

  const saveValue = async () => {
    if (saving) return
    if (valueDraft === (varItem.value ?? '')) return
    setSaving(true)
    try {
      await onUpsert({
        key: varItem.key,
        value: valueDraft,
        is_secret: varItem.is_secret,
      })
    } finally {
      setSaving(false)
    }
  }

  const saveKey = async () => {
    if (saving) return
    const trimmed = keyDraft.trim()
    if (!trimmed || trimmed === varItem.key) {
      setKeyDraft(varItem.key)
      return
    }
    setSaving(true)
    try {
      await onRename(varItem.key, trimmed)
    } catch (err: unknown) {
      setKeyDraft(varItem.key)
      window.alert(
        err instanceof Error ? err.message : `Could not rename "${varItem.key}"`
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr>
      <td>
        <input
          type="text"
          value={keyDraft}
          onInput={(e) => setKeyDraft(e.currentTarget.value)}
          onBlur={saveKey}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.currentTarget as HTMLInputElement).blur()
            } else if (e.key === 'Escape') {
              setKeyDraft(varItem.key)
              ;(e.currentTarget as HTMLInputElement).blur()
            }
          }}
        />
      </td>
      <td>
        {varItem.is_secret ? (
          <span class={styles.varSecret}>***redacted***</span>
        ) : (
          <input
            type="text"
            value={valueDraft}
            onInput={(e) => setValueDraft(e.currentTarget.value)}
            onBlur={saveValue}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.currentTarget as HTMLInputElement).blur()
              } else if (e.key === 'Escape') {
                setValueDraft(varItem.value ?? '')
                ;(e.currentTarget as HTMLInputElement).blur()
              }
            }}
          />
        )}
      </td>
      <td style="text-align: center">
        <input type="checkbox" checked={varItem.is_secret} disabled />
      </td>
      <td>
        <button
          class={styles.varDeleteBtn}
          onClick={onDelete}
          title="Delete variable"
        >
          <Trash2 size={13} />
        </button>
      </td>
    </tr>
  )
}

// -------------------- ScriptSection --------------------

interface ScriptSectionProps {
  kind: 'pre-request' | 'test'
  title: string
  /** Stored script content on the active request (pre_script_content /
   *  test_script_content). Empty string when no script is set. */
  content: string
  /** Fixed height in px when set; otherwise the section flexes to fill. */
  editorHeight?: number
  onSave: (content: string) => Promise<void>
}

/** Always-visible editor for the request's pre or test script. Save is
 *  enabled when the draft differs from what's stored on the request row. */
function ScriptSection({
  kind,
  title,
  content,
  editorHeight,
  onSave,
}: ScriptSectionProps) {
  const [draft, setDraft] = useState(content)
  const [saving, setSaving] = useState(false)

  // Re-seed draft when the active request's stored content changes (swap to
  // another request, or after a successful save).
  useEffect(() => {
    setDraft(content)
  }, [content])

  const dirty = draft !== content

  const save = async () => {
    if (!dirty) return
    setSaving(true)
    try {
      await onSave(draft)
    } finally {
      setSaving(false)
    }
  }

  const sectionStyle =
    editorHeight !== undefined ? `height: ${editorHeight}px; flex: 0 0 auto` : ''

  return (
    <div class={styles.scriptSection} style={sectionStyle}>
      <div class={styles.scriptSectionHeader}>
        <span class={styles.scriptSectionTitle}>{title}</span>
        <div class={styles.scriptActions}>
          <button
            class={styles.btnPrimary}
            onClick={save}
            disabled={saving || !dirty}
            data-testid={`kapi--script-save-${kind}`}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <div class={styles.scriptEditorWrap} style="flex: 1; min-height: 0">
        <CodeEditor
          value={draft}
          onChange={setDraft}
          language="javascript"
          placeholder={
            kind === 'pre-request'
              ? '// Pre-request: mutate khef.request before send\n// e.g. khef.request.headers["X-Trace-Id"] = khef.env.get("trace_prefix") + Date.now()'
              : '// Test: assert against khef.response\n// e.g. khef.expect(khef.response.status === 200, "ok")'
          }
          onSave={save}
          lineWrapping
        />
      </div>
    </div>
  )
}
