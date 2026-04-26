import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks'
import type { DiffFile } from '../types'
import { getCommitDiff, getBranchDiff, type WorkingTreeDiff, type BranchDiffResponse } from '../lib/api'

export type WorkingTreeMode = 'combined' | 'staged' | 'unstaged' | 'untracked'

interface UseDiffOptions {
  projectId: string
  commitSha: string | null
  branch: string
  baseBranch?: string | null
}

export interface ParsedHunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: ParsedLine[]
}

export interface ParsedLine {
  type: 'context' | 'addition' | 'deletion' | 'hunk-header'
  content: string
  oldLineNumber?: number
  newLineNumber?: number
  lineIndex: number // Index within the file's diff for anchoring
}

export interface ParsedFile {
  path: string
  oldPath?: string
  status: DiffFile['status']
  additions: number
  deletions: number
  hunks: ParsedHunk[]
}

// Parse unified diff content into structured data
function parseUnifiedDiff(content: string | undefined | null, files: DiffFile[]): ParsedFile[] {
  if (!content) return []

  const result: ParsedFile[] = []
  const lines = content.split('\n')

  let currentFile: ParsedFile | null = null
  let currentHunk: ParsedHunk | null = null
  let oldLineNum = 0
  let newLineNum = 0
  let lineIndex = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // File header: diff --git a/path b/path
    if (line.startsWith('diff --git ')) {
      // Save previous file
      if (currentFile && currentHunk) {
        currentFile.hunks.push(currentHunk)
      }
      if (currentFile) {
        result.push(currentFile)
      }

      // Extract file path from the diff header
      const match = line.match(/diff --git a\/(.+) b\/(.+)/)
      const filePath = match ? match[2] : ''
      const fileInfo = files.find(f => f.path === filePath) || {
        path: filePath,
        status: 'modified' as const,
        additions: 0,
        deletions: 0,
      }

      currentFile = {
        path: fileInfo.path,
        oldPath: fileInfo.old_path,
        status: fileInfo.status,
        additions: fileInfo.additions,
        deletions: fileInfo.deletions,
        hunks: [],
      }
      currentHunk = null
      lineIndex = 0
      continue
    }

    // Skip other header lines (index, ---, +++)
    if (line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      continue
    }

    // New file mode, deleted file mode, rename hints
    if (line.startsWith('new file mode')) {
      if (currentFile) currentFile.status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      if (currentFile) currentFile.status = 'deleted'
      continue
    }
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      if (currentFile) currentFile.status = 'renamed'
      if (line.startsWith('rename from ') && currentFile) {
        currentFile.oldPath = line.slice('rename from '.length).trim()
      }
      continue
    }

    // Hunk header: @@ -old,count +new,count @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/)
    if (hunkMatch) {
      // Save previous hunk
      if (currentFile && currentHunk) {
        currentFile.hunks.push(currentHunk)
      }

      oldLineNum = parseInt(hunkMatch[1], 10)
      newLineNum = parseInt(hunkMatch[3], 10)

      currentHunk = {
        header: line,
        oldStart: oldLineNum,
        oldCount: parseInt(hunkMatch[2] || '1', 10),
        newStart: newLineNum,
        newCount: parseInt(hunkMatch[4] || '1', 10),
        lines: [{
          type: 'hunk-header',
          content: line,
          lineIndex: lineIndex++,
        }],
      }
      continue
    }

    // Diff lines
    if (currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({
          type: 'addition',
          content: line.slice(1),
          newLineNumber: newLineNum++,
          lineIndex: lineIndex++,
        })
        if (currentFile) currentFile.additions++
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({
          type: 'deletion',
          content: line.slice(1),
          oldLineNumber: oldLineNum++,
          lineIndex: lineIndex++,
        })
        if (currentFile) currentFile.deletions++
      } else if (line.startsWith(' ') || line === '') {
        // Context line or empty line
        currentHunk.lines.push({
          type: 'context',
          content: line.slice(1) || '',
          oldLineNumber: oldLineNum++,
          newLineNumber: newLineNum++,
          lineIndex: lineIndex++,
        })
      }
      // Skip "\ No newline at end of file" markers
    }
  }

  // Don't forget the last file/hunk
  if (currentFile && currentHunk) {
    currentFile.hunks.push(currentHunk)
  }
  if (currentFile) {
    result.push(currentFile)
  }

  return result
}

export function useDiff({ projectId, commitSha, branch, baseBranch }: UseDiffOptions) {
  const [rawContent, setRawContent] = useState<string>('')
  const [workingTree, setWorkingTree] = useState<WorkingTreeDiff | null>(null)
  const [workingTreeMode, setWorkingTreeMode] = useState<WorkingTreeMode>('combined')
  const [branchDiffData, setBranchDiffData] = useState<BranchDiffResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Ref to track mounted state
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const fetchDiff = useCallback(async () => {
    // Branch diff mode
    if (baseBranch && projectId) {
      setIsLoading(true)
      setError(null)
      try {
        const result = await getBranchDiff(projectId, baseBranch)
        if (!mountedRef.current) return
        setRawContent(result.diff || '')
        setWorkingTree(null)
        setBranchDiffData(result)
      } catch (err: any) {
        if (mountedRef.current) {
          setError(err.message || 'Failed to fetch branch diff')
          setRawContent('')
          setBranchDiffData(null)
        }
      } finally {
        if (mountedRef.current) setIsLoading(false)
      }
      return
    }

    // commitSha can be null for uncommitted changes, but we need projectId and branch
    if (!projectId || !branch) {
      setRawContent('')
      setWorkingTree(null)
      setBranchDiffData(null)
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const rawDiff = await getCommitDiff(projectId, commitSha, branch)

      if (!mountedRef.current) return

      setRawContent(rawDiff.content || '')
      setWorkingTree(rawDiff.workingTree || null)
      setBranchDiffData(null)
    } catch (err: any) {
      if (mountedRef.current) {
        setError(err.message || 'Failed to fetch diff')
        setRawContent('')
        setWorkingTree(null)
        setBranchDiffData(null)
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [projectId, commitSha, branch, baseBranch])

  // Compute the active content based on working tree mode
  const activeContent = useMemo(() => {
    if (workingTree) {
      return workingTree[workingTreeMode] || ''
    }
    return rawContent
  }, [workingTree, workingTreeMode, rawContent])

  // Parse the active content into files
  const parsedFiles = useMemo(() => {
    return parseUnifiedDiff(activeContent, [])
  }, [activeContent])

  // Load on mount / commitSha change
  useEffect(() => {
    fetchDiff()
  }, [fetchDiff])

  // Check if working tree has content in each mode
  const hasStaged = Boolean(workingTree?.staged?.trim())
  const hasUnstaged = Boolean(workingTree?.unstaged?.trim())
  const hasUntracked = Boolean(workingTree?.untracked?.trim())
  const untrackedFiles = workingTree?.untrackedFiles || []

  return {
    parsedFiles,
    rawContent,
    isLoading,
    error,
    refetch: fetchDiff,
    // Working tree mode support
    workingTreeMode,
    setWorkingTreeMode,
    isWorkingTree: Boolean(workingTree),
    hasStaged,
    hasUnstaged,
    hasUntracked,
    untrackedFiles,
    // Branch diff data
    branchDiffData,
  }
}
