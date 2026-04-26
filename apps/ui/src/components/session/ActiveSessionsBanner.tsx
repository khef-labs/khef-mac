import { useState, useEffect, useCallback } from 'preact/hooks'
import { Link } from 'wouter-preact'
import { Radio, RefreshCw } from 'lucide-preact'
import clsx from 'clsx'
import { getActiveSessions, scanActiveSessions } from '../../lib/api'
import type { ActiveSession } from '../../types'
import { cardStyles, useToast } from '../ui'
import { SessionContextMenu } from '../shared/SessionContextMenu'
import styles from './ActiveSessionsBanner.module.css'

interface Props {
  assistantHandle: string
}

function formatDuration(firstSeen: string | null): string {
  if (!firstSeen) return ''
  const ms = Date.now() - new Date(firstSeen).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`
}

export function ActiveSessionsBanner({ assistantHandle }: Props) {
  const { showToast } = useToast()
  const [sessions, setSessions] = useState<ActiveSession[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; position: { x: number; y: number } } | null>(null)

  const handleContextMenu = useCallback((e: MouseEvent, sessionId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ sessionId, position: { x: e.clientX, y: e.clientY } })
  }, [])

  useEffect(() => {
    let mounted = true
    getActiveSessions({ status: 'active' })
      .then((data) => {
        if (mounted) setSessions(data.sessions || [])
      })
      .catch(() => {})
    return () => { mounted = false }
  }, [])

  const handleScan = useCallback(() => {
    setIsScanning(true)
    scanActiveSessions()
      .then((data) => setSessions(data.sessions || []))
      .catch(() => {})
      .finally(() => setIsScanning(false))
  }, [])

  if (sessions.length === 0) return null

  return (
    <div class={styles.activeSection}>
      <div class={styles.activeHeader}>
        <div class={styles.activeTitle}>
          <Radio size={14} class={styles.activeIcon} />
          {sessions.length} Active Session{sessions.length !== 1 ? 's' : ''}
        </div>
        <button
          class={styles.scanButton}
          onClick={handleScan}
          disabled={isScanning}
          title="Rescan for active sessions"
        >
          <RefreshCw size={12} class={isScanning ? styles.spinning : undefined} />
        </button>
      </div>
      <div class={styles.activeList}>
        {sessions.map((session) => {
          const fromParam = `?from=${encodeURIComponent(`/assistants/${assistantHandle}`)}`
          const href = session.transcript?.synced_session_id
            ? session.project
              ? `/projects/${session.project.id}/sessions/${session.transcript.synced_session_id}${fromParam}`
              : `/sessions/${session.transcript.synced_session_id}${fromParam}`
            : null
          const label = session.nickname || session.project?.name || session.project_dir || session.session_id
          return (
            <Link
              key={session.session_id}
              href={href || `/assistants/${assistantHandle}/sessions`}
              class={clsx(cardStyles.card, cardStyles.interactive, styles.activeCard)}
              onContextMenu={(e: MouseEvent) => handleContextMenu(e, session.session_id)}
            >
              <div class={styles.activeCardHeader}>
                <span class={styles.statusDot} />
                <span class={styles.activeLabel}>{label}</span>
              </div>
              <div class={styles.activeMeta}>
                <span class={styles.activeBadge}>PID {session.pid}</span>
                {session.first_seen_at && (
                  <span class={styles.activeBadge}>{formatDuration(session.first_seen_at)}</span>
                )}
                {session.transcript?.message_count && (
                  <span class={styles.activeBadge}>{session.transcript.message_count} msgs</span>
                )}
              </div>
            </Link>
          )
        })}
      </div>

      {contextMenu && (
        <SessionContextMenu
          sessionId={contextMenu.sessionId}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
          onShowToast={showToast}
        />
      )}
    </div>
  )
}
