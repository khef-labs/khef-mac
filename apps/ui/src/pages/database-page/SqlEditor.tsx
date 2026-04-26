import { useRef, useEffect } from 'preact/hooks'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { sql, PostgreSQL } from '@codemirror/lang-sql'
import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, foldKeymap, codeFolding, foldAll, unfoldAll } from '@codemirror/language'
import styles from './DatabasePage.module.css'

interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  onRun: () => void
  onSave?: () => void
  onCloseTab?: () => void
  onGetSelectedText?: (getText: () => string | null) => void
  onGetFoldActions?: (actions: { foldAll: () => void; unfoldAll: () => void }) => void
}

export function SqlEditor({ value, onChange, onRun, onSave, onCloseTab, onGetSelectedText, onGetFoldActions }: SqlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onRunRef = useRef(onRun)
  const onSaveRef = useRef(onSave)
  const onCloseTabRef = useRef(onCloseTab)
  onChangeRef.current = onChange
  onRunRef.current = onRun
  onSaveRef.current = onSave
  onCloseTabRef.current = onCloseTab

  // Prevent infinite update loop: track what we last emitted to parent
  const isApplyingExternalRef = useRef(false)
  const lastEmittedValueRef = useRef(value)
  const emitCounterRef = useRef(0)

  useEffect(() => {
    if (!containerRef.current) return

    const runKeymap = keymap.of([
      {
        key: 'Mod-Enter',
        run: () => { onRunRef.current(); return true },
      },
      {
        key: 'Mod-s',
        run: () => { onSaveRef.current?.(); return true },
      },
      {
        key: 'Mod-w',
        run: () => { onCloseTabRef.current?.(); return true },
      },
    ])

    const updateListener = EditorView.updateListener.of(update => {
      if (update.docChanged) {
        // Skip if we're applying an external value (prevents loop)
        if (isApplyingExternalRef.current) {
          isApplyingExternalRef.current = false
          return
        }
        const nextValue = update.state.doc.toString()
        lastEmittedValueRef.current = nextValue
        emitCounterRef.current++
        onChangeRef.current(nextValue)
      }
    })

    const theme = EditorView.theme({
      '&': {
        height: '100%',
        fontSize: '13px',
        backgroundColor: '#0f0f0f',
        color: '#e4e4e7',
      },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.6',
      },
      '.cm-content': {
        padding: '12px 0',
        caretColor: '#60a5fa',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: '#60a5fa',
      },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: '#1e3a5c',
      },
      '.cm-gutters': {
        backgroundColor: '#0f0f0f',
        borderRight: '1px solid #1f1f1f',
        color: '#525252',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'rgba(255, 255, 255, 0.04)',
        color: '#a1a1aa',
      },
      '.cm-activeLine': {
        backgroundColor: 'rgba(255, 255, 255, 0.04)',
      },
      '.cm-foldPlaceholder': {
        backgroundColor: '#2d2d2d',
        border: 'none',
        color: '#71717a',
      },
      '.cm-foldGutter .cm-gutterElement': {
        color: '#525252',
        cursor: 'pointer',
      },
      '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
        backgroundColor: 'rgba(96, 165, 250, 0.3)',
        outline: '1px solid rgba(96, 165, 250, 0.5)',
      },
      '.cm-tooltip': {
        border: '1px solid #2d2d2d',
        backgroundColor: '#1a1a1a',
        color: '#e4e4e7',
      },
      '.cm-tooltip-autocomplete': {
        '& > ul > li[aria-selected]': {
          backgroundColor: 'rgba(96, 165, 250, 0.2)',
          color: '#e4e4e7',
        },
      },
    }, { dark: true })

    const sqlHighlight = syntaxHighlighting(HighlightStyle.define([
      { tag: t.keyword, color: '#c084fc' },
      { tag: [t.controlKeyword, t.operatorKeyword], color: '#c084fc' },
      { tag: [t.string, t.special(t.string)], color: '#4ade80' },
      { tag: t.number, color: '#fb923c' },
      { tag: t.bool, color: '#fb923c' },
      { tag: [t.comment, t.lineComment, t.blockComment], color: '#6b7280', fontStyle: 'italic' },
      { tag: t.operator, color: '#c084fc' },
      { tag: [t.punctuation, t.separator, t.bracket], color: '#a1a1aa' },
      { tag: t.typeName, color: '#22d3ee' },
      { tag: [t.function(t.variableName)], color: '#60a5fa' },
      { tag: t.variableName, color: '#e4e4e7' },
      { tag: t.null, color: '#fb923c' },
      { tag: t.propertyName, color: '#93c5fd' },
    ]))

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        codeFolding(),
        foldGutter(),
        closeBrackets(),
        autocompletion(),
        sql({ dialect: PostgreSQL }),
        theme,
        sqlHighlight,
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        runKeymap,
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap, ...foldKeymap]),
        updateListener,
        cmPlaceholder('Enter SQL query...'),
        EditorView.lineWrapping,
      ],
    })

    const view = new EditorView({
      state,
      parent: containerRef.current,
    })

    viewRef.current = view

    // Expose fold actions to parent
    if (onGetFoldActions) {
      onGetFoldActions({
        foldAll: () => { if (viewRef.current) foldAll(viewRef.current) },
        unfoldAll: () => { if (viewRef.current) unfoldAll(viewRef.current) },
      })
    }

    // Expose active SQL getter: selection if any, otherwise the statement at cursor
    if (onGetSelectedText) {
      onGetSelectedText(() => {
        const v = viewRef.current
        if (!v) return null
        const sel = v.state.selection.main

        // If there's a selection, use it
        if (sel.from !== sel.to) {
          return v.state.sliceDoc(sel.from, sel.to)
        }

        // No selection — find the statement at cursor position
        const doc = v.state.doc.toString()
        const cursor = sel.head

        // Split by semicolons, tracking positions
        let start = 0
        const statements: { from: number; to: number; text: string }[] = []
        for (let i = 0; i <= doc.length; i++) {
          if (i === doc.length || doc[i] === ';') {
            const text = doc.slice(start, i).trim()
            if (text) {
              statements.push({ from: start, to: i, text })
            }
            start = i + 1
          }
        }

        // Find which statement contains the cursor
        for (const stmt of statements) {
          if (cursor >= stmt.from && cursor <= stmt.to + 1) {
            return stmt.text
          }
        }

        // Fallback: return the last statement if cursor is past all of them
        if (statements.length > 0) {
          return statements[statements.length - 1].text
        }

        return null
      })
    }

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, []) // Only create once

  // Capture emit counter at render time to detect stale value props
  const renderEmitCount = emitCounterRef.current

  // Sync external value changes (e.g., loading a script, history replay)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    // Skip if value matches what we last emitted — prevents loop
    if (value === lastEmittedValueRef.current) return
    // Skip if user has edited since this render — stale prop
    if (emitCounterRef.current !== renderEmitCount) return
    const currentDoc = view.state.doc.toString()
    if (currentDoc === value) return
    isApplyingExternalRef.current = true
    view.dispatch({
      changes: { from: 0, to: currentDoc.length, insert: value },
    })
  }, [value])

  return <div ref={containerRef} class={styles.cmEditor} />
}
