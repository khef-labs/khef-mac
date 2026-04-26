import { useState, useEffect, useCallback } from 'preact/hooks'
import { Link, useLocation } from 'wouter-preact'
import { Users, Plus, Radio } from 'lucide-preact'
import { getSessionTeams, createSessionTeam, getProjects } from '../lib/api'
import type { SessionTeam } from '../lib/api'
import type { Project } from '../types'
import { PageHeader } from '../components/layout'
import { cardStyles, useToast } from '../components/ui'
import { formatRelativeTime } from '../lib/format'
import { useLiveUpdates } from '../hooks/useLiveUpdates'
import { useDocumentTitle } from '../hooks'
import styles from './TeamsPage.module.css'

export function TeamsPage() {
  useDocumentTitle('Teams')
  const { showToast } = useToast()
  const [, setLocation] = useLocation()
  const [teams, setTeams] = useState<SessionTeam[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createProject, setCreateProject] = useState('')

  useEffect(() => {
    let mounted = true
    Promise.all([
      getSessionTeams(),
      getProjects(),
    ]).then(([teamsData, projectsData]) => {
      if (!mounted) return
      setTeams(teamsData.teams)
      setProjects(projectsData)
    }).catch(() => {}).finally(() => {
      if (mounted) setIsLoading(false)
    })
    return () => { mounted = false }
  }, [])

  // Live updates: refetch team list when sessions start or end so active_count
  // and member_count stay current without a manual refresh.
  useLiveUpdates(
    ['sessions:active'],
    useCallback((_room, delta) => {
      if (delta.type !== 'session.created' && delta.type !== 'session.ended') return
      getSessionTeams()
        .then((data) => setTeams(data.teams))
        .catch(() => {
          // Silent — next delta will retry
        })
    }, [])
  )

  const handleCreate = async () => {
    if (!createName.trim()) return
    try {
      const { team } = await createSessionTeam({
        name: createName.trim(),
        description: createDesc.trim() || undefined,
        project: createProject || undefined,
      })
      setTeams(prev => [team, ...prev])
      setShowCreate(false)
      setCreateName('')
      setCreateDesc('')
      setCreateProject('')
      setLocation(`/teams/${team.id}`)
    } catch (err: any) {
      showToast(err.message || 'Failed to create team')
    }
  }

  return (
    <div class={styles.page}>
      <div class={styles.header}>
        <PageHeader title="Teams" />
        <p class={styles.subtitle}>Session team boards for coordinating multi-session work</p>
      </div>

      <div class={styles.toolbar}>
        <button class={styles.createButton} onClick={() => setShowCreate(true)}>
          <Plus size={14} />
          New Team
        </button>
      </div>

      {showCreate && (
        <div class={styles.createForm}>
          <input
            type="text"
            class={styles.createInput}
            placeholder="Team name..."
            value={createName}
            onInput={(e) => setCreateName((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowCreate(false) }}
            autoFocus
          />
          <input
            type="text"
            class={styles.createInput}
            placeholder="Description (optional)"
            value={createDesc}
            onInput={(e) => setCreateDesc((e.target as HTMLInputElement).value)}
          />
          <select
            class={styles.createSelect}
            value={createProject}
            onChange={(e) => setCreateProject((e.target as HTMLSelectElement).value)}
          >
            <option value="">No project</option>
            {projects.map(p => (
              <option key={p.id} value={p.handle || p.id}>{p.display_name || p.name}</option>
            ))}
          </select>
          <div class={styles.createActions}>
            <button class={styles.cancelButton} onClick={() => setShowCreate(false)}>Cancel</button>
            <button class={styles.confirmButton} onClick={handleCreate} disabled={!createName.trim()}>Create</button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div class={styles.loading}>Loading teams...</div>
      ) : teams.length === 0 ? (
        <div class={styles.empty}>
          <Users size={48} class={styles.emptyIcon} />
          <p>No teams yet. Create one to start coordinating sessions.</p>
        </div>
      ) : (
        <div class={styles.teamList}>
          {teams.map(team => (
            <Link key={team.id} href={`/teams/${team.id}`} class={`${cardStyles.card} ${cardStyles.interactive} ${styles.teamCard}`}>
              <div class={styles.teamHeader}>
                <h3 class={styles.teamName}>{team.name}</h3>
                {team.project_handle && (
                  <span class={styles.projectBadge}>{team.project_name || team.project_handle}</span>
                )}
              </div>
              {team.description && (
                <p class={styles.teamDescription}>{team.description}</p>
              )}
              <div class={styles.teamMeta}>
                <span class={styles.memberCount}>
                  <Users size={12} />
                  {team.member_count || 0} session{(team.member_count || 0) !== 1 ? 's' : ''}
                </span>
                {(team.active_count || 0) > 0 && (
                  <span class={styles.activeCount}>
                    <Radio size={12} />
                    {team.active_count} active
                  </span>
                )}
                <span class={styles.timestamp}>
                  {formatRelativeTime(team.updated_at)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
