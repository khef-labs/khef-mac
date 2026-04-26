import type { SnapshotDiffChange } from '../../lib/api'
import styles from './SnapshotDiffViewer.module.css'

interface SnapshotDiffStats {
  additions: number
  deletions: number
  unchanged: number
}

interface SnapshotDiffViewerProps {
  changes: SnapshotDiffChange[]
  stats: SnapshotDiffStats
  isLoading?: boolean
  error?: string | null
  fromLabel?: string
  toLabel?: string
}

const MAX_LINE_LENGTH = 500

function truncateLine(text: string): { text: string; truncated: boolean; fullLength: number } {
  if (text.length <= MAX_LINE_LENGTH) return { text, truncated: false, fullLength: text.length }
  return { text: text.slice(0, MAX_LINE_LENGTH), truncated: true, fullLength: text.length }
}

function splitLines(value: string): string[] {
  if (!value) return []
  const lines = value.split('\n')
  // Trailing newline produces empty last element — drop it
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    return lines.slice(0, -1)
  }
  return lines
}

export function SnapshotDiffViewer({
  changes,
  stats,
  isLoading,
  error,
  fromLabel,
  toLabel,
}: SnapshotDiffViewerProps) {
  if (isLoading) {
    return (
      <div class={styles.container}>
        <div class={styles.loading}>Computing diff...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div class={styles.container}>
        <div class={styles.error}>{error}</div>
      </div>
    )
  }

  const totalChanges = stats.additions + stats.deletions
  const isEmpty = totalChanges === 0

  // Build line entries with line numbers
  type LineEntry = {
    type: 'add' | 'remove' | 'equal' | 'skip'
    content: string
    oldLineNum?: number
    newLineNum?: number
    linesSkipped?: number
  }

  const lines: LineEntry[] = []
  let oldLine = 1
  let newLine = 1

  for (const chunk of changes) {
    if (chunk.type === 'skip') {
      lines.push({
        type: 'skip',
        content: '',
        linesSkipped: chunk.lines_skipped,
      })
      const skipped = chunk.lines_skipped ?? 0
      oldLine += skipped
      newLine += skipped
      continue
    }

    const chunkLines = splitLines(chunk.value)
    for (const text of chunkLines) {
      if (chunk.type === 'add') {
        lines.push({ type: 'add', content: text, newLineNum: newLine })
        newLine++
      } else if (chunk.type === 'remove') {
        lines.push({ type: 'remove', content: text, oldLineNum: oldLine })
        oldLine++
      } else {
        lines.push({ type: 'equal', content: text, oldLineNum: oldLine, newLineNum: newLine })
        oldLine++
        newLine++
      }
    }
  }

  return (
    <div class={styles.container}>
      {/* Stats bar */}
      <div class={styles.statsBar}>
        {fromLabel && toLabel ? (
          <span class={styles.labels}>
            {fromLabel} → {toLabel}
          </span>
        ) : null}
        <span class={styles.statsGroup}>
          {isEmpty ? (
            <span class={styles.statNoChange}>No changes</span>
          ) : (
            <>
              {stats.additions > 0 && (
                <span class={styles.statAdd}>+{stats.additions}</span>
              )}
              {stats.deletions > 0 && (
                <span class={styles.statRemove}>-{stats.deletions}</span>
              )}
              <span class={styles.statEqual}>{stats.unchanged} unchanged</span>
            </>
          )}
        </span>
      </div>

      {/* Diff lines */}
      {!isEmpty && (
        <div class={styles.diffBody}>
          {lines.map((line, i) => {
            if (line.type === 'skip') {
              return (
                <div key={i} class={styles.skipLine}>
                  <span class={styles.lineNum} />
                  <span class={styles.lineNum} />
                  <span class={styles.skipContent}>
                    ⋮ {line.linesSkipped} unchanged line{line.linesSkipped !== 1 ? 's' : ''}
                  </span>
                </div>
              )
            }

            const lineClass =
              line.type === 'add'
                ? styles.lineAdd
                : line.type === 'remove'
                  ? styles.lineRemove
                  : styles.lineEqual

            const { text: displayText, truncated, fullLength } = truncateLine(line.content)

            return (
              <div key={i} class={`${styles.diffLine} ${lineClass}`}>
                <span class={styles.lineNum}>
                  {line.oldLineNum ?? ''}
                </span>
                <span class={styles.lineNum}>
                  {line.newLineNum ?? ''}
                </span>
                <span class={styles.linePrefix}>
                  {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                </span>
                <span class={styles.lineContent}>
                  {displayText || '\u00A0'}
                  {truncated && (
                    <span class={styles.truncated}>
                      {' '}[truncated — {fullLength.toLocaleString()} chars]
                    </span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
