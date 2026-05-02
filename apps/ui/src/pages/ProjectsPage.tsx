import { useLocation } from 'wouter-preact'
import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import { Plus, Star } from 'lucide-preact'
import { createProject, getProjects, updateProject } from '../lib/api'
import { setProjectNavContext } from '../lib/projectNavContext'
import type { Project } from '../types'
import { cardStyles } from '../components/ui'
import { SearchBar } from '../components/search'
import { ProjectContextMenu } from '../components/shared/ProjectContextMenu'
import { useDocumentTitle } from '../hooks'
import styles from './ProjectsPage.module.css'

export function ProjectsPage() {
  useDocumentTitle('Projects')
  const [, setLocation] = useLocation()
  const [projects, setProjects] = useState<Project[]>([])
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createHandle, setCreateHandle] = useState('')
  const [createDisplayName, setCreateDisplayName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    project: Project
    position: { x: number; y: number }
  } | null>(null)

  useEffect(() => {
    let mounted = true
    setError(null)
    setProjectsLoaded(false)
    getProjects()
      .then((data) => {
        if (mounted) setProjects(data)
      })
      .catch((err) => {
        if (mounted) console.warn('Failed to load projects:', err)
      })
      .finally(() => {
        if (mounted) setProjectsLoaded(true)
      })
    return () => {
      mounted = false
    }
  }, [])

  const resetCreateForm = () => {
    setCreateName('')
    setCreateHandle('')
    setCreateDisplayName('')
    setCreateDescription('')
    setCreateError(null)
  }

  const slugify = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')

  const refreshProjects = () => {
    setProjectsLoaded(false)
    setError(null)
    getProjects()
      .then(setProjects)
      .catch((err) => console.warn('Failed to load projects:', err))
      .finally(() => setProjectsLoaded(true))
  }

  const doCreateProject = useCallback(async () => {
    setCreateError(null)

    const name = createName.trim()
    const handle = createHandle.trim() || slugify(name)
    const displayName = createDisplayName.trim()
    const description = createDescription.trim()

    if (!name) {
      setCreateError('Project name is required.')
      return
    }

    if (!handle) {
      setCreateError('Provide a handle or a name that can generate one.')
      return
    }

    setIsCreating(true)
    try {
      await createProject({
        handle,
        name,
        display_name: displayName || undefined,
        description: description || undefined,
      })
      setShowCreate(false)
      resetCreateForm()
      refreshProjects()
    } catch (err: any) {
      setCreateError(err.message || 'Failed to create project')
    } finally {
      setIsCreating(false)
    }
  }, [createName, createHandle, createDisplayName, createDescription])

  const handleCreateProject = (event: Event) => {
    event.preventDefault()
    doCreateProject()
  }

  // Keyboard shortcuts for creating project
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!showCreate) return

      if (event.key === 'Escape') {
        event.preventDefault()
        setShowCreate(false)
        resetCreateForm()
      } else if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault()
        doCreateProject()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showCreate, doCreateProject])

  const filteredProjects = useMemo(() => {
    if (!projects.length) return []

    let filtered = projects
    if (favoriteOnly) {
      filtered = filtered.filter((p) => p.is_favorite)
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter((p) => {
        const name = (p.name || '').toLowerCase()
        const displayName = (p.display_name || '').toLowerCase()
        const handle = (p.handle || '').toLowerCase()
        return name.includes(query) || displayName.includes(query) || handle.includes(query)
      })
    }

    return [...filtered].sort((a, b) => {
      if (a.is_favorite !== b.is_favorite) return a.is_favorite ? -1 : 1
      const nameA = (a.display_name || a.name || '').toLowerCase()
      const nameB = (b.display_name || b.name || '').toLowerCase()
      return nameA.localeCompare(nameB)
    })
  }, [projects, searchQuery, favoriteOnly])

  const handleProjectClick = (projectId: string) => {
    const projectIds = filteredProjects.map(p => p.id)
    setProjectNavContext(projectIds, projectId, '/projects')
    setLocation(`/projects/${projectId}`)
  }

  const handleProjectKeyDown = (event: KeyboardEvent, projectId: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      const projectIds = filteredProjects.map(p => p.id)
      setProjectNavContext(projectIds, projectId, '/projects')
      event.preventDefault()
      setLocation(`/projects/${projectId}`)
    }
  }

  const toggleFavorite = async (project: Project) => {
    const nextFavorite = !project.is_favorite
    const previous = projects

    setProjects((prev) =>
      prev.map((item) =>
        item.id === project.id ? { ...item, is_favorite: nextFavorite } : item
      )
    )

    try {
      await updateProject(project.id, { is_favorite: nextFavorite })
    } catch {
      setProjects(previous)
      setError('Failed to update favorite')
    }
  }

  const handleContextMenu = (event: MouseEvent, project: Project) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      project,
      position: { x: event.clientX, y: event.clientY },
    })
  }

  return (
    <div class={styles.page}>
      <div class={styles.header}>
        <div class={styles.headerIntro}>
          <h1 class={styles.title}>Projects</h1>
          <p class={styles.subtitle}>Select a project to view its dashboard</p>
        </div>
        <div class={styles.headerActions}>
          {projectsLoaded && (
            <div class={styles.count}>
              {searchQuery ? `${filteredProjects.length} of ${projects.length}` : `${projects.length} total`}
            </div>
          )}
          <button
            class={styles.createButton}
            type="button"
            onClick={() => setShowCreate((prev) => !prev)}
          >
            <Plus size={16} />
            Create Project
          </button>
        </div>
      </div>

      <SearchBar
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="Search projects..."
      />

      <div class={styles.filterRow}>
        <button
          class={clsx(styles.favoriteToggle, favoriteOnly && styles.favoriteToggleActive)}
          type="button"
          aria-pressed={favoriteOnly}
          data-testid="favorite-filter"
          onClick={() => setFavoriteOnly((prev) => !prev)}
        >
          <Star size={16} fill={favoriteOnly ? 'currentColor' : 'none'} />
          {favoriteOnly ? 'Favorites only' : 'Show favorites'}
        </button>
      </div>

      {showCreate && (
        <>
          <form class={styles.createPanel} onSubmit={handleCreateProject}>
            <div class={styles.createRow}>
              <label class={styles.createLabel} htmlFor="project-name">
                Name
              </label>
              <input
                id="project-name"
                class={styles.createInput}
                type="text"
                value={createName}
                onInput={(e) =>
                  setCreateName((e.target as HTMLInputElement).value)
                }
                placeholder="Project name"
              />
            </div>
            <div class={styles.createRow}>
              <label class={styles.createLabel} htmlFor="project-handle">
                Handle
              </label>
              <input
                id="project-handle"
                class={styles.createInput}
                type="text"
                value={createHandle}
                onInput={(e) =>
                  setCreateHandle((e.target as HTMLInputElement).value)
                }
                placeholder="Optional (auto-generated from name)"
              />
            </div>
            <div class={styles.createRow}>
              <label class={styles.createLabel} htmlFor="project-display-name">
                Display name
              </label>
              <input
                id="project-display-name"
                class={styles.createInput}
                type="text"
                value={createDisplayName}
                onInput={(e) =>
                  setCreateDisplayName((e.target as HTMLInputElement).value)
                }
                placeholder="Optional"
              />
            </div>
            <div class={styles.createRow}>
              <label class={styles.createLabel} htmlFor="project-description">
                Description
              </label>
              <textarea
                id="project-description"
                class={styles.createTextarea}
                value={createDescription}
                onInput={(e) =>
                  setCreateDescription((e.target as HTMLTextAreaElement).value)
                }
                placeholder="Optional"
              />
            </div>
            {createError && <div class={styles.createError}>{createError}</div>}
            <div class={styles.createActions}>
              <button
                class={styles.cancelButton}
                type="button"
                onClick={() => {
                  setShowCreate(false)
                  resetCreateForm()
                }}
                disabled={isCreating}
              >
                Cancel
              </button>
              <button class={styles.submitButton} type="submit" disabled={isCreating}>
                {isCreating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </form>
          <div class={styles.sectionDivider} />
        </>
      )}

      {error && <div class={styles.error}>{error}</div>}

      <div class={styles.list}>
        {filteredProjects.length > 0 ? (
          filteredProjects.map((project) => {
            const displayName = project.display_name || project.name || project.handle
            return (
              <div
                key={project.id}
                class={clsx(cardStyles.card, cardStyles.interactive, styles.projectCard)}
                role="link"
                tabIndex={0}
                data-testid="project-card"
                data-project-id={project.id}
                onClick={() => handleProjectClick(project.id)}
                onKeyDown={(event) => handleProjectKeyDown(event, project.id)}
                onContextMenu={(event) => handleContextMenu(event, project)}
              >
                <div class={styles.projectMain}>
                  <div class={styles.projectName}>{displayName}</div>
                  <div class={styles.projectHandle}>{project.handle}</div>
                </div>
                {project.is_favorite && (
                  <button
                    type="button"
                    class={clsx(styles.favoriteButton, styles.favoriteButtonActive)}
                    aria-label="Unfavorite project"
                    aria-pressed={true}
                    data-project-id={project.id}
                    data-favorite="true"
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      toggleFavorite(project)
                    }}
                  >
                    <Star size={14} fill="currentColor" />
                  </button>
                )}
              </div>
            )
          })
        ) : (
          <div class={styles.empty}>
            {!projectsLoaded
              ? 'Loading projects...'
              : searchQuery
                ? favoriteOnly
                  ? 'No favorites match your search'
                  : 'No projects match your search'
                : favoriteOnly
                  ? 'No favorites yet'
                  : 'No projects yet'}
          </div>
        )}
      </div>

      {contextMenu && (
        <ProjectContextMenu
          project={contextMenu.project}
          position={contextMenu.position}
          onToggleFavorite={() => toggleFavorite(contextMenu.project)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
