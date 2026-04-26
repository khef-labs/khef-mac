import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import { useSearch } from 'wouter-preact'
import { GitBranch, GitCompare, RefreshCw, Copy, Check, ChevronsUpDown, ChevronsDownUp, ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-preact'
import { getProject, getGitBranches, checkoutBranch } from '../lib/api'
import { useToast } from '../components/ui/Toast'
import { setEditorDeepLink } from '../lib/editorDeepLink'
import { loadStore, saveStore } from '../lib/store'
import type { Project } from '../types'
import { useCommits, useDiff, useDiffComments } from '../hooks'
import { CommitList, DiffViewer } from '../components/diff'
import { PageHeader } from '../components/layout'
import styles from './ProjectDiffPage.module.css'

type DiffMode = 'commits' | 'branch'

interface Props {
  projectId: string
}

const SIDEBAR_MIN = 240
const SIDEBAR_MAX = 600
const SIDEBAR_DEFAULT = 360

function loadSidebarWidth(): number {
  const raw = loadStore().diff.sidebarWidth
  if (Number.isNaN(raw)) return SIDEBAR_DEFAULT
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, raw))
}

export function ProjectDiffPage({ projectId }: Props) {
  const searchString = useSearch()
  const initialCommit = new URLSearchParams(searchString).get('commit') || null

  const [project, setProject] = useState<Project | null>(null)
  const [selectedSha, setSelectedSha] = useState<string | null>(initialCommit)
  const [activeCommentLine, setActiveCommentLine] = useState<{ path: string; line: number } | null>(null)
  const [copiedSha, setCopiedSha] = useState(false)
  const [allExpanded, setAllExpanded] = useState(false)
  const [bodyExpanded, setBodyExpanded] = useState(false)
  const [commitPickerVisible, setCommitPickerVisible] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => loadSidebarWidth())
  const [isDraggingSidebar, setIsDraggingSidebar] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const [diffMode, setDiffMode] = useState<DiffMode>('commits')
  const [baseBranch, setBaseBranch] = useState<string | null>(null)
  const [availableBranches, setAvailableBranches] = useState<string[]>([])
  const [currentBranch, setCurrentBranch] = useState<string>('')
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null)
  const [branchSwitcherOpen, setBranchSwitcherOpen] = useState(false)
  const [checkoutLoading, setCheckoutLoading] = useState(false)
  const { showToast } = useToast()
  const branchDropdownRef = useRef<HTMLDivElement>(null)

  // Load project info
  useEffect(() => {
    getProject(projectId)
      .then(setProject)
      .catch(() => {})
  }, [projectId])

  // Fetch available branches
  useEffect(() => {
    if (!projectId) return
    getGitBranches(projectId)
      .then((res) => {
        setAvailableBranches(res.branches)
        setCurrentBranch(res.current)
        setDefaultBranch(res.default)
      })
      .catch(() => {})
  }, [projectId])

  // Close branch dropdown on outside click
  useEffect(() => {
    if (!branchSwitcherOpen) return
    const handleClick = (e: MouseEvent) => {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setBranchSwitcherOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [branchSwitcherOpen])

  // Commits hook
  const {
    commits,
    branch,
    hasUncommitted,
    uncommittedChecked,
    isLoading: commitsLoading,
    error: commitsError,
    hasMore,
    loadMore,
    refresh: refreshCommits,
  } = useCommits({ projectId, targetSha: initialCommit })

  // For uncommitted changes, pass null as commitSha
  const actualCommitSha = selectedSha === 'uncommitted' ? null : selectedSha

  // Diff hook
  const {
    parsedFiles,
    isLoading: diffLoading,
    error: diffError,
    refetch: refetchDiff,
    workingTreeMode,
    setWorkingTreeMode,
    isWorkingTree,
    hasStaged,
    hasUnstaged,
    hasUntracked,
    branchDiffData,
  } = useDiff({
    projectId,
    commitSha: diffMode === 'branch' ? null : actualCommitSha,
    branch,
    baseBranch: diffMode === 'branch' ? baseBranch : null,
  })

  // Comments hook - diff record is created on first comment
  const {
    commentInput,
    setCommentInput,
    isSubmitting,
    error: commentError,
    setLineAnchor,
    clearAnchor,
    submitComment,
    fetchComments,
    getLineComments,
    getLineCommentCount,
  } = useDiffComments({
    projectId,
    commitSha: actualCommitSha,
    branch,
  })

  // Handle mode switch
  const handleModeChange = useCallback((mode: DiffMode) => {
    setDiffMode(mode)
    if (mode === 'branch' && !baseBranch && defaultBranch) {
      // Auto-select default branch as base when switching to branch mode
      setBaseBranch(defaultBranch)
    }
    setActiveCommentLine(null)
    clearAnchor()
  }, [baseBranch, defaultBranch, clearAnchor])

  // Handle commit selection
  const handleSelectCommit = useCallback((sha: string) => {
    setSelectedSha(sha)
    setActiveCommentLine(null)
    setBodyExpanded(false)
    clearAnchor()
  }, [clearAnchor])

  // Handle line click for commenting
  const handleLineClick = useCallback((path: string, line: number) => {
    // Toggle if clicking the same line
    if (activeCommentLine?.path === path && activeCommentLine?.line === line) {
      setActiveCommentLine(null)
      clearAnchor()
    } else {
      setActiveCommentLine({ path, line })
      setLineAnchor(path, line)
    }
  }, [activeCommentLine, setLineAnchor, clearAnchor])

  // Handle comment submit
  const handleCommentSubmit = useCallback(async () => {
    await submitComment()
    setActiveCommentLine(null)
    await fetchComments()
  }, [submitComment, fetchComments])

  // Handle comment cancel
  const handleCommentCancel = useCallback(() => {
    setActiveCommentLine(null)
    clearAnchor()
    setCommentInput('')
  }, [clearAnchor, setCommentInput])

  // Open file in editor (new browser tab)
  const handleOpenInEditor = useCallback((filePath: string) => {
    setEditorDeepLink({ path: filePath, root: project?.path || undefined })
    window.open('/editor', '_blank')
  }, [project])

  // Copy commit SHA to clipboard
  const handleCopySha = useCallback(async () => {
    if (!selectedSha || selectedSha === 'uncommitted') return
    try {
      await navigator.clipboard.writeText(selectedSha)
      setCopiedSha(true)
      setTimeout(() => setCopiedSha(false), 2000)
    } catch {
      // ignore
    }
  }, [selectedSha])

  // Handle branch checkout
  const handleCheckout = useCallback(async (targetBranch: string) => {
    if (targetBranch === currentBranch || !projectId) return
    setCheckoutLoading(true)
    try {
      const result = await checkoutBranch(projectId, targetBranch)
      setCurrentBranch(result.current)
      setBranchSwitcherOpen(false)
      setSelectedSha(null)
      refreshCommits()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Checkout failed'
      // ky wraps errors — try to extract the API error
      const httpErr = err as any
      let errorMsg = message
      if (httpErr?.response?.json) {
        try {
          const body = await httpErr.response.json()
          errorMsg = body.error || message
        } catch { /* use default */ }
      }
      showToast(errorMsg, undefined, { variant: 'error', persistent: true })
    } finally {
      setCheckoutLoading(false)
    }
  }, [projectId, currentBranch, refreshCommits, showToast])

  // Auto-select: uncommitted changes if available, otherwise first commit
  useEffect(() => {
    if (selectedSha || !branch || !uncommittedChecked) return

    if (hasUncommitted) {
      setSelectedSha('uncommitted')
    } else if (commits.length > 0) {
      setSelectedSha(commits[0].sha)
    }
  }, [commits, selectedSha, branch, hasUncommitted, uncommittedChecked])

  // Sidebar resize handling
  useEffect(() => {
    if (!isDraggingSidebar) return
    const handleMove = (e: MouseEvent) => {
      if (!contentRef.current) return
      const rect = contentRef.current.getBoundingClientRect()
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX - rect.left))
      setSidebarWidth(next)
    }
    const handleUp = () => {
      setIsDraggingSidebar(false)
      saveStore({ diff: { sidebarWidth } })
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isDraggingSidebar, sidebarWidth])

  const handleSidebarResetWidth = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT)
    saveStore({ diff: { sidebarWidth: SIDEBAR_DEFAULT } })
  }, [])

  const selectedCommit = selectedSha && selectedSha !== 'uncommitted'
    ? commits.find(c => c.sha === selectedSha) || null
    : null

  const headerBlock = (
    <>
      <header class={styles.header}>
        <PageHeader
          title="Code Review"
          breadcrumbs={[{ label: 'Projects', href: '/projects' }, { label: project?.display_name || project?.name || projectId, href: `/projects/${projectId}` }]}
        >
          <button
            type="button"
            class={styles.refreshButton}
            onClick={() => { refreshCommits(); refetchDiff(); }}
            disabled={commitsLoading || diffLoading}
            title="Refresh"
          >
            <RefreshCw size={16} class={commitsLoading || diffLoading ? styles.spinning : ''} />
          </button>
        </PageHeader>
        <div class={styles.subHeaderRow}>
          {branch && (
            <div class={styles.branchSwitcher} ref={branchDropdownRef}>
              <button
                type="button"
                class={styles.branchButton}
                onClick={() => setBranchSwitcherOpen((v) => !v)}
                disabled={checkoutLoading}
                data-testid="diff-page--branch-button"
              >
                <GitBranch size={14} />
                <span>{currentBranch || branch}</span>
                <ChevronDown size={12} />
              </button>
              {branchSwitcherOpen && (
                <div class={styles.branchDropdown} data-testid="diff-page--branch-dropdown">
                  {availableBranches.map((b) => (
                    <button
                      key={b}
                      type="button"
                      class={`${styles.branchOption} ${b === currentBranch ? styles.branchOptionActive : ''}`}
                      onClick={() => handleCheckout(b)}
                      disabled={b === currentBranch || checkoutLoading}
                    >
                      {b}
                      {b === currentBranch && <Check size={12} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div class={styles.modeSwitch} data-testid="diff-page--mode-switch">
            <button
              type="button"
              class={`${styles.modeButton} ${diffMode === 'commits' ? styles.modeActive : ''}`}
              onClick={() => handleModeChange('commits')}
              data-testid="diff-page--mode-commits"
            >
              Commits
            </button>
            <button
              type="button"
              class={`${styles.modeButton} ${diffMode === 'branch' ? styles.modeActive : ''}`}
              onClick={() => handleModeChange('branch')}
              data-testid="diff-page--mode-branch"
            >
              <GitCompare size={14} />
              Branch
            </button>
          </div>
          {diffMode === 'commits' && (
            <button
              type="button"
              class={styles.commitPickerToggle}
              onClick={() => setCommitPickerVisible((v) => !v)}
              title={commitPickerVisible ? 'Hide commit picker' : 'Show commit picker'}
            >
              {commitPickerVisible ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
              <span>{commitPickerVisible ? 'Hide commits' : 'Show commits'}</span>
            </button>
          )}
        </div>
      </header>
      {commitsError && (
        <div class={styles.error}>{commitsError}</div>
      )}
    </>
  )

  return (
    <div
      ref={contentRef}
      class={`${styles.page} ${(diffMode === 'commits' && !commitPickerVisible) || diffMode === 'branch' ? styles.pageFull : ''}`}
      style={
        (diffMode === 'commits' && commitPickerVisible)
          ? { gridTemplateColumns: `${sidebarWidth}px 6px 1fr` }
          : undefined
      }
    >
      {diffMode === 'commits' && commitPickerVisible && (
        <>
          <aside class={styles.sidebar}>
            <CommitList
              commits={commits}
              selectedSha={selectedSha}
              onSelectCommit={handleSelectCommit}
              isLoading={commitsLoading}
              hasMore={hasMore}
              onLoadMore={loadMore}
              hasUncommitted={hasUncommitted}
            />
          </aside>
          <div
            class={`${styles.resizeHandle} ${isDraggingSidebar ? styles.resizeHandleActive : ''}`}
            onMouseDown={(e) => { e.preventDefault(); setIsDraggingSidebar(true) }}
            onDblClick={handleSidebarResetWidth}
            title="Drag to resize · double-click to reset"
            role="separator"
            aria-orientation="vertical"
          />
        </>
      )}

      <main class={styles.main}>
        {headerBlock}
          {diffMode === 'branch' ? (
            <>
              <div class={styles.commitHeader}>
                <div class={styles.commitInfo}>
                  <div class={styles.branchDiffHeader}>
                    <label class={styles.baseLabel}>Base:</label>
                    <select
                      class={styles.branchSelect}
                      value={baseBranch || ''}
                      onChange={(e) => setBaseBranch((e.target as HTMLSelectElement).value || null)}
                    >
                      <option value="">Select base branch</option>
                      {availableBranches
                        .filter((b) => b !== currentBranch)
                        .map((b) => (
                          <option key={b} value={b}>{b}</option>
                        ))}
                    </select>
                    <span class={styles.branchDiffArrow}>...</span>
                    <span class={styles.branchDiffHead}>{currentBranch || 'HEAD'}</span>
                    {branchDiffData && (
                      <span class={styles.branchDiffStats}>
                        {branchDiffData.commits.length} commit{branchDiffData.commits.length !== 1 ? 's' : ''},
                        {' '}{branchDiffData.stats.files} file{branchDiffData.stats.files !== 1 ? 's' : ''}
                        {branchDiffData.stats.insertions > 0 && (
                          <span class={styles.statAdd}> +{branchDiffData.stats.insertions}</span>
                        )}
                        {branchDiffData.stats.deletions > 0 && (
                          <span class={styles.statDel}> -{branchDiffData.stats.deletions}</span>
                        )}
                      </span>
                    )}
                  </div>
                  <div class={styles.viewControls}>
                    <button
                      type="button"
                      class={styles.expandButton}
                      onClick={() => setAllExpanded(!allExpanded)}
                      title={allExpanded ? 'Collapse all' : 'Expand all'}
                    >
                      {allExpanded ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
                    </button>
                  </div>
                </div>
              </div>

              {branchDiffData?.truncated && (
                <div class={styles.truncationWarning}>
                  Showing {branchDiffData.truncated.limit} of {branchDiffData.truncated.total} files
                  (diff too large to display in full)
                </div>
              )}

              {commentError && (
                <div class={styles.commentError}>{commentError}</div>
              )}

              <div class={styles.diffContent}>
                <DiffViewer
                  files={parsedFiles}
                  isLoading={diffLoading}
                  error={diffError}
                  getLineComments={getLineComments}
                  getLineCommentCount={getLineCommentCount}
                  onLineClick={handleLineClick}
                  activeCommentLine={activeCommentLine}
                  commentInput={commentInput}
                  onCommentInputChange={setCommentInput}
                  onCommentSubmit={handleCommentSubmit}
                  onCommentCancel={handleCommentCancel}
                  isSubmitting={isSubmitting}
                  allExpanded={allExpanded}
                  onOpenInEditor={handleOpenInEditor}
                />
              </div>
            </>
          ) : selectedSha ? (
            <>
              <div class={styles.commitHeader}>
                <div class={styles.commitInfo} data-testid="diff-page--commit-info">
                  {selectedSha === 'uncommitted' ? (
                    <>
                      <span class={styles.uncommittedLabel} data-testid="diff-page--uncommitted-label">Uncommitted changes</span>
                      {isWorkingTree && (
                        <div class={styles.modeSwitch} data-testid="diff-page--working-tree-mode-switch">
                          <button
                            type="button"
                            class={`${styles.modeButton} ${workingTreeMode === 'combined' ? styles.modeActive : ''}`}
                            onClick={() => setWorkingTreeMode('combined')}
                            disabled={!hasStaged && !hasUnstaged}
                          >
                            All
                          </button>
                          <button
                            type="button"
                            class={`${styles.modeButton} ${workingTreeMode === 'staged' ? styles.modeActive : ''}`}
                            onClick={() => setWorkingTreeMode('staged')}
                            disabled={!hasStaged}
                          >
                            Staged
                          </button>
                          <button
                            type="button"
                            class={`${styles.modeButton} ${workingTreeMode === 'unstaged' ? styles.modeActive : ''}`}
                            onClick={() => setWorkingTreeMode('unstaged')}
                            disabled={!hasUnstaged}
                          >
                            Unstaged
                          </button>
                          <button
                            type="button"
                            class={`${styles.modeButton} ${workingTreeMode === 'untracked' ? styles.modeActive : ''}`}
                            onClick={() => setWorkingTreeMode('untracked')}
                            disabled={!hasUntracked}
                          >
                            Untracked
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {(() => {
                        const hasBody = selectedCommit?.body && selectedCommit.body.trim().length > 0
                        const initial = selectedCommit?.author?.trim().charAt(0).toUpperCase() || '?'
                        const s = selectedCommit?.stats
                        return (
                          <div class={styles.commitInfoRow}>
                            <code class={styles.sha}>{selectedSha.slice(0, 8)}</code>
                            <button
                              type="button"
                              class={styles.copyButton}
                              onClick={handleCopySha}
                              title="Copy full SHA"
                            >
                              {copiedSha ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                            {hasBody && (
                              <button
                                type="button"
                                class={styles.expandBodyToggle}
                                onClick={() => setBodyExpanded(!bodyExpanded)}
                                title={bodyExpanded ? 'Collapse message' : 'Expand message'}
                              >
                                {bodyExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </button>
                            )}
                            <span class={styles.message}>
                              {selectedCommit?.message}
                            </span>
                            {selectedCommit && (
                              <div class={styles.headerMeta}>
                                <span class={styles.headerAvatar} title={selectedCommit.author}>{initial}</span>
                                <span class={styles.headerAuthor}>{selectedCommit.author}</span>
                                {s && (
                                  <>
                                    <span class={styles.headerSep}>·</span>
                                    <span class={styles.headerFiles}>
                                      {s.files} file{s.files !== 1 ? 's' : ''}
                                    </span>
                                    {s.insertions > 0 && (
                                      <span class={styles.statAdd}>+{s.insertions}</span>
                                    )}
                                    {s.deletions > 0 && (
                                      <span class={styles.statDel}>−{s.deletions}</span>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </>
                  )}
                  <div class={styles.viewControls}>
                    <button
                      type="button"
                      class={styles.expandButton}
                      onClick={() => setAllExpanded(!allExpanded)}
                      title={allExpanded ? 'Collapse all' : 'Expand all'}
                    >
                      {allExpanded ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
                    </button>
                  </div>
                </div>
                {selectedSha !== 'uncommitted' && bodyExpanded && selectedCommit?.body && (
                  <div class={styles.commitBody}>{selectedCommit.body}</div>
                )}
              </div>

              {commentError && (
                <div class={styles.commentError}>{commentError}</div>
              )}

              <div class={styles.diffContent}>
                <DiffViewer
                  files={parsedFiles}
                  isLoading={diffLoading}
                  error={diffError}
                  getLineComments={getLineComments}
                  getLineCommentCount={getLineCommentCount}
                  onLineClick={handleLineClick}
                  activeCommentLine={activeCommentLine}
                  commentInput={commentInput}
                  onCommentInputChange={setCommentInput}
                  onCommentSubmit={handleCommentSubmit}
                  onCommentCancel={handleCommentCancel}
                  isSubmitting={isSubmitting}
                  allExpanded={allExpanded}
                  isUntrackedView={workingTreeMode === 'untracked'}
                  onOpenInEditor={handleOpenInEditor}
                />
              </div>
            </>
          ) : (
            <div class={styles.empty}>
              Select a commit to view changes
            </div>
          )}
      </main>
    </div>
  )
}
