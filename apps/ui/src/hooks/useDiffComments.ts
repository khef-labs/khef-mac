import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks'
import type { DiffComment, CreateDiffCommentInput } from '../types'
import {
  getDiffComments,
  getDiffByRef,
  createDiffComment,
  createDiffCommentByRef,
  updateDiffComment,
  deleteDiffComment,
  deleteDiffResolvedComments,
} from '../lib/api'

// Comment with replies for threaded display
export interface DiffCommentThread extends DiffComment {
  replies: DiffComment[]
}

// Pending anchor for new comment (file path + line number)
interface PendingLineAnchor {
  anchor_path: string
  anchor_line: number
}

interface UseDiffCommentsOptions {
  /** Project ID for creating diff records */
  projectId: string
  /** Commit SHA or null for working tree */
  commitSha: string | null
  /** Branch name */
  branch: string
  /** Initial comments if diff record already exists */
  initialComments?: DiffComment[]
}

export function useDiffComments({ projectId, commitSha, branch, initialComments }: UseDiffCommentsOptions) {
  // Track diffId internally - starts null, set when first comment is created
  const [diffId, setDiffId] = useState<string | null>(null)
  const [comments, setComments] = useState<DiffComment[]>(initialComments || [])
  const [isLoading, setIsLoading] = useState(false)
  const seededRef = useRef(false)
  const [commentInput, setCommentInput] = useState('')
  const [pendingAnchor, setPendingAnchor] = useState<PendingLineAnchor | null>(null)
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null)
  const [editingCommentContent, setEditingCommentContent] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showOrphaned, setShowOrphaned] = useState(false)
  const [showResolved, setShowResolved] = useState(false)

  // Ref to track mounted state
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Fetch existing diff record on mount / ref change
  useEffect(() => {
    if (!projectId || !branch) return

    // Reset when commit changes so comments go to the correct diff record
    setDiffId(null)
    setComments([])

    const ref = commitSha || 'working'
    let cancelled = false

    getDiffByRef(projectId, ref)
      .then((diff) => {
        if (cancelled || !mountedRef.current) return
        if (diff) {
          setDiffId(diff.id)
          if (diff.comments && diff.comments.length > 0) {
            setComments(diff.comments)
          }
        }
      })
      .catch(() => {
        // Ignore errors - diff may not exist yet
      })

    return () => { cancelled = true }
  }, [projectId, commitSha, branch])

  // ---- derived lists ----
  const openComments = comments.filter((c) => c.status === 'active')
  const resolvedComments = comments.filter((c) => c.status === 'resolved')
  const orphanedComments = comments.filter((c) => c.status === 'orphaned')

  // ---- threading ----
  const [collapsedThreads, setCollapsedThreads] = useState<Set<string>>(new Set())

  const threads = useMemo((): DiffCommentThread[] => {
    const parentComments = comments.filter((c) => !c.parent_comment_id)
    return parentComments.map((parent) => ({
      ...parent,
      replies: comments.filter((c) => c.parent_comment_id === parent.id),
    }))
  }, [comments])

  const openThreads = useMemo((): DiffCommentThread[] => {
    return threads
      .filter((t) => t.status === 'active')
      .map((t) => ({
        ...t,
        replies: t.replies.filter((r) => r.status !== 'orphaned'),
      }))
  }, [threads])

  const resolvedThreads = useMemo((): DiffCommentThread[] => {
    return threads.filter((t) => t.status === 'resolved')
  }, [threads])

  const orphanedThreads = useMemo((): DiffCommentThread[] => {
    return threads.filter((t) => t.status === 'orphaned')
  }, [threads])

  const toggleThread = useCallback((commentId: string) => {
    setCollapsedThreads((prev) => {
      const next = new Set(prev)
      if (next.has(commentId)) {
        next.delete(commentId)
      } else {
        next.add(commentId)
      }
      return next
    })
  }, [])

  const isThreadExpanded = useCallback(
    (commentId: string) => !collapsedThreads.has(commentId),
    [collapsedThreads]
  )

  // ---- reply state ----
  const [replyingToId, setReplyingToId] = useState<string | null>(null)
  const [replyInput, setReplyInput] = useState('')

  // ---- fetch ----
  const fetchComments = useCallback(async () => {
    if (!diffId) return
    setIsLoading(true)
    try {
      const res = await getDiffComments(diffId, { order: 'asc' })
      if (mountedRef.current) {
        setComments(res.comments || [])
      }
    } catch {
      // silently ignore fetch errors
    } finally {
      if (mountedRef.current) setIsLoading(false)
    }
  }, [diffId])

  // Seed comments from initial data
  useEffect(() => {
    if (initialComments && initialComments.length > 0) {
      setComments(initialComments)
      seededRef.current = true
    }
  }, [initialComments])

  // Load on mount / diffId change
  useEffect(() => {
    if (seededRef.current) {
      seededRef.current = false
      return
    }
    fetchComments()
  }, [fetchComments])

  // ---- line anchor ----
  const setLineAnchor = useCallback((path: string, line: number) => {
    setPendingAnchor({ anchor_path: path, anchor_line: line })
  }, [])

  const clearAnchor = useCallback(() => {
    setPendingAnchor(null)
    setCommentInput('')
  }, [])

  // ---- submit ----
  const submitComment = useCallback(async () => {
    const content = commentInput.trim()
    if (!content) return

    setIsSubmitting(true)
    setError(null)
    try {
      if (diffId) {
        // Use existing diff record
        const data: CreateDiffCommentInput = { content }
        if (pendingAnchor) {
          data.anchor_path = pendingAnchor.anchor_path
          data.anchor_line = pendingAnchor.anchor_line
        }
        await createDiffComment(diffId, data)
      } else {
        // No diff record yet - use by-ref endpoint to create both
        const ref = commitSha || 'working'
        const res = await createDiffCommentByRef(projectId, ref, {
          branch,
          content,
          anchor_path: pendingAnchor?.anchor_path,
          anchor_line: pendingAnchor?.anchor_line,
        })
        // Store the new diffId for subsequent comments
        if (mountedRef.current) {
          setDiffId(res.diff.id)
        }
      }
      if (mountedRef.current) {
        setCommentInput('')
        setPendingAnchor(null)
        await fetchComments()
      }
    } catch (err: any) {
      if (mountedRef.current) setError(err.message || 'Failed to add comment')
    } finally {
      if (mountedRef.current) setIsSubmitting(false)
    }
  }, [commentInput, diffId, pendingAnchor, fetchComments, projectId, commitSha, branch])

  // ---- submit reply ----
  const submitReply = useCallback(
    async (parentCommentId: string) => {
      const content = replyInput.trim()
      if (!content || !diffId) return

      setIsSubmitting(true)
      setError(null)
      try {
        const data: CreateDiffCommentInput = {
          content,
          parent_comment_id: parentCommentId,
        }
        await createDiffComment(diffId, data)
        if (mountedRef.current) {
          setReplyInput('')
          setReplyingToId(null)
          setCollapsedThreads((prev) => {
            const next = new Set(prev)
            next.delete(parentCommentId)
            return next
          })
          await fetchComments()
        }
      } catch (err: any) {
        if (mountedRef.current) setError(err.message || 'Failed to add reply')
      } finally {
        if (mountedRef.current) setIsSubmitting(false)
      }
    },
    [replyInput, diffId, fetchComments]
  )

  const startReply = useCallback((commentId: string) => {
    setReplyingToId(commentId)
    setReplyInput('')
    setCollapsedThreads((prev) => {
      const next = new Set(prev)
      next.delete(commentId)
      return next
    })
  }, [])

  const cancelReply = useCallback(() => {
    setReplyingToId(null)
    setReplyInput('')
  }, [])

  // ---- editing ----
  const startEditing = useCallback((comment: DiffComment) => {
    setEditingCommentId(comment.id)
    setEditingCommentContent(comment.content)
  }, [])

  const cancelEditing = useCallback(() => {
    setEditingCommentId(null)
    setEditingCommentContent('')
  }, [])

  const saveEdit = useCallback(async () => {
    if (!editingCommentId || !diffId) return
    setIsSubmitting(true)
    setError(null)
    try {
      await updateDiffComment(diffId, editingCommentId, {
        content: editingCommentContent,
      })
      if (mountedRef.current) {
        setEditingCommentId(null)
        setEditingCommentContent('')
        await fetchComments()
      }
    } catch (err: any) {
      if (mountedRef.current) setError(err.message || 'Failed to update comment')
    } finally {
      if (mountedRef.current) setIsSubmitting(false)
    }
  }, [editingCommentId, editingCommentContent, diffId, fetchComments])

  // ---- delete ----
  const removeComment = useCallback(
    async (commentId: string) => {
      if (!diffId) return
      setError(null)
      try {
        await deleteDiffComment(diffId, commentId)
        if (mountedRef.current) await fetchComments()
      } catch (err: any) {
        if (mountedRef.current) setError(err.message || 'Failed to delete comment')
      }
    },
    [diffId, fetchComments]
  )

  // ---- resolve ----
  const resolveComment = useCallback(
    async (commentId: string) => {
      if (!diffId) return
      setError(null)
      try {
        await updateDiffComment(diffId, commentId, { status: 'resolved' })
        if (mountedRef.current) await fetchComments()
      } catch (err: any) {
        if (mountedRef.current) setError(err.message || 'Failed to resolve comment')
      }
    },
    [diffId, fetchComments]
  )

  // ---- reopen ----
  const reopenComment = useCallback(
    async (commentId: string) => {
      if (!diffId) return
      setError(null)
      try {
        await updateDiffComment(diffId, commentId, { status: 'active' })
        if (mountedRef.current) await fetchComments()
      } catch (err: any) {
        if (mountedRef.current) setError(err.message || 'Failed to reopen comment')
      }
    },
    [diffId, fetchComments]
  )

  // ---- delete resolved ----
  const deleteResolved = useCallback(async () => {
    if (!diffId) return
    setError(null)
    try {
      await deleteDiffResolvedComments(diffId)
      if (mountedRef.current) await fetchComments()
    } catch (err: any) {
      if (mountedRef.current) setError(err.message || 'Failed to delete resolved comments')
    }
  }, [diffId, fetchComments])

  // ---- get comments for a specific line ----
  const getLineComments = useCallback(
    (path: string, line: number): DiffCommentThread[] => {
      return openThreads.filter(
        (t) => t.anchor_path === path && t.anchor_line === line
      )
    },
    [openThreads]
  )

  // ---- get comment count for a line ----
  const getLineCommentCount = useCallback(
    (path: string, line: number): number => {
      return openComments.filter(
        (c) => c.anchor_path === path && c.anchor_line === line
      ).length
    },
    [openComments]
  )

  return {
    // Diff record ID (null until first comment creates it)
    diffId,
    comments,
    openComments,
    resolvedComments,
    orphanedComments,
    isLoading,
    commentInput,
    setCommentInput,
    pendingAnchor,
    editingCommentId,
    editingCommentContent,
    setEditingCommentContent,
    isSubmitting,
    error,
    showResolved,
    setShowResolved,
    showOrphaned,
    setShowOrphaned,

    // Threading
    threads,
    openThreads,
    resolvedThreads,
    orphanedThreads,
    collapsedThreads,
    toggleThread,
    isThreadExpanded,

    // Replies
    replyingToId,
    replyInput,
    setReplyInput,
    startReply,
    cancelReply,
    submitReply,

    // Actions
    fetchComments,
    submitComment,
    startEditing,
    cancelEditing,
    saveEdit,
    removeComment,
    resolveComment,
    reopenComment,
    deleteResolved,

    // Line anchoring
    setLineAnchor,
    clearAnchor,
    getLineComments,
    getLineCommentCount,
  }
}
