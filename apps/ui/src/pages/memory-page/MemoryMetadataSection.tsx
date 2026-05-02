import { Pencil, Copy, Check, Trash2, ChevronDown, RotateCcw, ExternalLink, RefreshCw, History, Unlink, Repeat, Layers } from 'lucide-preact'
import { useState } from 'preact/hooks'
import clsx from 'clsx'
import { TypeBadge, StatusBadge, TagBadge, TagInput } from '../../components/ui'
import { TOP_LEVEL_TYPES, getTypeLabel } from '../../lib/memoryTypes'
import {
  getDiagramTheme,
  getDiagramScale,
  getImageQuality,
  getDisplaySize,
  type DiagramTheme,
  type DiagramScale,
  type ImageQuality,
} from '../../lib/exportPreferences'
import { getSettings } from '../../lib/settings'
import { setEditorDeepLink } from '../../lib/editorDeepLink'
import { formatDate, getExternalSource, isGoogleDocType, STATUS_FALLBACK } from './lib'

const SYNC_TO_DISK_TYPES = new Set<string>(['assistant-rule', 'commands', 'context', 'pattern'])
import type { useMemoryMetadataEditor } from './useMemoryMetadataEditor'
import type { useMemoryContentEditor } from './useMemoryContentEditor'
import type { Memory, MemoryType, Project } from '../../types'
import styles from '../MemoryPage.module.css'

interface Props {
  memory: Memory
  projects: Project[]
  meta: ReturnType<typeof useMemoryMetadataEditor>
  editor: Pick<ReturnType<typeof useMemoryContentEditor>, 'copyMemoryId' | 'copiedId' | 'isDeleting'>
  // Snapshot props
  snapshotsData: { current_snapshot: number; total: number; snapshots: any[] } | null
  viewingSnapshot: number | null
  isViewingHistoricalSnapshot: boolean
  isLoadingSnapshot: boolean
  isRestoringSnapshot: boolean
  isDeletingSnapshot: boolean
  handleSnapshotChange: (val: number | null) => void
  isSyncingKnowledge?: boolean
  onSyncKnowledge?: () => void
  setShowDeleteConfirm: (v: boolean) => void
  setShowDeleteSnapshotConfirm: (v: boolean) => void
  setShowRestoreSnapshotConfirm: (v: boolean) => void
  onOpenManageSnapshots?: () => void
}

export function MemoryMetadataSection({
  memory,
  projects,
  meta,
  editor,
  snapshotsData,
  viewingSnapshot,
  isViewingHistoricalSnapshot,
  isLoadingSnapshot,
  isRestoringSnapshot,
  isDeletingSnapshot,
  handleSnapshotChange,
  isSyncingKnowledge,
  onSyncKnowledge,
  setShowDeleteConfirm,
  setShowDeleteSnapshotConfirm,
  setShowRestoreSnapshotConfirm,
  onOpenManageSnapshots,
}: Props) {
  const [copiedSeedPath, setCopiedSeedPath] = useState(false)
  const seedPath = memory.metadata?.['seed-path'] || null
  const seedRoot = projects.find((p) => p.handle === 'khef')?.path || undefined
  const isSeeded = seedPath !== null
  const seededStatusOptions = isSeeded
    ? ((meta.statusOptions && meta.statusOptions.length > 0)
        ? meta.statusOptions
        : ((memory.parent_type && STATUS_FALLBACK[memory.parent_type])
            || STATUS_FALLBACK[memory.type]
            || [memory.status].filter(Boolean) as string[]))
    : []

  const copySeedPath = () => {
    if (!seedPath) return
    navigator.clipboard.writeText(seedPath)
    setCopiedSeedPath(true)
    setTimeout(() => setCopiedSeedPath(false), 2000)
  }

  const openSeedInEditor = () => {
    if (!seedPath) return
    setEditorDeepLink({ path: seedPath, root: seedRoot })
    window.open('/editor', '_blank')
  }

  return (
    <div class={styles.sectionWrapper} data-testid="memory-page--metadata-section">
      <div class={styles.sectionHeader}>
        {meta.isEditingMetadata ? (
          <span class={styles.editingBadge}>Editing</span>
        ) : (
          <button
            class={styles.sectionLabelButton}
            onClick={() => meta.setIsMetadataCollapsed(!meta.isMetadataCollapsed)}
          >
            <ChevronDown
              size={14}
              class={clsx(styles.collapseIcon, meta.isMetadataCollapsed && styles.collapseIconCollapsed)}
            />
            <span class={styles.sectionLabel}>Metadata</span>
          </button>
        )}
        {!meta.isEditingMetadata && !isSeeded && (
          <button
            class={styles.editButton}
            onClick={() => {
              meta.setIsMetadataCollapsed(false)
              meta.startEditingMetadata()
            }}
            title="Edit metadata"
          >
            <Pencil size={14} />
          </button>
        )}
      </div>

      {/* Collapsed summary */}
      {meta.isMetadataCollapsed && !meta.isEditingMetadata && (
        <div
          class={styles.metadataCollapsed}
          onClick={isSeeded ? undefined : meta.handleMetadataClick}
        >
          <div class={styles.metaCollapsedItem}>
            <span class={styles.metaCollapsedLabel}>Project</span>
            <span class={styles.metaCollapsedValue}>
              {meta.resolveProjectLabel(memory.project_id)}
            </span>
          </div>
          <div class={styles.metaCollapsedItem}>
            <span class={styles.metaCollapsedLabel}>ID</span>
            <span class={styles.metaValueWithAction}>
              <span class={styles.metaCollapsedValue} title={memory.id}>{memory.id.slice(0, 8)}…</span>
              <button
                type="button"
                class={styles.copyButtonSmall}
                onClick={(e) => { e.stopPropagation(); editor.copyMemoryId() }}
                title={editor.copiedId ? 'Copied!' : 'Copy to clipboard'}
              >
                {editor.copiedId ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </span>
          </div>
          <div class={styles.metaCollapsedItem}>
            <span class={styles.metaCollapsedLabel}>Type</span>
            <span class={styles.metaCollapsedValue}>
              <TypeBadge
                type={(meta.displayTypeValues?.subtype || meta.displayTypeValues?.primaryType || memory.type) as MemoryType}
                parentType={meta.displayTypeValues?.subtype ? (meta.displayTypeValues?.primaryType as string) : undefined}
              />
            </span>
          </div>
          <div class={styles.metaCollapsedItem} onClick={isSeeded ? (e) => e.stopPropagation() : undefined}>
            <span class={styles.metaCollapsedLabel}>Status</span>
            <span class={styles.metaCollapsedValue}>
              {isSeeded ? (
                <select
                  class={styles.snapshotSelectInline}
                  value={memory.status}
                  onChange={(e) => meta.handleInlineStatusChange((e.target as HTMLSelectElement).value)}
                  title="Change status (seeded memory — other fields are locked)"
                  data-testid="memory-page--seeded-status-select"
                >
                  {seededStatusOptions.map((s) => (
                    <option key={s} value={s}>{s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}</option>
                  ))}
                </select>
              ) : (
                <StatusBadge status={memory.status} />
              )}
            </span>
          </div>
          {seedPath && (
            <div class={styles.metaCollapsedItem} onClick={(e) => e.stopPropagation()}>
              <span class={styles.metaCollapsedLabel}>Seed</span>
              <span class={styles.metaCollapsedValue}>
                <a
                  href="/editor"
                  target="_blank"
                  rel="noopener noreferrer"
                  class={styles.externalSourceLinkInline}
                  onClick={() => setEditorDeepLink({ path: seedPath, root: seedRoot })}
                  title={`Open ${seedPath} in editor`}
                  data-testid="memory-page--collapsed-open-seed-in-editor"
                >
                  <ExternalLink size={12} /> {seedPath.split('/').pop()}
                </a>
              </span>
            </div>
          )}
          {snapshotsData && snapshotsData.total > 0 && (
            <div class={styles.metaCollapsedItem} onClick={(e) => e.stopPropagation()}>
              <span class={styles.metaCollapsedLabel}>Snapshot</span>
              <span class={styles.metaCollapsedValue}>
                <select
                  class={styles.snapshotSelectInline}
                  value={viewingSnapshot ?? snapshotsData.current_snapshot}
                  onChange={(e) => {
                    const val = parseInt((e.target as HTMLSelectElement).value, 10)
                    handleSnapshotChange(val)
                  }}
                  disabled={isLoadingSnapshot}
                >
                  <option value={snapshotsData.current_snapshot}>
                    #{snapshotsData.current_snapshot} current
                  </option>
                  {snapshotsData.snapshots.map((s) => (
                    <option key={s.id} value={s.snapshot_number}>
                      #{s.snapshot_number}
                    </option>
                  ))}
                </select>
              </span>
            </div>
          )}
          {getExternalSource(memory.metadata) && (
            <div class={styles.metaCollapsedItem} onClick={(e) => e.stopPropagation()}>
              <span class={styles.metaCollapsedLabel}>
                <ExternalLink size={12} />
              </span>
              <span class={styles.metaCollapsedValue}>
                <a
                  href={getExternalSource(memory.metadata)!.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class={styles.externalSourceLinkInline}
                >
                  {isGoogleDocType(memory) ? 'Google Doc'
                    : getExternalSource(memory.metadata)!.id || getExternalSource(memory.metadata)!.type || 'External'}
                </a>
                {isGoogleDocType(memory) && (
                  <button
                    class={styles.syncButtonInline}
                    onClick={() => meta.handleSyncExternal('snapshot')}
                    disabled={meta.isSyncingExternal || isViewingHistoricalSnapshot}
                    title="Snapshot and sync from source"
                  >
                    <RefreshCw size={12} class={meta.isSyncingExternal ? styles.spinning : ''} />
                  </button>
                )}
              </span>
            </div>
          )}
          {onSyncKnowledge && (
            <div class={styles.metaCollapsedItem} onClick={(e) => e.stopPropagation()}>
              <span class={styles.metaCollapsedLabel}>Knowledge</span>
              <span class={styles.metaCollapsedValue}>
                <button
                  class={styles.syncButtonInline}
                  onClick={onSyncKnowledge}
                  disabled={isSyncingKnowledge}
                  title="Sync project knowledge to disk"
                >
                  <Repeat size={12} class={isSyncingKnowledge ? styles.spinning : ''} />
                </button>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Expanded metadata - 3 Table Layout */}
      {(!meta.isMetadataCollapsed || meta.isEditingMetadata) && (
      <div class={styles.metadataTables} onClick={!meta.isEditingMetadata && !isSeeded ? meta.handleMetadataClick : undefined} data-testid="memory-page--metadata-tables">
        {/* Table 1: Identity */}
        <div class={clsx(styles.metadataTable, meta.isEditingMetadata && styles.metadataTableEditing)}>
          <div class={styles.metaTableRow}>
            <div class={styles.metaTableLabel}>Title</div>
            <div class={styles.metaTableValue}>
              {meta.isEditingMetadata ? (
                <input type="text" class={styles.metaTableInput} value={meta.editTitle}
                  onInput={(e) => meta.setEditTitle((e.target as HTMLInputElement).value)} />
              ) : memory.title}
            </div>
          </div>
          <div class={styles.metaTableRow}>
            <div class={styles.metaTableLabel}>Project</div>
            <div class={styles.metaTableValue}>
              {meta.isEditingMetadata ? (
                <select class={styles.metaTableSelect} value={meta.editProjectId}
                  onChange={(e) => meta.setEditProjectId((e.target as HTMLSelectElement).value)} disabled={projects.length === 0}>
                  {projects.length === 0 && memory?.project_id && (
                    <option value={memory.project_id}>{meta.resolveProjectLabel(memory.project_id)}</option>
                  )}
                  {projects.map((item) => (
                    <option key={item.id} value={item.id}>{item.display_name || item.name || item.handle}</option>
                  ))}
                </select>
              ) : meta.resolveProjectLabel(memory.project_id)}
            </div>
          </div>
          <div class={styles.metaTableRow}>
            <div class={styles.metaTableLabel}>Memory ID</div>
            <div class={styles.metaTableValue}>
              <span class={styles.metaValueWithAction}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{memory.id}</span>
                <button type="button" class={styles.copyButton}
                  onClick={(e) => { e.stopPropagation(); editor.copyMemoryId() }}
                  title={editor.copiedId ? 'Copied!' : 'Copy to clipboard'}>
                  {editor.copiedId ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </span>
            </div>
          </div>
          <div class={styles.metaTableRow}>
            <div class={styles.metaTableLabel}>Handle</div>
            <div class={styles.metaTableValue}>
              {meta.isEditingMetadata ? (
                <input type="text" class={styles.metaTableInput} value={meta.editHandle}
                  onInput={(e) => meta.setEditHandle((e.target as HTMLInputElement).value)} />
              ) : memory.handle}
            </div>
          </div>
          {seedPath && !meta.isEditingMetadata && (
            <div class={styles.metaTableRow}>
              <div class={styles.metaTableLabel}>Seed File</div>
              <div class={styles.metaTableValue}>
                <span class={styles.metaValueWithAction}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }} data-testid="memory-page--seed-path">{seedPath}</span>
                  <button
                    type="button"
                    class={styles.copyButton}
                    onClick={(e) => { e.stopPropagation(); copySeedPath() }}
                    title={copiedSeedPath ? 'Copied!' : 'Copy seed file path'}
                    data-testid="memory-page--copy-seed-path"
                  >
                    {copiedSeedPath ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                  <button
                    type="button"
                    class={styles.copyButton}
                    onClick={(e) => { e.stopPropagation(); openSeedInEditor() }}
                    title="Open in editor"
                    data-testid="memory-page--open-seed-in-editor"
                  >
                    <ExternalLink size={14} />
                  </button>
                </span>
              </div>
            </div>
          )}
          <div class={styles.metaTableRow}>
            <div class={styles.metaTableLabel}>Type</div>
            <div class={styles.metaTableValue}>
              {meta.isEditingMetadata ? (
                <select class={styles.metaTableSelect} value={meta.editType}
                  onChange={(e) => meta.handleTypeChange((e.target as HTMLSelectElement).value as MemoryType)}>
                  {(meta.topLevelTypeOptions || TOP_LEVEL_TYPES).map((t) => (
                    <option key={t} value={t}>{getTypeLabel(t)}{meta.typeHierarchy[t] ? ' ▸' : ''}</option>
                  ))}
                </select>
              ) : (
                <TypeBadge
                  type={(meta.displayTypeValues?.subtype || meta.displayTypeValues?.primaryType || memory.type) as MemoryType}
                  parentType={meta.displayTypeValues?.subtype ? (meta.displayTypeValues?.primaryType as string) : undefined}
                />
              )}
            </div>
          </div>
          {(meta.isEditingMetadata ? meta.typeHierarchy[meta.editType] : memory.parent_type) && (
            <div class={styles.metaTableRow}>
              <div class={styles.metaTableLabel}>Subtype</div>
              <div class={styles.metaTableValue}>
                {meta.isEditingMetadata ? (
                  <select class={styles.metaTableSelect} value={meta.editSubtype}
                    onChange={(e) => meta.handleSubtypeChange((e.target as HTMLSelectElement).value)}>
                    {meta.typeHierarchy[meta.editType]?.map((t) => (<option key={t} value={t}>{getTypeLabel(t)}</option>))}
                  </select>
                ) : <TypeBadge type={memory.type} />}
              </div>
            </div>
          )}
          <div class={styles.metaTableRow}>
            <div class={styles.metaTableLabel}>Status</div>
            <div class={styles.metaTableValue}>
              {meta.isEditingMetadata ? (
                <select class={styles.metaTableSelect} value={meta.editStatus}
                  onChange={(e) => meta.setEditStatus((e.target as HTMLSelectElement).value)}>
                  {meta.statusOptions.map((s) => (
                    <option key={s} value={s}>{s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}</option>
                  ))}
                </select>
              ) : <StatusBadge status={memory.status} />}
            </div>
          </div>
          {SYNC_TO_DISK_TYPES.has(meta.effectiveEditType) && (
            <div class={styles.metaTableRow}>
              <div class={styles.metaTableLabel}>Sync to Disk</div>
              <div class={styles.metaTableValue}>
                {meta.isEditingMetadata ? (
                  <label class={styles.metaCheckboxLabel}>
                    <input
                      type="checkbox"
                      checked={meta.editSyncToDisk}
                      onChange={(e) => meta.setEditSyncToDisk((e.target as HTMLInputElement).checked)}
                    />
                    <span class={styles.metaCheckboxHint}>
                      {meta.editSyncToDisk
                        ? 'Auto-imported into CLAUDE.md on sync'
                        : 'Excluded from CLAUDE.md (still searchable)'}
                    </span>
                  </label>
                ) : (
                  <>{memory.metadata?.['sync_to_disk'] === 'false' ? 'Excluded' : 'Auto-imported'}</>
                )}
              </div>
            </div>
          )}
          {(meta.isEditingMetadata || (memory.tags && memory.tags.length > 0)) && (
            <div class={styles.metaTableRow}>
              <div class={styles.metaTableLabel}>Tags</div>
              <div class={styles.metaTableValue}>
                {meta.isEditingMetadata ? (
                  <TagInput tags={meta.editTags} onChange={meta.setEditTags} placeholder="Add tags (press Enter or comma)" />
                ) : (
                  <span class={styles.tagsInline}>
                    {memory.tags!.map((tag) => (<TagBadge key={tag.id} name={tag.name} />))}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Table 2: Rendering */}
        <div class={clsx(styles.metadataTable, meta.isEditingMetadata && styles.metadataTableEditing)}>
          <div class={styles.metaTableRow}>
            <div class={styles.metaTableLabel}>SVG Max Width</div>
            <div class={styles.metaTableValue}>
              {meta.isEditingMetadata ? (
                <input type="number" class={styles.metaTableInput} value={meta.editMaxWidth}
                  onChange={(e) => meta.setEditMaxWidth((e.target as HTMLInputElement).value)}
                  placeholder={String(getSettings().diagram.defaultMaxWidth)} min="100" max="4000" step="50" style={{ width: '100px' }} />
              ) : <>{memory.metadata?.['svg-max-width'] ? `${memory.metadata['svg-max-width']}px` : `${getSettings().diagram.defaultMaxWidth}px`}</>}
            </div>
          </div>
          <div class={styles.metaTableRow}>
            <div class={styles.metaTableLabel}>Theme</div>
            <div class={styles.metaTableValue}>
              {meta.isEditingMetadata ? (
                <select class={styles.metaTableSelect} value={meta.editDiagramTheme}
                  onChange={(e) => meta.setEditDiagramTheme((e.target as HTMLSelectElement).value as DiagramTheme | '')}>
                  <option value="">Use global setting</option>
                  <option value="neutral">Neutral</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                  <option value="forest">Forest</option>
                  <option value="ocean">Ocean</option>
                </select>
              ) : <>{memory.metadata?.['export-image-theme']
                ? memory.metadata['export-image-theme'].charAt(0).toUpperCase() + memory.metadata['export-image-theme'].slice(1)
                : getDiagramTheme().charAt(0).toUpperCase() + getDiagramTheme().slice(1)}</>}
            </div>
          </div>
          <div class={styles.metaTableRow}>
            <div class={styles.metaTableLabel}>Legacy Scale</div>
            <div class={styles.metaTableValue}>
              {meta.isEditingMetadata ? (
                <select class={styles.metaTableSelect} value={meta.editDiagramScale}
                  onChange={(e) => { const val = (e.target as HTMLSelectElement).value; meta.setEditDiagramScale(val ? (Number(val) as DiagramScale) : '') }}>
                  <option value="">Use global setting</option>
                  <option value="1">1x</option><option value="2">2x</option><option value="3">3x</option><option value="4">4x</option>
                </select>
              ) : <>{memory.metadata?.['export-diagram-scale'] ? `${memory.metadata['export-diagram-scale']}x` : `${getDiagramScale()}x`}</>}
            </div>
          </div>
          <div class={styles.metaTableRow}>
            <div class={styles.metaTableLabel}>Quality</div>
            <div class={styles.metaTableValue}>
              {meta.isEditingMetadata ? (
                <select class={styles.metaTableSelect} value={meta.editImageQuality}
                  onChange={(e) => { const val = (e.target as HTMLSelectElement).value; meta.setEditImageQuality(val ? (Number(val) as ImageQuality) : '') }}>
                  <option value="">Use global setting</option>
                  <option value="1">Standard</option><option value="2">High</option><option value="3">Very High</option><option value="4">Maximum</option>
                </select>
              ) : <>{memory.metadata?.['export-png-render-scale']
                ? ['Standard', 'High', 'Very High', 'Maximum'][Number(memory.metadata['export-png-render-scale']) - 1]
                : ['Standard', 'High', 'Very High', 'Maximum'][getImageQuality() - 1]}</>}
            </div>
          </div>
          <div class={styles.metaTableRow}>
            <div class={styles.metaTableLabel}>Display Size</div>
            <div class={styles.metaTableValue}>
              {meta.isEditingMetadata ? (
                <div class={styles.metaRangeRow}>
                  <input type="range" class={styles.metaRange} min="10" max="300" step="10" value={meta.editDisplaySize || 100}
                    onInput={(e) => meta.setEditDisplaySize(Number((e.target as HTMLInputElement).value))} />
                  <span class={styles.metaRangeValue}>{meta.editDisplaySize || 100}%</span>
                  {meta.editDisplaySize && (
                    <button type="button" class={styles.metaClearButton} onClick={() => meta.setEditDisplaySize('')} title="Use global setting">×</button>
                  )}
                </div>
              ) : <>{memory.metadata?.['export-png-display-scale-percent'] ? `${memory.metadata['export-png-display-scale-percent']}%` : `${getDisplaySize()}%`}</>}
            </div>
          </div>
          <div class={styles.metaTableRow}>
            <div class={styles.metaTableLabel}>Slide Order</div>
            <div class={styles.metaTableValue}>
              {meta.isEditingMetadata ? (
                <input
                  type="number"
                  class={styles.metaTableInput}
                  value={meta.editSlideOrder}
                  onChange={(e) => meta.setEditSlideOrder((e.target as HTMLInputElement).value)}
                  placeholder="1"
                  min="0"
                  step="1"
                  style={{ width: '90px' }}
                />
              ) : (
                <>{memory.metadata?.['slide-order'] || '—'}</>
              )}
            </div>
          </div>
          <div class={styles.metaTableRow}>
            <div class={styles.metaTableLabel}>Drive Folder</div>
            <div class={styles.metaTableValue}>
              {meta.isEditingMetadata ? (
                <input
                  type="text"
                  class={styles.metaTableInput}
                  value={meta.editDriveExportFolder}
                  onInput={(e) => meta.setEditDriveExportFolder((e.target as HTMLInputElement).value)}
                  placeholder={getSettings().drive.syncFolder || 'Use global setting'}
                  style={{ width: '100%' }}
                />
              ) : (
                <>{memory.metadata?.['drive-export-folder'] || (getSettings().drive.syncFolder ? 'Global' : '—')}</>
              )}
            </div>
          </div>
        </div>

        {/* Table 3: Activity (Timeline + Integration) */}
        {(!meta.isEditingMetadata || (snapshotsData && snapshotsData.total > 0) || getExternalSource(memory.metadata) || meta.isEditingMetadata) && (
          <div class={clsx(styles.metadataTable, meta.isEditingMetadata && styles.metadataTableEditing)}>
            {!meta.isEditingMetadata && (
              <>
                <div class={styles.metaTableRow}>
                  <div class={styles.metaTableLabel}>Created</div>
                  <div class={styles.metaTableValue}>{formatDate(memory.created_at)}</div>
                </div>
                <div class={styles.metaTableRow}>
                  <div class={styles.metaTableLabel}>Updated</div>
                  <div class={styles.metaTableValue}>{formatDate(memory.updated_at)}</div>
                </div>
                <div class={styles.metaTableRow}>
                  <div class={styles.metaTableLabel}>Status Updated</div>
                  <div class={styles.metaTableValue}>{memory.status_updated_at ? formatDate(memory.status_updated_at) : '—'}</div>
                </div>
              </>
            )}
            {snapshotsData && snapshotsData.total > 0 && !meta.isEditingMetadata && (
              <div class={styles.metaTableRow}>
                <div class={styles.metaTableLabel}>Snapshot</div>
                <div class={styles.metaTableValue} onClick={(e) => e.stopPropagation()}>
                  <span class={styles.snapshotInfo}>
                    <select class={styles.snapshotSelect} value={viewingSnapshot ?? snapshotsData.current_snapshot}
                      onChange={(e) => { handleSnapshotChange(parseInt((e.target as HTMLSelectElement).value, 10)) }} disabled={isLoadingSnapshot}>
                      <option value={snapshotsData.current_snapshot}>#{snapshotsData.current_snapshot} (current)</option>
                      {snapshotsData.snapshots.map((s) => (
                        <option key={s.id} value={s.snapshot_number}>
                          #{s.snapshot_number}{s.source ? ` - ${s.source}` : ''} - {formatDate(s.created_at)}{s.has_comments ? ' 💬' : ''}
                        </option>
                      ))}
                    </select>
                    {isLoadingSnapshot && <span class={styles.snapshotLoading}>Loading...</span>}
                    {isViewingHistoricalSnapshot && !isLoadingSnapshot && (
                      <>
                        <button
                          class={styles.restoreSnapshotButton}
                          onClick={() => setShowRestoreSnapshotConfirm(true)}
                          disabled={isRestoringSnapshot || isDeletingSnapshot}
                          title="Restore to current"
                          aria-label="Restore to current"
                        >
                          <RotateCcw size={14} />
                        </button>
                        <button class={styles.deleteSnapshotButton} onClick={() => setShowDeleteSnapshotConfirm(true)}
                          disabled={isDeletingSnapshot || isRestoringSnapshot} title="Delete this snapshot"><Trash2 size={14} /></button>
                      </>
                    )}
                    {onOpenManageSnapshots && !isLoadingSnapshot && (
                      <button
                        class={styles.restoreSnapshotButton}
                        onClick={onOpenManageSnapshots}
                        disabled={isDeletingSnapshot || isRestoringSnapshot}
                        title="Manage snapshots"
                        aria-label="Manage snapshots"
                      >
                        <Layers size={14} />
                      </button>
                    )}
                  </span>
                </div>
              </div>
            )}
            {!meta.isEditingMetadata && getExternalSource(memory.metadata) && (
              <div class={styles.metaTableRow}>
                <div class={styles.metaTableLabel}>External Source</div>
                <div class={styles.metaTableValue} onClick={(e) => e.stopPropagation()}>
                  <span class={styles.externalSourceInfo}>
                    <a href={getExternalSource(memory.metadata)!.url} target="_blank" rel="noopener noreferrer" class={styles.externalSourceLink}>
                      {isGoogleDocType(memory) ? 'Google Doc'
                        : getExternalSource(memory.metadata)!.type === 'external-link' ? new URL(getExternalSource(memory.metadata)!.url).hostname
                        : getExternalSource(memory.metadata)!.type}
                    </a>
                    {isGoogleDocType(memory) && (
                      <>
                        <button class={styles.syncButton} onClick={() => meta.handleSyncExternal('update')}
                          disabled={meta.isSyncingExternal || isViewingHistoricalSnapshot} title="Refresh from external source">
                          <RefreshCw size={14} class={meta.isSyncingExternal ? styles.spinning : ''} />
                        </button>
                        <button class={styles.syncSnapshotButton} onClick={() => meta.handleSyncExternal('snapshot')}
                          disabled={meta.isSyncingExternal || isViewingHistoricalSnapshot} title="Snapshot before syncing"><History size={14} /></button>
                        <button class={styles.unlinkButton} onClick={meta.handleUnlinkExternal}
                          disabled={meta.isSyncingExternal || isViewingHistoricalSnapshot} title="Unlink from external source"><Unlink size={14} /></button>
                        <button class={styles.cloneButton} onClick={meta.handleCloneMemory}
                          disabled={meta.isSyncingExternal || isViewingHistoricalSnapshot} title="Create editable copy"><Copy size={14} /></button>
                      </>
                    )}
                  </span>
                </div>
              </div>
            )}
            {meta.isEditingMetadata && (
              <div class={styles.metaTableRow}>
                <div class={styles.metaTableLabel}>External URL</div>
                <div class={styles.metaTableValue}>
                  <input type="text" class={styles.metaTableInput} value={meta.editExternalUrl}
                    onInput={(e) => meta.setEditExternalUrl((e.target as HTMLInputElement).value)}
                    placeholder="https://docs.google.com/document/d/..." />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      )}
      {meta.isEditingMetadata && (
        <div class={styles.actionButtons}>
          <button
            class={styles.deleteButton}
            onClick={() => setShowDeleteConfirm(true)}
            disabled={meta.isSaving || editor.isDeleting}
          >
            Delete
          </button>
          <button
            class={styles.cancelButton}
            onClick={meta.cancelEditingMetadata}
            disabled={meta.isSaving || editor.isDeleting}
          >
            Cancel
          </button>
          <button
            class={styles.saveButton}
            onClick={meta.saveMetadata}
            disabled={meta.isSaving || editor.isDeleting}
          >
            {meta.isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
