import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import {
  getMemory,
  searchMemories,
  createMemory,
  createRelation,
  updateRelation,
  deleteRelation,
  getMemoryRelations,
  getMemoryGraph,
} from '../../lib/api'
// Type hierarchy and options are passed in as props from MemoryPage
import { UUID_PATTERN } from './lib'
import type { Memory, GraphData, FlatRelation, RelationType, ContextualRelationType, RelationTypeInfo, MemoryType } from '../../types'

// Hardcoded inverse→forward mapping as fallback (in case relationTypeOptions hasn't loaded)
const INVERSE_TO_FORWARD: Record<string, RelationType> = {
  is_supported_by: 'supports',
  is_contradicted_by: 'contradicts',
  is_depended_on_by: 'depends_on',
  is_followed_by: 'follows_from',
  is_referenced_by: 'references',
  is_related_to: 'relates_to',
  is_superseded_by: 'supersedes',
  is_implemented_by: 'implements',
  is_blocked_by: 'blocks',
  is_extended_by: 'extends',
  is_duplicated_by: 'duplicates',
}

// Valid forward types that the backend accepts
const VALID_FORWARD_TYPES: RelationType[] = [
  'supports',
  'contradicts',
  'depends_on',
  'follows_from',
  'references',
  'relates_to',
  'supersedes',
  'implements',
  'blocks',
  'extends',
  'duplicates',
]

interface UseMemoryRelationsOptions {
  memory: Memory | null
  project: { id: string } | null
  relationTypeOptions: RelationTypeInfo[]
  typeHierarchy: Record<string, string[]>
  setError: (error: string | null) => void
  setRelations: (relations: FlatRelation[]) => void
  setGraphData: (data: GraphData | null) => void
}

export function useMemoryRelations({
  memory,
  project,
  relationTypeOptions,
  typeHierarchy,
  setError,
  setRelations,
  setGraphData,
}: UseMemoryRelationsOptions) {
  // Modal & search state
  const [showRelationModal, setShowRelationModal] = useState(false)
  const [relationSearch, setRelationSearch] = useState('')
  const [relationSearchResults, setRelationSearchResults] = useState<Memory[]>([])
  const [isSearchingRelations, setIsSearchingRelations] = useState(false)
  const [selectedRelationType, setSelectedRelationType] = useState<ContextualRelationType>('relates_to')
  const [isCreatingRelation, setIsCreatingRelation] = useState(false)

  // Editing state
  const [editingRelationId, setEditingRelationId] = useState<string | null>(null)
  const [editingRelationType, setEditingRelationType] = useState<ContextualRelationType>('relates_to')
  const [isUpdatingRelation, setIsUpdatingRelation] = useState(false)
  const [isDeletingRelation, setIsDeletingRelation] = useState<string | null>(null)

  // Context menu
  const [relationContextMenu, setRelationContextMenu] = useState<{ memoryId: string; x: number; y: number } | null>(null)
  const relationMenuRef = useRef<HTMLDivElement>(null)

  // New memory form state (within relation modal)
  const [showNewMemoryForm, setShowNewMemoryForm] = useState(false)
  const [newMemoryTitle, setNewMemoryTitle] = useState('')
  const [newMemoryHandle, setNewMemoryHandle] = useState('')
  const [newMemoryContent, setNewMemoryContent] = useState('')
  const [newMemoryType, setNewMemoryType] = useState<MemoryType>('user-note')
  const [newMemorySubtype, setNewMemorySubtype] = useState('')
  const [newMemoryTags, setNewMemoryTags] = useState<string[]>([])
  const [isCreatingNewMemory, setIsCreatingNewMemory] = useState(false)
  const [newMemoryError, setNewMemoryError] = useState<string | null>(null)

  // Sync new memory subtype when type or hierarchy changes
  useEffect(() => {
    const children = typeHierarchy[newMemoryType]
    if (!children || children.length === 0) {
      if (newMemorySubtype) setNewMemorySubtype('')
      return
    }
    if (!newMemorySubtype || !children.includes(newMemorySubtype)) {
      setNewMemorySubtype(children[0])
    }
  }, [newMemoryType, newMemorySubtype, typeHierarchy])

  // Context menu dismiss handlers
  useEffect(() => {
    if (!relationContextMenu) return
    const close = () => setRelationContextMenu(null)
    const handleClick = (e: MouseEvent) => {
      if (relationMenuRef.current && !relationMenuRef.current.contains(e.target as Node)) close()
    }
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const handleScroll = (e: Event) => {
      if (relationMenuRef.current && e.target instanceof Node && relationMenuRef.current.contains(e.target)) return
      close()
    }
    const timer = setTimeout(() => document.addEventListener('click', handleClick), 0)
    document.addEventListener('keydown', handleKey)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handleClick)
      document.removeEventListener('keydown', handleKey)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [relationContextMenu])

  // Helper to resolve inverse relation types - swaps source/target and returns forward type
  const resolveRelationType = useCallback(
    (
      currentMemoryId: string,
      otherMemoryId: string,
      relationType: ContextualRelationType
    ): { sourceId: string; targetId: string; type: RelationType } => {
      // First, try to resolve using loaded relationTypeOptions
      const inverseMatch = relationTypeOptions.find((rt) => rt.inverse_value === relationType)
      if (inverseMatch) {
        return {
          sourceId: otherMemoryId,
          targetId: currentMemoryId,
          type: inverseMatch.value,
        }
      }

      // Fallback: check hardcoded inverse mapping
      const fallbackForward = INVERSE_TO_FORWARD[relationType]
      if (fallbackForward) {
        return {
          sourceId: otherMemoryId,
          targetId: currentMemoryId,
          type: fallbackForward,
        }
      }

      // It's a forward type - validate it
      if (VALID_FORWARD_TYPES.includes(relationType as RelationType)) {
        return {
          sourceId: currentMemoryId,
          targetId: otherMemoryId,
          type: relationType as RelationType,
        }
      }

      // Unknown type - fallback to relates_to
      console.warn(`Unknown relation type: ${relationType}, falling back to relates_to`)
      return {
        sourceId: currentMemoryId,
        targetId: otherMemoryId,
        type: 'relates_to',
      }
    },
    [relationTypeOptions]
  )

  const refreshRelationsAndGraph = useCallback(
    async (memoryId: string) => {
      const [relationsData, newGraph] = await Promise.all([
        getMemoryRelations(memoryId),
        getMemoryGraph(memoryId, { depth: 1, compact: true, max_nodes: 10 }),
      ])
      setRelations(relationsData)
      setGraphData(newGraph)
    },
    [setRelations, setGraphData]
  )

  const searchForRelations = useCallback(
    async (searchQuery: string) => {
      const trimmed = searchQuery.trim()
      if (!trimmed || !memory) {
        setRelationSearchResults([])
        return
      }
      setIsSearchingRelations(true)
      try {
        if (UUID_PATTERN.test(trimmed)) {
          const fetched = await getMemory(trimmed)
          if (fetched && fetched.id !== memory.id) {
            setRelationSearchResults([fetched])
          } else {
            setRelationSearchResults([])
          }
        } else {
          const response = await searchMemories({
            q: trimmed,
            compact: true,
            limit: 10,
          })
          setRelationSearchResults(response.memories.filter((m) => m.id !== memory.id))
        }
      } catch {
        setRelationSearchResults([])
      } finally {
        setIsSearchingRelations(false)
      }
    },
    [memory]
  )

  const handleCreateRelation = useCallback(
    async (targetMemoryId: string) => {
      if (!memory) return
      setIsCreatingRelation(true)
      try {
        const { sourceId, targetId, type } = resolveRelationType(memory.id, targetMemoryId, selectedRelationType)
        await createRelation(sourceId, targetId, type)
        setRelationSearch('')
        setRelationSearchResults([])
        setShowRelationModal(false)
        setIsCreatingRelation(false)
        // Refresh relations and graph (don't block on this)
        refreshRelationsAndGraph(memory.id).catch(() => {
          // Silently fail refresh - relation was created successfully
        })
      } catch (err: any) {
        setError(err.message || 'Failed to create relation')
        setIsCreatingRelation(false)
      }
    },
    [memory, selectedRelationType, resolveRelationType, refreshRelationsAndGraph, setError]
  )

  const handleDeleteRelation = useCallback(
    async (relationId: string) => {
      if (!memory) return
      setIsDeletingRelation(relationId)
      try {
        await deleteRelation(relationId)
        await refreshRelationsAndGraph(memory.id)
      } catch (err: any) {
        setError(err.message || 'Failed to delete relation')
      } finally {
        setIsDeletingRelation(null)
      }
    },
    [memory, refreshRelationsAndGraph, setError]
  )

  const resetNewMemoryForm = useCallback(() => {
    setNewMemoryTitle('')
    setNewMemoryHandle('')
    setNewMemoryContent('')
    setNewMemoryType('user-note')
    setNewMemorySubtype('')
    setNewMemoryTags([])
    setNewMemoryError(null)
  }, [])

  const openRelationModal = useCallback(() => {
    setRelationSearch('')
    setRelationSearchResults([])
    setSelectedRelationType('relates_to')
    setShowNewMemoryForm(false)
    resetNewMemoryForm()
    setShowRelationModal(true)
  }, [resetNewMemoryForm])

  const slugify = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')

  const handleCreateNewMemoryWithRelation = useCallback(async () => {
    if (!memory) return
    const projectId = project?.id || memory.project_id
    if (!projectId) {
      setNewMemoryError('No project ID')
      return
    }

    const title = newMemoryTitle.trim()
    const content = newMemoryContent.trim()
    const handle = newMemoryHandle.trim() || slugify(title)

    if (!title || !content) {
      setNewMemoryError('Title and content are required.')
      return
    }

    if (!handle) {
      setNewMemoryError('Provide a handle or a title that can generate one.')
      return
    }

    setIsCreatingNewMemory(true)
    setNewMemoryError(null)

    try {
      const effectiveType = (newMemorySubtype || newMemoryType) as MemoryType
      const newMem = await createMemory(projectId, {
        handle,
        title,
        content,
        type: effectiveType,
        parent_type: newMemorySubtype ? newMemoryType : null,
        tags: newMemoryTags.length > 0 ? newMemoryTags : undefined,
      })

      // Create the relation (handle inverse types)
      const { sourceId, targetId, type } = resolveRelationType(memory.id, newMem.id, selectedRelationType)
      await createRelation(sourceId, targetId, type)

      // Close modal and refresh
      setShowRelationModal(false)
      resetNewMemoryForm()
      setShowNewMemoryForm(false)

      await refreshRelationsAndGraph(memory.id)
    } catch (err: any) {
      setNewMemoryError(err.message || 'Failed to create memory')
    } finally {
      setIsCreatingNewMemory(false)
    }
  }, [
    memory, project, newMemoryTitle, newMemoryContent, newMemoryHandle,
    newMemoryType, newMemorySubtype, newMemoryTags, selectedRelationType,
    resolveRelationType, resetNewMemoryForm, refreshRelationsAndGraph,
  ])

  const startEditingRelation = useCallback((relationId: string, currentType: ContextualRelationType) => {
    setEditingRelationId(relationId)
    setEditingRelationType(currentType)
  }, [])

  const cancelEditingRelation = useCallback(() => {
    setEditingRelationId(null)
  }, [])

  const handleUpdateRelation = useCallback(
    async (relationId: string, relations: FlatRelation[]) => {
      if (!memory) return
      setIsUpdatingRelation(true)
      try {
        const rel = relations.find((r) => r.id === relationId)
        if (!rel) throw new Error('Relation not found')

        const isInverseType = INVERSE_TO_FORWARD[editingRelationType] !== undefined
        const wasInverseType = INVERSE_TO_FORWARD[rel.relation_type] !== undefined

        if (isInverseType !== wasInverseType) {
          const { sourceId, targetId, type } = resolveRelationType(
            memory.id,
            rel.related_memory.id,
            editingRelationType
          )
          await deleteRelation(relationId)
          await createRelation(sourceId, targetId, type)
        } else {
          const forwardType = INVERSE_TO_FORWARD[editingRelationType] || editingRelationType
          await updateRelation(relationId, forwardType)
        }

        await refreshRelationsAndGraph(memory.id)
        setEditingRelationId(null)
      } catch (err: any) {
        setError(err.message || 'Failed to update relation')
      } finally {
        setIsUpdatingRelation(false)
      }
    },
    [memory, editingRelationType, resolveRelationType, refreshRelationsAndGraph, setError]
  )

  return {
    // Modal & search
    showRelationModal,
    setShowRelationModal,
    relationSearch,
    setRelationSearch,
    relationSearchResults,
    setRelationSearchResults,
    isSearchingRelations,
    selectedRelationType,
    setSelectedRelationType,
    isCreatingRelation,

    // Editing
    editingRelationId,
    setEditingRelationId,
    editingRelationType,
    setEditingRelationType,
    isUpdatingRelation,
    isDeletingRelation,

    // Context menu
    relationContextMenu,
    setRelationContextMenu,
    relationMenuRef,

    // New memory form
    showNewMemoryForm,
    setShowNewMemoryForm,
    newMemoryTitle,
    setNewMemoryTitle,
    newMemoryHandle,
    setNewMemoryHandle,
    newMemoryContent,
    setNewMemoryContent,
    newMemoryType,
    setNewMemoryType,
    newMemorySubtype,
    setNewMemorySubtype,
    newMemoryTags,
    setNewMemoryTags,
    isCreatingNewMemory,
    newMemoryError,

    // Actions
    searchForRelations,
    handleCreateRelation,
    handleDeleteRelation,
    handleCreateNewMemoryWithRelation,
    openRelationModal,
    startEditingRelation,
    cancelEditingRelation,
    handleUpdateRelation,
    resetNewMemoryForm,
  }
}
