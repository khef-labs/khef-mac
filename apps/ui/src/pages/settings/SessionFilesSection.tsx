import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { Search, ExternalLink, FolderOpen } from 'lucide-preact'
import { useSettings } from './useSettings'
import { useRegisterDirtySection } from './DirtySectionsContext'
import { getArchivedSessions, revealArchivedSessionInFinder, type ArchivedSession, type ArchiveLargestFile } from '../../lib/api'
import shared from './SettingsShared.module.css'

type SortMode = 'newest' | 'oldest' | 'largest' | 'nickname'

const INTERVAL_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 5, label: 'Every 5 minutes' },
  { value: 10, label: 'Every 10 minutes' },
  { value: 30, label: 'Every 30 minutes' },
  { value: 60, label: 'Every hour' },
  { value: 360, label: 'Every 6 hours' },
  { value: 720, label: 'Every 12 hours' },
  { value: 1440, label: 'Every 24 hours' },
]

function intervalLabel(minutes: number): string {
  const match = INTERVAL_OPTIONS.find((o) => o.value === minutes)
  return match ? match.label : `Every ${minutes} minutes`
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function SessionFilesSection() {
  const { settings, loading, saving, error, success, save, clearMessages } = useSettings()

  const [backupPath, setBackupPath] = useState('')
  const [backupEnabled, setBackupEnabled] = useState(false)
  const [intervalMinutes, setIntervalMinutes] = useState(10)

  const [archived, setArchived] = useState<ArchivedSession[]>([])
  const [largestFiles, setLargestFiles] = useState<ArchiveLargestFile[]>([])
  const [archiveTotalFiles, setArchiveTotalFiles] = useState(0)
  const [archiveTotalSize, setArchiveTotalSize] = useState('0 B')
  const [archivedLoading, setArchivedLoading] = useState(false)
  const [archivedError, setArchivedError] = useState<string | null>(null)

  const [filter, setFilter] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('newest')

  useEffect(() => {
    if (settings) {
      setBackupPath(settings.sessions.backupPath)
      setBackupEnabled(settings.sessions.backupEnabled)
      setIntervalMinutes(settings.sessions.backupIntervalMinutes)
    }
  }, [settings])

  const fetchArchived = useCallback(async () => {
    setArchivedLoading(true)
    setArchivedError(null)
    try {
      const data = await getArchivedSessions()
      setArchived(data.sessions)
      setLargestFiles(data.largest_files)
      setArchiveTotalFiles(data.archive_total_files)
      setArchiveTotalSize(data.archive_total_size_human)
    } catch (err: any) {
      setArchivedError(err?.message || 'Failed to load archived sessions')
    } finally {
      setArchivedLoading(false)
    }
  }, [])

  useEffect(() => { fetchArchived() }, [fetchArchived])

  const dirtyPath = settings ? backupPath !== settings.sessions.backupPath : false
  const dirtyEnabled = settings ? backupEnabled !== settings.sessions.backupEnabled : false
  const dirtyInterval = settings ? intervalMinutes !== settings.sessions.backupIntervalMinutes : false
  const hasChanges = dirtyPath || dirtyEnabled || dirtyInterval

  useRegisterDirtySection('session-files', hasChanges)

  const handleSave = useCallback(async () => {
    if (!hasChanges) return
    await save({
      sessions: {
        backupPath: backupPath.trim(),
        backupEnabled,
        backupIntervalMinutes: intervalMinutes,
      },
    })
  }, [hasChanges, backupPath, backupEnabled, intervalMinutes, save])

  const handleRevert = useCallback(() => {
    if (settings) {
      setBackupPath(settings.sessions.backupPath)
      setBackupEnabled(settings.sessions.backupEnabled)
      setIntervalMinutes(settings.sessions.backupIntervalMinutes)
    }
    clearMessages()
  }, [settings, clearMessages])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        handleRevert()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSave, handleRevert])

  const filteredSorted = useMemo(() => {
    const trimmed = filter.trim().toLowerCase()
    const filtered = trimmed
      ? archived.filter((s) =>
          (s.nickname?.toLowerCase().includes(trimmed) ?? false) ||
          s.session_id.toLowerCase().includes(trimmed) ||
          (s.project_handle?.toLowerCase().includes(trimmed) ?? false) ||
          (s.project_name?.toLowerCase().includes(trimmed) ?? false)
        )
      : archived
    const copy = [...filtered]
    copy.sort((a, b) => {
      switch (sortMode) {
        case 'newest':
          return (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
        case 'oldest':
          return (a.updated_at ?? '').localeCompare(b.updated_at ?? '')
        case 'largest':
          return b.size - a.size
        case 'nickname':
          return (a.nickname ?? 'zz').localeCompare(b.nickname ?? 'zz')
      }
    })
    return copy
  }, [archived, filter, sortMode])

  if (loading) return <div class={shared.description}>Loading…</div>

  return (
    <>
      <div class={shared.pageIntro} data-testid="session-files--intro">
        <h1 class={shared.pageTitle} data-testid="session-files--title">Session Files</h1>
        <p class={shared.pageDescription}>
          Mirror session JSONL files from configured coding assistants to a persistent location so they survive upstream pruning.
        </p>
      </div>

      <div class={shared.section}>
        <div class={shared.sectionHeader}>
          <div class={shared.sectionTitleBlock}>
            <h2 class={shared.sectionTitle}>Archive Settings</h2>
            <p class={shared.sectionSubtitle}>How often and where session files are mirrored.</p>
          </div>
          <span class={`${shared.statusPill} ${backupEnabled && settings?.sessions.backupEnabled ? shared.statusPillActive : ''}`}>
            <span class={shared.statusPillDot} />
            {backupEnabled && settings?.sessions.backupEnabled ? 'Active' : 'Disabled'}
          </span>
        </div>

        <div class={shared.field}>
          <button
            type="button"
            class={`${shared.toggleRow}`}
            onClick={() => setBackupEnabled(!backupEnabled)}
            role="switch"
            aria-checked={backupEnabled}
          >
            <span class={`${shared.toggle} ${backupEnabled ? shared.toggleOn : ''}`}>
              <span class={shared.toggleSlider} />
            </span>
            <span class={shared.toggleLabel}>
              <strong>{backupEnabled ? 'Enabled' : 'Disabled'}</strong>
              {' — '}run archive on the interval below
            </span>
            {dirtyEnabled && <span class={shared.fieldDirtyDot} title="Modified from saved value" />}
          </button>
        </div>

        <div class={shared.field}>
          <div class={shared.fieldLabelRow}>
            <label class={shared.label} htmlFor="archiveInterval">Backup Interval</label>
            {dirtyInterval && <span class={shared.fieldDirtyDot} title="Modified from saved value" />}
          </div>
          <select
            id="archiveInterval"
            data-testid="session-files--interval-select"
            class={`${shared.select} ${dirtyInterval ? shared.inputDirty : ''}`}
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(parseInt((e.target as HTMLSelectElement).value, 10))}
            disabled={!backupEnabled}
          >
            {INTERVAL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p class={shared.description}>
            How often the backup worker scans for new or changed session files.
            {dirtyInterval && settings && (
              <> Saved value: <em>{intervalLabel(settings.sessions.backupIntervalMinutes)}</em>.</>
            )}
          </p>
        </div>

        <div class={shared.field}>
          <div class={shared.fieldLabelRow}>
            <label class={shared.label} htmlFor="sessionsBackupPath">Archive Directory</label>
            {dirtyPath && <span class={shared.fieldDirtyDot} title="Modified from saved value" />}
          </div>
          <input
            id="sessionsBackupPath"
            data-testid="session-files--path-input"
            class={`${shared.inputWide} ${dirtyPath ? shared.inputDirty : ''}`}
            type="text"
            placeholder="/Users/you/session-archive"
            value={backupPath}
            onInput={(e) => setBackupPath((e.target as HTMLInputElement).value)}
            disabled={!backupEnabled}
          />
          <p class={shared.description}>
            Absolute path where session JSONL files are mirrored. Leading <code>~</code> is expanded to your home directory.
            Files are grouped by assistant handle (<code>claude-code/</code>, <code>codex-cli/</code>) preserving the source structure.
          </p>
          {dirtyPath && settings && (
            <p class={shared.savedValueHint}>
              Saved value: <em>{settings.sessions.backupPath || '(empty)'}</em>
            </p>
          )}
        </div>

        <div class={shared.statsStrip} data-testid="session-files--stats">
          <div class={shared.stat}>
            <span class={shared.statLabel}>Files archived</span>
            <span class={shared.statValue}>{archiveTotalFiles.toLocaleString()}</span>
          </div>
          <div class={shared.stat}>
            <span class={shared.statLabel}>Archive size</span>
            <span class={shared.statValue}>{archiveTotalSize}</span>
          </div>
          <div class={shared.stat}>
            <span class={shared.statLabel}>Interval</span>
            <span class={shared.statValue}>{intervalLabel(intervalMinutes)}</span>
          </div>
        </div>
      </div>

      <div class={shared.section}>
        <div class={shared.sectionHeader}>
          <div class={shared.sectionTitleBlock}>
            <h2 class={shared.sectionTitle}>
              Archive-only Sessions{' '}
              {archived.length > 0 && <span class={shared.countBadge}>{archived.length}</span>}
            </h2>
            <p class={shared.sectionSubtitle}>
              Sessions whose original JSONL is no longer available — served from the archive when viewed.
            </p>
          </div>
        </div>

        <div class={shared.field}>
          <div class={shared.listToolbar}>
            <div class={shared.listSearchWrap}>
              <span class={shared.listSearchIcon}><Search size={12} /></span>
              <input
                class={shared.listSearchInput}
                type="text"
                placeholder="Filter by nickname, ID, or project…"
                value={filter}
                onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
              />
            </div>
            <select
              class={shared.listSort}
              value={sortMode}
              onChange={(e) => setSortMode((e.target as HTMLSelectElement).value as SortMode)}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="largest">Largest first</option>
              <option value="nickname">By nickname</option>
            </select>
            <span class={shared.listCount}>
              {filteredSorted.length === archived.length
                ? `${archived.length} session${archived.length === 1 ? '' : 's'}`
                : `${filteredSorted.length} of ${archived.length}`}
            </span>
          </div>

          {archivedLoading ? (
            <p class={shared.description}>Loading archived sessions…</p>
          ) : archivedError ? (
            <div class={shared.error}>{archivedError}</div>
          ) : filteredSorted.length === 0 ? (
            <div class={shared.scrollList}>
              <div class={shared.listEmpty}>
                {archived.length === 0
                  ? (backupEnabled
                    ? 'No archive-only sessions yet. Sessions appear here when their original JSONL has been pruned upstream.'
                    : 'Backup is disabled — enable it above to start mirroring session files.')
                  : 'No sessions match the filter.'}
              </div>
            </div>
          ) : (
            <div class={shared.scrollList}>
              {filteredSorted.map((s) => (
                <div key={s.id} class={shared.listRow}>
                  <div class={shared.rowInfo}>
                    <div class={shared.rowPrimary}>
                      <span class={`${shared.rowName} ${!s.nickname ? shared.rowNameMuted : ''}`}>
                        {s.nickname ?? 'unnamed'}
                      </span>
                      <span class={shared.rowIdChip}>{s.session_id.slice(0, 8)}</span>
                    </div>
                    <span class={shared.rowMeta}>
                      {formatDate(s.updated_at)} · {s.size_human}
                      {s.project_handle ? ` · ${s.project_handle}` : s.project_name ? ` · ${s.project_name}` : ''}
                    </span>
                  </div>
                  <div class={shared.rowActions}>
                    <a
                      href={`/sessions/${s.id}`}
                      target="_blank"
                      rel="noopener"
                      class={shared.iconBtn}
                      title="Open session in new tab"
                    >
                      <ExternalLink size={14} />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <p class={shared.servedByHint}>
          Served by <code>GET /api/backups/sessions</code>
        </p>
      </div>

      <div class={shared.section}>
        <div class={shared.sectionHeader}>
          <div class={shared.sectionTitleBlock}>
            <h2 class={shared.sectionTitle}>Largest Archived Files</h2>
            <p class={shared.sectionSubtitle}>
              Top 10 by size. Open in a new tab to inspect — files without a matching session in the database show no link.
            </p>
          </div>
        </div>

        <div class={shared.field}>
          {archivedLoading ? (
            <p class={shared.description}>Loading…</p>
          ) : largestFiles.length === 0 ? (
            <div class={shared.scrollList}>
              <div class={shared.listEmpty}>No archived files yet.</div>
            </div>
          ) : (
            <div class={shared.scrollList} data-testid="session-files--largest-list">
              {largestFiles.map((f) => (
                <div key={f.archive_path} class={shared.listRow}>
                  <div class={shared.rowInfo}>
                    <div class={shared.rowPrimary}>
                      <span class={shared.rowFilename} title={f.relative_path}>
                        {f.nickname ?? f.filename}
                      </span>
                      {f.nickname && (
                        <span class={shared.rowIdChip}>{f.session_id?.slice(0, 8) ?? ''}</span>
                      )}
                    </div>
                    <span class={shared.rowMeta}>
                      {f.size_human} · {f.assistant_handle || 'unknown'}
                      {f.project_handle ? ` · ${f.project_handle}` : f.project_name ? ` · ${f.project_name}` : ''}
                    </span>
                  </div>
                  <div class={shared.rowActions}>
                    {f.session_db_id ? (
                      <a
                        href={`/sessions/${f.session_db_id}`}
                        target="_blank"
                        rel="noopener"
                        class={shared.iconBtn}
                        title="Open session in new tab"
                      >
                        <ExternalLink size={14} />
                      </a>
                    ) : (
                      <button
                        type="button"
                        class={shared.iconBtn}
                        title="Reveal in Finder"
                        onClick={async () => {
                          try {
                            await revealArchivedSessionInFinder(f.archive_path)
                          } catch (err) {
                            console.error('Failed to reveal in Finder', err)
                          }
                        }}
                      >
                        <FolderOpen size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <div class={shared.error}>{error}</div>}
      {success && <div class={shared.success}>Settings saved successfully</div>}

      <div class={shared.actionBar} data-testid="session-files--action-bar">
        {hasChanges ? (
          <span class={shared.modifiedIndicator} data-testid="session-files--modified-indicator">
            <span class={shared.modifiedIndicatorDot} />
            Unsaved changes
          </span>
        ) : (
          <span class={shared.pristineIndicator} data-testid="session-files--pristine-indicator">
            No pending changes
          </span>
        )}
        <div class={shared.actionBarRight}>
          <span class={shared.shortcutHint}>
            {hasChanges ? '⌘S to save · Esc to revert' : '⌘S to save'}
          </span>
          <button
            class={shared.saveButton}
            data-testid="session-files--save-button"
            type="button"
            onClick={handleSave}
            disabled={!hasChanges || saving}
          >
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </div>
    </>
  )
}
