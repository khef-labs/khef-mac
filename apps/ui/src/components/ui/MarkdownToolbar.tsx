import type { RefObject } from 'preact'
import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import { Bold, Italic, Heading, Code, Link, List, ListOrdered, TextQuote, Minus, ChevronDown, FileImage } from 'lucide-preact'
import {
  formatBold,
  formatItalic,
  formatHeading,
  formatCode,
  formatLink,
  formatBulletList,
  formatNumberedList,
  formatBlockquote,
  formatHorizontalRule,
} from '../../lib/markdownFormat'
import styles from './MarkdownToolbar.module.css'

interface MarkdownToolbarProps {
  textareaRef: RefObject<HTMLTextAreaElement>
  onInsertFileLink?: () => void
}

export function MarkdownToolbar({ textareaRef, onInsertFileLink }: MarkdownToolbarProps) {
  const [headingOpen, setHeadingOpen] = useState(false)
  const headingRef = useRef<HTMLDivElement>(null)

  const run = (fn: (textarea: HTMLTextAreaElement) => void) => {
    const textarea = textareaRef.current
    if (!textarea) return
    fn(textarea)
  }

  // Close popover on outside click
  useEffect(() => {
    if (!headingOpen) return
    const handleClick = (e: MouseEvent) => {
      if (headingRef.current && !headingRef.current.contains(e.target as Node)) {
        setHeadingOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [headingOpen])

  const pickHeading = useCallback((level: 1 | 2 | 3 | 4 | 5) => {
    const textarea = textareaRef.current
    if (!textarea) return
    formatHeading(textarea, level)
    setHeadingOpen(false)
  }, [textareaRef])

  return (
    <div class={styles.toolbar} role="toolbar" aria-label="Markdown formatting">
      <button
        class={styles.button}
        onClick={() => run(formatBold)}
        title="Bold (Cmd+B)"
        type="button"
      >
        <Bold size={14} />
      </button>
      <button
        class={styles.button}
        onClick={() => run(formatItalic)}
        title="Italic (Cmd+I)"
        type="button"
      >
        <Italic size={14} />
      </button>

      <span class={styles.divider} />

      <div class={styles.headingContainer} ref={headingRef}>
        <button
          class={styles.buttonWithChevron}
          onClick={() => setHeadingOpen((v) => !v)}
          title="Heading"
          type="button"
        >
          <Heading size={14} />
          <ChevronDown size={10} />
        </button>
        {headingOpen && (
          <div class={styles.headingPopover}>
            {([1, 2, 3, 4, 5] as const).map((lvl) => (
              <button class={styles.headingOption} type="button" onClick={() => pickHeading(lvl)}>
                H{lvl}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        class={styles.button}
        onClick={() => run(formatCode)}
        title="Code"
        type="button"
      >
        <Code size={14} />
      </button>

      <span class={styles.divider} />

      <button
        class={styles.button}
        onClick={() => {
          const textarea = textareaRef.current
          if (textarea) formatLink(textarea)
        }}
        title="Link (Cmd+K)"
        type="button"
      >
        <Link size={14} />
      </button>
      {onInsertFileLink && (
        <button
          class={styles.button}
          onClick={onInsertFileLink}
          title="Insert file as HTML img (Cmd+Shift+I)"
          type="button"
        >
          <FileImage size={14} />
        </button>
      )}

      <span class={styles.divider} />

      <button
        class={styles.button}
        onClick={() => run(formatBulletList)}
        title="Bullet list"
        type="button"
      >
        <List size={14} />
      </button>
      <button
        class={styles.button}
        onClick={() => run(formatNumberedList)}
        title="Numbered list"
        type="button"
      >
        <ListOrdered size={14} />
      </button>
      <button
        class={styles.button}
        onClick={() => run(formatBlockquote)}
        title="Blockquote"
        type="button"
      >
        <TextQuote size={14} />
      </button>

      <span class={styles.divider} />

      <button
        class={styles.button}
        onClick={() => run(formatHorizontalRule)}
        title="Horizontal rule"
        type="button"
      >
        <Minus size={14} />
      </button>
    </div>
  )
}
