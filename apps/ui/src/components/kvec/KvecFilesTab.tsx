import { useEffect, useState, useCallback } from 'preact/hooks'
import {
  Search, X, Trash2, Info,
  ChevronLeft, ChevronRight,
} from 'lucide-preact'
import {
  getKvecCollection,
  getKvecFiles,
  getKvecLanguages,
  deleteKvecFile,
  bulkDeleteKvecFiles,
} from '../../lib/api'
import type {
  KvecCollection,
  KvecFile,
  KvecLanguageStat,
  Pagination,
} from '../../types'
import { ConfirmModal } from '../ui'
import { formatBytes, formatTimeAgo } from './kvec-utils'
import styles from './KvecFilesTab.module.css'

interface PathPrefix {
  prefix: string
  count: number
}

interface Props {
  collectionName: string
  repos: Array<{ name: string }>
  showReposTab: boolean
  pathPrefixes: PathPrefix[]
  onFilterByRepo: (repoName: string) => void
  onFilterByPath: (path: string) => void
  onCollectionRefresh: (collection: KvecCollection) => void
}

export function KvecFilesTab({
  collectionName,
  repos,
  showReposTab,
  pathPrefixes,
  onFilterByRepo: _onFilterByRepo,
  onFilterByPath: _onFilterByPath,
  onCollectionRefresh,
}: Props) {
  const [files, setFiles] = useState<KvecFile[]>([])
  const [filesPagination, setFilesPagination] = useState<Pagination | null>(null)
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesOffset, setFilesOffset] = useState(0)
  const [filterRepo, setFilterRepo] = useState('')
  const [filterLanguage, setFilterLanguage] = useState('')
  const [filterQuery, setFilterQuery] = useState('')
  const [filterPath, setFilterPath] = useState('')
  const [deleteFileId, setDeleteFileId] = useState<string | null>(null)
  const [deleteSelectedIds, setDeleteSelectedIds] = useState<string[] | null>(null)
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set())
  const [languages, setLanguages] = useState<KvecLanguageStat[]>([])

  // Load languages for filter
  useEffect(() => {
    getKvecLanguages(collectionName).then((data) => setLanguages(data.languages)).catch(() => {})
  }, [collectionName])

  // Load files
  const loadFiles = useCallback(() => {
    setFilesLoading(true)
    const q = filterPath || filterQuery || undefined
    getKvecFiles(collectionName, {
      repo: filterRepo || undefined,
      language: filterLanguage || undefined,
      q,
      limit: 50,
      offset: filesOffset,
    })
      .then((data) => {
        setFiles(data.files)
        setFilesPagination(data.pagination)
      })
      .catch(() => {})
      .finally(() => setFilesLoading(false))
  }, [collectionName, filterRepo, filterLanguage, filterQuery, filterPath, filesOffset])

  useEffect(() => { loadFiles() }, [loadFiles])

  // Clear file selections when filters, pagination, or collection changes.
  useEffect(() => {
    setSelectedFileIds(new Set())
  }, [collectionName, filesOffset, filterRepo, filterLanguage, filterQuery, filterPath])

  const repoNames = repos.length > 0
    ? repos.map((r) => r.name)
    : [...new Set(files.map((f) => f.repo_name).filter(Boolean))] as string[]

  const hasRepos = files.some((f) => f.repo_name && f.repo_name !== files[0]?.repo_name)
    || (repos.length > 1)
  const hasLanguages = languages.length > 1
  const hasCommits = files.some((f) => f.commit_hash)
  const selectedCount = selectedFileIds.size
  const allVisibleSelected = files.length > 0 && files.every((f) => selectedFileIds.has(f.id))

  const toggleFileSelection = (fileId: string) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }

  const toggleSelectAllVisible = () => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        for (const file of files) next.delete(file.id)
      } else {
        for (const file of files) next.add(file.id)
      }
      return next
    })
  }

  const refreshCollection = () => {
    getKvecCollection(collectionName)
      .then((data) => onCollectionRefresh(data.collection))
      .catch(() => {})
  }

  const handleDeleteFile = async () => {
    if (!deleteFileId) return
    try {
      await deleteKvecFile(collectionName, deleteFileId)
      setSelectedFileIds((prev) => {
        const next = new Set(prev)
        next.delete(deleteFileId)
        return next
      })
      setDeleteFileId(null)
      loadFiles()
      refreshCollection()
    } catch {
      // error handled by parent
    }
  }

  const handleBulkDeleteFiles = async () => {
    if (!deleteSelectedIds || deleteSelectedIds.length === 0) return
    try {
      await bulkDeleteKvecFiles(collectionName, deleteSelectedIds)
      setDeleteSelectedIds(null)
      setSelectedFileIds(new Set())
      loadFiles()
      refreshCollection()
    } catch {
      // error handled by parent
    }
  }

  return (
    <div class={styles.tabContent}>
      <div class={styles.filterBar}>
        {hasRepos && (
          <select
            class={styles.filterSelect}
            value={filterRepo}
            onChange={(e) => { setFilterRepo((e.target as HTMLSelectElement).value); setFilesOffset(0) }}
          >
            <option value="">All repos</option>
            {repoNames.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
        {!showReposTab && pathPrefixes.length > 1 && (
          <select
            class={styles.filterSelect}
            value={filterPath}
            onChange={(e) => { setFilterPath((e.target as HTMLSelectElement).value); setFilesOffset(0) }}
          >
            <option value="">All paths</option>
            {pathPrefixes.map((p) => (
              <option key={p.prefix} value={p.prefix}>{p.prefix} ({p.count})</option>
            ))}
          </select>
        )}
        {hasLanguages && (
          <select
            class={styles.filterSelect}
            value={filterLanguage}
            onChange={(e) => { setFilterLanguage((e.target as HTMLSelectElement).value); setFilesOffset(0) }}
          >
            <option value="">All languages</option>
            {languages.map((l) => (
              <option key={l.language} value={l.language}>{l.language} ({l.count})</option>
            ))}
          </select>
        )}
        <div class={styles.searchInput}>
          <Search size={14} class={styles.searchIcon} />
          <input
            type="text"
            placeholder="Search file paths..."
            value={filterQuery}
            onInput={(e) => {
              setFilterQuery((e.target as HTMLInputElement).value)
              setFilesOffset(0)
            }}
          />
          {filterQuery && (
            <button type="button" class={styles.clearButton} onClick={() => { setFilterQuery(''); setFilesOffset(0) }}>
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {!showReposTab && (
        <div class={styles.pathsInfo}>
          <Info size={14} />
          Paths reflect original session file locations on disk. Files may have been deleted but remain indexed here.
        </div>
      )}

      {filesLoading && files.length === 0 ? (
        <div class={styles.loading}>Loading files...</div>
      ) : files.length === 0 ? (
        <div class={styles.emptyTab}>No files match the current filters</div>
      ) : (
        <>
          {selectedCount > 0 && (
            <div class={styles.selectionBar}>
              <span>{selectedCount} selected</span>
              <button
                type="button"
                class={styles.selectionDeleteButton}
                onClick={() => setDeleteSelectedIds(Array.from(selectedFileIds))}
              >
                <Trash2 size={14} />
                Delete selected
              </button>
            </div>
          )}
          <div class={styles.tableWrap}>
            <table class={styles.table} data-testid="kvec-files--table">
              <thead>
                <tr>
                  <th class={styles.selectCell}>
                    <input
                      type="checkbox"
                      class={styles.checkboxInput}
                      checked={allVisibleSelected}
                      onChange={toggleSelectAllVisible}
                      aria-label="Select all visible files"
                    />
                  </th>
                  <th>Path</th>
                  {hasRepos && <th>Repo</th>}
                  {hasLanguages && <th>Language</th>}
                  <th class={styles.numCell}>Size</th>
                  <th class={styles.numCell}>Chunks</th>
                  {hasCommits && <th class={styles.commitCell}>Commit</th>}
                  <th class={styles.dateCell}>Uploaded</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id}>
                    <td class={styles.selectCell}>
                      <input
                        type="checkbox"
                        class={styles.checkboxInput}
                        checked={selectedFileIds.has(f.id)}
                        onChange={() => toggleFileSelection(f.id)}
                        aria-label={`Select ${f.file_path}`}
                      />
                    </td>
                    <td class={styles.pathCell} title={f.file_path} data-testid="kvec-files--path-cell">
                      {f.status === 'error' && (
                        <span class={styles.errorDot} title={f.error_message || 'Embedding error'} />
                      )}
                      {f.file_path}
                    </td>
                    {hasRepos && <td class={styles.monoCell}>{f.repo_name || '-'}</td>}
                    {hasLanguages && <td>{f.language || '-'}</td>}
                    <td class={styles.numCell}>{formatBytes(f.file_size)}</td>
                    <td class={styles.numCell}>{f.chunk_count}</td>
                    {hasCommits && (
                      <td class={styles.commitCell}>
                        {f.commit_hash ? (
                          <span title={`${f.branch || ''} ${f.commit_hash}`}>
                            {f.branch && <span class={styles.branchName}>{f.branch}</span>}
                            <span class={styles.commitHash}>{f.commit_hash.slice(0, 7)}</span>
                          </span>
                        ) : '-'}
                      </td>
                    )}
                    <td class={styles.dateCell}>{formatTimeAgo(f.uploaded_at)}</td>
                    <td>
                      <button
                        type="button"
                        class={styles.rowDeleteButton}
                        title="Delete file"
                        onClick={() => setDeleteFileId(f.id)}
                        data-testid={`kvec-files--delete-${f.id}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filesPagination && (
            <div class={styles.pagination} data-testid="kvec-files--pagination">
              <span class={styles.paginationInfo} data-testid="kvec-files--pagination-info">
                {filesPagination.offset + 1}-{Math.min(filesPagination.offset + filesPagination.limit, filesPagination.total_count ?? 0)} of {(filesPagination.total_count ?? 0).toLocaleString()}
              </span>
              <div class={styles.paginationButtons}>
                <button
                  type="button"
                  class={styles.paginationButton}
                  disabled={filesPagination.offset === 0}
                  onClick={() => setFilesOffset(Math.max(0, filesOffset - filesPagination.limit))}
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  class={styles.paginationButton}
                  disabled={!filesPagination.has_more}
                  onClick={() => setFilesOffset(filesOffset + filesPagination.limit)}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {deleteFileId && (
        <ConfirmModal
          title="Delete File"
          message="Delete this file and all its chunks? This action cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDeleteFile}
          onCancel={() => setDeleteFileId(null)}
        />
      )}
      {deleteSelectedIds && (
        <ConfirmModal
          title="Delete Selected Files"
          message={`Delete ${deleteSelectedIds.length} selected file${deleteSelectedIds.length === 1 ? '' : 's'} and all chunks? This action cannot be undone.`}
          confirmLabel="Delete Selected"
          variant="danger"
          onConfirm={handleBulkDeleteFiles}
          onCancel={() => setDeleteSelectedIds(null)}
        />
      )}
    </div>
  )
}
