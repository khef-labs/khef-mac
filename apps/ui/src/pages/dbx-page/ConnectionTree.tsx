import { useState } from 'preact/hooks'
import { ChevronRight, Database, Table2, Eye, Columns3, Settings2, Pencil, Trash2, GitBranch, Braces, Zap } from 'lucide-preact'
import clsx from 'clsx'
import type { DbxConnection } from '../../lib/dbx-api'
import { deleteConnection } from '../../lib/dbx-api'
import { ConfirmModal } from '../../components/ui'
import type { TreeNode } from './types'
import styles from './DbxPage.module.css'

interface ConnectionTreeProps {
  connections: DbxConnection[]
  treeData: Map<string, TreeNode>
  openNodes: Set<string>
  activeNodeKey: string | null
  filter: string
  onNodeClick: (key: string, node: { type: string; connectionId?: string; schema?: string; name: string }) => void
  onNodeDoubleClick: (connectionId: string, schema: string, name: string) => void
  onToggleNode: (key: string) => void
  onEditConnection: (conn: DbxConnection) => void
  onConnectionDeleted: () => void
  onGenerateSchemaErd: (connectionId: string, schema: string) => void
}

export function ConnectionTree({
  connections, treeData, openNodes, activeNodeKey, filter,
  onNodeClick, onNodeDoubleClick, onToggleNode, onEditConnection, onConnectionDeleted, onGenerateSchemaErd,
}: ConnectionTreeProps) {
  const [contextMenu, setContextMenu] = useState<
    | { kind: 'connection'; x: number; y: number; conn: DbxConnection }
    | { kind: 'schema'; x: number; y: number; connectionId: string; schema: string }
    | null
  >(null)
  const [confirmDelete, setConfirmDelete] = useState<DbxConnection | null>(null)

  function renderNode(
    key: string,
    node: { type: string; name: string; connectionId?: string; schema?: string; badge?: string },
    depth: number,
    children?: any[],
    hasChildren = true,
  ) {
    const isOpen = filter ? true : openNodes.has(key)
    const isActive = activeNodeKey === key

    const icons: Record<string, any> = {
      connection: <Database size={14} class={styles.treeIcon} style={{ color: 'var(--accent)' }} />,
      schema: <Columns3 size={14} class={styles.treeIcon} style={{ color: 'var(--brand-purple)' }} />,
      folder: <span class={styles.treeIcon} style={{ fontSize: 12 }}>📁</span>,
      table: <Table2 size={14} class={styles.treeIcon} style={{ color: 'var(--success)' }} />,
      view: <Eye size={14} class={styles.treeIcon} style={{ color: 'var(--warning)' }} />,
      function: <Braces size={14} class={styles.treeIcon} style={{ color: 'var(--info, #60a5fa)' }} />,
      trigger: <Zap size={14} class={styles.treeIcon} style={{ color: '#fb923c' }} />,
    }

    return (
      <div key={key}>
        <div
          class={clsx(styles.treeNode, isActive && styles.active)}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          onClick={() => { setContextMenu(null); onNodeClick(key, node) }}
          onContextMenu={(e) => {
            if (node.type === 'connection' && node.connectionId) {
              e.preventDefault()
              const conn = connections.find(c => c.id === node.connectionId)
              if (conn) setContextMenu({ kind: 'connection', x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY, conn })
            } else if (node.type === 'schema' && node.connectionId) {
              e.preventDefault()
              setContextMenu({ kind: 'schema', x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY, connectionId: node.connectionId, schema: node.name })
            }
          }}
          onDblClick={() => {
            if ((node.type === 'table' || node.type === 'view') && node.connectionId && node.schema) {
              onNodeDoubleClick(node.connectionId, node.schema, node.name)
            }
          }}
        >
          <span
            class={clsx(styles.chevron, isOpen && styles.chevronOpen, !hasChildren && styles.chevronHidden)}
            onClick={(e) => { e.stopPropagation(); onToggleNode(key) }}
          >
            <ChevronRight size={12} />
          </span>
          {icons[node.type] || null}
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
          {node.type === 'connection' && (
            <>
              <span
                class={styles.treeIcon}
                style={{ marginLeft: '4px', opacity: 0.5, cursor: 'pointer' }}
                title="Edit connection"
                onClick={(e) => {
                  e.stopPropagation()
                  const conn = connections.find(c => c.id === node.connectionId)
                  if (conn) onEditConnection(conn)
                }}
              >
                <Settings2 size={12} />
              </span>
              <span class={clsx(styles.connBadge, styles.connBadgeRw)}>RW</span>
            </>
          )}
          {node.badge && <span class={styles.treeBadge}>{node.badge}</span>}
        </div>
        {isOpen && children}
      </div>
    )
  }

  function fuzzyMatch(name: string, filter: string): boolean {
    let fi = 0
    for (let ni = 0; ni < name.length && fi < filter.length; ni++) {
      if (name[ni] === filter[fi]) fi++
    }
    return fi === filter.length
  }

  return (
    <>
      {/* Context menu overlay */}
      {contextMenu && (
        <div class={styles.contextOverlay} onClick={() => setContextMenu(null)} onContextMenu={e => { e.preventDefault(); setContextMenu(null) }}>
          <div class={styles.contextMenu} style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }} onClick={e => e.stopPropagation()}>
            {contextMenu.kind === 'connection' && (
              <>
                <button class={styles.contextMenuItem} onClick={() => { onEditConnection(contextMenu.conn); setContextMenu(null) }}>
                  <Pencil size={13} /> Edit
                </button>
                {!contextMenu.conn.is_builtin && (
                  <button class={clsx(styles.contextMenuItem, styles.contextMenuDanger)} onClick={() => { setConfirmDelete(contextMenu.conn); setContextMenu(null) }}>
                    <Trash2 size={13} /> Delete
                  </button>
                )}
              </>
            )}
            {contextMenu.kind === 'schema' && (
              <button class={styles.contextMenuItem} onClick={() => { onGenerateSchemaErd(contextMenu.connectionId, contextMenu.schema); setContextMenu(null) }}>
                <GitBranch size={13} /> Generate ERD
              </button>
            )}
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <ConfirmModal
          title="Delete Connection"
          message={`Delete "${confirmDelete.name}"? Scripts linked to this connection will be unlinked.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={async () => {
            await deleteConnection(confirmDelete.id)
            setConfirmDelete(null)
            onConnectionDeleted()
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {connections.map(conn => {
        const connKey = `conn:${conn.id}`
        const connNode = treeData.get(connKey)
        const schemas = connNode?.children || []
        const lowerFilter = filter.toLowerCase()

        const filteredSchemas = schemas.map(schema => {
          const schemaKey = `schema:${conn.id}:${schema.name}`
          const schemaData = treeData.get(schemaKey)
          const folders = schemaData?.children || []

          const filteredFolders = folders.map(folder => {
            const folderKey = `folder:${conn.id}:${schema.name}:${folder.name}`
            const items = folder.children || []
            const filteredItems = lowerFilter
              ? items.filter(item => fuzzyMatch(item.name.toLowerCase(), lowerFilter))
              : items

            if (lowerFilter && filteredItems.length === 0) return null

            return renderNode(folderKey, { type: 'folder', name: folder.name, badge: lowerFilter ? `${filteredItems.length}` : folder.badge }, 2,
              filteredItems.map(item => {
                const itemKey = `${item.type}:${conn.id}:${schema.name}:${item.name}`
                return renderNode(itemKey, {
                  type: item.type,
                  name: item.name,
                  connectionId: conn.id,
                  schema: schema.name,
                  badge: item.badge,
                }, 3, undefined, false)
              }),
              filteredItems.length > 0
            )
          }).filter(Boolean)

          if (lowerFilter && filteredFolders.length === 0) return null

          return renderNode(schemaKey, { type: 'schema', name: schema.name, connectionId: conn.id, badge: schema.badge }, 1,
            filteredFolders,
            filteredFolders.length > 0
          )
        }).filter(Boolean)

        return renderNode(connKey, { type: 'connection', name: conn.name, connectionId: conn.id }, 0,
          filteredSchemas,
          filteredSchemas.length > 0
        )
      })}
    </>
  )
}
