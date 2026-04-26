import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks'
import type { RefObject } from 'preact'
import type { Comment, CreateCommentInput } from '../types'
import {
  getComments,
  createComment,
  updateComment,
  deleteComment,
  deleteResolvedComments,
  getPlanComments,
  createPlanComment,
  updatePlanComment,
  deletePlanComment,
  deletePlanResolvedComments,
} from '../lib/api'
import { locateAnchorInDOM } from '../lib/anchor'

// Comment with replies for threaded display
export interface CommentThread extends Comment {
  replies: Comment[]
}

// Anchor info for pending comment (content added later)
interface PendingAnchor {
  anchor_text?: string
  anchor_prefix?: string
  anchor_suffix?: string
}

// Base options for both entity types
interface UseCommentsBaseOptions {
  rawContent: string
  contentRef: RefObject<HTMLDivElement>
  /** Trigger re-highlight when rendered content changes */
  renderedContent: string
  /** Pre-loaded comments (skips initial GET) */
  initialComments?: Comment[]
}

// Memory-specific options
interface UseCommentsMemoryOptions extends UseCommentsBaseOptions {
  entityType?: 'memory'
  memoryId: string
}

// Plan-specific options (uses plan UUID)
interface UsePlanCommentsOptions extends UseCommentsBaseOptions {
  entityType: 'plan'
  planId: string
}

type UseCommentsOptions = UseCommentsMemoryOptions | UsePlanCommentsOptions

// Legacy interface for backward compatibility
interface UseLegacyCommentsOptions {
  memoryId: string
  rawContent: string
  contentRef: RefObject<HTMLDivElement>
  renderedContent: string
  initialComments?: Comment[]
}

// Helper to check if options are for plan entity
function isPlanOptions(opts: UseCommentsOptions | UseLegacyCommentsOptions): opts is UsePlanCommentsOptions {
  return 'entityType' in opts && opts.entityType === 'plan'
}

export function useComments(opts: UseCommentsOptions | UseLegacyCommentsOptions) {
  const {
    rawContent: _rawContent,
    contentRef,
    renderedContent,
    initialComments,
  } = opts

  // Extract entity-specific identifiers
  const isPlan = isPlanOptions(opts)
  const memoryId = isPlan ? '' : opts.memoryId
  const planId = isPlan ? opts.planId : ''

  // rawContent available for future use but not currently needed
  void _rawContent
  const [comments, setComments] = useState<Comment[]>(initialComments || [])
  const [isLoading, setIsLoading] = useState(false)
  const seededRef = useRef(false)
  const [commentInput, setCommentInput] = useState('')
  const [pendingAnchor, setPendingAnchor] = useState<PendingAnchor | null>(null)
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null)
  const [editingCommentContent, setEditingCommentContent] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showOrphaned, setShowOrphaned] = useState(false)

  // Ref to track mounted state
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // ---- derived lists ----
  const openComments = comments.filter((c) => c.status === 'active')
  const resolvedComments = comments.filter((c) => c.status === 'resolved')
  const activeComments = [...openComments, ...resolvedComments]
  const orphanedComments = comments.filter((c) => c.status === 'orphaned')
  const [showResolved, setShowResolved] = useState(false)

  // ---- threading ----
  // Track which threads are collapsed (expanded by default)
  const [collapsedThreads, setCollapsedThreads] = useState<Set<string>>(new Set())

  // Group top-level comments with their replies
  const threads = useMemo((): CommentThread[] => {
    // Parent comments (no parent_comment_id)
    const parentComments = comments.filter((c) => !c.parent_comment_id)
    return parentComments.map((parent) => ({
      ...parent,
      replies: comments.filter((c) => c.parent_comment_id === parent.id),
    }))
  }, [comments])

  // Open threads (parent is active, and group active replies)
  const openThreads = useMemo((): CommentThread[] => {
    return threads
      .filter((t) => t.status === 'active')
      .map((t) => ({
        ...t,
        replies: t.replies.filter((r) => r.status !== 'orphaned'),
      }))
  }, [threads])

  // Resolved threads (parent is resolved)
  const resolvedThreads = useMemo((): CommentThread[] => {
    return threads.filter((t) => t.status === 'resolved')
  }, [threads])

  // Orphaned threads (parent is orphaned)
  const orphanedThreads = useMemo((): CommentThread[] => {
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

  // Reset seeded flag when entity ID changes so stale comments aren't retained
  useEffect(() => {
    seededRef.current = false
  }, [memoryId, planId])

  // ---- fetch ----
  const fetchComments = useCallback(async () => {
    if (isPlan) {
      if (!planId) return
    } else {
      if (!memoryId) return
    }
    setIsLoading(true)
    try {
      const res = isPlan
        ? await getPlanComments(planId, { order: 'asc' })
        : await getComments(memoryId, { order: 'asc' })
      if (mountedRef.current) {
        setComments(res.comments || [])
      }
    } catch {
      // silently ignore fetch errors — section stays empty
    } finally {
      if (mountedRef.current) setIsLoading(false)
    }
  }, [isPlan, memoryId, planId])

  // Seed comments from memory fetch (avoids separate GET)
  useEffect(() => {
    if (initialComments && initialComments.length > 0) {
      setComments(initialComments)
      seededRef.current = true
    }
  }, [initialComments])

  // Load on mount / memoryId change (skip if seeded from memory)
  useEffect(() => {
    if (seededRef.current) {
      seededRef.current = false
      return
    }
    fetchComments()
  }, [fetchComments])

  // ---- submit ----
  const submitComment = useCallback(async () => {
    const content = commentInput.trim()
    if (!content) return
    if (isPlan) {
      if (!planId) {
        setError('Cannot submit comment: plan ID not available')
        return
      }
    } else {
      if (!memoryId) return
    }

    setIsSubmitting(true)
    setError(null)
    try {
      const data: CreateCommentInput = { content }
      if (pendingAnchor) {
        data.anchor_text = pendingAnchor.anchor_text
        data.anchor_prefix = pendingAnchor.anchor_prefix
        data.anchor_suffix = pendingAnchor.anchor_suffix
      }
      if (isPlan) {
        await createPlanComment(planId, data)
      } else {
        await createComment(memoryId, data)
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
  }, [commentInput, isPlan, memoryId, planId, pendingAnchor, fetchComments])

  // ---- submit reply ----
  const submitReply = useCallback(
    async (parentCommentId: string) => {
      const content = replyInput.trim()
      if (!content) return
      if (isPlan) {
        if (!planId) return
      } else {
        if (!memoryId) return
      }

      setIsSubmitting(true)
      setError(null)
      try {
        const data: CreateCommentInput = {
          content,
          parent_comment_id: parentCommentId,
        }
        if (isPlan) {
          await createPlanComment(planId, data)
        } else {
          await createComment(memoryId, data)
        }
        if (mountedRef.current) {
          setReplyInput('')
          setReplyingToId(null)
          // Auto-expand the thread to show the new reply (remove from collapsed)
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
    [replyInput, isPlan, memoryId, planId, fetchComments]
  )

  const startReply = useCallback((commentId: string) => {
    setReplyingToId(commentId)
    setReplyInput('')
    // Auto-expand the thread when starting a reply (remove from collapsed)
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
  const startEditing = useCallback((comment: Comment) => {
    setEditingCommentId(comment.id)
    setEditingCommentContent(comment.content)
  }, [])

  const cancelEditing = useCallback(() => {
    setEditingCommentId(null)
    setEditingCommentContent('')
  }, [])

  const saveEdit = useCallback(async () => {
    if (!editingCommentId) return
    if (isPlan) {
      if (!planId) return
    } else {
      if (!memoryId) return
    }
    setIsSubmitting(true)
    setError(null)
    try {
      if (isPlan) {
        await updatePlanComment(planId, editingCommentId, {
          content: editingCommentContent,
        })
      } else {
        await updateComment(memoryId, editingCommentId, {
          content: editingCommentContent,
        })
      }
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
  }, [editingCommentId, editingCommentContent, isPlan, memoryId, planId, fetchComments])

  // ---- delete ----
  const removeComment = useCallback(
    async (commentId: string) => {
      if (isPlan) {
        if (!planId) return
      } else {
        if (!memoryId) return
      }
      setError(null)
      try {
        if (isPlan) {
          await deletePlanComment(planId, commentId)
        } else {
          await deleteComment(memoryId, commentId)
        }
        if (mountedRef.current) await fetchComments()
      } catch (err: any) {
        if (mountedRef.current) setError(err.message || 'Failed to delete comment')
      }
    },
    [isPlan, memoryId, planId, fetchComments]
  )

  // ---- resolve ----
  const resolveComment = useCallback(
    async (commentId: string) => {
      if (isPlan) {
        if (!planId) return
      } else {
        if (!memoryId) return
      }
      setError(null)
      try {
        if (isPlan) {
          await updatePlanComment(planId, commentId, { status: 'resolved' })
        } else {
          await updateComment(memoryId, commentId, { status: 'resolved' })
        }
        if (mountedRef.current) await fetchComments()
      } catch (err: any) {
        if (mountedRef.current) setError(err.message || 'Failed to resolve comment')
      }
    },
    [isPlan, memoryId, planId, fetchComments]
  )

  // ---- reopen ----
  const reopenComment = useCallback(
    async (commentId: string) => {
      if (isPlan) {
        if (!planId) return
      } else {
        if (!memoryId) return
      }
      setError(null)
      try {
        if (isPlan) {
          await updatePlanComment(planId, commentId, { status: 'active' })
        } else {
          await updateComment(memoryId, commentId, { status: 'active' })
        }
        if (mountedRef.current) await fetchComments()
      } catch (err: any) {
        if (mountedRef.current) setError(err.message || 'Failed to reopen comment')
      }
    },
    [isPlan, memoryId, planId, fetchComments]
  )

  // ---- delete resolved ----
  const deleteResolved = useCallback(async () => {
    if (isPlan) {
      if (!planId) return
    } else {
      if (!memoryId) return
    }
    setError(null)
    try {
      if (isPlan) {
        await deletePlanResolvedComments(planId)
      } else {
        await deleteResolvedComments(memoryId)
      }
      if (mountedRef.current) await fetchComments()
    } catch (err: any) {
      if (mountedRef.current) setError(err.message || 'Failed to delete resolved comments')
    }
  }, [isPlan, memoryId, planId, fetchComments])

  // ---- anchor capture ----
  const captureSelection = useCallback(() => {
    // Always clear previous anchor first so stale values don't persist
    setPendingAnchor(null)

    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !contentRef.current) return

    const selectedText = selection.toString()
    if (!selectedText.trim()) return

    // Build anchor directly from DOM text.
    // We avoid searching raw markdown because rendered HTML strips formatting
    // characters (**, `, #, [](), etc.) so the DOM text often won't match
    // the raw source. Since locateAnchorInDOM re-matches against the DOM too,
    // storing DOM-based context is correct.
    const range = selection.getRangeAt(0)
    const container = contentRef.current

    const preRange = document.createRange()
    preRange.selectNodeContents(container)
    preRange.setEnd(range.startContainer, range.startOffset)
    const prefix = preRange.toString().slice(-50)

    const postRange = document.createRange()
    postRange.selectNodeContents(container)
    postRange.setStart(range.endContainer, range.endOffset)
    const suffix = postRange.toString().slice(0, 50)

    // Normalize whitespace to match what locateAnchorInDOM will see
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()

    setPendingAnchor({
      anchor_text: normalize(selectedText),
      anchor_prefix: normalize(prefix),
      anchor_suffix: normalize(suffix),
    })

    // Clear the browser selection
    selection.removeAllRanges()
  }, [contentRef])

  const clearAnchor = useCallback(() => {
    setPendingAnchor(null)
  }, [])

  // ---- scroll to anchor ----
  const scrollToAnchor = useCallback(
    (comment: Comment) => {
      if (!comment.anchor_text || !contentRef.current) return
      const range = locateAnchorInDOM(
        contentRef.current,
        comment.anchor_text,
        comment.anchor_prefix,
        comment.anchor_suffix
      )
      if (range) {
        const rect = range.getBoundingClientRect()
        const container = contentRef.current
        const containerRect = container.getBoundingClientRect()
        const isInContainer = rect.top >= containerRect.top && rect.top <= containerRect.bottom
        if (container.scrollHeight > container.clientHeight || isInContainer) {
          const offset = rect.top - containerRect.top
          container.scrollTo({
            top: Math.max(container.scrollTop + offset - 16, 0),
            behavior: 'smooth',
          })
          // Ensure the content container is visible in the viewport
          const viewportPadding = 16
          if (containerRect.top < viewportPadding || containerRect.bottom > window.innerHeight - viewportPadding) {
            container.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        } else {
          window.scrollTo({
            top: window.scrollY + rect.top - 120,
            behavior: 'smooth',
          })
        }
      }
    },
    [contentRef]
  )

  // ---- anchor highlighting ----
  useEffect(() => {
    const container = contentRef.current
    if (!container || !renderedContent) return

    // Small delay to let DOM settle after render
    const timer = setTimeout(() => {
      // Remove existing highlights
      container
        .querySelectorAll('mark[data-comment-anchor]')
        .forEach((el) => {
          const parent = el.parentNode
          if (parent) {
            // Replace mark with its text content
            const text = document.createTextNode(el.textContent || '')
            parent.replaceChild(text, el)
            parent.normalize()
          }
        })

      // Add highlights for each active anchored comment
      for (const comment of activeComments) {
        if (!comment.anchor_text) continue
        const range = locateAnchorInDOM(
          container,
          comment.anchor_text,
          comment.anchor_prefix,
          comment.anchor_suffix
        )
        if (!range) continue

        try {
          const mark = document.createElement('mark')
          mark.setAttribute('data-comment-anchor', '')
          mark.setAttribute('data-comment-id', comment.id)
          mark.className = 'comment-anchor'
          range.surroundContents(mark)
        } catch {
          // surroundContents fails if range spans multiple elements — skip
        }
      }
    }, 100)

    return () => clearTimeout(timer)
  }, [comments, renderedContent, contentRef]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const container = contentRef.current
    if (!container) return

    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      const anchor = target.closest('mark[data-comment-id]') as HTMLElement | null
      if (!anchor) return
      const commentId = anchor.getAttribute('data-comment-id')
      if (!commentId) return
      const getScrollParent = (): HTMLElement => {
        const main = document.querySelector('main') as HTMLElement | null
        if (main && main.scrollHeight > main.clientHeight) return main
        return (document.scrollingElement as HTMLElement) || document.documentElement
      }

      const getOffsetTop = (el: HTMLElement, parent: HTMLElement): number => {
        let top = 0
        let node: HTMLElement | null = el
        while (node && node !== parent) {
          top += node.offsetTop || 0
          node = node.offsetParent as HTMLElement | null
        }
        return top
      }

      const scrollPageToElement = (el: HTMLElement) => {
        const scrollParent = getScrollParent()
        const targetTop = Math.max(getOffsetTop(el, scrollParent) - 120, 0)
        scrollParent.scrollTo({ top: targetTop, behavior: 'smooth' })
      }

      const directTarget = document.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(commentId)}"]`)
      if (directTarget) {
        scrollPageToElement(directTarget)
        directTarget.classList.add('commentScrollTarget')
        window.setTimeout(() => {
          directTarget.classList.remove('commentScrollTarget')
        }, 1200)
        return
      }

      const parentById = new Map<string, string | null>()
      for (const c of comments) {
        parentById.set(c.id, c.parent_comment_id ?? null)
      }
      const parentId = parentById.get(commentId)
      if (parentId) {
        // Ensure parent thread is expanded
        setCollapsedThreads((prev) => {
          if (!prev.has(parentId)) return prev
          const next = new Set(prev)
          next.delete(parentId)
          return next
        })
        window.setTimeout(() => {
          const thread = document.querySelector<HTMLElement>(`[data-comment-thread="${CSS.escape(parentId)}"]`)
          if (thread) {
            scrollPageToElement(thread)
            thread.classList.add('commentScrollTarget')
            window.setTimeout(() => {
              thread.classList.remove('commentScrollTarget')
            }, 1200)
          }
        }, 120)
      }
    }

    container.addEventListener('click', handleClick)
    return () => {
      container.removeEventListener('click', handleClick)
    }
  }, [contentRef, comments])

  return {
    comments,
    openComments,
    resolvedComments,
    activeComments,
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

    fetchComments,
    submitComment,
    startEditing,
    cancelEditing,
    saveEdit,
    removeComment,
    resolveComment,
    reopenComment,
    deleteResolved,
    captureSelection,
    clearAnchor,
    scrollToAnchor,
  }
}
