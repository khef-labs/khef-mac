import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import {
  updateMemory,
  updateMemoryStatus,
  getMemory,
  getProject,
  getProjectMemoryTypeStatuses,
  setMemoryMetadataField,
  deleteMemoryMetadataField,
  syncExternalSource,
  createMemory,
  createRelation,
} from '../../lib/api'
import {
  resolvePrimaryType,
  resolveSubtype,
  buildTypeHierarchy,
  uniqueTypeList,
} from '../../lib/memoryTypes'
import {
  type DiagramTheme,
  type DiagramScale,
  type ImageQuality,
} from '../../lib/exportPreferences'
import { setNavContext } from '../../lib/navContext'
import { getSettings } from '../../lib/settings'
import { STATUS_FALLBACK, parseExternalUrl } from './lib'
import type { Memory, Project, MemoryType, MemoryStatus } from '../../types'

interface UseMemoryMetadataEditorOptions {
  memory: Memory | null
  project: Project | null
  projects: Project[]
  setError: (error: string | null) => void
  setMemory: (memory: Memory) => void
  setProject: (project: Project | null) => void
  setEditContent: (content: string) => void
  showToast: (msg: string) => void
  setLocation: (path: string) => void
  refreshSnapshots: () => Promise<unknown>
}

export function useMemoryMetadataEditor({
  memory,
  project,
  projects,
  setError,
  setMemory,
  setProject,
  setEditContent,
  showToast,
  setLocation,
  refreshSnapshots,
}: UseMemoryMetadataEditorOptions) {
  // Edit state
  const [isEditingMetadata, setIsEditingMetadata] = useState(false)
  const [isMetadataCollapsed, setIsMetadataCollapsed] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  // Edit form values
  const [editTitle, setEditTitle] = useState('')
  const [editHandle, setEditHandle] = useState('')
  const [editType, setEditType] = useState<MemoryType>('user-note')
  const [editSubtype, setEditSubtype] = useState('')
  const [editStatus, setEditStatus] = useState('')
  const [editProjectId, setEditProjectId] = useState('')
  const [editTags, setEditTags] = useState<string[]>([])
  const [editMaxWidth, setEditMaxWidth] = useState('')
  const [editDiagramTheme, setEditDiagramTheme] = useState<DiagramTheme | ''>('')
  const [editDiagramScale, setEditDiagramScale] = useState<DiagramScale | ''>('')
  const [editImageQuality, setEditImageQuality] = useState<ImageQuality | ''>('')
  const [editDisplaySize, setEditDisplaySize] = useState<number | ''>('')
  const [editExternalUrl, setEditExternalUrl] = useState('')
  const [editSlideOrder, setEditSlideOrder] = useState('')
  const [editDriveExportFolder, setEditDriveExportFolder] = useState('')
  const [editSyncToDisk, setEditSyncToDisk] = useState(true)

  // The actual memory type: subtype if set, otherwise primary type
  const effectiveEditType = (editSubtype || editType) as MemoryType

  // Status options for current type
  const [statusOptions, setStatusOptions] = useState<string[]>([])
  const [statusOptionsType, setStatusOptionsType] = useState<MemoryType | null>(null)

  // Available types from API
  const [allTypeOptions, setAllTypeOptions] = useState<string[] | null>(null)
  const [topLevelTypeOptions, setTopLevelTypeOptions] = useState<string[] | null>(null)
  const [typeHierarchy, setTypeHierarchy] = useState<Record<string, string[]>>({})

  // External sync
  const [isSyncingExternal, setIsSyncingExternal] = useState(false)

  const resolveEditTypeValues = useCallback(
    (mem: Memory) => {
      if (mem.parent_type) {
        return {
          primaryType: resolvePrimaryType(mem.type, mem.parent_type),
          subtype: resolveSubtype(mem.type, mem.parent_type),
        }
      }
      return { primaryType: mem.type, subtype: '' }
    },
    []
  )

  const displayTypeValues = useMemo(
    () => (memory ? resolveEditTypeValues(memory) : null),
    [memory, resolveEditTypeValues]
  )

  // Initialize edit form values when memory loads
  const initializeFromMemory = useCallback(
    (mem: Memory) => {
      setEditContent(mem.content)
      setEditTitle(mem.title)
      setEditHandle(mem.handle)
      setEditStatus(mem.status)
      setEditProjectId(mem.project_id)
      setEditTags(mem.tags?.map((t) => t.name) || [])
      const resolved = resolveEditTypeValues(mem)
      setEditType(resolved.primaryType)
      setEditSubtype(resolved.subtype)
    },
    [resolveEditTypeValues, setEditContent]
  )

  // Initialize type options from API data
  const initializeTypeOptions = useCallback(
    (typesData: { memory_types: Array<{ type: string; parent_type?: string | null; children?: string[] }> } | null) => {
      if (typesData?.memory_types) {
        setAllTypeOptions(uniqueTypeList(typesData.memory_types.map((t) => t.type)))
        const normalized = typesData.memory_types.map((t) => ({
          ...t,
          parent_type: t.parent_type ?? undefined,
        }))
        const { hierarchy } = buildTypeHierarchy(normalized)
        setTypeHierarchy(hierarchy)
        const topLevelTypes = uniqueTypeList(
          typesData.memory_types
            .filter((entry) => !entry.parent_type)
            .map((entry) => entry.type)
        )
        setTopLevelTypeOptions(topLevelTypes.length ? topLevelTypes : null)
      } else {
        setAllTypeOptions(null)
        setTopLevelTypeOptions(null)
        setTypeHierarchy({})
      }
    },
    []
  )

  // Load status options when effective type changes
  useEffect(() => {
    const projectId = project?.id || memory?.project_id
    if (!projectId || !effectiveEditType) {
      setStatusOptions(STATUS_FALLBACK[effectiveEditType] || [])
      setStatusOptionsType(effectiveEditType)
      return
    }

    let stale = false
    getProjectMemoryTypeStatuses(projectId, effectiveEditType)
      .then((data) => {
        if (stale) return
        if (data?.statuses && data.statuses.length > 0) {
          setStatusOptions(data.statuses.map((s) => s.value))
          setStatusOptionsType(effectiveEditType)
        } else {
          setStatusOptions(STATUS_FALLBACK[effectiveEditType] || [])
          setStatusOptionsType(effectiveEditType)
        }
      })
      .catch(() => {
        if (stale) return
        setStatusOptions(STATUS_FALLBACK[effectiveEditType] || [])
        setStatusOptionsType(effectiveEditType)
      })
    return () => { stale = true }
  }, [project, memory, effectiveEditType])

  // Auto-correct edit status when type changes and current status is invalid
  useEffect(() => {
    if (!effectiveEditType) return
    const options = statusOptionsType === effectiveEditType ? statusOptions : []
    if (options.length === 0) return
    if (options.includes(editStatus)) return
    setEditStatus(options[0])
  }, [effectiveEditType, editStatus, statusOptions, statusOptionsType])

  const startEditingMetadata = useCallback(() => {
    if (memory) {
      setEditHandle(memory.handle)
      const resolved = resolveEditTypeValues(memory)
      setEditType(resolved.primaryType)
      setEditSubtype(resolved.subtype)
      setEditStatus(memory.status)
      setEditTitle(memory.title)
      setEditTags(memory.tags?.map((t) => t.name) || [])
      setEditMaxWidth(memory.metadata?.['svg-max-width'] || String(getSettings().diagram.defaultMaxWidth))
      setEditDiagramTheme((memory.metadata?.['export-image-theme'] as DiagramTheme) || '')
      const scaleVal = memory.metadata?.['export-diagram-scale']
      setEditDiagramScale(scaleVal ? (Number(scaleVal) as DiagramScale) : '')
      const qualityVal = memory.metadata?.['export-png-render-scale']
      setEditImageQuality(qualityVal ? (Number(qualityVal) as ImageQuality) : '')
      const displayVal = memory.metadata?.['export-png-display-scale-percent']
      setEditDisplaySize(displayVal ? Number(displayVal) : '')
      setEditExternalUrl(memory.metadata?.['external-source-url'] || '')
      setEditSlideOrder(memory.metadata?.['slide-order'] || '')
      setEditDriveExportFolder(memory.metadata?.['drive-export-folder'] || '')
      setEditSyncToDisk(memory.metadata?.['sync_to_disk'] !== 'false')
      setIsEditingMetadata(true)
    }
  }, [memory, resolveEditTypeValues])

  const handleMetadataClick = useCallback((event: MouseEvent) => {
    if (isEditingMetadata) return
    if (isMetadataCollapsed) {
      setIsMetadataCollapsed(false)
      return
    }
    const target = event.target as HTMLElement | null
    if (!target) return
    if (target.closest('button, a, select, input, textarea')) return
    setIsMetadataCollapsed(false)
    startEditingMetadata()
  }, [isEditingMetadata, isMetadataCollapsed, startEditingMetadata])

  const cancelEditingMetadata = useCallback(() => {
    if (memory) {
      setEditHandle(memory.handle)
      const resolved = resolveEditTypeValues(memory)
      setEditType(resolved.primaryType)
      setEditSubtype(resolved.subtype)
      setEditStatus(memory.status)
      setEditTitle(memory.title)
      setEditProjectId(memory.project_id)
      setEditTags(memory.tags?.map((t) => t.name) || [])
      setEditMaxWidth(memory.metadata?.['svg-max-width'] || '')
      setEditExternalUrl(memory.metadata?.['external-source-url'] || '')
      setEditSlideOrder(memory.metadata?.['slide-order'] || '')
      setEditDriveExportFolder(memory.metadata?.['drive-export-folder'] || '')
      setEditSyncToDisk(memory.metadata?.['sync_to_disk'] !== 'false')
    }
    setIsEditingMetadata(false)
  }, [memory, resolveEditTypeValues])

  const handleTypeChange = useCallback((newType: MemoryType) => {
    setEditType(newType)
    const children = typeHierarchy[newType]
    const newSubtype = children ? children[0] : ''
    setEditSubtype(newSubtype)
    const resolved = (newSubtype || newType) as MemoryType
    const options = statusOptionsType === resolved
      ? statusOptions
      : (STATUS_FALLBACK[resolved] || [])
    if (options.length > 0) {
      setEditStatus(options[0])
    }
  }, [typeHierarchy, statusOptionsType, statusOptions])

  const handleSubtypeChange = useCallback((newSubtype: string) => {
    setEditSubtype(newSubtype)
    const resolved = (newSubtype || editType) as MemoryType
    const options = statusOptionsType === resolved
      ? statusOptions
      : (STATUS_FALLBACK[resolved] || [])
    if (options.length > 0) {
      setEditStatus(options[0])
    }
  }, [editType, statusOptionsType, statusOptions])

  const saveMetadata = useCallback(async () => {
    if (!memory) return
    const projectId = project?.id || memory.project_id
    if (!projectId) {
      setError('Missing project ID for update')
      return
    }

    setIsSaving(true)
    try {
      const hasTypeStatuses = statusOptionsType === effectiveEditType
      const candidateStatuses = hasTypeStatuses ? statusOptions : []
      if (!hasTypeStatuses || candidateStatuses.length === 0) {
        throw new Error('Status options are still loading for this type')
      }

      const resolvedStatus = candidateStatuses.includes(editStatus)
        ? editStatus
        : candidateStatuses[0]

      if (resolvedStatus && resolvedStatus !== editStatus) {
        setEditStatus(resolvedStatus)
      }

      const memoryUpdates: {
        title?: string
        handle?: string
        content?: string
        type?: MemoryType
        parent_type?: string | null
        status?: MemoryStatus
        project_id?: string
        tags?: string[]
        metadata?: Record<string, string>
      } = {}
      const editParentType = editSubtype ? editType : null
      const typeChanged = effectiveEditType !== memory.type || (editParentType || null) !== (memory.parent_type || null)
      const statusChanged = resolvedStatus !== memory.status
      const projectChanged = editProjectId && editProjectId !== memory.project_id

      const currentTags = memory.tags?.map((t) => t.name).sort() || []
      const newTags = [...editTags].sort()
      const tagsChanged =
        currentTags.length !== newTags.length ||
        currentTags.some((t, i) => t !== newTags[i])

      const currentMaxWidth = memory.metadata?.['svg-max-width'] || ''
      const maxWidthChanged = editMaxWidth !== currentMaxWidth
      const currentSlideOrder = memory.metadata?.['slide-order'] || ''
      const slideOrderChanged = editSlideOrder !== currentSlideOrder

      const currentDiagramTheme = memory.metadata?.['export-image-theme'] || ''
      const diagramThemeChanged = editDiagramTheme !== currentDiagramTheme

      const currentDiagramScale = memory.metadata?.['export-diagram-scale'] || ''
      const diagramScaleChanged = String(editDiagramScale) !== currentDiagramScale

      const currentImageQuality = memory.metadata?.['export-png-render-scale'] || ''
      const imageQualityChanged = String(editImageQuality) !== currentImageQuality

      const currentDisplaySize = memory.metadata?.['export-png-display-scale-percent'] || ''
      const displaySizeChanged = String(editDisplaySize) !== currentDisplaySize

      if (editTitle !== memory.title) memoryUpdates.title = editTitle
      if (editHandle !== memory.handle) memoryUpdates.handle = editHandle
      if (typeChanged) {
        memoryUpdates.type = effectiveEditType
        memoryUpdates.parent_type = editParentType
      }
      if (resolvedStatus && (typeChanged || statusChanged)) {
        memoryUpdates.status = resolvedStatus as MemoryStatus
      }
      if (projectChanged) memoryUpdates.project_id = editProjectId
      if (tagsChanged) memoryUpdates.tags = editTags
      if (maxWidthChanged || slideOrderChanged) {
        const metadataUpdates: Record<string, string> = {}
        if (maxWidthChanged) metadataUpdates['svg-max-width'] = editMaxWidth
        if (slideOrderChanged && editSlideOrder !== '') metadataUpdates['slide-order'] = editSlideOrder
        memoryUpdates.metadata = metadataUpdates
      }

      if (Object.keys(memoryUpdates).length > 0) {
        await updateMemory(projectId, memory.id, memoryUpdates)
      }

      // Update metadata via dedicated endpoints
      if (diagramThemeChanged) {
        if (editDiagramTheme) {
          await setMemoryMetadataField(memory.id, 'export-image-theme', editDiagramTheme)
        } else {
          await deleteMemoryMetadataField(memory.id, 'export-image-theme')
        }
      }
      if (diagramScaleChanged) {
        if (editDiagramScale) {
          await setMemoryMetadataField(memory.id, 'export-diagram-scale', String(editDiagramScale))
        } else {
          await deleteMemoryMetadataField(memory.id, 'export-diagram-scale')
        }
      }
      if (imageQualityChanged) {
        if (editImageQuality) {
          await setMemoryMetadataField(memory.id, 'export-png-render-scale', String(editImageQuality))
        } else {
          await deleteMemoryMetadataField(memory.id, 'export-png-render-scale')
        }
      }
      if (displaySizeChanged) {
        if (editDisplaySize) {
          await setMemoryMetadataField(memory.id, 'export-png-display-scale-percent', String(editDisplaySize))
        } else {
          await deleteMemoryMetadataField(memory.id, 'export-png-display-scale-percent')
        }
      }

      const currentSyncToDisk = memory.metadata?.['sync_to_disk'] !== 'false'
      if (editSyncToDisk !== currentSyncToDisk) {
        if (editSyncToDisk) {
          await deleteMemoryMetadataField(memory.id, 'sync_to_disk')
        } else {
          await setMemoryMetadataField(memory.id, 'sync_to_disk', 'false')
        }
      }

      const currentDriveExportFolder = memory.metadata?.['drive-export-folder'] || ''
      const driveExportFolderChanged = editDriveExportFolder !== currentDriveExportFolder
      if (driveExportFolderChanged) {
        const cleanedFolder = editDriveExportFolder.trim().replace(/^['"]|['"]$/g, '')
        if (cleanedFolder) {
          await setMemoryMetadataField(memory.id, 'drive-export-folder', cleanedFolder)
        } else {
          await deleteMemoryMetadataField(memory.id, 'drive-export-folder')
        }
      }

      const currentExternalUrl = memory.metadata?.['external-source-url'] || ''
      const externalUrlChanged = editExternalUrl !== currentExternalUrl
      if (externalUrlChanged) {
        const parsed = parseExternalUrl(editExternalUrl)
        if (parsed) {
          await setMemoryMetadataField(memory.id, 'external-source-type', parsed.type)
          await setMemoryMetadataField(memory.id, 'external-source-url', parsed.url)
          if (parsed.id) {
            await setMemoryMetadataField(memory.id, 'external-source-id', parsed.id)
          } else {
            await deleteMemoryMetadataField(memory.id, 'external-source-id')
            await deleteMemoryMetadataField(memory.id, 'external-source-last-synced-at')
          }
        } else if (!editExternalUrl.trim()) {
          await deleteMemoryMetadataField(memory.id, 'external-source-type')
          await deleteMemoryMetadataField(memory.id, 'external-source-id')
          await deleteMemoryMetadataField(memory.id, 'external-source-url')
          await deleteMemoryMetadataField(memory.id, 'external-source-last-synced-at')
        }
      }

      // Reload the memory to get updated data
      const reloadProjectId = memoryUpdates.project_id || projectId
      const updated = await getMemory(memory.id, reloadProjectId)
      setMemory(updated)
      setEditTags(updated.tags?.map((t) => t.name) || [])
      setEditMaxWidth(updated.metadata?.['svg-max-width'] || '')
      setEditDiagramTheme((updated.metadata?.['export-image-theme'] as DiagramTheme) || '')
      const updatedScale = updated.metadata?.['export-diagram-scale']
      setEditDiagramScale(updatedScale ? (Number(updatedScale) as DiagramScale) : '')
      const updatedQuality = updated.metadata?.['export-png-render-scale']
      setEditImageQuality(updatedQuality ? (Number(updatedQuality) as ImageQuality) : '')
      const updatedDisplay = updated.metadata?.['export-png-display-scale-percent']
      setEditDisplaySize(updatedDisplay ? Number(updatedDisplay) : '')
      setEditExternalUrl(updated.metadata?.['external-source-url'] || '')
      setEditSlideOrder(updated.metadata?.['slide-order'] || '')
      setEditDriveExportFolder(updated.metadata?.['drive-export-folder'] || '')
      setEditSyncToDisk(updated.metadata?.['sync_to_disk'] !== 'false')
      if (updated.project_id && updated.project_id !== project?.id) {
        const nextProject = await getProject(updated.project_id).catch(() => null)
        setProject(nextProject)
      }
      setIsEditingMetadata(false)
    } catch (err: any) {
      setError(err.message || 'Failed to save metadata')
    } finally {
      setIsSaving(false)
    }
  }, [
    memory, project, editTitle, editHandle, editType, editSubtype, effectiveEditType,
    editStatus, editProjectId, editTags, editMaxWidth, editDiagramTheme, editDiagramScale,
    editImageQuality, editDisplaySize, editExternalUrl, editSlideOrder, editDriveExportFolder,
    editSyncToDisk,
    statusOptions, statusOptionsType, setError, setMemory, setProject,
  ])

  // Sync from external source (e.g., Google Docs)
  const handleSyncExternal = useCallback(async (mode: 'update' | 'snapshot' = 'update') => {
    if (!memory || !project || isSyncingExternal) return
    setIsSyncingExternal(true)
    try {
      const result = await syncExternalSource(memory.id, mode)
      const updated = await getMemory(memory.id, project.id)
      setMemory(updated)
      if (mode === 'snapshot') {
        await refreshSnapshots()
      }
      showToast(`Synced from ${result.source?.type || 'external source'}`)
    } catch (err: any) {
      showToast(err.message || 'Sync failed')
    } finally {
      setIsSyncingExternal(false)
    }
  }, [memory, project, isSyncingExternal, setMemory, refreshSnapshots, showToast])

  // Unlink from external source
  const handleUnlinkExternal = useCallback(async () => {
    if (!memory) return
    try {
      await deleteMemoryMetadataField(memory.id, 'external-source-type')
      await deleteMemoryMetadataField(memory.id, 'external-source-id')
      await deleteMemoryMetadataField(memory.id, 'external-source-url')
      await deleteMemoryMetadataField(memory.id, 'external-source-last-synced-at')
      const projectId = project?.id || memory.project_id
      if (projectId) {
        const updated = await getMemory(memory.id, projectId)
        setMemory(updated)
      }
      showToast('Unlinked from external source')
    } catch (err: any) {
      showToast(err.message || 'Failed to unlink')
    }
  }, [memory, project, setMemory, showToast])

  // Inline status update — used for seeded memories where the full metadata form is hidden.
  const handleInlineStatusChange = useCallback(async (newStatus: string) => {
    if (!memory) return
    const projectId = project?.id || memory.project_id
    if (!projectId) return
    try {
      await updateMemoryStatus(projectId, memory.id, newStatus as MemoryStatus)
      const updated = await getMemory(memory.id, projectId)
      setMemory(updated)
    } catch (err: any) {
      showToast(err.message || 'Failed to update status')
    }
  }, [memory, project, setMemory, showToast])

  // Clone memory (create editable copy)
  const handleCloneMemory = useCallback(async () => {
    if (!memory) return
    const projectId = project?.id || memory.project_id
    if (!projectId) return

    try {
      const baseHandle = memory.handle || memory.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      const cloneHandle = `${baseHandle}-copy-${Date.now().toString(36)}`

      const newMemory = await createMemory(projectId, {
        handle: cloneHandle,
        title: `${memory.title} (copy)`,
        content: memory.content,
        type: memory.type,
        tags: memory.tags?.map((t) => t.name) || [],
      })

      await createRelation(newMemory.id, memory.id, 'clones')

      const projectUrl = `/projects/${projectId}`
      setNavContext([newMemory.id], newMemory.id, projectUrl)

      showToast('Created editable copy')
      setLocation(`/memories/${newMemory.id}`)
    } catch (err: any) {
      showToast(err.message || 'Failed to clone memory')
    }
  }, [memory, project, showToast, setLocation])

  const resolveProjectLabel = useCallback((projectId?: string | null) => {
    if (!projectId) return 'Unknown'
    if (project?.id === projectId) {
      return project.display_name || project.name || project.handle
    }
    const match = projects.find((item) => item.id === projectId)
    if (match) return match.display_name || match.name || match.handle
    return memory?.project_handle || projectId
  }, [project, projects, memory])

  return {
    // Edit state
    isEditingMetadata,
    setIsEditingMetadata,
    isMetadataCollapsed,
    setIsMetadataCollapsed,
    isSaving,
    setIsSaving,

    // Form values
    editTitle, setEditTitle,
    editHandle, setEditHandle,
    editType, setEditType,
    editSubtype, setEditSubtype,
    editStatus, setEditStatus,
    editProjectId, setEditProjectId,
    editTags, setEditTags,
    editMaxWidth, setEditMaxWidth,
    editDiagramTheme, setEditDiagramTheme,
    editDiagramScale, setEditDiagramScale,
    editImageQuality, setEditImageQuality,
    editDisplaySize, setEditDisplaySize,
    editExternalUrl, setEditExternalUrl,
    editSlideOrder, setEditSlideOrder,
    editDriveExportFolder, setEditDriveExportFolder,
    editSyncToDisk, setEditSyncToDisk,
    effectiveEditType,

    // Type/status options
    statusOptions,
    allTypeOptions,
    topLevelTypeOptions,
    typeHierarchy,

    // Display helpers
    displayTypeValues,
    resolveProjectLabel,

    // Actions
    initializeFromMemory,
    initializeTypeOptions,
    startEditingMetadata,
    cancelEditingMetadata,
    saveMetadata,
    handleMetadataClick,
    handleTypeChange,
    handleSubtypeChange,
    handleInlineStatusChange,

    // External source
    isSyncingExternal,
    handleSyncExternal,
    handleUnlinkExternal,
    handleCloneMemory,
  }
}
