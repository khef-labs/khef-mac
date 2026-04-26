import { Copy, Check, Download, ChevronLeft, ChevronRight, ImageDown, FileText, MessageSquareText, FileDown, Network, HardDriveDownload, Pin, Layers } from 'lucide-preact'
import clsx from 'clsx'
import { CANVAS_TYPES } from './lib'
import { getSettings } from '../../lib/settings'
import type { useMemoryContentEditor } from './useMemoryContentEditor'
import type { Memory, Project, GraphData } from '../../types'
import styles from '../MemoryPage.module.css'

interface Props {
  memory: Memory
  project: Project | null
  graphData: GraphData | null
  hasCollections: boolean | null
  collectionParams: { collectionId: string } | null
  collectionName: string | null
  navPosition: { current: number; total: number } | null
  navigatePrev: () => void
  navigateNext: () => void
  editor: Pick<ReturnType<typeof useMemoryContentEditor>,
    'handleTogglePin' | 'copyContent' | 'copiedContent' | 'handleCopyMarkdown' | 'copiedMarkdown' |
    'handleExportSlack' | 'copiedSlack' | 'handleExportMarkdown' | 'handleExportDocx' |
    'handleExportCsv' | 'handleExportXlsx' | 'handleExportHtml' | 'handleSaveToDrive' | 'exportAsPng'
  >
  setLocation: (path: string) => void
  setShowAddToCollection: (v: boolean) => void
}

export function MemoryTopNav({
  memory,
  project,
  graphData,
  hasCollections,
  collectionParams,
  collectionName,
  navPosition,
  navigatePrev,
  navigateNext,
  editor,
  setLocation,
  setShowAddToCollection,
}: Props) {
  return (
    <>
      {collectionParams && collectionName && memory && (
        <div class={styles.collectionBanner}>
          <a
            href={`/projects/${memory.project_id}/collections/${collectionParams.collectionId}`}
            class={styles.collectionBannerLink}
            onClick={(e) => {
              e.preventDefault()
              setLocation(`/projects/${memory.project_id}/collections/${collectionParams.collectionId}`)
            }}
          >
            <Layers size={14} />
            {collectionName}
          </a>
          {navPosition && (
            <span class={styles.collectionBannerPosition}>
              Memory {navPosition.current} of {navPosition.total}
            </span>
          )}
        </div>
      )}
      <div class={styles.topNav}>
        {navPosition && (
          <div class={styles.navControls}>
            <button
              class={styles.navButton}
              onClick={navigatePrev}
              title="Previous memory (Left arrow)"
              aria-label="Previous memory"
            >
              <ChevronLeft size={18} />
            </button>
            <span class={styles.navPosition} data-testid="nav-position">
              {navPosition.current} of {navPosition.total}
            </span>
            <button
              class={styles.navButton}
              onClick={navigateNext}
              title="Next memory (Right arrow)"
              aria-label="Next memory"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        )}
        <div class={styles.exportButtons}>
          <button
            class={clsx(styles.exportButton, memory.is_pinned && styles.exportButtonActive)}
            onClick={editor.handleTogglePin}
            title={memory.is_pinned ? 'Unpin memory' : 'Pin memory'}
          >
            <Pin size={16} />
            {memory.is_pinned ? 'Pinned' : 'Pin'}
          </button>
          {hasCollections && (
            <button
              class={styles.exportButton}
              onClick={() => setShowAddToCollection(true)}
              title="Add to collection"
            >
              <Layers size={16} />
              Collection
            </button>
          )}
          {graphData && graphData.nodes.length > 1 && (
            <button
              class={styles.exportButton}
              onClick={() => setLocation(`/memories/${memory.id}/graph`)}
              title="View graph"
            >
              <Network size={16} />
              Graph
            </button>
          )}
          <div class={styles.exportMenuContainer}>
            <button class={styles.exportButton} onClick={editor.copyContent} title="Copy content to clipboard">
              {editor.copiedContent ? <Check size={16} /> : <Copy size={16} />}
              {editor.copiedContent ? 'Copied' : 'Copy'}
            </button>
            <div class={styles.exportMenuOptions}>
              <button class={styles.exportOption} onClick={editor.handleCopyMarkdown} title="Copy as Markdown with frontmatter">
                {editor.copiedMarkdown ? <Check size={14} /> : <FileText size={14} />}
                {editor.copiedMarkdown ? 'Copied' : 'Markdown'}
              </button>
              <button class={styles.exportOption} onClick={editor.handleExportSlack} title="Copy as Slack message">
                {editor.copiedSlack ? <Check size={14} /> : <MessageSquareText size={14} />}
                {editor.copiedSlack ? 'Copied' : 'Slack'}
              </button>
            </div>
          </div>
          <div class={styles.exportMenuContainer}>
            <button class={styles.exportButton} onClick={editor.handleExportMarkdown} title="Export as Markdown">
              <Download size={16} />
              Export
            </button>
            <div class={styles.exportMenuOptions}>
              <button class={styles.exportOption} onClick={editor.handleExportMarkdown} title="Download as Markdown">
                <FileText size={14} />
                Markdown
              </button>
              <button class={styles.exportOption} onClick={editor.handleExportDocx} title="Download as Word document">
                <FileDown size={14} />
                DOCX
              </button>
              {memory.type === 'csv' && (
                <>
                  <button class={styles.exportOption} onClick={editor.handleExportCsv} title="Download as CSV">
                    <FileDown size={14} />
                    CSV
                  </button>
                  <button class={styles.exportOption} onClick={editor.handleExportXlsx} title="Download as Excel spreadsheet">
                    <FileDown size={14} />
                    XLSX
                  </button>
                </>
              )}
              {memory.type && CANVAS_TYPES.has(memory.type) && (
                <button class={styles.exportOption} onClick={editor.handleExportHtml} title="Download as HTML file">
                  <FileDown size={14} />
                  HTML
                </button>
              )}
              {getSettings().drive.syncFolder && (
                <>
                  <button class={styles.exportOption} onClick={() => editor.handleSaveToDrive('markdown')} title="Save as Markdown to Google Drive folder">
                    <HardDriveDownload size={14} />
                    Drive (.md)
                  </button>
                  <button class={styles.exportOption} onClick={() => editor.handleSaveToDrive('docx')} title="Save as DOCX to Google Drive folder">
                    <HardDriveDownload size={14} />
                    Drive (.docx)
                  </button>
                  {memory.type === 'csv' && (
                    <>
                      <button class={styles.exportOption} onClick={() => editor.handleSaveToDrive('csv')} title="Save as CSV to Google Drive folder">
                        <HardDriveDownload size={14} />
                        Drive (.csv)
                      </button>
                      <button class={styles.exportOption} onClick={() => editor.handleSaveToDrive('xlsx')} title="Save as Excel to Google Drive folder">
                        <HardDriveDownload size={14} />
                        Drive (.xlsx)
                      </button>
                    </>
                  )}
                  {memory.type && CANVAS_TYPES.has(memory.type) && (
                    <button class={styles.exportOption} onClick={() => editor.handleSaveToDrive('html')} title="Save as HTML to Google Drive folder">
                      <HardDriveDownload size={14} />
                      Drive (.html)
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
          {memory.type === 'diagram' && (
            <button class={styles.exportButton} onClick={() => editor.exportAsPng()} title="Export as PNG">
              <ImageDown size={16} />
              PNG
            </button>
          )}
        </div>
      </div>

      <div class={styles.header}>
        <h1 class={styles.title}>{memory.title}</h1>
        {project && (
          <button
            class={styles.projectLink}
            onClick={() => setLocation(`/projects/${project.id}`)}
            data-testid="memory-page--project-link"
          >
            {project.display_name || project.name || project.handle}
          </button>
        )}
      </div>
    </>
  )
}
