import { useRef, useEffect, useState } from 'preact/hooks'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { Send, Loader, GripHorizontal, Megaphone } from 'lucide-preact'
import styles from './ChatInput.module.css'

interface ChatInputProps {
  onSend: (content: string) => void
  disabled?: boolean
  sending?: boolean
  placeholder?: string
  broadcastMode?: boolean
  onBroadcastToggle?: (mode: boolean) => void
}

const MIN_HEIGHT = 44
const MAX_HEIGHT = 400
const DEFAULT_HEIGHT = 44

export function ChatInput({ onSend, disabled, sending, placeholder = 'Send a message... (Cmd+Enter)', broadcastMode, onBroadcastToggle }: ChatInputProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onSendRef = useRef(onSend)
  const disabledRef = useRef(disabled)
  const sendingRef = useRef(sending)
  onSendRef.current = onSend
  disabledRef.current = disabled
  sendingRef.current = sending

  const [editorHeight, setEditorHeight] = useState(DEFAULT_HEIGHT)
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)

  const doSend = () => {
    const view = viewRef.current
    if (!view || disabledRef.current || sendingRef.current) return
    const content = view.state.doc.toString().trim()
    if (!content) return
    onSendRef.current(content)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
  }

  // Drag-to-resize from top edge
  const handleDragStart = (e: MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startHeight: editorHeight }

    const handleDragMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const delta = dragRef.current.startY - ev.clientY
      const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragRef.current.startHeight + delta))
      setEditorHeight(newHeight)
    }

    const handleDragEnd = () => {
      dragRef.current = null
      document.removeEventListener('mousemove', handleDragMove)
      document.removeEventListener('mouseup', handleDragEnd)
    }

    document.addEventListener('mousemove', handleDragMove)
    document.addEventListener('mouseup', handleDragEnd)
  }

  useEffect(() => {
    if (!containerRef.current) return

    const sendKeymap = keymap.of([
      {
        key: 'Mod-Enter',
        run: () => { doSend(); return true },
      },
    ])

    const theme = EditorView.theme({
      '&': {
        fontSize: '13px',
        backgroundColor: 'var(--bg-surface, #1a1a1a)',
        color: 'var(--text-primary, #e4e4e7)',
        borderRadius: '8px',
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.5',
        overflow: 'auto',
      },
      '.cm-content': {
        padding: '10px 12px',
        caretColor: '#60a5fa',
        minHeight: '20px',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: '#60a5fa',
      },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: '#1e3a5c',
      },
      '.cm-line': {
        padding: '0',
      },
      '.cm-placeholder': {
        color: 'var(--text-muted, #71717a)',
      },
    }, { dark: true })

    const state = EditorState.create({
      doc: '',
      extensions: [
        history(),
        markdown(),
        theme,
        sendKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        cmPlaceholder(placeholder),
        EditorView.lineWrapping,
      ],
    })

    const view = new EditorView({
      state,
      parent: containerRef.current,
    })

    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div class={styles.chatInput}>
      <div class={styles.resizeHandle} onMouseDown={handleDragStart} title="Drag to resize">
        <GripHorizontal size={14} />
      </div>
      <div class={styles.inputRow}>
        {onBroadcastToggle && (
          <button
            class={`${styles.broadcastBtn} ${broadcastMode ? styles.broadcastBtnActive : ''}`}
            onClick={() => onBroadcastToggle(!broadcastMode)}
            title={broadcastMode ? 'Switch to direct message' : 'Broadcast to all active sessions'}
          >
            <Megaphone size={14} />
          </button>
        )}
        <div
          class={styles.editorWrapper}
          ref={containerRef}
          style={{ height: `${editorHeight}px` }}
        />
        <button
          class={styles.sendButton}
          onClick={doSend}
          disabled={disabled || sending}
          title="Send message (Cmd+Enter)"
        >
          {sending ? <Loader size={16} class={styles.spinning} /> : <Send size={16} />}
        </button>
      </div>
    </div>
  )
}
