import { useState, useEffect } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { Plus, ChevronUp, ChevronDown, Trash2 } from 'lucide-preact'
import clsx from 'clsx'
import {
  getMemoryTypes,
  createMemoryType,
  updateMemoryType,
  deleteMemoryType,
  type MemoryTypeListItem,
} from '../lib/api'
import { PageHeader } from '../components/layout'
import styles from './CustomTypeFormPage.module.css'

interface StatusEntry {
  value: string
  display_name: string
}

interface Props {
  typeName?: string
}

const NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

export function CustomTypeFormPage({ typeName }: Props) {
  const [, setLocation] = useLocation()
  const isEditMode = Boolean(typeName)

  // Get parent query param for distinguishing types with same name
  const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
  const parentQueryParam = urlParams?.get('parent') || null

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [parentType, setParentType] = useState<string>('')
  const [availableParents, setAvailableParents] = useState<MemoryTypeListItem[]>([])
  const [statuses, setStatuses] = useState<StatusEntry[]>([{ value: '', display_name: '' }])
  const [memoryCount, setMemoryCount] = useState(0)

  const [isLoading, setIsLoading] = useState(isEditMode)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  // Load existing type data when editing, and always load available parent types
  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const allTypes = await getMemoryTypes()

        // Types that can be parents: types with is_parent_type flag
        const parents = allTypes.filter((t) => t.is_parent_type)
        setAvailableParents(parents)

        if (typeName) {
          // Match by type name and parent to handle same name under different parents
          const found = allTypes.find((t) =>
            t.type === typeName &&
            (t.parent_type || null) === parentQueryParam
          )
          if (!found) {
            setError('Memory type not found')
            return
          }
          setName(found.type)
          setDescription(found.description || '')
          setParentType(found.parent_type || '')
          setMemoryCount(found.memory_count)
          setStatuses(
            found.statuses.length > 0
              ? found.statuses
                  .sort((a, b) => a.sort_order - b.sort_order)
                  .map((s) => ({ value: s.value, display_name: s.display_name || '' }))
              : [{ value: '', display_name: '' }]
          )
        }
      } catch (err: any) {
        setError(err.message || 'Failed to load memory type')
      } finally {
        setIsLoading(false)
      }
    }

    loadData()
  }, [typeName, parentQueryParam])

  const validateForm = (): string | null => {
    const trimmedName = name.trim()
    if (!trimmedName) return 'Name is required'
    if (trimmedName.length < 2 || trimmedName.length > 50) {
      return 'Name must be between 2 and 50 characters'
    }
    if (!NAME_PATTERN.test(trimmedName)) {
      return 'Name must be kebab-case (lowercase letters, numbers, hyphens)'
    }

    const validStatuses = statuses.filter((s) => s.value.trim())
    if (validStatuses.length === 0) {
      return 'At least one status is required'
    }

    for (const status of validStatuses) {
      const statusValue = status.value.trim()
      if (!/^[a-z][a-z0-9_-]*$/.test(statusValue)) {
        return `Invalid status value "${statusValue}". Use lowercase letters, numbers, hyphens, or underscores.`
      }
    }

    // Check for duplicate status values
    const values = validStatuses.map((s) => s.value.trim())
    const uniqueValues = new Set(values)
    if (uniqueValues.size !== values.length) {
      return 'Status values must be unique'
    }

    return null
  }

  const handleSubmit = async () => {
    const validationError = validateForm()
    if (validationError) {
      setError(validationError)
      return
    }

    setError(null)
    setIsSaving(true)

    const validStatuses = statuses
      .filter((s) => s.value.trim())
      .map((s, i) => ({
        value: s.value.trim(),
        display_name: s.display_name.trim() || undefined,
        sort_order: i,
      }))

    try {
      if (isEditMode && typeName) {
        await updateMemoryType(typeName, {
          description: description.trim() || undefined,
          statuses: validStatuses,
        })
      } else {
        await createMemoryType({
          name: name.trim(),
          description: description.trim() || undefined,
          parent_type: parentType || undefined,
          statuses: validStatuses,
        })
      }
      setLocation('/settings/custom-types')
    } catch (err: any) {
      setError(err.message || 'Failed to save memory type')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!typeName) return
    setIsDeleting(true)
    try {
      await deleteMemoryType(typeName)
      setLocation('/settings/custom-types')
    } catch (err: any) {
      setError(err.message || 'Failed to delete memory type')
      setShowDeleteModal(false)
    } finally {
      setIsDeleting(false)
    }
  }

  const handleCancel = () => {
    setLocation('/settings/custom-types')
  }

  const addStatus = () => {
    setStatuses([...statuses, { value: '', display_name: '' }])
  }

  const removeStatus = (index: number) => {
    if (statuses.length <= 1) return
    setStatuses(statuses.filter((_, i) => i !== index))
  }

  const updateStatus = (index: number, field: keyof StatusEntry, value: string) => {
    setStatuses(
      statuses.map((s, i) => (i === index ? { ...s, [field]: value } : s))
    )
  }

  const moveStatus = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1
    if (newIndex < 0 || newIndex >= statuses.length) return
    const newStatuses = [...statuses]
    const temp = newStatuses[index]
    newStatuses[index] = newStatuses[newIndex]
    newStatuses[newIndex] = temp
    setStatuses(newStatuses)
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault()
        handleSubmit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        handleCancel()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [name, description, statuses])

  if (isLoading) {
    return (
      <div class={styles.loading}>Loading...</div>
    )
  }

  return (
    <div class={styles.wrapper}>
      <PageHeader
        title={isEditMode ? typeName || '' : 'New'}
        breadcrumbs={[{ label: 'Custom Types', href: '/settings/custom-types' }]}
        hideTitle
      />

      <div class={styles.form}>
        <div class={styles.section}>
          <div class={styles.field}>
            <label class={styles.label} htmlFor="name">
              Name
            </label>
            <input
              id="name"
              class={clsx(styles.input, styles.inputMono)}
              type="text"
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              disabled={isEditMode}
              placeholder="my-custom-type"
            />
            <p class={styles.description}>
              Kebab-case identifier (2-50 characters). Cannot be changed after creation.
            </p>
          </div>

          {availableParents.length > 0 && (
            <div class={styles.field}>
              <label class={styles.label} htmlFor="parent-type">
                Parent Type
              </label>
              <select
                id="parent-type"
                class={styles.select}
                value={parentType}
                onChange={(e) => setParentType((e.target as HTMLSelectElement).value)}
                disabled={isEditMode}
              >
                <option value="">None (standalone type)</option>
                {availableParents.map((p) => (
                  <option key={p.type} value={p.type}>
                    {p.type}
                  </option>
                ))}
              </select>
              <p class={styles.description}>
                Optional. Child types inherit parent statuses and can be filtered together.
              </p>
            </div>
          )}

          <div class={styles.field}>
            <label class={styles.label} htmlFor="description">
              Description
            </label>
            <textarea
              id="description"
              class={styles.textarea}
              value={description}
              onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
              placeholder="Describe what this memory type is used for..."
            />
          </div>
        </div>

        <div class={styles.section}>
          <h2 class={styles.sectionTitle}>Statuses</h2>
          <p class={styles.sectionSubtitle}>
            Define the workflow statuses for this memory type. Use up/down arrows to change order.
          </p>

          <div class={styles.statusList}>
            {statuses.map((status, index) => (
              <div key={index} class={styles.statusRow}>
                <span class={styles.statusIndex}>{index + 1}</span>
                <div class={styles.statusInputs}>
                  <input
                    class={clsx(styles.statusInput, styles.statusInputMono)}
                    type="text"
                    value={status.value}
                    onInput={(e) =>
                      updateStatus(index, 'value', (e.target as HTMLInputElement).value)
                    }
                    placeholder="status-value"
                  />
                  <input
                    class={styles.statusInput}
                    type="text"
                    value={status.display_name}
                    onInput={(e) =>
                      updateStatus(index, 'display_name', (e.target as HTMLInputElement).value)
                    }
                    placeholder="Display Name (optional)"
                  />
                </div>
                <div class={styles.statusActions}>
                  <button
                    class={styles.iconButton}
                    onClick={() => moveStatus(index, 'up')}
                    disabled={index === 0}
                    type="button"
                    title="Move up"
                  >
                    <ChevronUp size={16} />
                  </button>
                  <button
                    class={styles.iconButton}
                    onClick={() => moveStatus(index, 'down')}
                    disabled={index === statuses.length - 1}
                    type="button"
                    title="Move down"
                  >
                    <ChevronDown size={16} />
                  </button>
                  <button
                    class={clsx(styles.iconButton, styles.iconButtonDanger)}
                    onClick={() => removeStatus(index)}
                    disabled={statuses.length <= 1}
                    type="button"
                    title="Remove status"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button
            class={styles.addStatusButton}
            onClick={addStatus}
            type="button"
          >
            <Plus size={16} />
            Add Status
          </button>
        </div>

        {isEditMode && memoryCount === 0 && (
          <div class={styles.deleteSection}>
            <h2 class={styles.sectionTitle}>Danger Zone</h2>
            <p class={styles.sectionSubtitle}>
              Delete this memory type permanently. This action cannot be undone.
            </p>
            <button
              class={styles.deleteButton}
              onClick={() => setShowDeleteModal(true)}
              type="button"
            >
              Delete Memory Type
            </button>
          </div>
        )}
      </div>

      {error && <div class={styles.error}>{error}</div>}

      <div class={styles.actions}>
        <button
          class={styles.saveButton}
          onClick={handleSubmit}
          disabled={isSaving}
          type="button"
        >
          {isSaving ? 'Saving...' : isEditMode ? 'Save Changes' : 'Create Type'}
        </button>
        <button
          class={styles.cancelButton}
          onClick={handleCancel}
          type="button"
        >
          Cancel
        </button>
        <span class={styles.shortcutHint}>⌘S to save, Esc to cancel</span>
      </div>

      {showDeleteModal && (
        <div class={styles.modalOverlay} onClick={() => setShowDeleteModal(false)}>
          <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 class={styles.modalTitle}>Delete Memory Type</h2>
            <p class={styles.modalText}>
              Are you sure you want to delete "{typeName}"? This action cannot be undone.
            </p>
            <div class={styles.modalActions}>
              <button
                class={styles.modalButtonSecondary}
                onClick={() => setShowDeleteModal(false)}
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                class={styles.modalButtonDanger}
                onClick={handleDelete}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
