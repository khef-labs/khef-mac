import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { X, Check } from 'lucide-preact'
import {
  type AgentQuestion,
  type AgentQuestionField,
  answerAgentQuestion,
  cancelAgentQuestion,
} from '../../lib/api'
import styles from './QuestionPanel.module.css'

interface Props {
  question: AgentQuestion
  /** Called when the user closes the panel without resolving the question (Esc, X, outside-click). The question stays pending and the badge remains. */
  onClose: () => void
  /** Called after the question is answered or explicitly canceled via the API. */
  onResolved: (kind: 'answered' | 'canceled') => void
}

type Values = Record<string, unknown>

function buildInitialValues(fields: AgentQuestionField[]): Values {
  const out: Values = {}
  for (const f of fields) {
    if (f.default !== undefined) {
      out[f.key] = f.default
    } else if (f.type === 'multi-choice') {
      out[f.key] = []
    } else if (f.type === 'toggle') {
      out[f.key] = false
    }
  }
  return out
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'expired'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m === 0) return `${s}s`
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

function isMissing(field: AgentQuestionField, value: unknown): boolean {
  if (!field.required) return false
  if (value === undefined || value === null) return true
  if (typeof value === 'string' && value.trim() === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

export function QuestionPanel({ question, onClose, onResolved }: Props) {
  const [values, setValues] = useState<Values>(() => buildInitialValues(question.fields))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const submitRef = useRef<HTMLButtonElement>(null)
  const firstFieldRef = useRef<HTMLElement | null>(null)

  // Tick the expiry countdown once a second.
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(handle)
  }, [])

  // Focus the first interactive field on open.
  useEffect(() => {
    firstFieldRef.current?.focus?.()
  }, [question.id])

  const expiresAt = useMemo(() => new Date(question.expires_at).getTime(), [question.expires_at])
  const remainingMs = expiresAt - now
  const expiryClass = remainingMs < 30_000 ? styles.expiryUrgent : ''

  const requiredOk = useMemo(() => {
    return question.fields.every((f) => !isMissing(f, values[f.key]))
  }, [question.fields, values])

  const update = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  const toggleMulti = (key: string, optionValue: string) => {
    setValues((prev) => {
      const arr = Array.isArray(prev[key]) ? [...(prev[key] as string[])] : []
      const idx = arr.indexOf(optionValue)
      if (idx === -1) arr.push(optionValue)
      else arr.splice(idx, 1)
      return { ...prev, [key]: arr }
    })
  }

  const handleSubmit = async (e?: Event) => {
    e?.preventDefault()
    if (!requiredOk || submitting) return
    setError(null)
    setSubmitting(true)
    try {
      // Strip empty optional fields so backend gets a tidy payload.
      const payload: Values = {}
      for (const f of question.fields) {
        const v = values[f.key]
        if (v === undefined || v === null) continue
        if (typeof v === 'string' && v.trim() === '' && !f.required) continue
        payload[f.key] = v
      }
      await answerAgentQuestion(question.id, payload)
      onResolved('answered')
    } catch (err: any) {
      setError(err?.message || 'Failed to submit answer')
      setSubmitting(false)
    }
  }

  const handleCancelQuestion = async () => {
    try {
      await cancelAgentQuestion(question.id)
    } catch {
      // ignore — best effort
    }
    onResolved('canceled')
  }

  // Keyboard shortcuts: Cmd+Enter submit, Esc close (does NOT cancel the question).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        handleSubmit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requiredOk, submitting, values, onClose])

  return (
    <div
      class={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="aq-title"
      data-testid="agent-question-panel"
    >
      <form class={styles.panel} onSubmit={handleSubmit}>
        <div class={styles.header}>
          <div class={styles.titleBlock}>
            <div class={styles.kicker}>
              <span>Agent question</span>
              {question.agent.nickname && <span>· {question.agent.nickname}</span>}
              <span class={`${styles.expiry} ${expiryClass}`}>
                · {formatRemaining(remainingMs)}
              </span>
            </div>
            <h2 id="aq-title" class={styles.title}>
              {question.title}
            </h2>
          </div>
          <button
            type="button"
            class={styles.closeBtn}
            onClick={onClose}
            aria-label="Answer later (question stays pending)"
            title="Answer later (Esc) — question stays pending"
            data-testid="agent-question-panel--close"
          >
            <X size={16} />
          </button>
        </div>

        <div class={styles.scrollArea}>
          {question.description && <p class={styles.description}>{question.description}</p>}

          <div class={styles.fields}>
            {question.fields.map((field, idx) => {
            const value = values[field.key]
            const hint = field.hint ? <p class={styles.fieldHint}>{field.hint}</p> : null
            const labelEl = (
              <label class={styles.label} for={`aq-${field.key}`}>
                <span class={styles.fieldNumber}>{idx + 1}</span>
                <span class={styles.fieldLabelText}>{field.label}</span>
                {field.required && <span class={styles.required}>*</span>}
              </label>
            )

            const refForFirst = (el: HTMLElement | null) => {
              if (idx === 0) firstFieldRef.current = el
            }

            switch (field.type) {
              case 'text':
                return (
                  <div class={styles.field} key={field.key}>
                    {labelEl}
                    <input
                      ref={refForFirst}
                      class={styles.input}
                      id={`aq-${field.key}`}
                      type="text"
                      value={typeof value === 'string' ? value : ''}
                      placeholder={field.placeholder}
                      onInput={(e) => update(field.key, (e.target as HTMLInputElement).value)}
                      data-testid={`agent-question-field--${field.key}`}
                    />
                    {hint}
                  </div>
                )
              case 'textarea':
                return (
                  <div class={styles.field} key={field.key}>
                    {labelEl}
                    <textarea
                      ref={refForFirst}
                      class={styles.textarea}
                      id={`aq-${field.key}`}
                      value={typeof value === 'string' ? value : ''}
                      placeholder={field.placeholder}
                      onInput={(e) => update(field.key, (e.target as HTMLTextAreaElement).value)}
                      data-testid={`agent-question-field--${field.key}`}
                    />
                    {hint}
                  </div>
                )
              case 'number':
                return (
                  <div class={styles.field} key={field.key}>
                    {labelEl}
                    <input
                      ref={refForFirst}
                      class={styles.input}
                      id={`aq-${field.key}`}
                      type="number"
                      value={value === undefined || value === null ? '' : String(value)}
                      placeholder={field.placeholder}
                      min={field.min}
                      max={field.max}
                      onInput={(e) => {
                        const raw = (e.target as HTMLInputElement).value
                        update(field.key, raw === '' ? null : Number(raw))
                      }}
                      data-testid={`agent-question-field--${field.key}`}
                    />
                    {hint}
                  </div>
                )
              case 'toggle':
                return (
                  <div class={styles.field} key={field.key}>
                    <label class={styles.toggle} for={`aq-${field.key}`}>
                      <span class={styles.fieldNumber}>{idx + 1}</span>
                      <input
                        ref={refForFirst}
                        id={`aq-${field.key}`}
                        type="checkbox"
                        class={styles.toggleInput}
                        checked={Boolean(value)}
                        onChange={(e) =>
                          update(field.key, (e.target as HTMLInputElement).checked)
                        }
                        data-testid={`agent-question-field--${field.key}`}
                      />
                      <span class={styles.fieldLabelText}>{field.label}</span>
                      {field.required && <span class={styles.required}>*</span>}
                    </label>
                    {hint}
                  </div>
                )
              case 'single-choice':
                return (
                  <div class={styles.field} key={field.key}>
                    {labelEl}
                    <div class={styles.optionList} role="radiogroup">
                      {(field.options ?? []).map((opt, optIdx) => {
                        const checked = value === opt.value
                        return (
                          <label
                            class={`${styles.option} ${checked ? styles.optionSelected : ''}`}
                            key={opt.value}
                            data-testid={`agent-question-option--${field.key}--${opt.value}`}
                          >
                            <input
                              ref={idx === 0 && optIdx === 0 ? refForFirst : undefined}
                              type="radio"
                              class={styles.optionRadio}
                              name={`aq-${field.key}`}
                              value={opt.value}
                              checked={checked}
                              onChange={() => update(field.key, opt.value)}
                            />
                            <div class={styles.optionBody}>
                              <span class={styles.optionLabel}>{opt.label}</span>
                              {opt.hint && <span class={styles.optionHint}>{opt.hint}</span>}
                            </div>
                          </label>
                        )
                      })}
                    </div>
                    {hint}
                  </div>
                )
              case 'multi-choice':
                return (
                  <div class={styles.field} key={field.key}>
                    {labelEl}
                    <div class={styles.optionList}>
                      {(field.options ?? []).map((opt, optIdx) => {
                        const arr = Array.isArray(value) ? (value as string[]) : []
                        const checked = arr.includes(opt.value)
                        return (
                          <label
                            class={`${styles.option} ${checked ? styles.optionSelected : ''}`}
                            key={opt.value}
                            data-testid={`agent-question-option--${field.key}--${opt.value}`}
                          >
                            <input
                              ref={idx === 0 && optIdx === 0 ? refForFirst : undefined}
                              type="checkbox"
                              class={styles.optionRadio}
                              checked={checked}
                              onChange={() => toggleMulti(field.key, opt.value)}
                            />
                            <div class={styles.optionBody}>
                              <span class={styles.optionLabel}>{opt.label}</span>
                              {opt.hint && <span class={styles.optionHint}>{opt.hint}</span>}
                            </div>
                          </label>
                        )
                      })}
                    </div>
                    {hint}
                  </div>
                )
              default:
                return null
            }
          })}
          </div>
        </div>

        {error && <p class={styles.error}>{error}</p>}

        <div class={styles.actions}>
          <button
            type="button"
            class={styles.cancelBtn}
            onClick={handleCancelQuestion}
            title="Cancel this question (the agent will be notified)"
            data-testid="agent-question-panel--cancel-question"
          >
            Cancel
          </button>
          <button
            type="button"
            class={styles.laterBtn}
            onClick={onClose}
            title="Close panel — question stays pending"
            data-testid="agent-question-panel--later"
          >
            Answer later
          </button>
          <button
            ref={submitRef}
            type="submit"
            class={styles.submitBtn}
            disabled={!requiredOk || submitting}
            data-testid="agent-question-panel--submit"
          >
            <Check size={14} />
            <span>{submitting ? 'Submitting...' : 'Submit'}</span>
          </button>
        </div>
      </form>
    </div>
  )
}
