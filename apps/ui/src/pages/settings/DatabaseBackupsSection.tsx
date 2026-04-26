import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { Copy, Trash2, RotateCcw, Search, Plus } from 'lucide-preact'
import { useSettings } from './useSettings'
import { useRegisterDirtySection } from './DirtySectionsContext'
import { getBackups, deleteBackup, createBackup, restoreBackup, type BackupFile } from '../../lib/api'
import { TypeToConfirmModal } from '../../components/ui'
import shared from './SettingsShared.module.css'
import styles from './BackupsSection.module.css'

type SortMode = 'newest' | 'oldest' | 'largest' | 'smallest'

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function totalSize(backups: BackupFile[]): string {
  const bytes = backups.reduce((sum, b) => sum + b.size, 0)
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${parseFloat(value.toFixed(1))} ${units[i]}`
}

function oldestLabel(backups: BackupFile[]): string {
  if (backups.length === 0) return '—'
  const oldest = backups.reduce((a, b) => (a.created_at < b.created_at ? a : b))
  return new Date(oldest.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function DatabaseBackupsSection() {
  const { settings, loading, saving, error, success, save, clearMessages } = useSettings()
  const [backupLocation, setBackupLocation] = useState('')
  const [backups, setBackups] = useState<BackupFile[]>([])
  const [backupsLoading, setBackupsLoading] = useState(false)
  const [backupsError, setBackupsError] = useState<string | null>(null)
  const [deletingBackup, setDeletingBackup] = useState<string | null>(null)
  const [copiedBackup, setCopiedBackup] = useState<string | null>(null)
  const [creatingBackup, setCreatingBackup] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<BackupFile | null>(null)
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null)
  const [restoreResult, setRestoreResult] = useState<string | null>(null)

  const [filter, setFilter] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('newest')

  useEffect(() => {
    if (settings) setBackupLocation(settings.backup.location)
  }, [settings])

  const fetchBackups = useCallback(async () => {
    setBackupsLoading(true)
    setBackupsError(null)
    try {
      const data = await getBackups()
      setBackups(data.backups)
    } catch (err: any) {
      setBackupsError(err?.message || 'Failed to load backups')
    } finally {
      setBackupsLoading(false)
    }
  }, [])

  useEffect(() => { fetchBackups() }, [fetchBackups])

  const dirtyLocation = settings ? backupLocation !== settings.backup.location : false
  const hasChanges = dirtyLocation

  useRegisterDirtySection('database-backups', hasChanges)

  const handleSave = useCallback(async () => {
    if (!hasChanges) return
    await save({ backup: { location: backupLocation.trim() } })
  }, [hasChanges, backupLocation, save])

  const handleRevert = useCallback(() => {
    if (settings) setBackupLocation(settings.backup.location)
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
      ? backups.filter((b) => b.filename.toLowerCase().includes(trimmed))
      : backups
    const copy = [...filtered]
    copy.sort((a, b) => {
      switch (sortMode) {
        case 'newest': return b.created_at.localeCompare(a.created_at)
        case 'oldest': return a.created_at.localeCompare(b.created_at)
        case 'largest': return b.size - a.size
        case 'smallest': return a.size - b.size
      }
    })
    return copy
  }, [backups, filter, sortMode])

  if (loading) return <div class={shared.description}>Loading...</div>

  return (
    <>
      <div class={shared.pageIntro} data-testid="database-backups--intro">
        <h1 class={shared.pageTitle} data-testid="database-backups--title">Database Backups</h1>
        <p class={shared.pageDescription}>
          Snapshots of the khef database — created on demand and automatically before migrations and rollbacks. Used for disaster recovery and safe schema changes.
        </p>
      </div>

      <div class={shared.section}>
        <div class={shared.sectionHeader}>
          <div class={shared.sectionTitleBlock}>
            <h2 class={shared.sectionTitle}>Backup Directory</h2>
            <p class={shared.sectionSubtitle}>
              Where snapshots are written. Relative paths resolve from the API root (<code>apps/api/</code>).
            </p>
          </div>
          <button
            type="button"
            class={shared.primaryButton}
            disabled={creatingBackup}
            onClick={async () => {
              setCreatingBackup(true)
              setBackupsError(null)
              try {
                await createBackup()
                await fetchBackups()
              } catch (err: any) {
                setBackupsError(err?.message || 'Backup failed')
              } finally {
                setCreatingBackup(false)
              }
            }}
          >
            <Plus size={14} />
            {creatingBackup ? 'Creating…' : 'Create Backup'}
          </button>
        </div>

        <div class={shared.field}>
          <div class={shared.fieldLabelRow}>
            <label class={shared.label} htmlFor="backupLocation">Backup Directory</label>
            {dirtyLocation && <span class={shared.fieldDirtyDot} title="Modified from saved value" />}
          </div>
          <input
            id="backupLocation"
            data-testid="database-backups--location-input"
            class={`${shared.inputWide} ${dirtyLocation ? shared.inputDirty : ''}`}
            type="text"
            placeholder="db/backups"
            value={backupLocation}
            onInput={(e) => setBackupLocation((e.target as HTMLInputElement).value)}
          />
          {dirtyLocation && settings && (
            <p class={shared.savedValueHint}>
              Saved value: <em>{settings.backup.location || '(empty)'}</em>
            </p>
          )}
        </div>

        <div class={shared.statsStrip} data-testid="database-backups--stats">
          <div class={shared.stat}>
            <span class={shared.statLabel}>Backups</span>
            <span class={shared.statValue}>{backups.length}</span>
          </div>
          <div class={shared.stat}>
            <span class={shared.statLabel}>Total size</span>
            <span class={shared.statValue}>{totalSize(backups)}</span>
          </div>
          <div class={shared.stat}>
            <span class={shared.statLabel}>Oldest</span>
            <span class={shared.statValue}>{oldestLabel(backups)}</span>
          </div>
        </div>

        <div class={shared.field}>
          <div class={shared.listToolbar}>
            <div class={shared.listSearchWrap}>
              <span class={shared.listSearchIcon}><Search size={12} /></span>
              <input
                class={shared.listSearchInput}
                type="text"
                placeholder="Filter by filename…"
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
              <option value="smallest">Smallest first</option>
            </select>
            <span class={shared.listCount}>
              {filteredSorted.length === backups.length
                ? `${backups.length} file${backups.length === 1 ? '' : 's'}`
                : `${filteredSorted.length} of ${backups.length}`}
            </span>
          </div>

          {backupsLoading ? (
            <p class={shared.description}>Loading backups…</p>
          ) : backupsError ? (
            <div class={shared.error}>{backupsError}</div>
          ) : filteredSorted.length === 0 ? (
            <div class={shared.scrollList}>
              <div class={shared.listEmpty}>
                {backups.length === 0 ? 'No backups found in the configured directory.' : 'No backups match the filter.'}
              </div>
            </div>
          ) : (
            <div class={shared.scrollList}>
              {filteredSorted.map((b) => (
                <div key={b.filename} class={shared.listRow}>
                  <div class={shared.rowInfo}>
                    <div class={shared.rowPrimary}>
                      <span class={shared.rowFilename}>{b.filename}</span>
                    </div>
                    <span class={shared.rowMeta}>{b.size_human} · {formatDate(b.created_at)}</span>
                  </div>
                  <div class={shared.rowActions}>
                    <button
                      type="button"
                      class={shared.iconBtn}
                      title="Copy path"
                      onClick={async () => {
                        await navigator.clipboard.writeText(b.path)
                        setCopiedBackup(b.filename)
                        setTimeout(() => setCopiedBackup(null), 2000)
                      }}
                    >
                      {copiedBackup === b.filename ? <span class={styles.copiedLabel}>Copied</span> : <Copy size={14} />}
                    </button>
                    <button
                      type="button"
                      class={`${shared.iconBtn} ${shared.iconBtnWarn}`}
                      title="Restore from this backup"
                      disabled={restoringBackup !== null}
                      onClick={() => setRestoreTarget(b)}
                    >
                      <RotateCcw size={14} />
                    </button>
                    <button
                      type="button"
                      class={`${shared.iconBtn} ${shared.iconBtnDanger}`}
                      title="Delete backup"
                      disabled={deletingBackup === b.filename || restoringBackup !== null}
                      onClick={async () => {
                        if (!confirm(`Delete backup ${b.filename}?`)) return
                        setDeletingBackup(b.filename)
                        try {
                          await deleteBackup(b.filename)
                          setBackups((prev) => prev.filter((x) => x.filename !== b.filename))
                        } catch (err: any) {
                          setBackupsError(err?.message || 'Failed to delete backup')
                        } finally {
                          setDeletingBackup(null)
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {restoreResult && <div class={shared.syncResult}>{restoreResult}</div>}
          {restoringBackup && (
            <p class={shared.description}>Restoring from {restoringBackup}… This may take a moment.</p>
          )}
        </div>

        <p class={shared.servedByHint}>
          Served by <code>GET /api/backups/db</code>
        </p>
      </div>

      {error && <div class={shared.error}>{error}</div>}
      {success && <div class={shared.success}>Settings saved successfully</div>}

      <div class={shared.actionBar} data-testid="database-backups--action-bar">
        {hasChanges ? (
          <span class={shared.modifiedIndicator} data-testid="database-backups--modified-indicator">
            <span class={shared.modifiedIndicatorDot} />
            Unsaved changes
          </span>
        ) : (
          <span class={shared.pristineIndicator} data-testid="database-backups--pristine-indicator">
            No pending changes
          </span>
        )}
        <div class={shared.actionBarRight}>
          <span class={shared.shortcutHint}>
            {hasChanges ? '⌘S to save · Esc to revert' : '⌘S to save'}
          </span>
          <button
            class={shared.saveButton}
            data-testid="database-backups--save-button"
            type="button"
            onClick={handleSave}
            disabled={!hasChanges || saving}
          >
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </div>

      {restoreTarget && (
        <TypeToConfirmModal
          title="Restore Database"
          message={`This will replace the current database with ${restoreTarget.filename}. A safety backup will be created first. This action cannot be undone.`}
          confirmPhrase={restoreTarget.filename}
          confirmLabel="Restore"
          onCancel={() => setRestoreTarget(null)}
          onConfirm={async () => {
            const target = restoreTarget
            setRestoreTarget(null)
            setRestoringBackup(target.filename)
            setRestoreResult(null)
            setBackupsError(null)
            try {
              const result = await restoreBackup(target.filename)
              setRestoreResult(result.message)
              await fetchBackups()
              setTimeout(() => setRestoreResult(null), 10000)
            } catch (err: any) {
              setBackupsError(err?.message || 'Restore failed')
            } finally {
              setRestoringBackup(null)
            }
          }}
        />
      )}
    </>
  )
}
