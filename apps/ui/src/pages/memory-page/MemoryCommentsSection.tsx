import { useState } from 'preact/hooks'
import { Pencil, Copy, Check, Trash2, Send, ChevronDown, RotateCcw, User, Bot, MessageCircle, ChevronRight as ChevronRightIcon, FileText } from 'lucide-preact'
import clsx from 'clsx'
import type { useComments } from '../../hooks/useComments'
import styles from '../MemoryPage.module.css'

interface MemoryCommentsSectionProps {
  isViewingHistoricalSnapshot: boolean
  snapshotComments: any[]
  comments: ReturnType<typeof useComments>
  showToast: (msg: string) => void
}

export function MemoryCommentsSection({
  isViewingHistoricalSnapshot,
  snapshotComments,
  comments,
  showToast,
}: MemoryCommentsSectionProps) {
  const [copiedCommentId, setCopiedCommentId] = useState<string | null>(null)
  const [copiedCommentText, setCopiedCommentText] = useState<string | null>(null)

  const copyCommentId = async (commentId: string) => {
    try {
      await navigator.clipboard.writeText(commentId)
      setCopiedCommentId(commentId)
      setTimeout(() => {
        setCopiedCommentId((prev) => (prev === commentId ? null : prev))
      }, 2000)
    } catch (err) {
      console.error('Failed to copy comment ID:', err)
      showToast('Copy failed')
    }
  }

  const copyCommentText = async (commentId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedCommentText(commentId)
      setTimeout(() => {
        setCopiedCommentText((prev) => (prev === commentId ? null : prev))
      }, 2000)
    } catch (err) {
      console.error('Failed to copy comment text:', err)
      showToast('Copy failed')
    }
  }

  return (
    <div class={styles.commentsSection} data-testid="memory-page--comments-section">
      <div class={styles.commentsHeader}>
        <h2 class={styles.commentsTitle}>
          Comments
          {isViewingHistoricalSnapshot ? (
            snapshotComments.length > 0 && (
              <span class={styles.commentCount} data-testid="comments--count">{snapshotComments.length}</span>
            )
          ) : (
            comments.openThreads.length > 0 && (
              <span class={styles.commentCount} data-testid="comments--count">{comments.openThreads.length}</span>
            )
          )}
        </h2>
      </div>

      {/* Historical snapshot comments (read-only) */}
      {isViewingHistoricalSnapshot ? (
        snapshotComments.length > 0 ? (
          <div class={styles.commentsList}>
            {snapshotComments.map((comment: any) => (
              <div key={comment.id} class={styles.commentThread} data-comment-id={comment.id}>
                <div class={styles.commentItem}>
                  <div class={styles.commentBody}>
                    <span class={clsx(styles.commentAuthor, comment.author !== 'user' && styles.commentAuthorBot)}>
                      {comment.author === 'user' ? <User size={12} /> : <Bot size={12} />}
                      {comment.author || 'user'}
                    </span>
                    {comment.anchor_text && (
                      <span class={styles.commentAnchorBadge}>
                        &ldquo;{comment.anchor_text.length > 40
                          ? comment.anchor_text.slice(0, 40) + '...'
                          : comment.anchor_text}&rdquo;
                      </span>
                    )}
                    <p class={styles.commentContent}>{comment.content}</p>
                    <span class={styles.commentTimestamp}>
                      {new Date(comment.created_at).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p class={styles.emptyComments}>No comments at the time of this snapshot</p>
        )
      ) : (
      <>
      {/* Open comment threads (live) */}
      {comments.openThreads.length > 0 ? (
        <div class={styles.commentsList}>
          {comments.openThreads.map((thread) => (
            <div key={thread.id} class={styles.commentThread} data-comment-thread={thread.id} data-comment-id={thread.id}>
              <div class={styles.commentItem} data-testid={`comment--${thread.id}`}>
                {comments.editingCommentId === thread.id ? (
                  <div class={styles.commentEditArea}>
                    <textarea
                      class={styles.commentTextarea}
                      value={comments.editingCommentContent}
                      onInput={(e) =>
                        comments.setEditingCommentContent(
                          (e.target as HTMLTextAreaElement).value
                        )
                      }
                    />
                    <div class={styles.commentEditActions}>
                      <button
                        class={styles.cancelButton}
                        onClick={comments.cancelEditing}
                        disabled={comments.isSubmitting}
                      >
                        Cancel
                      </button>
                      <button
                        class={styles.saveButton}
                        onClick={comments.saveEdit}
                        disabled={comments.isSubmitting}
                      >
                        {comments.isSubmitting ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div class={styles.commentBody}>
                      <span class={clsx(styles.commentAuthor, thread.author !== 'user' && styles.commentAuthorBot)}>
                        {thread.author === 'user' ? <User size={12} /> : <Bot size={12} />}
                        {thread.author}
                      </span>
                      {thread.anchor_text && (
                        <button
                          class={styles.commentAnchorBadge}
                          onClick={() => comments.scrollToAnchor(thread)}
                          title="Click to scroll to anchored text"
                        >
                          &ldquo;{thread.anchor_text.length > 40
                            ? thread.anchor_text.slice(0, 40) + '...'
                            : thread.anchor_text}&rdquo;
                        </button>
                      )}
                      <p class={styles.commentContent}>{thread.content}</p>
                      <div class={styles.commentFooter}>
                        <span class={styles.commentTimestamp}>
                          {new Date(thread.created_at).toLocaleString()}
                        </span>
                        {thread.replies.length > 0 ? (
                          <button
                            class={clsx(
                              styles.replyToggle,
                              comments.isThreadExpanded(thread.id) && styles.replyToggleExpanded
                            )}
                            onClick={() => comments.toggleThread(thread.id)}
                          >
                            <ChevronRightIcon size={12} />
                            {thread.replies.length} {thread.replies.length === 1 ? 'reply' : 'replies'}
                          </button>
                        ) : (
                          <button
                            class={styles.replyLink}
                            onClick={() => comments.startReply(thread.id)}
                          >
                            Reply
                          </button>
                        )}
                      </div>
                    </div>
                    <div class={styles.commentActions}>
                      <button
                        class={styles.replyButton}
                        onClick={() => comments.startReply(thread.id)}
                        title="Reply"
                      >
                        <MessageCircle size={12} />
                      </button>
                      <button
                        class={styles.commentActionButton}
                        onClick={() => copyCommentText(thread.id, thread.content)}
                        title={copiedCommentText === thread.id ? 'Copied!' : 'Copy text'}
                      >
                        {copiedCommentText === thread.id ? <Check size={12} /> : <FileText size={12} />}
                      </button>
                      <button
                        class={styles.commentActionButton}
                        onClick={() => copyCommentId(thread.id)}
                        title={copiedCommentId === thread.id ? 'Copied!' : 'Copy comment ID'}
                      >
                        {copiedCommentId === thread.id ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                      <button
                        class={styles.commentActionButton}
                        onClick={() => comments.resolveComment(thread.id)}
                        title="Resolve comment"
                      >
                        <Check size={12} />
                      </button>
                      <button
                        class={styles.commentActionButton}
                        onClick={() => comments.startEditing(thread)}
                        title="Edit comment"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        class={styles.commentActionButton}
                        onClick={() => comments.removeComment(thread.id)}
                        title="Delete comment"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* Expanded replies */}
              {comments.isThreadExpanded(thread.id) && thread.replies.length > 0 && (
                <div class={styles.repliesContainer}>
                  {thread.replies.map((reply) => (
                    <div key={reply.id} class={styles.replyItem} data-comment-id={reply.id}>
                      <span class={styles.replyArrow}>↳</span>
                      <div class={styles.commentBody}>
                        <span class={clsx(styles.commentAuthor, reply.author !== 'user' && styles.commentAuthorBot)}>
                          {reply.author === 'user' ? <User size={12} /> : <Bot size={12} />}
                          {reply.author}
                        </span>
                        <p class={styles.commentContent}>{reply.content}</p>
                        <div class={styles.commentFooter}>
                          <span class={styles.commentTimestamp}>
                            {new Date(reply.created_at).toLocaleString()}
                          </span>
                          <button
                            class={styles.replyLink}
                            onClick={() => comments.startReply(thread.id)}
                          >
                            Reply
                          </button>
                        </div>
                      </div>
                      <div class={styles.commentActions}>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => copyCommentText(reply.id, reply.content)}
                          title={copiedCommentText === reply.id ? 'Copied!' : 'Copy text'}
                        >
                          {copiedCommentText === reply.id ? <Check size={12} /> : <FileText size={12} />}
                        </button>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => copyCommentId(reply.id)}
                          title={copiedCommentId === reply.id ? 'Copied!' : 'Copy comment ID'}
                        >
                          {copiedCommentId === reply.id ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => comments.startEditing(reply)}
                          title="Edit reply"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => comments.removeComment(reply.id)}
                          title="Delete reply"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Reply input (shown when replying to this thread) */}
              {comments.replyingToId === thread.id && (
                <div class={styles.repliesContainer}>
                  <div class={styles.replyInputArea}>
                    <div class={styles.replyInputRow}>
                      <textarea
                        class={styles.replyTextarea}
                        placeholder="Write a reply..."
                        value={comments.replyInput}
                        onInput={(e) =>
                          comments.setReplyInput((e.target as HTMLTextAreaElement).value)
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            comments.submitReply(thread.id)
                          }
                        }}
                        autoFocus
                      />
                      <button
                        class={styles.submitReplyButton}
                        onClick={() => comments.submitReply(thread.id)}
                        disabled={comments.isSubmitting || !comments.replyInput.trim()}
                        title="Submit reply (Enter)"
                      >
                        <Send size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        !comments.isLoading && comments.resolvedThreads.length === 0 && (
          <p class={styles.emptyComments} data-testid="comments--empty">No comments yet</p>
        )
      )}

      {/* Resolved threads (collapsible) */}
      {comments.resolvedThreads.length > 0 && (
        <div class={styles.resolvedSection}>
          <div class={styles.resolvedHeader}>
            <button
              class={styles.resolvedToggle}
              onClick={() => comments.setShowResolved(!comments.showResolved)}
            >
              <ChevronDown
                size={14}
                style={{
                  transform: comments.showResolved ? 'none' : 'rotate(-90deg)',
                  transition: 'transform 0.15s',
                }}
              />
              {comments.resolvedThreads.length} resolved{' '}
              {comments.resolvedThreads.length !== 1 ? 'threads' : 'thread'}
            </button>
            <button
              class={styles.deleteResolvedButton}
              onClick={() => comments.deleteResolved()}
              title="Delete all resolved comments"
            >
              <Trash2 size={12} />
              Delete resolved
            </button>
          </div>
          {comments.showResolved && (
            <div class={styles.commentsList}>
              {comments.resolvedThreads.map((thread) => (
                <div key={thread.id} class={styles.commentThread} data-comment-thread={thread.id} data-comment-id={thread.id}>
                  <div class={clsx(styles.commentItem, styles.commentItemResolved)}>
                    <div class={styles.commentBody}>
                      <span class={clsx(styles.commentAuthor, thread.author !== 'user' && styles.commentAuthorBot)}>
                        {thread.author === 'user' ? <User size={12} /> : <Bot size={12} />}
                        {thread.author}
                      </span>
                      {thread.anchor_text && (
                        <button
                          class={styles.commentAnchorBadge}
                          onClick={() => comments.scrollToAnchor(thread)}
                          title="Click to scroll to anchored text"
                        >
                          &ldquo;{thread.anchor_text.length > 40
                            ? thread.anchor_text.slice(0, 40) + '...'
                            : thread.anchor_text}&rdquo;
                        </button>
                      )}
                      <p class={styles.commentContent}>{thread.content}</p>
                      <span class={styles.commentTimestamp}>
                        {new Date(thread.created_at).toLocaleString()}
                      </span>
                      {thread.replies.length > 0 && (
                        <button
                          class={clsx(
                            styles.replyToggle,
                            comments.isThreadExpanded(thread.id) && styles.replyToggleExpanded
                          )}
                          onClick={() => comments.toggleThread(thread.id)}
                        >
                          <ChevronRightIcon size={12} />
                          {thread.replies.length} {thread.replies.length === 1 ? 'reply' : 'replies'}
                        </button>
                      )}
                    </div>
                    <div class={styles.commentActions}>
                      <button
                        class={styles.commentActionButton}
                        onClick={() => comments.reopenComment(thread.id)}
                        title="Reopen comment"
                      >
                        <RotateCcw size={12} />
                      </button>
                      <button
                        class={styles.commentActionButton}
                        onClick={() => comments.removeComment(thread.id)}
                        title="Delete comment"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  {comments.isThreadExpanded(thread.id) && thread.replies.length > 0 && (
                    <div class={styles.repliesContainer}>
                      {thread.replies.map((reply) => (
                        <div key={reply.id} class={clsx(styles.replyItem, styles.commentItemResolved)} data-comment-id={reply.id}>
                          <span class={styles.replyArrow}>↳</span>
                          <div class={styles.commentBody}>
                            <span class={clsx(styles.commentAuthor, reply.author !== 'user' && styles.commentAuthorBot)}>
                              {reply.author === 'user' ? <User size={12} /> : <Bot size={12} />}
                              {reply.author}
                            </span>
                            <p class={styles.commentContent}>{reply.content}</p>
                            <span class={styles.commentTimestamp}>
                              {new Date(reply.created_at).toLocaleString()}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Orphaned threads (collapsible) */}
      {comments.orphanedThreads.length > 0 && (
        <div class={styles.orphanedSection}>
          <button
            class={styles.orphanedToggle}
            onClick={() => comments.setShowOrphaned(!comments.showOrphaned)}
          >
            <ChevronDown
              size={14}
              style={{
                transform: comments.showOrphaned ? 'none' : 'rotate(-90deg)',
                transition: 'transform 0.15s',
              }}
            />
            {comments.orphanedThreads.length} orphaned{' '}
            {comments.orphanedThreads.length !== 1 ? 'threads' : 'thread'}
          </button>
          {comments.showOrphaned && (
            <div class={styles.commentsList}>
              {comments.orphanedThreads.map((thread) => (
                <div key={thread.id} class={styles.commentThread} data-comment-thread={thread.id} data-comment-id={thread.id}>
                  <div class={clsx(styles.commentItem, styles.commentItemOrphaned)}>
                    <div class={styles.commentBody}>
                      <span class={clsx(styles.commentAuthor, thread.author !== 'user' && styles.commentAuthorBot)}>
                        {thread.author === 'user' ? <User size={12} /> : <Bot size={12} />}
                        {thread.author}
                      </span>
                      <p class={styles.commentContent}>{thread.content}</p>
                      {thread.anchor_text && (
                        <span class={styles.commentAnchorBadgeOrphaned}>
                          &ldquo;{thread.anchor_text.length > 40
                            ? thread.anchor_text.slice(0, 40) + '...'
                            : thread.anchor_text}&rdquo;
                        </span>
                      )}
                      <span class={styles.commentTimestamp}>
                        {new Date(thread.created_at).toLocaleString()}
                      </span>
                      {thread.replies.length > 0 && (
                        <button
                          class={clsx(
                            styles.replyToggle,
                            comments.isThreadExpanded(thread.id) && styles.replyToggleExpanded
                          )}
                          onClick={() => comments.toggleThread(thread.id)}
                        >
                          <ChevronRightIcon size={12} />
                          {thread.replies.length} {thread.replies.length === 1 ? 'reply' : 'replies'}
                        </button>
                      )}
                    </div>
                    <div class={styles.commentActions}>
                      <button
                        class={styles.commentActionButton}
                        onClick={() => comments.resolveComment(thread.id)}
                        title="Resolve"
                      >
                        <Check size={12} />
                      </button>
                      <button
                        class={styles.commentActionButton}
                        onClick={() => comments.removeComment(thread.id)}
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  {comments.isThreadExpanded(thread.id) && thread.replies.length > 0 && (
                    <div class={styles.repliesContainer}>
                      {thread.replies.map((reply) => (
                        <div key={reply.id} class={clsx(styles.replyItem, styles.commentItemOrphaned)} data-comment-id={reply.id}>
                          <span class={styles.replyArrow}>↳</span>
                          <div class={styles.commentBody}>
                            <span class={clsx(styles.commentAuthor, reply.author !== 'user' && styles.commentAuthorBot)}>
                              {reply.author === 'user' ? <User size={12} /> : <Bot size={12} />}
                              {reply.author}
                            </span>
                            <p class={styles.commentContent}>{reply.content}</p>
                            <span class={styles.commentTimestamp}>
                              {new Date(reply.created_at).toLocaleString()}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Comment input area (general, non-anchored) */}
      <div class={styles.commentInputArea}>
        <div class={styles.commentInputRow}>
          <textarea
            data-comment-input
            class={styles.commentTextarea}
            placeholder="Add a comment... (select text + Alt+C to anchor)"
            value={comments.commentInput}
            onInput={(e) =>
              comments.setCommentInput((e.target as HTMLTextAreaElement).value)
            }
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                comments.submitComment()
              }
            }}
          />
          <button
            class={styles.submitCommentButton}
            onClick={comments.submitComment}
            disabled={comments.isSubmitting || !comments.commentInput.trim()}
            title="Submit comment (Cmd+Enter)"
            data-testid="comments--submit"
          >
            <Send size={14} />
          </button>
        </div>
        {comments.error && (
          <p class={styles.commentError}>{comments.error}</p>
        )}
      </div>
      </>
      )}
    </div>
  )
}
