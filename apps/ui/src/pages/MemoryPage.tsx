import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks'
import { useLocation, useSearch } from 'wouter-preact'
import { AlertTriangle } from 'lucide-preact'
import clsx from 'clsx'
import { ConfirmModal, useToast } from '../components/ui'
import { AddToCollectionModal } from '../components/shared'
import { SnapshotDiffViewer } from '../components/diff'
import { useDocumentTitle } from '../hooks'
import {
  getMemory,
  getMemoryGraph,
  getProject,
  getProjects,
  getProjectMemoryTypes,
  getMemoryRelations,
  getRelationTypes,
  createComment,
  getAllCollections,
  syncProjectKnowledge,
} from '../lib/api'
import type { DiagramTheme } from '../lib/exportPreferences'
import { useComments } from '../hooks/useComments'
import { useSpeechSynthesis } from '../hooks/useSpeechSynthesis'
import { useTtsHighlight } from '../hooks/useTtsHighlight'
import {
  isUuid,
} from './memory-page/lib'
import { getRandomLoadingMessage } from '../components/ui'
import { useMemoryPageNavigation } from './memory-page/useMemoryPageNavigation'
import { useMemorySnapshots } from './memory-page/useMemorySnapshots'
import { useMemoryRelations } from './memory-page/useMemoryRelations'
import { MemoryRelationsSection } from './memory-page/MemoryRelationsSection'
import { MemoryCommentsSection } from './memory-page/MemoryCommentsSection'
import { MemoryContentSection } from './memory-page/MemoryContentSection'
import { MemoryMetadataSection } from './memory-page/MemoryMetadataSection'
import { SnapshotsManageModal } from './memory-page/SnapshotsManageModal'
import { MemoryTopNav } from './memory-page/MemoryTopNav'
import { MemoryDiagramViewer } from './memory-page/MemoryDiagramViewer'
import { MemorySlideshowOverlay } from './memory-page/MemorySlideshowOverlay'
import { useMemoryPageShortcuts } from './memory-page/useMemoryPageShortcuts'
import { useMemoryMetadataEditor } from './memory-page/useMemoryMetadataEditor'
import { useContentSearch } from './memory-page/useContentSearch'
import { useMemoryContentRenderer } from './memory-page/useMemoryContentRenderer'
import { useMemoryContentEditor } from './memory-page/useMemoryContentEditor'
import type { Memory, GraphData, Project, FlatRelation, RelationTypeInfo, CreateCommentInput } from '../types'
import styles from './MemoryPage.module.css'

interface Props {
  id: string
}

export function MemoryPage({ id }: Props) {
  const [, setLocation] = useLocation()
  const searchString = useSearch()
  const { showToast } = useToast()

  // Collection context from query params (when navigating from a collection)
  const collectionParams = useMemo(() => {
    const params = new URLSearchParams(searchString)
    if (params.get('context') === 'collection') {
      const contextId = params.get('contextId')
      if (contextId) return { collectionId: contextId }
    }
    return null
  }, [searchString])

  const [memory, setMemory] = useState<Memory | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [graphData, setGraphData] = useState<GraphData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Pick a random loading message once per memory load
  const loadingMessage = useMemo(() => getRandomLoadingMessage(), [id])

  // Edit states
  const [isEditingContent, setIsEditingContent] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showDiscardContentConfirm, setShowDiscardContentConfirm] = useState(false)
  const [isSyncingKnowledge, setIsSyncingKnowledge] = useState(false)
  const [showSlideshowConfirm, setShowSlideshowConfirm] = useState(false)
  const [isSlideshowOpen, setIsSlideshowOpen] = useState(false)

  const [showDeleteSnapshotConfirm, setShowDeleteSnapshotConfirm] = useState(false)
  const [showRestoreSnapshotConfirm, setShowRestoreSnapshotConfirm] = useState(false)
  const [snapshotBeforeRestore, setSnapshotBeforeRestore] = useState(true)
  const [showManageSnapshots, setShowManageSnapshots] = useState(false)

  const [contentMode, setContentMode] = useState<'edit' | 'preview'>('edit')
  const [csvViewMode, setCsvViewMode] = useState<'table' | 'raw'>('table')

  // Content edit value (kept here because content editing is separate from metadata)
  const [editContent, setEditContent] = useState('')

  // Add to collection modal
  const [showAddToCollection, setShowAddToCollection] = useState(false)
  const [hasCollections, setHasCollections] = useState<boolean | null>(null)

  // Relation state (managed by useMemoryRelations hook, but relations + relationTypeOptions
  // are also used during initial data load, so kept here as shared state)
  const [relations, setRelations] = useState<FlatRelation[]>([])
  const [relationTypeOptions, setRelationTypeOptions] = useState<RelationTypeInfo[]>([])

  // Ref for mermaid rendering
  const contentRef = useRef<HTMLDivElement>(null)

  // Diagram viewer state
  const [diagramViewerSvg, setDiagramViewerSvg] = useState<string | null>(null)
  const [diagramViewerTheme, setDiagramViewerTheme] = useState<DiagramTheme | null>(null)

  // Floating comment button + inline comment box state
  const [floatingButtonPos, setFloatingButtonPos] = useState<{ x: number; y: number } | null>(null)
  const [inlineCommentPos, setInlineCommentPos] = useState<{ x: number; y: number } | null>(null)
  const inlineCommentOpenRef = useRef(false)
  const [inlineCommentInput, setInlineCommentInput] = useState('')
  const [isSubmittingInline, setIsSubmittingInline] = useState(false)
  useDocumentTitle(memory?.title ? `Mem - ${memory.title}` : 'Mem - Loading')

  // Speech synthesis hook for text-to-speech
  const tts = useSpeechSynthesis()

  // Highlight the current block being read aloud
  useTtsHighlight(contentRef, tts.isSpeaking, tts.currentChunkIndex, tts.chunks, tts.spokenCharIndex)

  const {
    collectionName,
    navPosition,
    navigateNext,
    navigatePrev,
  } = useMemoryPageNavigation({
    id,
    memory,
    collectionParams,
    setLocation,
  })

  const {
    handleCreateSnapshot,
    handleDeleteSnapshot,
    handleRestoreSnapshot,
    handleSnapshotChange,
    isCreatingSnapshot,
    isDeletingSnapshot,
    isLoadingDiff,
    isLoadingSnapshot,
    isRestoringSnapshot,
    refreshSnapshots,
    setShowSnapshotDiff,
    showSnapshotDiff,
    snapshotComments,
    snapshotContent,
    snapshotDiffData,
    snapshotsData,
    viewingSnapshot,
  } = useMemorySnapshots({
    memory,
    projectId: project?.id || memory?.project_id,
    setError,
    setMemory,
    setEditContent,
    showToast,
  })

  const meta = useMemoryMetadataEditor({
    memory,
    project,
    projects,
    setError,
    setMemory,
    setProject,
    setEditContent,
    showToast,
    setLocation,
    refreshSnapshots,
  })

  const rel = useMemoryRelations({
    memory,
    project,
    relationTypeOptions,
    typeHierarchy: meta.typeHierarchy,
    setError,
    setRelations,
    setGraphData,
  })

  // Computed: is viewing a historical (non-current) snapshot?
  const isViewingHistoricalSnapshot = viewingSnapshot !== null && viewingSnapshot !== snapshotsData?.current_snapshot

  const renderer = useMemoryContentRenderer({
    memory,
    isEditingContent,
    editContent,
    contentMode,
    isViewingHistoricalSnapshot,
    snapshotContent,
    contentRef,
    editMaxWidth: meta.editMaxWidth,
  })

  const editor = useMemoryContentEditor({
    memory,
    project,
    isEditingContent,
    setIsEditingContent,
    editContent,
    setEditContent,
    setContentMode,
    contentRef,
    headingPositions: renderer.headingPositions,
    editorTopLine: renderer.editorTopLine,
    pendingScrollSlugRef: renderer.pendingScrollSlugRef,
    setError,
    setMemory,
    setLocation,
    showToast,
    setMetaIsSaving: meta.setIsSaving,
  })

  // Comments hook (initialized with defaults, re-initialized when memory loads)
  const comments = useComments({
    memoryId: id,
    rawContent: memory?.content || '',
    contentRef,
    renderedContent: renderer.renderedContent,
    initialComments: memory?.comments,
  })

  // Stop speech when navigating to a different memory
  useEffect(() => {
    return () => tts.stop()
  }, [id])


  // Load all initial data in parallel on mount/id change
  useEffect(() => {
    let mounted = true
    setIsLoading(true)
    setError(null)

    const loadData = async () => {
      try {
        // Phase 1: Load memory and static data in parallel
        const isValidUuid = isUuid(id)
        const [mem, projectsData, relationTypesData] = await Promise.all([
          getMemory(id),
          getProjects().catch(() => []),
          getRelationTypes().catch(() => []),
        ])

        if (!mounted) return

        setProjects(projectsData)
        setRelationTypeOptions(relationTypesData)

        const projectId = mem.project_id

        // Phase 2: Load project-dependent data in parallel
        const [memWithTags, proj, relationsData, graphData, typesData] = await Promise.all([
          // Re-fetch with project ID to get tags (only if we have projectId)
          projectId ? getMemory(id, projectId, { comments: true }).catch(() => mem) : Promise.resolve(mem),
          projectId ? getProject(projectId).catch(() => null) : Promise.resolve(null),
          isValidUuid ? getMemoryRelations(id).catch(() => []) : Promise.resolve([]),
          isValidUuid ? getMemoryGraph(id, { depth: 1, compact: true, max_nodes: 10 }).catch(() => null) : Promise.resolve(null),
          projectId ? getProjectMemoryTypes(projectId).catch(() => null) : Promise.resolve(null),
        ])

        if (!mounted) return

        setMemory(memWithTags)
        meta.initializeFromMemory(memWithTags)
        setProject(proj)
        setRelations(relationsData)
        setGraphData(graphData)
        meta.initializeTypeOptions(typesData)
      } catch (err: any) {
        if (mounted) {
          setError(err.message || 'Failed to load memory')
        }
      } finally {
        if (mounted) {
          setIsLoading(false)
        }
      }
    }

    loadData()

    return () => {
      mounted = false
    }
  }, [id])

  // Check if any collections exist (for showing the Add to Collection button)
  useEffect(() => {
    let mounted = true
    getAllCollections()
      .then((res) => { if (mounted) setHasCollections(res.collections.length > 0) })
      .catch(() => { if (mounted) setHasCollections(false) })
    return () => { mounted = false }
  }, [])

  const contentSearch = useContentSearch({
    memory,
    tocItems: renderer.tocItems,
    contentRef,
    tocClickActiveUntilRef: renderer.tocClickActiveUntilRef,
    setActiveHeadingId: renderer.setActiveHeadingId,
  })

  // Add click handlers to mermaid diagrams for fullscreen viewer
  useEffect(() => {
    if (!contentRef.current || !renderer.renderedContent) return

    const diagrams = contentRef.current.querySelectorAll('.mermaid-diagram')
    const handleClick = (e: Event) => {
      const target = e.currentTarget as HTMLElement
      const svg = target.querySelector('svg')
      if (svg) {
        setDiagramViewerSvg(svg.outerHTML)
        const theme = target.getAttribute('data-theme') as DiagramTheme | null
        setDiagramViewerTheme(theme)
      }
    }

    diagrams.forEach((diagram) => {
      ;(diagram as HTMLElement).style.cursor = 'zoom-in'
      diagram.addEventListener('click', handleClick)
    })

    return () => {
      diagrams.forEach((diagram) => {
        diagram.removeEventListener('click', handleClick)
      })
    }
  }, [renderer.renderedContent])

  // Floating comment button — show near selection in view mode
  useEffect(() => {
    if (isEditingContent || isLoading) {
      setFloatingButtonPos(null)
      return
    }
    const container = contentRef.current
    if (!container) return

    const handleMouseUp = () => {
      // Defer to let the selection settle
      requestAnimationFrame(() => {
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || !container.contains(sel.anchorNode)) {
          setFloatingButtonPos(null)
          return
        }
        const range = sel.getRangeAt(0)
        const rect = range.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        setFloatingButtonPos({
          x: rect.left - containerRect.left + rect.width / 2,
          y: rect.top - containerRect.top - 8,
        })
      })
    }

    const handleMouseDownOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      // Dismiss floating button when clicking outside it
      if (!target.closest('[class*="floatingCommentButton"]')) {
        setFloatingButtonPos(null)
      }
      // Dismiss inline comment box when clicking outside it
      if (!target.closest('[class*="inlineCommentBox"]')) {
        if (inlineCommentOpenRef.current) {
          setInlineCommentPos(null)
          inlineCommentOpenRef.current = false
          comments.clearAnchor()
        }
      }
    }

    container.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('mousedown', handleMouseDownOutside)
    return () => {
      container.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('mousedown', handleMouseDownOutside)
    }
  }, [isEditingContent, isLoading])

  const openSlideshow = useCallback(() => {
    setIsSlideshowOpen(true)
  }, [])

  const closeSlideshow = useCallback(() => {
    setIsSlideshowOpen(false)
  }, [])






  // Submit inline anchored comment
  const handleInlineSubmit = async () => {
    const content = inlineCommentInput.trim()
    if (!content || !id) return
    setIsSubmittingInline(true)
    try {
      const data: CreateCommentInput = { content }
      if (comments.pendingAnchor) {
        data.anchor_text = comments.pendingAnchor.anchor_text
        data.anchor_prefix = comments.pendingAnchor.anchor_prefix
        data.anchor_suffix = comments.pendingAnchor.anchor_suffix
      }
      await createComment(id, data)
      setInlineCommentPos(null)
      inlineCommentOpenRef.current = false
      setInlineCommentInput('')
      comments.clearAnchor()
      comments.fetchComments()
    } catch {
      // Fall through — error is shown in the bottom section
    } finally {
      setIsSubmittingInline(false)
    }
  }

  // Ref-based save dispatcher to avoid stale closures in capture listener.
  // Updated every render so the capture handler always calls the right function.
  const cmdSaveRef = useRef<{
    save: (() => void) | null
    submitComment: () => void
    submitInlineComment: () => void
  }>({ save: null, submitComment: () => {}, submitInlineComment: () => {} })

  cmdSaveRef.current.submitComment = comments.submitComment
  cmdSaveRef.current.submitInlineComment = handleInlineSubmit
  if (isEditingContent) {
    cmdSaveRef.current.save = editor.saveContent
  } else if (meta.isEditingMetadata) {
    cmdSaveRef.current.save = meta.saveMetadata
  } else if (comments.editingCommentId) {
    cmdSaveRef.current.save = comments.saveEdit
  } else {
    cmdSaveRef.current.save = null
  }

  // All window/document keyboard listeners consolidated in one hook
  useMemoryPageShortcuts({
    isEditingContent,
    isEditingMetadata: meta.isEditingMetadata,
    isContentDirty: editor.isContentDirty,
    isUploading: editor.isUploading,
    isSlideshowOpen,
    isContentSearchOpen: contentSearch.isContentSearchOpen,
    isViewingHistoricalSnapshot,
    diagramViewerSvg,
    contentSearchInputRef: contentSearch.contentSearchInputRef,
    fileInputRef: editor.fileInputRef,
    insertAsHtmlRef: editor.insertAsHtmlRef,
    contentRef,
    inlineCommentOpenRef,
    navigatePrev,
    navigateNext,
    startEditingContent: editor.startEditingContent,
    cancelEditingContent: editor.cancelEditingContent,
    cancelEditingMetadata: meta.cancelEditingMetadata,
    closeSlideshow,
    openContentSearch: contentSearch.openContentSearch,
    setDiagramViewerSvg,
    setDiagramViewerTheme,
    setShowDiscardContentConfirm,
    setShowSlideshowConfirm,
    setFloatingButtonPos,
    setInlineCommentPos,
    setInlineCommentInput,
    comments,
    cmdSaveRef,
  })


  if (isLoading) {
    return (
      <div class={styles.page}>
        <div class={styles.loading}>
          <div class={styles.loadingSpinner} />
          <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{loadingMessage}</span>
        </div>
        {isSlideshowOpen && (
          <MemorySlideshowOverlay
            renderedContent={renderer.renderedContent}
            navPosition={navPosition}
            onClose={closeSlideshow}
            onDiagramClick={(svg, theme) => {
              setDiagramViewerSvg(svg)
              setDiagramViewerTheme(theme)
            }}
          />
        )}
      </div>
    )
  }

  if (error || !memory) {
    return (
      <div class={styles.page}>
        <div class={styles.error} data-testid="memory-page--error">{error || 'Memory not found'}</div>
      </div>
    )
  }

  return (
    <div class={styles.page}>
      <MemoryTopNav
        memory={memory}
        project={project}
        graphData={graphData}
        hasCollections={hasCollections}
        collectionParams={collectionParams}
        collectionName={collectionName}
        navPosition={navPosition}
        navigatePrev={navigatePrev}
        navigateNext={navigateNext}
        editor={editor}
        setLocation={setLocation}
        setShowAddToCollection={setShowAddToCollection}
      />

      <MemoryMetadataSection
        memory={memory}
        projects={projects}
        meta={meta}
        editor={editor}
        snapshotsData={snapshotsData}
        viewingSnapshot={viewingSnapshot}
        isViewingHistoricalSnapshot={isViewingHistoricalSnapshot}
        isLoadingSnapshot={isLoadingSnapshot}
        isRestoringSnapshot={isRestoringSnapshot}
        isDeletingSnapshot={isDeletingSnapshot}
        handleSnapshotChange={handleSnapshotChange}
        isSyncingKnowledge={isSyncingKnowledge}
        onSyncKnowledge={memory.parent_type === 'knowledge' ? async () => {
          setIsSyncingKnowledge(true)
          try {
            const result = await syncProjectKnowledge(memory.project_id)
            const updated = result.results.filter((r) => r.action !== 'unchanged').length
            showToast(updated > 0 ? `Synced ${updated} knowledge file(s)` : 'Knowledge already up to date')
          } catch {
            showToast('Failed to sync knowledge', undefined, { variant: 'error' })
          } finally {
            setIsSyncingKnowledge(false)
          }
        } : undefined}
        setShowDeleteConfirm={setShowDeleteConfirm}
        setShowDeleteSnapshotConfirm={setShowDeleteSnapshotConfirm}
        setShowRestoreSnapshotConfirm={setShowRestoreSnapshotConfirm}
        onOpenManageSnapshots={
          snapshotsData && snapshotsData.total > 0
            ? () => setShowManageSnapshots(true)
            : undefined
        }
      />

      {/* Historical Snapshot Banner */}
      {isViewingHistoricalSnapshot && (
        <div class={styles.snapshotBanner}>
          <AlertTriangle size={16} />
          <span>
            Viewing snapshot #{viewingSnapshot} (read-only).
            {' '}
            <button
              class={styles.snapshotBannerLink}
              onClick={() => handleSnapshotChange(null)}
            >
              Return to current
            </button>
            {' · '}
            <button
              class={clsx(styles.snapshotBannerLink, showSnapshotDiff && styles.snapshotBannerLinkActive)}
              onClick={() => setShowSnapshotDiff((v) => !v)}
            >
              {showSnapshotDiff ? 'Hide diff' : 'Show diff vs current'}
            </button>
            {' · '}
            <button
              class={styles.snapshotBannerLink}
              onClick={() => setShowRestoreSnapshotConfirm(true)}
              disabled={isRestoringSnapshot}
            >
              {isRestoringSnapshot ? 'Restoring...' : 'Restore this snapshot'}
            </button>
          </span>
        </div>
      )}

      {/* Snapshot Diff */}
      {isViewingHistoricalSnapshot && showSnapshotDiff && (
        <div class={styles.sectionWrapper}>
          <div class={styles.sectionHeader}>
            <span class={styles.sectionLabel}>Diff</span>
          </div>
          <SnapshotDiffViewer
            changes={snapshotDiffData?.changes ?? []}
            stats={snapshotDiffData?.stats ?? { additions: 0, deletions: 0, unchanged: 0 }}
            isLoading={isLoadingDiff}
            fromLabel={`#${viewingSnapshot}`}
            toLabel={`#${snapshotsData?.current_snapshot} (current)`}
          />
        </div>
      )}

      <MemoryContentSection
        memory={memory}
        isEditingContent={isEditingContent}
        editContent={editContent}
        setEditContent={setEditContent}
        contentMode={contentMode}
        setContentMode={setContentMode}
        csvViewMode={csvViewMode}
        setCsvViewMode={setCsvViewMode}
        contentRef={contentRef}
        isViewingHistoricalSnapshot={isViewingHistoricalSnapshot}
        loadingMessage={loadingMessage}
        isSaving={meta.isSaving}
        snapshotsData={snapshotsData}
        handleCreateSnapshot={handleCreateSnapshot}
        isCreatingSnapshot={isCreatingSnapshot}
        editor={editor}
        renderer={renderer}
        contentSearch={contentSearch}
        tts={tts}
        comments={comments}
        floatingButtonPos={floatingButtonPos}
        setFloatingButtonPos={setFloatingButtonPos}
        inlineCommentPos={inlineCommentPos}
        setInlineCommentPos={setInlineCommentPos}
        inlineCommentInput={inlineCommentInput}
        setInlineCommentInput={setInlineCommentInput}
        inlineCommentOpenRef={inlineCommentOpenRef}
        isSubmittingInline={isSubmittingInline}
        handleInlineSubmit={handleInlineSubmit}
        setShowDiscardContentConfirm={setShowDiscardContentConfirm}
      />

      <MemoryRelationsSection
        memory={memory}
        relations={relations}
        relationTypeOptions={relationTypeOptions}
        allTypeOptions={meta.allTypeOptions}
        topLevelTypeOptions={meta.topLevelTypeOptions}
        typeHierarchy={meta.typeHierarchy}
        setLocation={setLocation}
        showToast={showToast}
        rel={rel}
      />
      <MemoryCommentsSection
        isViewingHistoricalSnapshot={isViewingHistoricalSnapshot}
        snapshotComments={snapshotComments}
        comments={comments}
        showToast={showToast}
      />


      {/* Diagram fullscreen viewer */}
      {diagramViewerSvg && (
        <MemoryDiagramViewer
          svgHtml={diagramViewerSvg}
          theme={diagramViewerTheme}
          onClose={() => {
            setDiagramViewerSvg(null)
            setDiagramViewerTheme(null)
          }}
          onExportPng={editor.exportAsPng}
        />
      )}

      {showDeleteConfirm && (
        <ConfirmModal
          title="Delete Memory"
          message="Delete this memory? This cannot be undone."
          confirmLabel={editor.isDeleting ? 'Deleting...' : 'Delete'}
          variant="danger"
          onConfirm={editor.handleDeleteMemory}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {showDeleteSnapshotConfirm && viewingSnapshot !== null && (
        <ConfirmModal
          title="Delete Snapshot"
          message={
            viewingSnapshot === snapshotsData?.current_snapshot
              ? `Delete snapshot #${viewingSnapshot}? The previous snapshot will become current.`
              : `Delete snapshot #${viewingSnapshot}? This cannot be undone.`
          }
          confirmLabel={isDeletingSnapshot ? 'Deleting...' : 'Delete'}
          variant="danger"
          onConfirm={async () => {
            await handleDeleteSnapshot()
            setShowDeleteSnapshotConfirm(false)
          }}
          onCancel={() => setShowDeleteSnapshotConfirm(false)}
        />
      )}

      {showManageSnapshots && snapshotsData && (
        <SnapshotsManageModal
          memoryId={memory.id}
          snapshots={snapshotsData.snapshots}
          currentSnapshot={snapshotsData.current_snapshot}
          onClose={() => setShowManageSnapshots(false)}
          onChanged={async () => {
            const fresh = await refreshSnapshots()
            // If the user was viewing a historical snapshot that just got deleted,
            // drop them back to the current snapshot so the page stays consistent.
            if (
              viewingSnapshot !== null &&
              fresh &&
              viewingSnapshot !== fresh.current_snapshot &&
              !fresh.snapshots.some((s) => s.snapshot_number === viewingSnapshot)
            ) {
              handleSnapshotChange(null)
            }
          }}
        />
      )}

      {showRestoreSnapshotConfirm && viewingSnapshot !== null && (
        <div
          class={styles.overlay}
          onClick={(e) => { if (e.target === e.currentTarget) { setShowRestoreSnapshotConfirm(false); setSnapshotBeforeRestore(true) } }}
          role="dialog"
          aria-modal="true"
        >
          <div class={styles.restoreModal}>
            <h2 class={styles.restoreModalTitle}>Restore Snapshot</h2>
            <p class={styles.restoreModalSubtitle}>Restore content from snapshot #{viewingSnapshot}</p>
            <label class={styles.restoreCheckbox}>
              <input
                type="checkbox"
                checked={snapshotBeforeRestore}
                onChange={(e) => setSnapshotBeforeRestore((e.target as HTMLInputElement).checked)}
              />
              Snapshot current content before restoring
            </label>
            <div class={styles.restoreModalActions}>
              <button
                class={styles.cancelButton}
                onClick={() => { setShowRestoreSnapshotConfirm(false); setSnapshotBeforeRestore(true) }}
                type="button"
              >
                Cancel
              </button>
              <button
                class={styles.confirmButton}
                onClick={async () => {
                  await handleRestoreSnapshot({ skipSnapshot: !snapshotBeforeRestore })
                  setShowRestoreSnapshotConfirm(false)
                  setSnapshotBeforeRestore(true)
                }}
                type="button"
              >
                {isRestoringSnapshot ? 'Restoring...' : 'Restore'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDiscardContentConfirm && (
        <ConfirmModal
          title="Discard Changes"
          message="Discard your unsaved content changes?"
          confirmLabel="Discard"
          variant="danger"
          onConfirm={() => {
            setShowDiscardContentConfirm(false)
            editor.cancelEditingContent()
          }}
          onCancel={() => setShowDiscardContentConfirm(false)}
        />
      )}

      {showSlideshowConfirm && (
        <ConfirmModal
          title="Enter Slideshow Mode"
          message="Open a full-screen view of this memory? Use left/right arrows to navigate, and Q to exit."
          confirmLabel="Enter"
          onConfirm={() => {
            setShowSlideshowConfirm(false)
            openSlideshow()
          }}
          onCancel={() => setShowSlideshowConfirm(false)}
        />
      )}

      {isSlideshowOpen && (
        <MemorySlideshowOverlay
          renderedContent={renderer.renderedContent}
          navPosition={navPosition}
          onClose={closeSlideshow}
          onDiagramClick={(svg, theme) => {
            setDiagramViewerSvg(svg)
            setDiagramViewerTheme(theme)
          }}
        />
      )}

      {showAddToCollection && memory && (
        <AddToCollectionModal
          memoryId={memory.id}
          projectId={memory.project_id}
          onClose={() => setShowAddToCollection(false)}
          onAdded={() => showToast('Added to collection')}
        />
      )}
    </div>
  )
}
