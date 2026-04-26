import { Pencil, Copy, Check, Plus, X, Trash2, Search, ExternalLink } from 'lucide-preact'
import { TypeBadge, StatusBadge, TagInput, SelectUpward } from '../../components/ui'
import { getTypeLabel, MEMORY_TYPES } from '../../lib/memoryTypes'
import type { Memory, FlatRelation, ContextualRelationType, RelationTypeInfo, MemoryType } from '../../types'
import type { useMemoryRelations } from './useMemoryRelations'
import styles from '../MemoryPage.module.css'

interface MemoryRelationsSectionProps {
  memory: Memory
  relations: FlatRelation[]
  relationTypeOptions: RelationTypeInfo[]
  allTypeOptions: string[] | null
  topLevelTypeOptions: string[] | null
  typeHierarchy: Record<string, string[]>
  setLocation: (path: string) => void
  showToast: (msg: string) => void
  rel: ReturnType<typeof useMemoryRelations>
}

export function MemoryRelationsSection({
  memory,
  relations,
  relationTypeOptions,
  allTypeOptions,
  topLevelTypeOptions,
  typeHierarchy,
  setLocation,
  showToast,
  rel,
}: MemoryRelationsSectionProps) {
  return (
    <>
      {/* Related Memories */}
      <div class={styles.relatedSection} data-testid="memory-page--relations-section">
        <div class={styles.relatedHeader}>
          <h2 class={styles.relatedTitle}>Related Memories</h2>
          <button
            class={styles.addRelationButton}
            onClick={rel.openRelationModal}
            title="Add relation"
          >
            <Plus size={14} />
            Add Relation
          </button>
        </div>
        {relations.length === 0 ? (
          <p class={styles.emptyRelated}>No related memories found.</p>
        ) : (
          <div class={styles.relatedList}>
            {relations.map((r) => (
              <div key={r.id} class={styles.relatedItemWrapper} data-testid={`relation--${r.id}`}>
                {rel.editingRelationId === r.id ? (
                  // Edit mode
                  <div class={styles.relatedItemEdit} data-testid="relation--edit-mode">
                    <div class={styles.editRelationTop}>
                      <SelectUpward
                        value={rel.editingRelationType}
                        onChange={(val) => rel.setEditingRelationType(val as ContextualRelationType)}
                        disabled={rel.isUpdatingRelation}
                        options={relationTypeOptions.flatMap((rt) => [
                          { value: rt.value, label: rt.forward_label, group: 'Forward' },
                          { value: rt.inverse_value, label: rt.inverse_label, group: 'Inverse' },
                        ])}
                      />
                      <span class={styles.editRelationLabel}>→</span>
                      <span class={styles.editRelationTarget}>{r.related_memory.title}</span>
                    </div>
                    <div class={styles.editRelationActions}>
                      <button
                        class={styles.editRelationSave}
                        onClick={() => rel.handleUpdateRelation(r.id, relations)}
                        disabled={rel.isUpdatingRelation}
                        title="Save"
                        data-testid="relation--save-button"
                      >
                        {rel.isUpdatingRelation ? (
                          <span class={styles.deleteSpinner} />
                        ) : (
                          <Check size={14} />
                        )}
                      </button>
                      <button
                        class={styles.editRelationCancel}
                        onClick={rel.cancelEditingRelation}
                        disabled={rel.isUpdatingRelation}
                        title="Cancel"
                        data-testid="relation--cancel-button"
                      >
                        <X size={14} />
                      </button>
                      <button
                        class={styles.editRelationDelete}
                        onClick={() => {
                          rel.handleDeleteRelation(r.id)
                          rel.setEditingRelationId(null)
                        }}
                        disabled={rel.isDeletingRelation === r.id || rel.isUpdatingRelation}
                        title="Delete relation"
                        data-testid="relation--delete-button"
                      >
                        {rel.isDeletingRelation === r.id ? (
                          <span class={styles.deleteSpinner} />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  // View mode
                  <>
                    <button
                      class={styles.relatedItem}
                      onClick={() => setLocation(`/memories/${r.related_memory.id}`)}
                      data-testid={`related-item--${r.related_memory.id}`}
                      onContextMenu={(e: MouseEvent) => {
                        e.preventDefault()
                        rel.setRelationContextMenu({ memoryId: r.related_memory.id, x: e.clientX, y: e.clientY })
                      }}
                    >
                      <span class={styles.relatedRelation}>
                        {r.relation_label} →
                      </span>
                      <div class={styles.relatedContent}>
                        <h3 class={styles.relatedItemTitle}>{r.related_memory.title}</h3>
                      </div>
                      <div class={styles.relatedBadges}>
                        <TypeBadge type={r.related_memory.type} parentType={r.related_memory.parent_type} />
                        <StatusBadge status={r.related_memory.status} />
                      </div>
                    </button>
                    <button
                      class={styles.editRelationButton}
                      onClick={(e) => {
                        e.stopPropagation()
                        window.open(`/memories/${r.related_memory.id}`, '_blank')
                      }}
                      title="Open in new tab"
                    >
                      <ExternalLink size={14} />
                    </button>
                    <button
                      class={styles.editRelationButton}
                      onClick={(e) => {
                        e.stopPropagation()
                        rel.startEditingRelation(r.id, r.relation_type as ContextualRelationType)
                      }}
                      title="Edit relation"
                      data-testid={`relation--edit-${r.id}`}
                    >
                      <Pencil size={14} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        {rel.relationContextMenu && (
          <div
            ref={rel.relationMenuRef}
            class={styles.relationMenu}
            style={{ left: `${rel.relationContextMenu.x}px`, top: `${rel.relationContextMenu.y}px` }}
            onClick={(e: MouseEvent) => e.stopPropagation()}
            onMouseDown={(e: MouseEvent) => e.stopPropagation()}
          >
            <button
              type="button"
              class={styles.relationMenuItem}
              onClick={async () => {
                await navigator.clipboard.writeText(rel.relationContextMenu!.memoryId)
                showToast('UUID copied')
                rel.setRelationContextMenu(null)
              }}
            >
              <span>Copy UUID</span>
              <Copy size={14} class={styles.relationMenuIcon} />
            </button>
            <button
              type="button"
              class={styles.relationMenuItem}
              onClick={() => {
                window.open(`/memories/${rel.relationContextMenu!.memoryId}`, '_blank')
                rel.setRelationContextMenu(null)
              }}
            >
              <span>Open in new tab</span>
              <ExternalLink size={14} class={styles.relationMenuIcon} />
            </button>
          </div>
        )}
      </div>

      {/* Relation Search Modal */}
      {rel.showRelationModal && (
        <div class={styles.modalOverlay} onClick={() => rel.setShowRelationModal(false)} data-testid="relation-modal--overlay">
          <div class={styles.modal} onClick={(e) => e.stopPropagation()} data-testid="relation-modal">
            <div class={styles.modalHeader}>
              <h3 class={styles.modalTitle} data-testid="relation-modal--title">Add Relation</h3>
              <button
                class={styles.modalClose}
                onClick={() => rel.setShowRelationModal(false)}
                data-testid="relation-modal--close"
              >
                <X size={20} />
              </button>
            </div>
            <div class={styles.modalBody}>
              <div class={styles.relationTypeSelect} data-testid="relation-modal--type-select">
                <label class={styles.relationTypeLabel}>Relation Type</label>
                <select
                  class={styles.metaSelect}
                  value={rel.selectedRelationType}
                  onChange={(e) =>
                    rel.setSelectedRelationType(
                      (e.target as HTMLSelectElement).value as ContextualRelationType
                    )
                  }
                >
                  <optgroup label="Forward">
                    {relationTypeOptions.map((rt) => (
                      <option key={rt.value} value={rt.value}>
                        {rt.forward_label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Inverse">
                    {relationTypeOptions.map((rt) => (
                      <option key={rt.inverse_value} value={rt.inverse_value}>
                        {rt.inverse_label}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <span class={styles.relationTypeHint}>
                  This memory → Target memory
                </span>
              </div>

              {rel.showNewMemoryForm ? (
                // New memory form
                <div class={styles.newMemoryForm} data-testid="relation-modal--new-memory-form">
                  <div class={styles.newMemoryRow}>
                    <label class={styles.newMemoryLabel}>Title</label>
                    <input
                      type="text"
                      class={styles.newMemoryInput}
                      value={rel.newMemoryTitle}
                      onInput={(e) => rel.setNewMemoryTitle((e.target as HTMLInputElement).value)}
                      placeholder="Memory title"
                      autoFocus
                    />
                  </div>
                  <div class={styles.newMemoryRow}>
                    <label class={styles.newMemoryLabel}>Handle</label>
                    <input
                      type="text"
                      class={styles.newMemoryInput}
                      value={rel.newMemoryHandle}
                      onInput={(e) => rel.setNewMemoryHandle((e.target as HTMLInputElement).value)}
                      placeholder="Optional (auto-generated)"
                    />
                  </div>
                  <div class={styles.newMemoryRow}>
                    <label class={styles.newMemoryLabel}>Type</label>
                    <select
                      class={styles.metaSelect}
                      value={rel.newMemoryType}
                      onChange={(e) => {
                        const nextType = (e.target as HTMLSelectElement).value as MemoryType
                        rel.setNewMemoryType(nextType)
                        const children = typeHierarchy[nextType]
                        rel.setNewMemorySubtype(children && children.length > 0 ? children[0] : '')
                      }}
                    >
                      {(topLevelTypeOptions || allTypeOptions || MEMORY_TYPES).map((t) => (
                        <option key={t} value={t}>
                          {getTypeLabel(t)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {(typeHierarchy[rel.newMemoryType]?.length ?? 0) > 0 && (
                    <div class={styles.newMemoryRow}>
                      <label class={styles.newMemoryLabel}>Subtype</label>
                      <select
                        class={styles.metaSelect}
                        value={rel.newMemorySubtype}
                        onChange={(e) => rel.setNewMemorySubtype((e.target as HTMLSelectElement).value)}
                      >
                        {typeHierarchy[rel.newMemoryType]?.map((t) => (
                          <option key={t} value={t}>
                            {getTypeLabel(t)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div class={styles.newMemoryRow}>
                    <label class={styles.newMemoryLabel}>Content</label>
                    <textarea
                      class={styles.newMemoryTextarea}
                      value={rel.newMemoryContent}
                      onInput={(e) => rel.setNewMemoryContent((e.target as HTMLTextAreaElement).value)}
                      placeholder="Memory content..."
                      rows={4}
                    />
                  </div>
                  <div class={styles.newMemoryRow}>
                    <label class={styles.newMemoryLabel}>Tags</label>
                    <TagInput
                      tags={rel.newMemoryTags}
                      onChange={rel.setNewMemoryTags}
                      placeholder="Add tags (Enter or comma)"
                    />
                  </div>
                  {rel.newMemoryError && <div class={styles.newMemoryError} data-testid="relation-modal--new-memory-error">{rel.newMemoryError}</div>}
                  <div class={styles.newMemoryActions}>
                    <button
                      type="button"
                      class={styles.cancelButton}
                      onClick={() => {
                        rel.setShowNewMemoryForm(false)
                        rel.resetNewMemoryForm()
                      }}
                      disabled={rel.isCreatingNewMemory}
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      class={styles.saveButton}
                      onClick={rel.handleCreateNewMemoryWithRelation}
                      disabled={rel.isCreatingNewMemory}
                    >
                      {rel.isCreatingNewMemory ? 'Creating...' : 'Create & Link'}
                    </button>
                  </div>
                </div>
              ) : (
                // Search view
                <>
                  <div class={styles.searchInputWrapper}>
                    <div class={styles.searchInputInner}>
                      <Search size={16} class={styles.searchIcon} />
                      <input
                        type="text"
                        class={styles.searchInput}
                        placeholder="Search for memories to relate..."
                        value={rel.relationSearch}
                        onInput={(e) => {
                          const value = (e.target as HTMLInputElement).value
                          rel.setRelationSearch(value)
                          rel.searchForRelations(value)
                        }}
                        autoFocus
                      />
                      {rel.relationSearch && (
                        <button
                          type="button"
                          class={styles.searchClearButton}
                          onClick={() => {
                            rel.setRelationSearch('')
                            rel.setRelationSearchResults([])
                          }}
                          aria-label="Clear search"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      class={styles.newMemoryButton}
                      onClick={() => rel.setShowNewMemoryForm(true)}
                      title="Create new memory"
                      data-testid="relation-modal--new-memory-button"
                    >
                      <Plus size={16} />
                      New
                    </button>
                  </div>
                  <div class={styles.searchResults}>
                    {rel.isSearchingRelations ? (
                      <div class={styles.searchingMessage}>Searching...</div>
                    ) : rel.relationSearchResults.length === 0 && rel.relationSearch.trim() ? (
                      <div class={styles.noResultsMessage}>No memories found</div>
                    ) : (
                      rel.relationSearchResults.map((result) => (
                        <button
                          key={result.id}
                          class={styles.searchResultItem}
                          onClick={() => rel.handleCreateRelation(result.id)}
                          disabled={rel.isCreatingRelation}
                          data-testid={`relation-search-result--${result.id}`}
                        >
                          <div class={styles.searchResultContent}>
                            <span class={styles.searchResultTitle}>{result.title}</span>
                            {result.content_excerpt && (
                              <span class={styles.searchResultExcerpt}>
                                {result.content_excerpt}
                              </span>
                            )}
                          </div>
                          <div class={styles.searchResultBadges}>
                            {result.project_handle && result.project_id !== memory.project_id && (
                              <span class={styles.searchResultProject}>{result.project_handle}</span>
                            )}
                            <TypeBadge type={result.type} parentType={result.parent_type} />
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
