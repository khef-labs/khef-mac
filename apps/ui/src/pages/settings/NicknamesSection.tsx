import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import { GripVertical, ExternalLink, LogOut, ChevronUp, ChevronDown } from 'lucide-preact'
import { useSettings } from './useSettings'
import { getActiveSessions, deactivateActiveSession } from '../../lib/api'
import type { ActiveSession } from '../../types'
import styles from './SettingsShared.module.css'
import ns from './NicknamesSection.module.css'

export function NicknamesSection() {
  const { settings, loading, error, save } = useSettings()
  const [preferred, setPreferred] = useState<string[]>([])
  const [staleDays, setStaleDays] = useState(7)
  const [minLength, setMinLength] = useState(0)
  const [maxLength, setMaxLength] = useState(0)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([])
  const [releasedNames, setReleasedNames] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (settings) {
      setPreferred(settings.nicknames.preferred)
      setStaleDays(settings.nicknames.staleDays)
      setMinLength(settings.nicknames.minLength)
      setMaxLength(settings.nicknames.maxLength)
    }
  }, [settings])

  // Fetch active sessions to show which names are in use
  const refreshSessions = useCallback(() => {
    getActiveSessions({ status: 'active' })
      .then((data) => setActiveSessions(data.sessions || []))
      .catch(() => {})
  }, [])

  useEffect(() => { refreshSessions() }, [refreshSessions])

  // Build a map of nickname → active session for quick lookup
  const nicknameSessionMap = new Map<string, ActiveSession>()
  for (const s of activeSessions) {
    if (s.nickname) nicknameSessionMap.set(s.nickname, s)
  }

  const saveNow = (next: { preferred?: string[]; staleDays?: number; minLength?: number; maxLength?: number }) => {
    save({ nicknames: {
      preferred: next.preferred ?? preferred,
      staleDays: next.staleDays ?? staleDays,
      minLength: next.minLength ?? minLength,
      maxLength: next.maxLength ?? maxLength,
    } })
  }

  const addName = (value: string) => {
    const normalized = value.trim().toLowerCase()
    if (normalized && !preferred.includes(normalized)) {
      const next = [...preferred, normalized]
      setPreferred(next)
      saveNow({ preferred: next })
    }
  }

  const removeName = (index: number) => {
    const next = preferred.filter((_, i) => i !== index)
    setPreferred(next)
    saveNow({ preferred: next })
  }

  const handleRelease = async (name: string, sessionId: string) => {
    try {
      await deactivateActiveSession(sessionId)
      setActiveSessions((prev) => prev.filter((s) => s.session_id !== sessionId))
      setReleasedNames((prev) => new Set(prev).add(name))
      setTimeout(() => setReleasedNames((prev) => {
        const next = new Set(prev)
        next.delete(name)
        return next
      }), 2000)
    } catch { /* ignore */ }
  }

  const getSessionHref = (session: ActiveSession): string | null => {
    if (!session.transcript?.synced_session_id) return null
    const syncedId = session.transcript.synced_session_id
    if (session.project) {
      return `/projects/${session.project.id}/sessions/${syncedId}`
    }
    return `/sessions/${syncedId}`
  }

  const staleDaysTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleStaleDays = (value: number) => {
    const clamped = Math.max(1, Math.min(90, value))
    setStaleDays(clamped)
    if (staleDaysTimer.current) clearTimeout(staleDaysTimer.current)
    staleDaysTimer.current = setTimeout(() => saveNow({ staleDays: clamped }), 1500)
  }

  const lengthTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleMinLength = (value: number) => {
    const clamped = Math.max(0, Math.min(15, value))
    setMinLength(clamped)
    if (lengthTimer.current) clearTimeout(lengthTimer.current)
    lengthTimer.current = setTimeout(() => saveNow({ minLength: clamped }), 1500)
  }

  const handleMaxLength = (value: number) => {
    const clamped = Math.max(0, Math.min(15, value))
    setMaxLength(clamped)
    if (lengthTimer.current) clearTimeout(lengthTimer.current)
    lengthTimer.current = setTimeout(() => saveNow({ maxLength: clamped }), 1500)
  }

  useEffect(() => {
    return () => {
      if (staleDaysTimer.current) clearTimeout(staleDaysTimer.current)
      if (lengthTimer.current) clearTimeout(lengthTimer.current)
    }
  }, [])

  // Drag and drop reorder
  const handleDragStart = (index: number) => {
    setDragIndex(index)
  }

  const handleDragOver = (e: DragEvent, index: number) => {
    e.preventDefault()
    if (dragIndex === null || dragIndex === index) return
    setOverIndex(index)
  }

  const handleDrop = (e: DragEvent, dropIndex: number) => {
    e.preventDefault()
    if (dragIndex === null || dragIndex === dropIndex) {
      setDragIndex(null)
      setOverIndex(null)
      return
    }
    const next = [...preferred]
    const [moved] = next.splice(dragIndex, 1)
    next.splice(dropIndex, 0, moved)
    setPreferred(next)
    setDragIndex(null)
    setOverIndex(null)
    saveNow({ preferred: next })
  }

  const handleDragEnd = () => {
    setDragIndex(null)
    setOverIndex(null)
  }

  if (loading) return <div class={styles.description}>Loading...</div>

  return (
    <>
      <div class={styles.section} data-testid="nicknames-section">
        <p class={styles.description}>
          Preferred names for session nicknames.
        </p>
        <p class={styles.description}>
          Names are tried in order when
          assigning a nickname. Names already held by an active session are skipped.
        </p>

        <div class={styles.field}>
          <label class={styles.label}>Stale threshold</label>
          <p class={styles.description}>
            Sessions not seen for this many days have their nickname freed.
            Non-resumable sessions (deleted transcript) are always freed.
          </p>
          <div class={ns.lengthRow}>
            <span class={ns.incrementerLabel}>Days</span>
            <div class={ns.incrementer} data-testid="nicknames-stale-days">
              <button
                type="button"
                class={ns.incrementerButton}
                onClick={() => handleStaleDays(staleDays - 1)}
                disabled={staleDays <= 1}
              >
                <ChevronDown size={14} />
              </button>
              <span class={ns.incrementerValue}>{staleDays}</span>
              <button
                type="button"
                class={ns.incrementerButton}
                onClick={() => handleStaleDays(staleDays + 1)}
                disabled={staleDays >= 90}
              >
                <ChevronUp size={14} />
              </button>
            </div>
          </div>
        </div>

        <div class={styles.field}>
          <label class={styles.label}>Auto-generated name length</label>
          <p class={styles.description}>
            Filter auto-generated names by character count. Does not apply to
            custom names above. Set to 0 for no constraint.
          </p>
          <div class={ns.lengthRow}>
            <span class={ns.incrementerLabel}>Min</span>
            <div class={ns.incrementer} data-testid="nicknames-min-length">
              <button
                type="button"
                class={ns.incrementerButton}
                onClick={() => handleMinLength(minLength - 1)}
                disabled={minLength <= 0}
              >
                <ChevronDown size={14} />
              </button>
              <span class={ns.incrementerValue}>{minLength || 'None'}</span>
              <button
                type="button"
                class={ns.incrementerButton}
                onClick={() => handleMinLength(minLength + 1)}
                disabled={minLength >= 15}
              >
                <ChevronUp size={14} />
              </button>
            </div>

            <span class={ns.incrementerLabel}>Max</span>
            <div class={ns.incrementer} data-testid="nicknames-max-length">
              <button
                type="button"
                class={ns.incrementerButton}
                onClick={() => handleMaxLength(maxLength - 1)}
                disabled={maxLength <= 0}
              >
                <ChevronDown size={14} />
              </button>
              <span class={ns.incrementerValue}>{maxLength || 'None'}</span>
              <button
                type="button"
                class={ns.incrementerButton}
                onClick={() => handleMaxLength(maxLength + 1)}
                disabled={maxLength >= 15}
              >
                <ChevronUp size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class={styles.field}>
        <form
          class={styles.customToolForm}
          onSubmit={(e) => {
            e.preventDefault()
            const form = e.currentTarget
            const input = form.elements.namedItem('nickname') as HTMLInputElement
            addName(input.value)
            input.value = ''
          }}
        >
          <input
            name="nickname"
            type="text"
            class={styles.input}
            placeholder="e.g. ridge, peak, ember"
            data-testid="nicknames-add-input"
          />
          <button type="submit" class={styles.addButton} data-testid="nicknames-add-button">Add</button>
        </form>
      </div>

      {preferred.length === 0 ? (
        <div class={ns.emptyList} data-testid="nicknames-empty-list">No preferred names configured</div>
      ) : (
        <div class={ns.nameList} data-testid="nicknames-list">
          {preferred.map((name, i) => {
            const session = nicknameSessionMap.get(name)
            const isActive = !!session
            const sessionHref = session ? getSessionHref(session) : null

            return (
              <div
                key={name}
                class={`${ns.nameRow} ${dragIndex === i ? ns.nameRowDragging : ''} ${overIndex === i ? ns.nameRowOver : ''}`}
                draggable
                onDragStart={() => handleDragStart(i)}
                onDragOver={(e: DragEvent) => handleDragOver(e, i)}
                onDrop={(e: DragEvent) => handleDrop(e, i)}
                onDragEnd={handleDragEnd}
                data-testid={`nicknames-row--${name}`}
              >
                <GripVertical size={14} class={ns.dragHandle} />
                <span
                  class={`${ns.statusDot} ${isActive ? ns.statusDotActive : ''}`}
                  title={isActive ? `In use by session ${session!.session_id.slice(0, 8)}` : 'Available'}
                  data-testid={`nicknames-row--${name}--status`}
                />
                <span class={ns.nameIndex}>{i + 1}</span>
                <span class={ns.nameText} data-testid={`nicknames-row--${name}--text`}>{name}</span>
                <div class={ns.nameActions}>
                  {releasedNames.has(name) ? (
                    <span class={ns.releasedLabel}>Released</span>
                  ) : isActive ? (
                    <>
                      {sessionHref && (
                        <a
                          href={sessionHref}
                          target="_blank"
                          rel="noopener"
                          class={ns.sessionLink}
                          title="View session"
                          data-testid={`nicknames-row--${name}--session-link`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink size={12} />
                        </a>
                      )}
                      <button
                        type="button"
                        class={ns.releaseButton}
                        title="Release nickname"
                        onClick={() => handleRelease(name, session!.session_id)}
                        data-testid={`nicknames-row--${name}--release`}
                      >
                        <LogOut size={12} />
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    class={ns.removeButton}
                    onClick={() => removeName(i)}
                    data-testid={`nicknames-row--${name}--remove`}
                  >
                    &times;
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {error && <div class={styles.error}>{error}</div>}
    </>
  )
}
