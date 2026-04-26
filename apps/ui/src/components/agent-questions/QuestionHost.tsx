import { useEffect, useRef, useState } from 'preact/hooks'
import { MessageCircleQuestion } from 'lucide-preact'
import {
  type AgentQuestion,
  type AgentQuestionEvent,
  listAgentQuestions,
  openAgentQuestionStream,
} from '../../lib/api'
import { QuestionPanel } from './QuestionPanel'
import styles from './QuestionHost.module.css'

/**
 * QuestionHost subscribes to the agent-questions SSE stream and keeps a queue
 * of pending questions. When at least one question is pending it shows a
 * floating notification badge in the bottom-right corner. Clicking the badge
 * (or pressing Cmd+Shift+Q) opens the panel for the oldest pending question.
 *
 * The panel never auto-opens — new questions surface as a count on the badge,
 * not as an interruption.
 */
export function QuestionHost() {
  const [queue, setQueue] = useState<AgentQuestion[]>([])
  const [active, setActive] = useState<AgentQuestion | null>(null)
  const [open, setOpen] = useState(false)
  const queueRef = useRef<AgentQuestion[]>([])

  useEffect(() => {
    queueRef.current = queue
  }, [queue])

  useEffect(() => {
    let canceled = false

    listAgentQuestions()
      .then((res) => {
        if (canceled) return
        setQueue(res.questions)
      })
      .catch(() => {
        // ignore — SSE will populate
      })

    const onEvent = (event: AgentQuestionEvent) => {
      if (event.type === 'question.created' && event.question) {
        setQueue((prev) => {
          if (prev.some((q) => q.id === event.question!.id)) return prev
          return [...prev, event.question!]
        })
      } else if (
        event.type === 'question.answered' ||
        event.type === 'question.canceled' ||
        event.type === 'question.expired'
      ) {
        setQueue((prev) => prev.filter((q) => q.id !== event.question_id))
      }
    }

    const es = openAgentQuestionStream(onEvent)
    return () => {
      canceled = true
      es.close()
    }
  }, [])

  // Keep the active question pointed at the queue head while the panel is open.
  useEffect(() => {
    if (!open) {
      setActive(null)
      return
    }
    if (active && queue.some((q) => q.id === active.id)) return
    setActive(queue[0] ?? null)
  }, [queue, active, open])

  // Close the panel automatically when the queue empties.
  useEffect(() => {
    if (open && queue.length === 0) setOpen(false)
  }, [queue, open])

  // Cmd+Shift+Q opens the panel when at least one question is pending.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'q') {
        e.preventDefault()
        if (queueRef.current.length > 0) setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (queue.length === 0) return null

  return (
    <>
      <button
        type="button"
        class={`${styles.fab} ${open ? styles.fabHidden : ''}`}
        onClick={() => setOpen(true)}
        aria-label={`Open ${queue.length} pending agent question${queue.length === 1 ? '' : 's'}`}
        title="Open pending agent question (⌘⇧Q)"
        data-testid="agent-question-host--badge"
      >
        <MessageCircleQuestion size={18} />
        <span class={styles.fabCount}>{queue.length}</span>
      </button>
      {open && active && (
        <QuestionPanel
          // Key by question id so when the queue head rotates (e.g. after one
          // is submitted and the next slides in), Preact remounts the panel
          // and clears submit/value state — otherwise the new question would
          // inherit the previous one's `submitting=true`.
          key={active.id}
          question={active}
          onClose={() => setOpen(false)}
          onResolved={() => {
            // Server-side state changes (answered/canceled) will arrive via SSE
            // and remove the question from the queue. Until then, optimistically
            // drop it so the next queued question can take focus.
            if (active) {
              setQueue((prev) => prev.filter((q) => q.id !== active.id))
            }
          }}
        />
      )}
    </>
  )
}
