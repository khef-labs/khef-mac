import { useRef, useEffect } from 'preact/hooks'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { EditorState, Compartment, EditorSelection, Prec, type Extension } from '@codemirror/state'
import {
  cursorCharBackward,
  cursorCharForward,
  cursorDocEnd,
  cursorDocStart,
  cursorGroupBackward,
  cursorGroupForward,
  cursorLineDown,
  cursorLineUp,
  selectCharBackward,
  selectCharForward,
  selectGroupBackward,
  selectGroupForward,
  selectLineDown,
  selectLineUp,
  indentWithTab,
  redo,
  undo,
} from '@codemirror/commands'
import { basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { markdown } from '@codemirror/lang-markdown'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { yaml } from '@codemirror/lang-yaml'
import { json } from '@codemirror/lang-json'
import { sql } from '@codemirror/lang-sql'
import { java } from '@codemirror/lang-java'
import { python } from '@codemirror/lang-python'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { HighlightStyle, syntaxHighlighting, foldAll, unfoldAll, StreamLanguage, foldService } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import styles from './CodeEditor.module.css'

export type EditorLanguage =
  | 'markdown'
  | 'javascript'
  | 'typescript'
  | 'json'
  | 'css'
  | 'html'
  | 'yaml'
  | 'plain'
  | 'shell'
  | 'sql'
  | 'python'
  | 'rust'
  | 'go'
  | string

interface CodeEditorProps {
  value: string
  onChange?: (value: string) => void
  language?: EditorLanguage
  readOnly?: boolean
  placeholder?: string
  className?: string
  autoFocus?: boolean
  fontSize?: number
  lineWrapping?: boolean
  onSave?: () => void
  onCursorChange?: (line: number, col: number) => void
  onScroll?: (topLine: number) => void
  cursorTarget?: { line: number; col: number; token: number } | null
  fileId?: string
  onPasteFile?: (file: File) => Promise<string | null>
  onGetFoldActions?: (actions: { foldAll: () => void; unfoldAll: () => void }) => void
}

type CMCommand = (view: EditorView) => boolean

// Emacs kill ring — shared across all CodeEditor instances (like Emacs)
let killRing = ''

// Per-file EditorState cache — preserves undo history across tab switches
const editorStateCache = new Map<string, EditorState>()

// Indent-based fold fallback for files that don't have a parser-driven
// folding extension. Works well for Python, shell, YAML, plain text, etc.
const indentFoldFallback = foldService.of((state, lineStart, lineEnd) => {
  const startLine = state.doc.lineAt(lineStart)
  const startText = startLine.text
  const startIndent = startText.search(/\S/)
  if (startIndent < 0) return null // blank line, nothing to fold
  let foldEnd = startLine.to
  let line = startLine
  while (line.to < state.doc.length) {
    const next = state.doc.lineAt(line.to + 1)
    const nextIndent = next.text.search(/\S/)
    if (nextIndent >= 0 && nextIndent <= startIndent) break
    foldEnd = next.to
    line = next
  }
  if (foldEnd <= lineEnd) return null
  return { from: lineEnd, to: foldEnd }
})

function getLanguageExtension(lang?: string) {
  switch (lang) {
    case 'javascript':
      return javascript({ jsx: true })
    case 'typescript':
      return javascript({ typescript: true, jsx: true })
    case 'json':
      return json()
    case 'markdown':
      return markdown()
    case 'css':
    case 'scss':
      return css()
    case 'html':
      return html()
    case 'yaml':
      return [yaml(), indentFoldFallback]
    case 'sql':
      return sql()
    case 'java':
      return java()
    case 'ruby':
      return [StreamLanguage.define(ruby), indentFoldFallback]
    case 'python':
      return [python(), indentFoldFallback]
    case 'shell':
    case 'bash':
      return [StreamLanguage.define(shell), indentFoldFallback]
    default:
      return indentFoldFallback
  }
}

function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return false
  const theme = document.documentElement.getAttribute('data-theme')
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

// ── Custom dark theme matching khef design tokens ──

const khefDarkTheme = EditorView.theme({
  '&': {
    backgroundColor: '#0f0f0f',
    color: '#e4e4e7',
  },
  '.cm-content': {
    caretColor: '#60a5fa',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: '#60a5fa',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: '#1e3a5c',
  },
  '.cm-content ::selection': {
    backgroundColor: '#1e3a5c',
    color: '#f4f4f5',
  },
  '.cm-panels': {
    backgroundColor: '#1a1a1a',
    color: '#e4e4e7',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid #2d2d2d',
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: '1px solid #2d2d2d',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(250, 204, 21, 0.25)',
    outline: '1px solid rgba(250, 204, 21, 0.4)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgba(250, 204, 21, 0.4)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'rgba(96, 165, 250, 0.15)',
  },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'rgba(96, 165, 250, 0.3)',
    outline: '1px solid rgba(96, 165, 250, 0.5)',
  },
  '.cm-gutters': {
    backgroundColor: '#0f0f0f',
    color: '#525252',
    borderRight: '1px solid #1f1f1f',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: '#a1a1aa',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: '#2d2d2d',
    border: 'none',
    color: '#71717a',
  },
  '.cm-tooltip': {
    border: '1px solid #2d2d2d',
    backgroundColor: '#1a1a1a',
    color: '#e4e4e7',
  },
  '.cm-tooltip .cm-tooltip-arrow:before': {
    borderTopColor: '#2d2d2d',
    borderBottomColor: '#2d2d2d',
  },
  '.cm-tooltip .cm-tooltip-arrow:after': {
    borderTopColor: '#1a1a1a',
    borderBottomColor: '#1a1a1a',
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li[aria-selected]': {
      backgroundColor: 'rgba(96, 165, 250, 0.2)',
      color: '#e4e4e7',
    },
  },
}, { dark: true })

const khefDarkHighlight = HighlightStyle.define([
  // Keywords: vibrant purple
  { tag: t.keyword, color: '#c084fc' },
  { tag: [t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#c084fc' },

  // Comments: muted but readable
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#6b7280', fontStyle: 'italic' },

  // Strings: green
  { tag: [t.string, t.special(t.string)], color: '#4ade80' },
  { tag: t.regexp, color: '#fb923c' },

  // Numbers: orange
  { tag: t.number, color: '#fb923c' },
  { tag: t.bool, color: '#fb923c' },

  // Variables and properties
  { tag: t.variableName, color: '#e4e4e7' },
  { tag: t.definition(t.variableName), color: '#67e8f9' },
  { tag: t.propertyName, color: '#93c5fd' },
  { tag: t.definition(t.propertyName), color: '#93c5fd' },

  // Functions: blue
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#60a5fa' },

  // Types: cyan
  { tag: [t.typeName, t.className, t.namespace], color: '#22d3ee' },
  { tag: t.definition(t.typeName), color: '#22d3ee' },

  // Tags (HTML/JSX): red-pink
  { tag: t.tagName, color: '#f87171' },
  { tag: t.attributeName, color: '#fdba74' },
  { tag: t.attributeValue, color: '#4ade80' },

  // Operators and punctuation
  { tag: t.operator, color: '#c084fc' },
  { tag: [t.punctuation, t.separator, t.bracket], color: '#a1a1aa' },
  { tag: t.derefOperator, color: '#e4e4e7' },

  // Markdown-specific
  { tag: t.heading, color: '#f87171', fontWeight: 'bold' },
  { tag: [t.heading1, t.heading2], color: '#f87171', fontWeight: 'bold' },
  { tag: [t.heading3, t.heading4], color: '#fb923c', fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic', color: '#fbbf24' },
  { tag: t.strong, fontWeight: 'bold', color: '#fbbf24' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: '#60a5fa', textDecoration: 'underline' },
  { tag: t.url, color: '#60a5fa' },
  { tag: [t.processingInstruction, t.inserted], color: '#4ade80' },
  { tag: t.monospace, color: '#a78bfa' },

  // Meta and special
  { tag: t.meta, color: '#71717a' },
  { tag: t.atom, color: '#fb923c' },
  { tag: t.self, color: '#f87171' },
  { tag: t.null, color: '#fb923c' },
  { tag: t.invalid, color: '#ef4444' },
])

const khefDarkExtension = [khefDarkTheme, syntaxHighlighting(khefDarkHighlight)]

// ── Custom light theme ──

const khefLightTheme = EditorView.theme({
  '&': {
    backgroundColor: '#ffffff',
    color: '#1a1a1a',
  },
  '.cm-content': {
    caretColor: '#3b82f6',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: '#3b82f6',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(59, 130, 246, 0.2)',
  },
  '.cm-panels': {
    backgroundColor: '#f5f5f5',
    color: '#1a1a1a',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(250, 204, 21, 0.3)',
    outline: '1px solid rgba(250, 204, 21, 0.5)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgba(250, 204, 21, 0.5)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(0, 0, 0, 0.03)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'rgba(59, 130, 246, 0.12)',
  },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'rgba(59, 130, 246, 0.2)',
    outline: '1px solid rgba(59, 130, 246, 0.4)',
  },
  '.cm-gutters': {
    backgroundColor: '#fafafa',
    color: '#9ca3af',
    borderRight: '1px solid #e5e7eb',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(0, 0, 0, 0.04)',
    color: '#6b7280',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: '#e5e7eb',
    border: 'none',
    color: '#9ca3af',
  },
  '.cm-tooltip': {
    border: '1px solid #e5e7eb',
    backgroundColor: '#ffffff',
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li[aria-selected]': {
      backgroundColor: 'rgba(59, 130, 246, 0.12)',
    },
  },
}, { dark: false })

const khefLightHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#7c3aed' },
  { tag: [t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#7c3aed' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#9ca3af', fontStyle: 'italic' },
  { tag: [t.string, t.special(t.string)], color: '#16a34a' },
  { tag: t.regexp, color: '#ea580c' },
  { tag: t.number, color: '#ea580c' },
  { tag: t.bool, color: '#ea580c' },
  { tag: t.variableName, color: '#1a1a1a' },
  { tag: t.definition(t.variableName), color: '#0891b2' },
  { tag: t.propertyName, color: '#2563eb' },
  { tag: t.definition(t.propertyName), color: '#2563eb' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#2563eb' },
  { tag: [t.typeName, t.className, t.namespace], color: '#0891b2' },
  { tag: t.tagName, color: '#dc2626' },
  { tag: t.attributeName, color: '#ea580c' },
  { tag: t.attributeValue, color: '#16a34a' },
  { tag: t.operator, color: '#7c3aed' },
  { tag: [t.punctuation, t.separator, t.bracket], color: '#6b7280' },
  { tag: t.heading, color: '#dc2626', fontWeight: 'bold' },
  { tag: [t.heading1, t.heading2], color: '#dc2626', fontWeight: 'bold' },
  { tag: [t.heading3, t.heading4], color: '#ea580c', fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic', color: '#b45309' },
  { tag: t.strong, fontWeight: 'bold', color: '#b45309' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: '#2563eb', textDecoration: 'underline' },
  { tag: t.url, color: '#2563eb' },
  { tag: t.monospace, color: '#7c3aed' },
  { tag: t.meta, color: '#9ca3af' },
  { tag: t.atom, color: '#ea580c' },
  { tag: t.self, color: '#dc2626' },
  { tag: t.null, color: '#ea580c' },
  { tag: t.invalid, color: '#ef4444' },
])

const khefLightExtension = [khefLightTheme, syntaxHighlighting(khefLightHighlight)]

// ── Component ──

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  placeholder,
  className,
  autoFocus = false,
  fontSize = 14,
  lineWrapping: lineWrappingProp = true,
  onSave,
  onCursorChange,
  onScroll,
  cursorTarget,
  fileId,
  onPasteFile,
  onGetFoldActions,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartment = useRef(new Compartment())
  const langCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  const fontSizeCompartment = useRef(new Compartment())
  const lineWrappingCompartment = useRef(new Compartment())

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onCursorRef = useRef(onCursorChange)
  onCursorRef.current = onCursorChange
  const onScrollRef = useRef(onScroll)
  onScrollRef.current = onScroll
  const onPasteFileRef = useRef(onPasteFile)
  onPasteFileRef.current = onPasteFile
  const emacsMarkActiveRef = useRef(false)
  const isApplyingExternalUpdateRef = useRef(false)
  const lastEmittedValueRef = useRef(value)
  const emitCounterRef = useRef(0)
  const extensionsRef = useRef<Extension[]>([])
  const prevFileIdRef = useRef(fileId)

  const buildFontSizeTheme = (size: number) => EditorView.theme({
    '&': { fontSize: `${size}px` },
    '.cm-gutters': { fontSize: `${size}px` },
  })

  const clearEmacsMark = (view?: EditorView | null) => {
    emacsMarkActiveRef.current = false
    if (!view) return
    const { main } = view.state.selection
    if (!main.empty) {
      view.dispatch({
        selection: EditorSelection.cursor(main.head),
      })
    }
  }

  const setEmacsMark = (view: EditorView) => {
    const head = view.state.selection.main.head
    emacsMarkActiveRef.current = true
    view.dispatch({
      selection: EditorSelection.cursor(head),
    })
    return true
  }

  const runEmacsMotion = (move: CMCommand, selectMove: CMCommand): CMCommand => {
    return (view) => {
      if (emacsMarkActiveRef.current) {
        return selectMove(view)
      }
      return move(view)
    }
  }

  const isModifierOnlyKey = (event: KeyboardEvent) =>
    event.key === 'Shift' ||
    event.key === 'Control' ||
    event.key === 'Alt' ||
    event.key === 'Meta'

  const isEmacsMarkKey = (event: KeyboardEvent) =>
    event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'Space'

  const isEmacsMovementKey = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase()
    if (event.metaKey) return false
    if (event.ctrlKey && !event.altKey && ['p', 'n', 'f', 'b', 'w', 'y', 'k', 'z'].includes(key)) return true
    if (event.altKey && !event.ctrlKey && ['f', 'b'].includes(key)) return true
    return false
  }

  useEffect(() => {
    if (!containerRef.current) return

    const dark = isDarkTheme()

    const fontSizeTheme = buildFontSizeTheme(fontSize)

    const extensions = [
      // Emacs mark + motion: Prec.highest before basicSetup so Ctrl-Space
      // wins over autocompletion's Prec.highest Ctrl-Space → startCompletion
      Prec.highest(keymap.of([
        {
          key: 'Ctrl-Space',
          preventDefault: true,
          run: setEmacsMark,
        },
        {
          key: 'Ctrl-g',
          run: (view) => {
            if (!emacsMarkActiveRef.current && view.state.selection.main.empty) return false
            clearEmacsMark(view)
            return true
          },
        },
        {
          key: 'Escape',
          run: (view) => {
            if (!emacsMarkActiveRef.current) return false
            clearEmacsMark(view)
            return true
          },
        },
        { key: 'Ctrl-p', preventDefault: true, run: runEmacsMotion(cursorLineUp, selectLineUp) },
        { key: 'Ctrl-n', preventDefault: true, run: runEmacsMotion(cursorLineDown, selectLineDown) },
        { key: 'Ctrl-f', preventDefault: true, run: runEmacsMotion(cursorCharForward, selectCharForward) },
        { key: 'Ctrl-b', preventDefault: true, run: runEmacsMotion(cursorCharBackward, selectCharBackward) },
        // Alt-f/b handled in domEventHandlers below (macOS Option key
        // transforms the character, so CM6 keymap matching fails)
        {
          key: 'Ctrl-k',
          preventDefault: true,
          run: (view) => {
            const { head } = view.state.selection.main
            const line = view.state.doc.lineAt(head)
            let to: number
            if (head >= line.to) {
              // At end of line — kill the newline (join with next line)
              to = Math.min(line.to + 1, view.state.doc.length)
            } else {
              // Kill from cursor to end of line
              to = line.to
            }
            if (head === to) return false
            killRing = view.state.sliceDoc(head, to)
            view.dispatch({ changes: { from: head, to } })
            emacsMarkActiveRef.current = false
            navigator.clipboard.writeText(killRing).catch(() => {})
            return true
          },
        },
        {
          key: 'Ctrl-o',
          preventDefault: true,
          run: (view) => {
            const { head } = view.state.selection.main
            const line = view.state.doc.lineAt(head)
            view.dispatch({
              changes: { from: line.from, insert: '\n' },
              selection: EditorSelection.cursor(line.from),
            })
            return true
          },
        },
        { key: 'Ctrl-z', preventDefault: true, stopPropagation: true, run: (view) => undo(view) },
        { key: 'Mod-z', preventDefault: true, stopPropagation: true, run: (view) => undo(view) },
        { key: 'Ctrl-Shift-z', preventDefault: true, stopPropagation: true, run: (view) => redo(view) },
        { key: 'Mod-Shift-z', preventDefault: true, stopPropagation: true, run: (view) => redo(view) },
        {
          key: 'Ctrl-w',
          preventDefault: true,
          run: (view) => {
            const { main } = view.state.selection
            if (main.empty) return false
            killRing = view.state.sliceDoc(main.from, main.to)
            view.dispatch({
              changes: { from: main.from, to: main.to },
              selection: EditorSelection.cursor(main.from),
            })
            emacsMarkActiveRef.current = false
            navigator.clipboard.writeText(killRing).catch(() => {})
            return true
          },
        },
        {
          key: 'Mod-c',
          preventDefault: true,
          run: (view) => {
            const { main } = view.state.selection
            if (main.empty) return false
            const text = view.state.sliceDoc(main.from, main.to)
            killRing = text
            navigator.clipboard.writeText(text).catch(() => {})
            emacsMarkActiveRef.current = false
            return true
          },
        },
        {
          key: 'Ctrl-y',
          preventDefault: true,
          run: (view) => {
            if (!killRing) return false
            const { main } = view.state.selection
            view.dispatch({
              changes: { from: main.from, to: main.to, insert: killRing },
              selection: EditorSelection.cursor(main.from + killRing.length),
            })
            return true
          },
        },
      ])),
      basicSetup,
      lineWrappingCompartment.current.of(lineWrappingProp ? EditorView.lineWrapping : []),
      themeCompartment.current.of(dark ? khefDarkExtension : khefLightExtension),
      langCompartment.current.of(getLanguageExtension(language)),
      readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
      fontSizeCompartment.current.of(fontSizeTheme),
      keymap.of([
        indentWithTab,
        {
          key: 'Mod-s',
          run: () => {
            onSaveRef.current?.()
            return true
          },
        },
      ]),
      EditorView.domEventHandlers({
        keydown: (_event, view) => {
          const event = _event as KeyboardEvent

          // Alt+F/B word movement — handled here because macOS Option key
          // transforms event.key to special chars (ƒ/∫), breaking CM6 keymap matching.
          // event.code is always KeyF/KeyB regardless of OS character transformation.
          if (event.altKey && !event.ctrlKey && !event.metaKey) {
            if (event.code === 'KeyF' || event.code === 'KeyB') {
              event.preventDefault()
              const forward = event.code === 'KeyF'
              if (emacsMarkActiveRef.current) {
                forward ? selectGroupForward(view) : selectGroupBackward(view)
              } else {
                forward ? cursorGroupForward(view) : cursorGroupBackward(view)
              }
              return true
            }
            // Alt+Shift+< / Alt+Shift+> — jump to beginning/end of document
            if (event.shiftKey && (event.code === 'Comma' || event.code === 'Period')) {
              event.preventDefault()
              const toStart = event.code === 'Comma'
              if (emacsMarkActiveRef.current) {
                const anchor = view.state.selection.main.anchor
                const target = toStart ? 0 : view.state.doc.length
                view.dispatch({
                  selection: EditorSelection.range(anchor, target),
                  scrollIntoView: true,
                })
              } else {
                toStart ? cursorDocStart(view) : cursorDocEnd(view)
              }
              return true
            }
          }
          if (!emacsMarkActiveRef.current) return false
          if (isModifierOnlyKey(event)) return false
          if (isEmacsMarkKey(event)) return false
          if (isEmacsMovementKey(event)) return false
          clearEmacsMark(view)
          return false
        },
        mousedown: () => {
          emacsMarkActiveRef.current = false
          return false
        },
        paste: (event, view) => {
          if (!onPasteFileRef.current) return false
          const items = (event as ClipboardEvent).clipboardData?.items
          if (!items) return false
          for (const item of Array.from(items)) {
            if (item.type.startsWith('image/')) {
              const file = item.getAsFile()
              if (!file) continue
              event.preventDefault()
              const pos = view.state.selection.main.head
              onPasteFileRef.current(file).then((markup) => {
                if (!markup) return
                view.dispatch({
                  changes: { from: pos, insert: markup },
                  selection: EditorSelection.cursor(pos + markup.length),
                })
              })
              return true
            }
          }
          return false
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          if (isApplyingExternalUpdateRef.current) {
            isApplyingExternalUpdateRef.current = false
            return
          }
          emacsMarkActiveRef.current = false
          const nextValue = update.state.doc.toString()
          lastEmittedValueRef.current = nextValue
          emitCounterRef.current++
          onChangeRef.current?.(nextValue)
        }
        if (update.selectionSet) {
          const pos = update.state.selection.main.head
          const line = update.state.doc.lineAt(pos)
          onCursorRef.current?.(line.number, pos - line.from + 1)
        }
        if (update.viewportChanged && onScrollRef.current) {
          const topLine = update.view.state.doc.lineAt(update.view.viewport.from).number
          onScrollRef.current(topLine)
        }
      }),
    ]

    if (placeholder) {
      extensions.push(cmPlaceholder(placeholder))
    }

    extensionsRef.current = extensions

    const state = EditorState.create({
      doc: value,
      extensions,
    })

    const view = new EditorView({
      state,
      parent: containerRef.current,
    })

    viewRef.current = view

    if (onGetFoldActions) {
      onGetFoldActions({
        foldAll: () => { if (viewRef.current) foldAll(viewRef.current) },
        unfoldAll: () => { if (viewRef.current) unfoldAll(viewRef.current) },
      })
    }

    if (autoFocus) {
      requestAnimationFrame(() => view.focus())
    }

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Capture emit counter at render time to detect stale value props in the effect
  const renderEmitCount = emitCounterRef.current

  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    // Per-file state management: save/restore EditorState on file switch
    if (fileId) {
      const prevId = prevFileIdRef.current
      prevFileIdRef.current = fileId

      if (prevId && fileId !== prevId) {
        editorStateCache.set(prevId, view.state)

        const cached = editorStateCache.get(fileId)
        if (cached && cached.doc.toString() === value) {
          isApplyingExternalUpdateRef.current = true
          view.setState(cached)
        } else {
          const newState = EditorState.create({
            doc: value,
            extensions: extensionsRef.current,
          })
          isApplyingExternalUpdateRef.current = true
          view.setState(newState)
        }
        lastEmittedValueRef.current = value
        return
      }
    }

    // Same file (or no fileId): apply external value changes.
    // Skip if user has edited since this render — the value prop is from a
    // stale intermediate render and would overwrite the user's latest edit.
    if (emitCounterRef.current !== renderEmitCount) return
    const currentDoc = view.state.doc.toString()
    if (value === currentDoc) {
      // Doc already matches — keep the ref in sync so later skips are correct.
      lastEmittedValueRef.current = value
      return
    }
    isApplyingExternalUpdateRef.current = true
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    })
    lastEmittedValueRef.current = value
  }, [value, fileId])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !cursorTarget) return

    const targetLine = Math.max(1, Math.min(cursorTarget.line, view.state.doc.lines))
    const lineInfo = view.state.doc.line(targetLine)
    const targetCol = Math.max(1, cursorTarget.col)
    const head = Math.min(lineInfo.from + targetCol - 1, lineInfo.to)

    view.dispatch({
      selection: EditorSelection.cursor(head),
      effects: EditorView.scrollIntoView(head, { y: 'center' }),
    })
    view.focus()
  }, [cursorTarget?.token])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: langCompartment.current.reconfigure(getLanguageExtension(language)),
    })
  }, [language])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
    })
  }, [readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: lineWrappingCompartment.current.reconfigure(lineWrappingProp ? EditorView.lineWrapping : []),
    })
  }, [lineWrappingProp])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: fontSizeCompartment.current.reconfigure(
        buildFontSizeTheme(fontSize)
      ),
    })
  }, [fontSize])

  useEffect(() => {
    if (typeof document === 'undefined') return

    const updateTheme = () => {
      const view = viewRef.current
      if (!view) return
      const dark = isDarkTheme()
      view.dispatch({
        effects: themeCompartment.current.reconfigure(
          dark ? khefDarkExtension : khefLightExtension
        ),
      })
    }

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.attributeName === 'data-theme') {
          updateTheme()
          break
        }
      }
    })
    observer.observe(document.documentElement, { attributes: true })

    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', updateTheme)

    return () => {
      observer.disconnect()
      mq.removeEventListener('change', updateTheme)
    }
  }, [])

  return (
    <div
      ref={containerRef}
      class={`${styles.editor} ${className || ''}`}
    />
  )
}
