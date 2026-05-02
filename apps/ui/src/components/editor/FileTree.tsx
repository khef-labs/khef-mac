import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import { File, FileCode, FileText, Folder, FolderOpen, ChevronRight, FilePlus, FolderPlus, Trash2, Copy, Undo2 } from 'lucide-preact'
import clsx from 'clsx'
import { fsTree, fsNew, fsDelete } from '../../lib/api'
import { formatBytes } from '../../lib/format'
import type { FsEntry } from '../../types/api'
import styles from './FileTree.module.css'

interface FileTreeProps {
  rootPath: string
  onFileSelect: (path: string) => void
  onDirectorySelect?: (path: string) => void
  onFileCreated?: (path: string) => void
  onFileDeleted?: (path: string) => void
  selectedPath?: string
  selectedDirectoryPath?: string
  modifiedPaths?: Set<string>
  createRootRequest?: { type: 'file' | 'directory'; parentPath: string; nonce: number } | null
  revealPath?: string | null
  showHidden?: boolean
  onRevertFile?: (path: string) => void
  // Bump to ask the tree to re-list its root (used after external file creates).
  refreshNonce?: number
}

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const codeExts = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go',
    'java', 'rb', 'php', 'c', 'cpp', 'h', 'swift', 'kt',
    'css', 'scss', 'html', 'vue', 'svelte', 'sql',
  ])
  const textExts = new Set(['md', 'mdx', 'txt', 'yaml', 'yml', 'toml', 'json', 'xml', 'csv'])

  if (codeExts.has(ext)) return <FileCode size={15} class={styles.icon} />
  if (textExts.has(ext)) return <FileText size={15} class={styles.icon} />
  return <File size={15} class={styles.icon} />
}

interface ContextMenuState {
  x: number
  y: number
  entry: FsEntry | null
  isRoot?: boolean
}

interface InlineInputState {
  parentPath: string
  type: 'file' | 'directory'
}

interface TreeNodeProps {
  entry: FsEntry
  depth: number
  selectedPath?: string
  selectedDirectoryPath?: string
  modifiedPaths?: Set<string>
  onFileSelect: (path: string) => void
  onDirectorySelect?: (path: string) => void
  onContextMenu: (e: MouseEvent, entry: FsEntry) => void
  inlineInput: InlineInputState | null
  renderInlineInput: (depth: number) => preact.JSX.Element | null
  refreshDirRequest: { path: string; nonce: number } | null
  revealPath?: string | null
  showHidden?: boolean
}

function TreeNode({ entry, depth, selectedPath, selectedDirectoryPath, modifiedPaths, onFileSelect, onContextMenu, inlineInput, renderInlineInput, refreshDirRequest, onDirectorySelect, revealPath, showHidden }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FsEntry[] | null>(entry.children || null)
  const nodeRef = useRef<HTMLDivElement>(null)

  const MAX_EDITOR_FILE_SIZE = 2 * 1024 * 1024 // 2MB — matches API MAX_FILE_SIZE
  const isDir = entry.type === 'directory'
  const isTooLarge = !isDir && entry.size != null && entry.size > MAX_EDITOR_FILE_SIZE
  const isSelected = selectedPath === entry.path || (isDir && selectedDirectoryPath === entry.path)
  const isModified = modifiedPaths?.has(entry.path)
  const isInlineTarget = isDir && inlineInput?.parentPath === entry.path

  // Auto-expand directories along the reveal path
  const isRevealAncestor = isDir && revealPath ? revealPath.startsWith(entry.path + '/') : false
  const isRevealTarget = revealPath === entry.path

  useEffect(() => {
    if (!isRevealAncestor) return
    if (expanded) return
    if (children === null) {
      fsTree(entry.path, 1, showHidden)
        .then((result) => setChildren(result.entries))
        .catch(() => setChildren([]))
    }
    setExpanded(true)
  }, [isRevealAncestor, revealPath])

  // Scroll into view when this node is the reveal target
  useEffect(() => {
    if (!isRevealTarget || !nodeRef.current) return
    requestAnimationFrame(() => {
      nodeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [isRevealTarget, revealPath])

  const handleClick = useCallback(async () => {
    if (isTooLarge) return
    if (isDir) {
      onDirectorySelect?.(entry.path)
      if (!expanded && children === null) {
        try {
          const result = await fsTree(entry.path, 1, showHidden)
          setChildren(result.entries)
        } catch {
          setChildren([])
        }
      }
      setExpanded(!expanded)
    } else {
      onFileSelect(entry.path)
    }
  }, [isDir, isTooLarge, expanded, children, entry.path, onFileSelect, onDirectorySelect])

  const handleContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onContextMenu(e, entry)
  }, [entry, onContextMenu])

  useEffect(() => {
    if (entry.children) {
      setChildren(entry.children)
    }
  }, [entry.children])

  // Auto-expand when this directory is the inline input target
  useEffect(() => {
    if (!isInlineTarget) return
    if (!expanded) {
      if (children === null) {
        fsTree(entry.path, 1, showHidden)
          .then((result) => setChildren(result.entries))
          .catch(() => setChildren([]))
      }
      setExpanded(true)
    }
  }, [isInlineTarget])

  // Refresh a specific expanded directory after create/delete operations.
  useEffect(() => {
    if (!isDir) return
    if (!refreshDirRequest) return
    if (refreshDirRequest.path !== entry.path) return

    fsTree(entry.path, 1, showHidden)
      .then((result) => setChildren(result.entries))
      .catch(() => setChildren([]))
  }, [isDir, entry.path, refreshDirRequest?.nonce])

  return (
    <>
      <div
        ref={nodeRef}
        class={clsx(
          styles.item,
          isSelected && styles.itemSelected,
          isModified && styles.itemModified,
          isTooLarge && styles.itemDisabled,
        )}
        style={{ '--depth': depth } as any}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={isTooLarge ? `File too large to open (${formatBytes(entry.size!)})` : entry.path}
      >
        {isDir ? (
          <>
            <span class={clsx(styles.chevron, expanded && styles.chevronOpen)}>
              <ChevronRight size={14} />
            </span>
            {expanded ? (
              <FolderOpen size={15} class={clsx(styles.icon, styles.iconDir)} />
            ) : (
              <Folder size={15} class={clsx(styles.icon, styles.iconDir)} />
            )}
          </>
        ) : (
          <>
            <span class={styles.chevron} />
            <FileIcon name={entry.name} />
          </>
        )}
        <span class={styles.name}>{entry.name}</span>
      </div>
      {isDir && expanded && children && children.map((child) => (
        <TreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          selectedDirectoryPath={selectedDirectoryPath}
          modifiedPaths={modifiedPaths}
          onFileSelect={onFileSelect}
          onContextMenu={onContextMenu}
          inlineInput={inlineInput}
          renderInlineInput={renderInlineInput}
          refreshDirRequest={refreshDirRequest}
          onDirectorySelect={onDirectorySelect}
          revealPath={revealPath}
          showHidden={showHidden}
        />
      ))}
      {isInlineTarget && renderInlineInput(depth + 1)}
    </>
  )
}

export function FileTree({ rootPath, onFileSelect, onDirectorySelect, onFileCreated, onFileDeleted, selectedPath, selectedDirectoryPath, modifiedPaths, createRootRequest, revealPath, showHidden, onRevertFile, refreshNonce }: FileTreeProps) {
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [inlineInput, setInlineInput] = useState<InlineInputState | null>(null)
  const [inlineValue, setInlineValue] = useState('')
  const [inlineError, setInlineError] = useState<string | null>(null)
  const [pendingDeleteEntry, setPendingDeleteEntry] = useState<FsEntry | null>(null)
  const [refreshDirRequest, setRefreshDirRequest] = useState<{ path: string; nonce: number } | null>(null)
  const submittingRef = useRef(false)
  const refreshNonceRef = useRef(0)
  const treeRef = useRef<HTMLDivElement>(null)
  const inlineFieldRef = useRef<HTMLInputElement>(null)
  const deleteModalRef = useRef<HTMLDivElement>(null)

  const refreshRoot = useCallback(() => {
    if (!rootPath) return
    fsTree(rootPath, 1, showHidden)
      .then((result) => setEntries(result.entries))
      .catch(() => {})
  }, [rootPath, showHidden])

  const requestDirRefresh = useCallback((path: string) => {
    refreshNonceRef.current += 1
    setRefreshDirRequest({ path, nonce: refreshNonceRef.current })
  }, [])

  useEffect(() => {
    if (!rootPath) return
    setLoading(true)
    setError(null)
    fsTree(rootPath, 1, showHidden)
      .then((result) => {
        setEntries(result.entries)
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message || 'Failed to load directory')
        setEntries([])
        setLoading(false)
      })
  }, [rootPath, showHidden])

  useEffect(() => {
    if (!createRootRequest || !rootPath) return
    setContextMenu(null)
    setInlineInput({ parentPath: createRootRequest.parentPath, type: createRootRequest.type })
    setInlineValue('')
    setInlineError(null)
  }, [createRootRequest?.nonce, rootPath])

  // External refresh trigger — re-list the root when the parent bumps the nonce.
  useEffect(() => {
    if (refreshNonce === undefined) return
    refreshRoot()
  }, [refreshNonce, refreshRoot])

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const handler = () => setContextMenu(null)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [contextMenu])

  // `autoFocus` is not always reliable here because the inline field can mount
  // after the context-menu click and directory expansion update settle.
  useEffect(() => {
    if (!inlineInput) return

    let frame = 0
    let attempts = 0

    const focusInlineField = () => {
      const field = inlineFieldRef.current
      if (field) {
        field.focus()
        field.select()
        return
      }

      if (attempts < 4) {
        attempts += 1
        frame = requestAnimationFrame(focusInlineField)
      }
    }

    frame = requestAnimationFrame(focusInlineField)
    return () => {
      if (frame) cancelAnimationFrame(frame)
    }
  }, [inlineInput?.parentPath, inlineInput?.type])

  const handleContextMenu = useCallback((e: MouseEvent, entry: FsEntry) => {
    setContextMenu({ x: e.clientX, y: e.clientY, entry })
  }, [])

  const handleRootContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, entry: null, isRoot: true })
  }, [])

  const startNewItem = useCallback((type: 'file' | 'directory') => {
    if (!contextMenu) return
    let parentPath: string
    if (contextMenu.entry) {
      parentPath = contextMenu.entry.type === 'directory'
        ? contextMenu.entry.path
        : contextMenu.entry.path.substring(0, contextMenu.entry.path.lastIndexOf('/'))
    } else {
      parentPath = rootPath
    }
    setContextMenu(null)
    setInlineInput({ parentPath, type })
    setInlineValue('')
    setInlineError(null)
  }, [contextMenu, rootPath])

  const handleInlineSubmit = useCallback(async () => {
    if (submittingRef.current) return
    if (!inlineInput || !inlineValue.trim()) {
      setInlineInput(null)
      setInlineError(null)
      return
    }
    submittingRef.current = true
    const fullPath = `${inlineInput.parentPath}/${inlineValue.trim()}`
    try {
      await fsNew(fullPath, inlineInput.type)
      if (inlineInput.parentPath === rootPath) {
        refreshRoot()
      } else {
        requestDirRefresh(inlineInput.parentPath)
      }
      if (inlineInput.type === 'file') {
        onFileCreated?.(fullPath)
      }
      setInlineInput(null)
      setInlineError(null)
    } catch (err: any) {
      setInlineError(err.message || 'Failed to create')
    } finally {
      submittingRef.current = false
    }
  }, [inlineInput, inlineValue, refreshRoot, onFileCreated, requestDirRefresh, rootPath])

  const handleDeleteRequest = useCallback(() => {
    const entry = contextMenu?.entry
    if (!entry) return
    setContextMenu(null)
    setPendingDeleteEntry(entry)
  }, [contextMenu])

  const handleDeleteConfirm = useCallback(async () => {
    const entry = pendingDeleteEntry
    if (!entry) return
    setPendingDeleteEntry(null)
    try {
      await fsDelete(entry.path)
      const parentPath = entry.path.substring(0, entry.path.lastIndexOf('/')) || rootPath
      // Refresh root and the specific expanded parent subtree so the UI updates immediately.
      refreshRoot()
      if (parentPath !== rootPath) requestDirRefresh(parentPath)
      onFileDeleted?.(entry.path)
    } catch (err: any) {
      setInlineError(err.message || 'Failed to delete')
    }
  }, [pendingDeleteEntry, refreshRoot, onFileDeleted, rootPath, requestDirRefresh])

  const handleDeleteCancel = useCallback(() => {
    setPendingDeleteEntry(null)
  }, [])

  const handleCopyPath = useCallback(async () => {
    if (!contextMenu) return
    const targetPath = contextMenu.entry?.path || rootPath
    setContextMenu(null)

    try {
      await navigator.clipboard.writeText(targetPath)
      setInlineError(null)
    } catch {
      setInlineError('Failed to copy path')
    }
  }, [contextMenu, rootPath])

  useEffect(() => {
    if (!pendingDeleteEntry) return
    requestAnimationFrame(() => deleteModalRef.current?.querySelector<HTMLButtonElement>('button[autofocus]')?.focus())
  }, [pendingDeleteEntry])

  const renderInlineInput = useCallback((depth: number) => {
    if (!inlineInput) return null
    return (
      <div class={styles.inlineInputWrap} style={{ '--depth': depth } as any}>
        <div class={styles.inlineInput}>
          {inlineInput.type === 'directory' ? (
            <FolderPlus size={14} class={styles.icon} />
          ) : (
            <FilePlus size={14} class={styles.icon} />
          )}
          <input
            ref={inlineFieldRef}
            class={clsx(styles.inlineField, inlineError && styles.inlineFieldError)}
            type="text"
            value={inlineValue}
            onInput={(e) => {
              setInlineValue((e.target as HTMLInputElement).value)
              setInlineError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleInlineSubmit()
              if (e.key === 'Escape') { setInlineInput(null); setInlineError(null) }
            }}
            onBlur={handleInlineSubmit}
            placeholder={inlineInput.type === 'directory' ? 'folder name' : 'filename'}
            autoFocus
          />
        </div>
        {inlineError && (
          <div class={styles.inlineErrorMsg}>{inlineError}</div>
        )}
      </div>
    )
  }, [inlineInput, inlineValue, inlineError, handleInlineSubmit])

  if (loading) {
    return <div class={styles.empty}>Loading...</div>
  }

  if (error) {
    return <div class={styles.empty}>{error}</div>
  }

  if (entries.length === 0 && !inlineInput) {
    return <div class={styles.empty}>Empty directory</div>
  }

  const isRootTarget = inlineInput?.parentPath === rootPath

  return (
    <div class={styles.tree} ref={treeRef} onContextMenu={handleRootContextMenu}>
      {entries.map((entry) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          depth={0}
          selectedPath={selectedPath}
          selectedDirectoryPath={selectedDirectoryPath}
          modifiedPaths={modifiedPaths}
          onFileSelect={onFileSelect}
          onContextMenu={handleContextMenu}
          inlineInput={inlineInput}
          renderInlineInput={renderInlineInput}
          refreshDirRequest={refreshDirRequest}
          onDirectorySelect={onDirectorySelect}
          revealPath={revealPath}
          showHidden={showHidden}
        />
      ))}

      {/* Root-level inline input (when creating at root) */}
      {isRootTarget && renderInlineInput(0)}

      {/* Context menu */}
      {contextMenu && (
        <div
          class={styles.contextMenu}
          style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
          onClick={(e: Event) => e.stopPropagation()}
          onMouseDown={(e: Event) => e.stopPropagation()}
        >
          <button class={styles.contextMenuItem} onClick={handleCopyPath}>
            <Copy size={14} /> Copy Path
          </button>
          {contextMenu.entry && contextMenu.entry.type !== 'directory' && modifiedPaths?.has(contextMenu.entry.path) && onRevertFile && (
            <button class={styles.contextMenuItem} onClick={() => {
              const path = contextMenu.entry!.path
              setContextMenu(null)
              onRevertFile(path)
            }}>
              <Undo2 size={14} /> Revert
            </button>
          )}
          <div class={styles.contextMenuDivider} />
          <button class={styles.contextMenuItem} onClick={() => startNewItem('file')}>
            <FilePlus size={14} /> New File
          </button>
          <button class={styles.contextMenuItem} onClick={() => startNewItem('directory')}>
            <FolderPlus size={14} /> New Folder
          </button>
          {contextMenu.entry && (
            <>
              <div class={styles.contextMenuDivider} />
              <button class={clsx(styles.contextMenuItem, styles.contextMenuDanger)} onClick={handleDeleteRequest}>
                <Trash2 size={14} /> Delete
              </button>
            </>
          )}
        </div>
      )}

      {pendingDeleteEntry && (
        <div class={styles.modalOverlay} onClick={handleDeleteCancel}>
          <div
            ref={deleteModalRef}
            class={styles.modal}
            onClick={(e: Event) => e.stopPropagation()}
          >
            <h3 class={styles.modalTitle}>Delete {pendingDeleteEntry.type === 'directory' ? 'Directory' : 'File'}</h3>
            <p class={styles.modalMessage}>
              Delete "{pendingDeleteEntry.name}"? This action cannot be undone.
            </p>
            <div class={styles.modalActions}>
              <button class={styles.modalBtn} onClick={handleDeleteCancel}>Cancel</button>
              <button class={styles.modalBtnDanger} onClick={handleDeleteConfirm} autoFocus>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
