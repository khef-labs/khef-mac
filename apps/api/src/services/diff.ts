/**
 * Reusable line-level diff computation.
 * Generic — works for memory snapshots, config snapshots, or any text content.
 */

import { diffLines } from 'diff';

export interface DiffChange {
  type: 'add' | 'remove' | 'equal' | 'skip';
  value: string;
  lines_skipped?: number;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  unchanged: number;
}

export interface DiffResult {
  changes: DiffChange[];
  stats: DiffStats;
}

/**
 * Compute a line-level diff between two strings.
 * Returns structured changes and summary stats (line counts).
 */
export function computeLineDiff(oldText: string, newText: string): DiffResult {
  const parts = diffLines(oldText, newText);

  const changes: DiffChange[] = [];
  let additions = 0;
  let deletions = 0;
  let unchanged = 0;

  for (const part of parts) {
    const lineCount = countLines(part.value);

    if (part.added) {
      changes.push({ type: 'add', value: part.value });
      additions += lineCount;
    } else if (part.removed) {
      changes.push({ type: 'remove', value: part.value });
      deletions += lineCount;
    } else {
      changes.push({ type: 'equal', value: part.value });
      unchanged += lineCount;
    }
  }

  return {
    changes,
    stats: { additions, deletions, unchanged },
  };
}

/**
 * Trim equal chunks to show only N lines of context around changes.
 * Inserts {type:'skip', lines_skipped} where content is omitted.
 */
export function applyContext(changes: DiffChange[], contextLines: number): DiffChange[] {
  const result: DiffChange[] = [];

  for (let i = 0; i < changes.length; i++) {
    const chunk = changes[i];

    if (chunk.type !== 'equal') {
      result.push(chunk);
      continue;
    }

    const lines = chunk.value.split('\n');
    // Preserve trailing empty string from split (represents trailing newline)
    const hasTrailingNewline = lines[lines.length - 1] === '';
    const contentLines = hasTrailingNewline ? lines.slice(0, -1) : lines;

    const hasPrev = i > 0;
    const hasNext = i < changes.length - 1;

    // How many lines to keep at start (context after previous change)
    const keepStart = hasPrev ? contextLines : 0;
    // How many lines to keep at end (context before next change)
    const keepEnd = hasNext ? contextLines : 0;

    if (contentLines.length <= keepStart + keepEnd) {
      // Chunk is small enough — keep it all
      result.push(chunk);
      continue;
    }

    // Split into: tail context, skip, head context
    if (keepStart > 0) {
      const startLines = contentLines.slice(0, keepStart);
      result.push({ type: 'equal', value: startLines.join('\n') + '\n' });
    }

    const skipped = contentLines.length - keepStart - keepEnd;
    result.push({ type: 'skip', value: '', lines_skipped: skipped });

    if (keepEnd > 0) {
      const endLines = contentLines.slice(contentLines.length - keepEnd);
      const suffix = hasTrailingNewline ? '\n' : '';
      result.push({ type: 'equal', value: endLines.join('\n') + suffix });
    }
  }

  return result;
}

/** Count non-empty lines in a string. */
function countLines(text: string): number {
  if (!text) return 0;
  // Split and count lines — a trailing newline doesn't add an extra line
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}
