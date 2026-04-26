import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { Eye, EyeOff } from 'lucide-preact'
import { useSettings } from './useSettings'
import { getProjects } from '../../lib/api'
import type { Project } from '../../types'
import styles from './SettingsShared.module.css'

export function ProjectsSection() {
  const { settings, loading, error, success, save, clearMessages } = useSettings()
  const [projects, setProjects] = useState<Project[]>([])
  const [hiddenHandles, setHiddenHandles] = useState<string[]>([])
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    if (settings) {
      setHiddenHandles(settings.projects.hidden)
    }
  }, [settings])

  useEffect(() => {
    getProjects({ includeHidden: true })
      .then(setProjects)
      .catch((err) => console.warn('Failed to load projects:', err))
      .finally(() => setProjectsLoaded(true))
  }, [])

  const toggleProject = useCallback((handle: string) => {
    setHiddenHandles((prev) => {
      const next = prev.includes(handle)
        ? prev.filter((h) => h !== handle)
        : [...prev, handle]
      save({ projects: { hidden: next } })
      return next
    })
  }, [save])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (settings) setHiddenHandles(settings.projects.hidden)
        setSearchQuery('')
        clearMessages()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [settings, clearMessages])

  const sortedFilteredProjects = useMemo(() => {
    const q = searchQuery.toLowerCase()
    return [...projects]
      .sort((a, b) => {
        const aName = (a.display_name || a.name).toLowerCase()
        const bName = (b.display_name || b.name).toLowerCase()
        return aName.localeCompare(bName)
      })
      .filter((p) => {
        if (!q) return true
        const name = (p.display_name || p.name).toLowerCase()
        return name.includes(q) || p.handle.includes(q)
      })
  }, [projects, searchQuery])

  if (loading || !projectsLoaded) return <div class={styles.description}>Loading...</div>

  return (
    <>
      <p class={styles.description}>
        Hidden projects are excluded from the Projects page, Sessions page, and search results.
        Toggle visibility below. Changes are saved automatically.
      </p>

      <div class={styles.field}>
        <input
          class={styles.inputWide}
          type="text"
          placeholder="Filter projects..."
          value={searchQuery}
          onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class={styles.section}>
        {sortedFilteredProjects.map((project) => {
          const isHidden = hiddenHandles.includes(project.handle)
          return (
            <button
              key={project.id}
              class={styles.toggleRow}
              onClick={() => toggleProject(project.handle)}
              title={isHidden ? `Show ${project.handle}` : `Hide ${project.handle}`}
            >
              <span class={styles.toggleIcon} style={{ opacity: isHidden ? 0.4 : 1 }}>
                {isHidden ? <EyeOff size={16} /> : <Eye size={16} />}
              </span>
              <span class={styles.toggleLabel} style={{ opacity: isHidden ? 0.4 : 1 }}>
                {project.display_name || project.name}
              </span>
              <span class={styles.toggleMeta} style={{ opacity: isHidden ? 0.3 : 0.5 }}>
                {project.handle}
              </span>
            </button>
          )
        })}
        {sortedFilteredProjects.length === 0 && (
          <div class={styles.description}>No projects match "{searchQuery}"</div>
        )}
      </div>

      {error && <div class={styles.error}>{error}</div>}
      {success && <div class={styles.success}>Settings saved</div>}
    </>
  )
}
