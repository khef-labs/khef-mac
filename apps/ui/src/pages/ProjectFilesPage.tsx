import { useState, useEffect, useMemo } from 'preact/hooks'
import { ArrowUpDown, File, Image, FileVideo, FileAudio, FileText, FileSpreadsheet, Trash2, Upload, AlertTriangle } from 'lucide-preact'
import clsx from 'clsx'
import { getProject, getProjectFiles, uploadFile, deleteFile, cleanupFiles } from '../lib/api'
import type { ProjectFile } from '../lib/api'
import type { Project } from '../types'
import { cardStyles, ConfirmModal, useToast } from '../components/ui'
import { PageHeader } from '../components/layout'
import styles from './ProjectFilesPage.module.css'

type SortField = 'filename' | 'size' | 'mime_type' | 'created_at'
type SortOrder = 'asc' | 'desc'

interface Props {
  projectId: string
}

function formatDate(dateString: string): string {
  const date = new Date(dateString)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return Image
  if (mimeType.startsWith('video/')) return FileVideo
  if (mimeType.startsWith('audio/')) return FileAudio
  if (mimeType === 'text/csv' || mimeType.includes('spreadsheet')) return FileSpreadsheet
  if (mimeType === 'application/pdf' || mimeType.startsWith('text/') || mimeType.includes('document')) return FileText
  return File
}

function getMimeLabel(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': 'PNG',
    'image/jpeg': 'JPEG',
    'image/gif': 'GIF',
    'image/webp': 'WebP',
    'audio/mpeg': 'MP3',
    'audio/wav': 'WAV',
    'audio/ogg': 'OGG',
    'video/mp4': 'MP4',
    'video/webm': 'WebM',
    'video/quicktime': 'MOV',
    'application/pdf': 'PDF',
    'text/csv': 'CSV',
    'text/plain': 'Text',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  }
  return map[mimeType] || mimeType.split('/').pop()?.toUpperCase() || mimeType
}

export function ProjectFilesPage({ projectId }: Props) {
  const { showToast } = useToast()
  const [project, setProject] = useState<Project | null>(null)
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProjectFile | null>(null)
  const [sortField, setSortField] = useState<SortField>('created_at')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false)

  const sortedFiles = useMemo(() => {
    const list = [...files]
    list.sort((a, b) => {
      let cmp = 0
      if (sortField === 'filename') {
        cmp = a.filename.localeCompare(b.filename)
      } else if (sortField === 'size') {
        cmp = a.size - b.size
      } else if (sortField === 'mime_type') {
        cmp = a.mime_type.localeCompare(b.mime_type)
      } else {
        const dateA = new Date(a.created_at).getTime()
        const dateB = new Date(b.created_at).getTime()
        cmp = dateA - dateB
      }
      return sortOrder === 'asc' ? cmp : -cmp
    })
    return list
  }, [files, sortField, sortOrder])

  const totalSize = useMemo(() => files.reduce((sum, f) => sum + f.size, 0), [files])
  const orphanCount = useMemo(() => files.filter((f) => !f.exists_on_disk).length, [files])

  const loadFiles = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await getProjectFiles(projectId)
      setFiles(res.files)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    getProject(projectId).then(p => setProject(p)).catch(() => {})
    loadFiles()
  }, [projectId])

  const handleUpload = async (e: Event) => {
    const input = e.target as HTMLInputElement
    const fileList = input.files
    if (!fileList || fileList.length === 0) return

    setIsUploading(true)
    setError(null)
    let uploaded = 0

    try {
      for (const file of Array.from(fileList)) {
        const res = await uploadFile(projectId, file)
        setFiles((prev) => [{
          id: res.id,
          url: res.url,
          filename: res.filename,
          mime_type: res.mime_type,
          size: res.size,
          created_at: res.created_at,
          exists_on_disk: true,
        }, ...prev])
        uploaded++
      }
      showToast(`Uploaded ${uploaded} file${uploaded === 1 ? '' : 's'}`)
    } catch (err: any) {
      const msg = err?.response
        ? await err.response.text().catch(() => 'Upload failed')
        : err instanceof Error ? err.message : 'Upload failed'
      try {
        const parsed = JSON.parse(msg)
        setError(parsed.error || msg)
      } catch {
        setError(msg)
      }
    } finally {
      setIsUploading(false)
      input.value = ''
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await deleteFile(projectId, deleteTarget.id)
      setFiles((prev) => prev.filter((f) => f.id !== deleteTarget.id))
      showToast('File deleted')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete file')
    } finally {
      setDeleteTarget(null)
    }
  }

  const handleCleanup = async () => {
    try {
      const res = await cleanupFiles(projectId)
      setFiles((prev) => prev.filter((f) => f.exists_on_disk))
      showToast(`Removed ${res.removed} orphaned record${res.removed === 1 ? '' : 's'}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cleanup files')
    } finally {
      setShowCleanupConfirm(false)
    }
  }

  const isPreviewable = (mimeType: string) =>
    mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType.startsWith('audio/')

  return (
    <div class={styles.page}>
      <header class={styles.header}>
        <PageHeader
          title="Files"
          subtitle={files.length > 0 ? `${files.length} file${files.length === 1 ? '' : 's'} · ${formatSize(totalSize)} total` : undefined}
          breadcrumbs={[{ label: 'Projects', href: '/projects' }, { label: project?.display_name || project?.name || projectId, href: `/projects/${projectId}` }]}
        >
          <div class={styles.titleActions}>
            <div class={styles.sortControl}>
              <ArrowUpDown size={13} class={styles.sortIcon} />
              <select
                class={styles.sortSelect}
                value={`${sortField}:${sortOrder}`}
                onChange={(e) => {
                  const [field, order] = (e.target as HTMLSelectElement).value.split(':') as [SortField, SortOrder]
                  setSortField(field)
                  setSortOrder(order)
                }}
              >
                <option value="filename:asc">Name A-Z</option>
                <option value="filename:desc">Name Z-A</option>
                <option value="size:desc">Largest</option>
                <option value="size:asc">Smallest</option>
                <option value="mime_type:asc">Type A-Z</option>
                <option value="created_at:desc">Newest</option>
                <option value="created_at:asc">Oldest</option>
              </select>
            </div>
            <label class={styles.uploadButton}>
              <Upload size={16} />
              {isUploading ? 'Uploading...' : 'Upload'}
              <input
                type="file"
                multiple
                class={styles.fileInput}
                onChange={handleUpload}
                disabled={isUploading}
              />
            </label>
          </div>
        </PageHeader>
      </header>

      {orphanCount > 0 && (
        <div class={styles.orphanBanner}>
          <AlertTriangle size={16} />
          <span>
            {orphanCount} file{orphanCount === 1 ? '' : 's'} missing from disk
          </span>
          <button
            class={styles.cleanupButton}
            onClick={() => setShowCleanupConfirm(true)}
          >
            Clean up
          </button>
        </div>
      )}

      {error && <div class={styles.error}>{error}</div>}

      {isLoading ? (
        <div class={styles.loading}>Loading files...</div>
      ) : sortedFiles.length === 0 ? (
        <div class={styles.empty}>
          <File size={48} />
          <p>No files uploaded</p>
          <p class={styles.hint}>Upload images, documents, audio, or video files</p>
        </div>
      ) : (
        <div class={styles.list}>
          {sortedFiles.map((file) => {
            const Icon = getFileIcon(file.mime_type)
            return (
              <div key={file.id} class={clsx(cardStyles.card, styles.fileCard, !file.exists_on_disk && styles.missingFile)}>
                <div class={styles.filePreview}>
                  {!file.exists_on_disk ? (
                    <AlertTriangle size={28} class={styles.missingIcon} />
                  ) : file.mime_type.startsWith('image/') ? (
                    <img
                      src={`${file.url}`}
                      alt={file.filename}
                      class={styles.thumbnail}
                      loading="lazy"
                    />
                  ) : (
                    <Icon size={28} class={styles.fileIcon} />
                  )}
                </div>
                <div class={styles.cardContent}>
                  <div class={styles.cardTitle}>
                    {!file.exists_on_disk ? (
                      <span class={styles.missingLabel}>{file.filename}</span>
                    ) : isPreviewable(file.mime_type) ? (
                      <a
                        href={`${file.url}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        class={styles.fileLink}
                      >
                        {file.filename}
                      </a>
                    ) : (
                      <a
                        href={`${file.url}`}
                        download={file.filename}
                        class={styles.fileLink}
                      >
                        {file.filename}
                      </a>
                    )}
                  </div>
                  <div class={styles.cardMeta}>
                    <span class={styles.mimeLabel}>{getMimeLabel(file.mime_type)}</span>
                    <span>{formatSize(file.size)}</span>
                    <span>{formatDate(file.created_at)}</span>
                    {!file.exists_on_disk && <span class={styles.missingBadge}>Missing</span>}
                  </div>
                </div>
                <button
                  class={styles.deleteButton}
                  title="Delete file"
                  onClick={() => setDeleteTarget(file)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete File"
          message={`Delete "${deleteTarget.filename}"? This will remove the file from disk and cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {showCleanupConfirm && (
        <ConfirmModal
          title="Clean Up Orphaned Files"
          message={`Remove ${orphanCount} database record${orphanCount === 1 ? '' : 's'} for files no longer on disk? No files will be deleted.`}
          confirmLabel="Clean up"
          variant="danger"
          onConfirm={handleCleanup}
          onCancel={() => setShowCleanupConfirm(false)}
        />
      )}
    </div>
  )
}
