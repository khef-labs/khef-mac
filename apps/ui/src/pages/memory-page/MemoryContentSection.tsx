import type { RefObject } from 'preact'
import { Pencil, Search, X, ImagePlus, ListTree, MessageSquareText, Send, Save, Volume2, Pause, Play, Square } from 'lucide-preact'
import clsx from 'clsx'
import { CodeEditor } from '../../components/editor'
import { SpreadsheetViewer } from '../../components/csv/SpreadsheetViewer'
import { VideoPlayer } from '../../components/video/VideoPlayer'
import { CanvasViewer } from '../../components/canvas/CanvasViewer'
import { CANVAS_TYPES, extractVideoUrl } from './lib'
import type { useContentSearch } from './useContentSearch'
import type { useMemoryContentRenderer } from './useMemoryContentRenderer'
import type { useMemoryContentEditor } from './useMemoryContentEditor'
import type { useComments } from '../../hooks/useComments'
import type { useSpeechSynthesis } from '../../hooks/useSpeechSynthesis'
import type { Memory } from '../../types'
import styles from '../MemoryPage.module.css'

interface Props {
  memory: Memory
  isEditingContent: boolean
  editContent: string
  setEditContent: (v: string) => void
  contentMode: 'edit' | 'preview'
  setContentMode: (v: 'edit' | 'preview') => void
  csvViewMode: 'table' | 'raw'
  setCsvViewMode: (v: 'table' | 'raw') => void
  contentRef: RefObject<HTMLDivElement>
  isViewingHistoricalSnapshot: boolean
  loadingMessage: string
  isSaving: boolean
  snapshotsData: { current_snapshot: number; total: number; snapshots: any[] } | null
  handleCreateSnapshot: () => void
  isCreatingSnapshot: boolean
  // Hook objects
  editor: ReturnType<typeof useMemoryContentEditor>
  renderer: ReturnType<typeof useMemoryContentRenderer>
  contentSearch: ReturnType<typeof useContentSearch>
  tts: ReturnType<typeof useSpeechSynthesis>
  comments: ReturnType<typeof useComments>
  // Inline comment state
  floatingButtonPos: { x: number; y: number } | null
  setFloatingButtonPos: (v: { x: number; y: number } | null) => void
  inlineCommentPos: { x: number; y: number } | null
  setInlineCommentPos: (v: { x: number; y: number } | null) => void
  inlineCommentInput: string
  setInlineCommentInput: (v: string) => void
  inlineCommentOpenRef: { current: boolean }
  isSubmittingInline: boolean
  handleInlineSubmit: () => void
  // Actions
  setShowDiscardContentConfirm: (v: boolean) => void
}

export function MemoryContentSection({
  memory,
  isEditingContent,
  editContent,
  setEditContent,
  contentMode,
  setContentMode,
  csvViewMode,
  setCsvViewMode,
  contentRef,
  isViewingHistoricalSnapshot,
  loadingMessage,
  isSaving,
  snapshotsData,
  handleCreateSnapshot,
  isCreatingSnapshot,
  editor,
  renderer,
  contentSearch,
  tts,
  comments,
  floatingButtonPos,
  setFloatingButtonPos,
  inlineCommentPos,
  setInlineCommentPos,
  inlineCommentInput,
  setInlineCommentInput,
  inlineCommentOpenRef,
  isSubmittingInline,
  handleInlineSubmit,
  setShowDiscardContentConfirm,
}: Props) {
  return (
    <div class={styles.sectionWrapper} data-testid="memory-page--content-section">
      <div class={clsx(styles.sectionHeader, isEditingContent && styles.sectionHeaderSticky)}>
        {isEditingContent ? (
          <span class={styles.editingBadge}>Editing</span>
        ) : (
          <span class={styles.sectionLabel}>Content</span>
        )}
        {isEditingContent && (
          <div class={styles.contentEditControls}>
            <button
              class={styles.editButton}
              onClick={() => renderer.setIsTocVisible((prev) => !prev)}
              disabled={!renderer.canShowToc}
              title={renderer.showToc ? 'Hide table of contents' : 'Show table of contents'}
            >
              <ListTree size={14} />
            </button>
            {memory?.type === 'video' ? (
              <button
                class={styles.uploadButton}
                onClick={() => editor.videoFileInputRef.current?.click()}
                disabled={editor.isUploading}
                title="Upload video file"
                type="button"
              >
                {editor.isUploading ? (
                  <span class={styles.uploadSpinner} />
                ) : (
                  <ImagePlus size={16} />
                )}
              </button>
            ) : (
              <button
                class={styles.uploadButton}
                onClick={() => editor.fileInputRef.current?.click()}
                disabled={editor.isUploading}
                title="Upload image"
                type="button"
              >
                {editor.isUploading ? (
                  <span class={styles.uploadSpinner} />
                ) : (
                  <ImagePlus size={16} />
                )}
              </button>
            )}
            <div class={styles.contentModeToggle} role="group" aria-label="Content view">
              <button
                class={clsx(
                  styles.toggleButton,
                  contentMode === 'edit' && styles.toggleButtonActive
                )}
                onClick={() => setContentMode('edit')}
                type="button"
              >
                Edit
              </button>
              <button
                class={clsx(
                  styles.toggleButton,
                  contentMode === 'preview' && styles.toggleButtonActive
                )}
                onClick={() => setContentMode('preview')}
                type="button"
              >
                Preview
              </button>
            </div>
          </div>
        )}
        {!isEditingContent && !isViewingHistoricalSnapshot && (
          <div class={styles.contentHeaderButtons}>
            {memory?.type === 'video' && (
              <button
                class={styles.editButton}
                onClick={() => editor.videoFileInputRef.current?.click()}
                disabled={editor.isUploading}
                title="Upload video file"
              >
                {editor.isUploading ? <span class={styles.uploadSpinner} /> : <ImagePlus size={14} />}
              </button>
            )}
            {memory?.type === 'csv' && (
              <div class={styles.contentModeToggle} role="group" aria-label="CSV view">
                <button
                  class={clsx(styles.toggleButton, csvViewMode === 'table' && styles.toggleButtonActive)}
                  onClick={() => setCsvViewMode('table')}
                  type="button"
                >
                  Table
                </button>
                <button
                  class={clsx(styles.toggleButton, csvViewMode === 'raw' && styles.toggleButtonActive)}
                  onClick={() => setCsvViewMode('raw')}
                  type="button"
                >
                  Raw
                </button>
              </div>
            )}
            <button
              class={clsx(styles.editButton, contentSearch.isContentSearchOpen && styles.editButtonActive)}
              onClick={contentSearch.isContentSearchOpen ? contentSearch.closeContentSearch : contentSearch.openContentSearch}
              title="Search within memory (Cmd+F)"
            >
              <Search size={14} />
            </button>
            <button
              class={styles.editButton}
              onClick={() => renderer.setIsTocVisible((prev) => !prev)}
              disabled={!renderer.canShowToc}
              title={renderer.showToc ? 'Hide table of contents' : 'Show table of contents'}
            >
              <ListTree size={14} />
            </button>
            {tts.isSupported && (
              <div class={styles.ttsMenuContainer}>
                <button
                  class={clsx(styles.editButton, tts.isSpeaking && styles.editButtonActive)}
                  onClick={() => {
                    if (tts.isSpeaking && !tts.isPaused) {
                      tts.pause()
                    } else if (tts.isPaused) {
                      tts.resume()
                    } else {
                      tts.speak(memory?.content || '')
                    }
                  }}
                  title={
                    tts.isSpeaking && !tts.isPaused
                      ? 'Pause'
                      : tts.isPaused
                        ? 'Resume'
                        : 'Read aloud'
                  }
                >
                  {tts.isSpeaking && !tts.isPaused ? <Pause size={14} /> : <Volume2 size={14} />}
                </button>
                <div class={styles.ttsMenuOptions}>
                  <div class={styles.ttsControls}>
                    <button
                      class={clsx(styles.ttsControlButton, !tts.isSpeaking && styles.ttsControlButtonPrimary)}
                      onClick={() => {
                        if (tts.isPaused) {
                          tts.resume()
                        } else if (!tts.isSpeaking) {
                          tts.speak(memory?.content || '')
                        }
                      }}
                      disabled={tts.isSpeaking && !tts.isPaused}
                      title="Play"
                    >
                      <Play size={14} />
                    </button>
                    <button
                      class={styles.ttsControlButton}
                      onClick={() => tts.pause()}
                      disabled={!tts.isSpeaking || tts.isPaused}
                      title="Pause"
                    >
                      <Pause size={14} />
                    </button>
                    <button
                      class={styles.ttsControlButton}
                      onClick={() => tts.stop()}
                      disabled={!tts.isSpeaking}
                      title="Stop"
                    >
                      <Square size={14} />
                    </button>
                  </div>
                </div>
              </div>
            )}
            {!memory?.metadata?.['seed-path'] && (
              <button
                class={styles.editButton}
                onClick={editor.startEditingContent}
                disabled={editor.isContentEditingDisabled}
                title={editor.contentEditingDisabledReason || 'Edit content'}
              >
                <Pencil size={14} />
              </button>
            )}
            {snapshotsData && !memory?.metadata?.['seed-path'] && (
              <button
                class={styles.editButton}
                onClick={handleCreateSnapshot}
                disabled={isCreatingSnapshot}
                title="Save snapshot"
              >
                <Save size={14} />
              </button>
            )}
          </div>
        )}
      </div>
      {contentSearch.isContentSearchOpen && (
        <div class={styles.contentSearchBar}>
          <Search size={14} class={styles.contentSearchIcon} />
          <input
            ref={contentSearch.contentSearchInputRef}
            type="text"
            class={styles.contentSearchInput}
            placeholder="Search within this memory..."
            value={contentSearch.contentSearchQuery}
            onInput={(e) => contentSearch.setContentSearchQuery((e.target as HTMLInputElement).value)}
            onKeyDown={contentSearch.handleContentSearchKeyDown}
          />
          {contentSearch.isContentSearching && <span class={styles.contentSearchSpinner} />}
          {contentSearch.contentSearchResults && (
            <span class={styles.contentSearchCount}>
              {contentSearch.contentSearchResults.match_count} match{contentSearch.contentSearchResults.match_count !== 1 ? 'es' : ''}
            </span>
          )}
          <button class={styles.contentSearchClose} onClick={contentSearch.closeContentSearch} title="Close search">
            <X size={14} />
          </button>
        </div>
      )}
      {contentSearch.contentSearchResults && contentSearch.contentSearchResults.sections.length > 0 && (
        <div class={styles.contentSearchResults}>
          {contentSearch.contentSearchResults.sections.map((section) => (
            <div key={`${section.start}:${section.heading}`} class={styles.contentSearchSection}>
              <button
                class={styles.contentSearchSectionHeading}
                onClick={() => contentSearch.scrollToSearchResult(section.heading)}
                title={`Jump to "${section.heading}"`}
              >
                {section.heading}
              </button>
              {section.hits.map((hit, i) => (
                <button
                  key={i}
                  class={styles.contentSearchHit}
                  onClick={() => contentSearch.scrollToSearchResult(section.heading)}
                  dangerouslySetInnerHTML={{
                    __html: hit.excerpt
                      .replace(/&/g, '&amp;')
                      .replace(/</g, '&lt;')
                      .replace(/>/g, '&gt;')
                      .replace(/\*\*(.+?)\*\*/g, '<mark>$1</mark>')
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      {contentSearch.contentSearchResults && contentSearch.contentSearchResults.sections.length === 0 && contentSearch.contentSearchQuery.trim() && (
        <div class={styles.contentSearchNoResults}>No matches found</div>
      )}
      <div class={clsx(styles.contentLayout, renderer.showToc && styles.contentLayoutWithToc)}>
        {renderer.showToc && (
          <aside class={styles.tocPanel} aria-label="Table of contents">
            <div class={styles.tocTitle}>Contents</div>
            <ul class={styles.tocList}>
              {renderer.tocItems.map((item) => (
                <li key={item.id} class={styles.tocItem}>
                  <a
                    class={clsx(
                      styles.tocLink,
                      item.depth === 2 && styles.tocLinkDepth2,
                      item.depth === 3 && styles.tocLinkDepth3,
                      item.id === renderer.activeHeadingId && styles.tocLinkActive
                    )}
                    href={`#${item.id}`}
                    aria-current={item.id === renderer.activeHeadingId ? 'true' : undefined}
                    onClick={(e) => {
                      e.preventDefault()
                      renderer.handleTocClick(item.id)
                    }}
                  >
                    {item.text}
                  </a>
                </li>
              ))}
            </ul>
          </aside>
        )}
        <div
          ref={contentRef}
          class={clsx(
            styles.content,
            isEditingContent && styles.contentEditing,
            renderer.showToc && styles.contentScroll,
            !isEditingContent && !renderer.renderedContent && memory?.content && styles.contentLoadingContainer
          )}
          data-testid="memory-page--content"
        >
          {/* Hidden file input for file upload */}
          <input
            ref={editor.fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/csv,text/plain,.xlsx,.docx"
            onChange={editor.handleFileUpload}
            style={{ display: 'none' }}
          />
          {/* Hidden file input for video upload */}
          <input
            ref={editor.videoFileInputRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
            onChange={editor.handleVideoUpload}
            style={{ display: 'none' }}
          />
          {isEditingContent && contentMode === 'edit' ? (
            <CodeEditor
              value={editContent}
              onChange={setEditContent}
              language="markdown"
              onSave={editor.saveContent}
              onScroll={renderer.setEditorTopLine}
              cursorTarget={renderer.editorCursorTarget}
              onPasteFile={editor.handlePasteFile}
              lineWrapping
              autoFocus
              className={styles.contentCodeEditor}
            />
        ) : isEditingContent && memory?.type === 'csv' ? (
            <SpreadsheetViewer
              content={editContent}
              onContentChange={setEditContent}
            />
        ) : isEditingContent ? (
          <div
            class={clsx(styles.contentMarkdown, styles.contentMarkdownPreview)}
            dangerouslySetInnerHTML={{ __html: renderer.renderedEditContent }}
          />
          ) : memory?.type === 'csv' && memory?.content ? (
            csvViewMode === 'table' ? (
              <SpreadsheetViewer content={memory.content} readOnly />
            ) : (
              <pre class={styles.contentMarkdown} style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)' }}>{memory.content}</pre>
            )
          ) : memory?.type === 'video' && memory?.content && extractVideoUrl(memory.content) ? (
            <>
              <VideoPlayer src={extractVideoUrl(memory.content)!} />
              {renderer.renderedContent && (
                <div
                  class={styles.contentMarkdown}
                  dangerouslySetInnerHTML={{ __html: renderer.renderedContent }}
                />
              )}
            </>
          ) : memory?.type && CANVAS_TYPES.has(memory.type) && memory?.content ? (
            <CanvasViewer content={memory.content} />
          ) : !renderer.renderedContent && memory?.content ? (
            <div class={styles.contentLoading}>
              <div class={styles.contentSpinner} />
              <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)', marginTop: 'var(--space-2)' }}>{loadingMessage}</span>
            </div>
          ) : (
            <div
              class={styles.contentMarkdown}
              dangerouslySetInnerHTML={{ __html: renderer.renderedContent }}
              data-testid="memory-page--content-markdown"
              onClick={(e) => {
                if (!tts.isSpeaking || !memory?.content) return
                // Find the closest block-level element that was clicked
                const target = (e.target as HTMLElement).closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, tr, pre')
                if (!target) return
                const snippet = target.textContent || ''
                if (snippet.trim().length < 5) return
                tts.speakFrom(memory.content, snippet)
              }}
            />
          )}
          {/* Floating comment button on text selection */}
          {floatingButtonPos && !isEditingContent && !inlineCommentPos && (
            <button
              class={styles.floatingCommentButton}
              data-testid="comments--floating-button"
              style={{
                left: `${floatingButtonPos.x}px`,
                top: `${floatingButtonPos.y}px`,
              }}
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const sel = window.getSelection()
                let posX = floatingButtonPos.x
                let posY = floatingButtonPos.y + 40
                if (sel && !sel.isCollapsed && contentRef.current) {
                  const range = sel.getRangeAt(0)
                  const rect = range.getBoundingClientRect()
                  const containerRect = contentRef.current.getBoundingClientRect()
                  posX = rect.left - containerRect.left + rect.width / 2
                  posY = rect.bottom - containerRect.top + 4
                }
                comments.captureSelection()
                setInlineCommentPos({ x: posX, y: posY })
                inlineCommentOpenRef.current = true
                setInlineCommentInput('')
                setFloatingButtonPos(null)
                requestAnimationFrame(() => {
                  const inlineTextarea = document.querySelector<HTMLTextAreaElement>('[data-inline-comment-input]')
                  inlineTextarea?.focus()
                })
              }}
              title="Comment on selection (Alt+C)"
            >
              <MessageSquareText size={14} />
            </button>
          )}
          {/* Inline comment box at selection */}
          {inlineCommentPos && !isEditingContent && (
            <div
              class={styles.inlineCommentBox}
              data-testid="comments--inline-box"
              style={{
                left: `${Math.max(0, inlineCommentPos.x - 150)}px`,
                top: `${inlineCommentPos.y + 8}px`,
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {comments.pendingAnchor && (
                <div class={styles.inlineAnchorPreview} data-testid="comments--inline-anchor-preview">
                  &ldquo;{comments.pendingAnchor.anchor_text!.length > 40
                    ? comments.pendingAnchor.anchor_text!.slice(0, 40) + '...'
                    : comments.pendingAnchor.anchor_text}&rdquo;
                </div>
              )}
              <div class={styles.commentInputRow}>
                <textarea
                  data-inline-comment-input
                  class={styles.commentTextarea}
                  placeholder="Add a comment..."
                  value={inlineCommentInput}
                  onInput={(e) =>
                    setInlineCommentInput((e.target as HTMLTextAreaElement).value)
                  }
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'Enter')) {
                      e.preventDefault()
                      handleInlineSubmit()
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setInlineCommentPos(null)
                      inlineCommentOpenRef.current = false
                      setInlineCommentInput('')
                      comments.clearAnchor()
                    }
                  }}
                />
                <button
                  class={styles.submitCommentButton}
                  onClick={handleInlineSubmit}
                  disabled={isSubmittingInline || !inlineCommentInput.trim()}
                  title="Submit (Cmd+S)"
                  data-testid="comments--inline-submit"
                >
                  <Send size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {isEditingContent && (
        <div class={styles.actionButtons}>
          <button
            class={styles.cancelButton}
            onClick={() => {
              if (editor.isContentDirty) {
                setShowDiscardContentConfirm(true)
              } else {
                editor.cancelEditingContent()
              }
            }}
            disabled={isSaving}
          >
            Cancel
          </button>
          <button
            class={styles.saveButton}
            onClick={editor.saveContent}
            disabled={isSaving}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
