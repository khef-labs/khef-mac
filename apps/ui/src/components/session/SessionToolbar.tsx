import { useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { User, Bot, Eye, EyeOff, Search, X, Code, Square, ChevronDown, RefreshCw, Copy, Terminal as TerminalIcon } from 'lucide-preact'
import clsx from 'clsx'
import styles from './SessionToolbar.module.css'

export type ViewMode = 'parsed' | 'raw' | 'terminal'
export type SortOrder = 'desc' | 'asc'

export interface SessionToolbarProps {
  // Search (optional)
  searchQuery?: string
  onSearchChange?: (value: string) => void
  searchPlaceholder?: string

  // View mode toggle (optional)
  viewMode?: ViewMode
  onViewModeChange?: (mode: ViewMode) => void
  // Show the Terminal view button alongside Parsed/Raw (default: false)
  showTerminalToggle?: boolean

  // Role filters
  showUser: boolean
  onShowUserChange: (value: boolean) => void
  showAssistant: boolean
  onShowAssistantChange: (value: boolean) => void
  showThinking: boolean
  onShowThinkingChange: (value: boolean) => void

  // Raw-mode filters (optional, shown when viewMode === 'raw')
  showTools?: boolean
  onShowToolsChange?: (value: boolean) => void
  showCommandsOnly?: boolean
  onShowCommandsOnlyChange?: (value: boolean) => void
  showBashOnly?: boolean
  onShowBashOnlyChange?: (value: boolean) => void

  // Expand/Collapse toggle (optional, for raw mode)
  onExpandToggle?: (expanded: boolean) => void

  // Sort (optional)
  sortOrder?: SortOrder
  onSortChange?: (order: SortOrder) => void

  // Refresh (optional) — force re-syncs this session
  onRefresh?: () => void

  // Copy DB session UUID (optional) — the UUID used in the URL
  dbSessionId?: string
  onCopyDbSessionId?: () => void

  // Segment count (optional)
  segmentCount?: number

  // Session file info (optional, adds split copy button to row 1)
  sessionId?: string
  filePath?: string

  // Stats slot (rendered right-aligned in row 2)
  statsSlot?: ComponentChildren

  // Extra class
  class?: string
}

export function SessionToolbar(props: SessionToolbarProps) {
  const {
    searchQuery, onSearchChange, searchPlaceholder = 'Search messages...',
    viewMode, onViewModeChange, showTerminalToggle = false,
    showUser, onShowUserChange, showAssistant, onShowAssistantChange,
    showThinking, onShowThinkingChange,
    showTools, onShowToolsChange, showCommandsOnly, onShowCommandsOnlyChange,
    showBashOnly, onShowBashOnlyChange,
    onExpandToggle,
    sortOrder, onSortChange,
    onRefresh,
    dbSessionId,
    onCopyDbSessionId,
    segmentCount,
    sessionId,
    filePath,
    statsSlot,
  } = props

  const isRaw = viewMode === 'raw'
  const [expanded, setExpanded] = useState(true)

  const handleExpandToggle = () => {
    const next = !expanded
    setExpanded(next)
    onExpandToggle?.(next)
  }

  return (
    <div class={clsx(styles.toolbar, props.class)}>
      {/* Row 1: Search + Sort + Refresh + Count */}
      <div class={styles.row1}>
        {onSearchChange != null && (
          <div class={styles.search}>
            <Search size={14} class={styles.searchIcon} />
            <input
              type="text"
              class={styles.searchInput}
              placeholder={searchPlaceholder}
              value={searchQuery || ''}
              onInput={(e) => onSearchChange((e.target as HTMLInputElement).value)}
            />
            {searchQuery && (
              <button class={styles.searchClear} onClick={() => onSearchChange('')} title="Clear search">
                <X size={12} />
              </button>
            )}
          </div>
        )}

        <span class={styles.spacer} />

        {onSortChange != null && (
          <select
            class={styles.sortSelect}
            value={sortOrder || 'desc'}
            onChange={(e) => onSortChange((e.target as HTMLSelectElement).value as SortOrder)}
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        )}

        {onRefresh && (
          <button class={styles.chip} onClick={onRefresh} title="Force re-sync this session">
            <RefreshCw size={12} /> Refresh
          </button>
        )}

        {dbSessionId && (
          <button
            class={styles.chip}
            onClick={() => {
              void navigator.clipboard.writeText(dbSessionId)
              onCopyDbSessionId?.()
            }}
            title={`Copy session UUID: ${dbSessionId}`}
          >
            <Copy size={12} /> UUID
          </button>
        )}

        {sessionId && (
          <span class={styles.splitBtn}>
            <span class={styles.splitLabel}>File:</span>
            <button
              class={styles.splitSide}
              onClick={() => navigator.clipboard.writeText(sessionId)}
              title={sessionId}
            >
              {sessionId.slice(0, 8)}…
            </button>
            {filePath && (
              <>
                <span class={styles.splitDivider} />
                <button
                  class={styles.splitSide}
                  onClick={() => navigator.clipboard.writeText(filePath)}
                  title={filePath.split('/').pop() || filePath}
                >
                  Path
                </button>
              </>
            )}
          </span>
        )}

        {segmentCount != null && (
          <span class={styles.meta}>
            {segmentCount} segment{segmentCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Row 2: View toggle + Filters */}
      <div class={styles.row2}>
        {onViewModeChange != null && (
          <>
            <div class={styles.toggleGroup}>
              {showTerminalToggle && (
                <button
                  class={clsx(styles.toggleBtn, viewMode === 'terminal' && styles.toggleBtnActive)}
                  onClick={() => onViewModeChange('terminal')}
                  title="Live PTY terminal view"
                >
                  <TerminalIcon size={11} />
                  <span>Terminal</span>
                </button>
              )}
              <button
                class={clsx(styles.toggleBtn, viewMode === 'parsed' && styles.toggleBtnActive)}
                onClick={() => onViewModeChange('parsed')}
              >
                Parsed
              </button>
              <button
                class={clsx(styles.toggleBtn, viewMode === 'raw' && styles.toggleBtnActive)}
                onClick={() => onViewModeChange('raw')}
              >
                Raw
              </button>
            </div>
            <span class={styles.divider} />
          </>
        )}

        <button
          class={clsx(styles.chip, showUser && styles.chipActive)}
          onClick={() => onShowUserChange(!showUser)}
          title={showUser ? 'Hide user messages' : 'Show user messages'}
        >
          <User size={12} /> User
        </button>
        <button
          class={clsx(styles.chip, showAssistant && styles.chipActive)}
          onClick={() => onShowAssistantChange(!showAssistant)}
          title={showAssistant ? 'Hide assistant messages' : 'Show assistant messages'}
        >
          <Bot size={12} /> Assistant
        </button>
        <button
          class={clsx(styles.chip, showThinking && styles.chipActive)}
          onClick={() => onShowThinkingChange(!showThinking)}
          title={showThinking ? 'Hide thinking blocks' : 'Show thinking blocks'}
        >
          {showThinking ? <Eye size={12} /> : <EyeOff size={12} />} Thinking
        </button>

        {onShowToolsChange && (
          <>
            <span class={styles.divider} />
            <button
              class={clsx(styles.chip, showTools && styles.chipActive)}
              onClick={() => { onShowToolsChange(!showTools); onShowCommandsOnlyChange?.(false) }}
              title={showTools ? 'Hide tool calls' : 'Show tool calls'}
            >
              <Code size={12} /> Tools
            </button>
            {onShowCommandsOnlyChange && (
              <button
                class={clsx(styles.chip, showCommandsOnly && styles.chipCommand)}
                onClick={() => { onShowCommandsOnlyChange(!showCommandsOnly); onShowBashOnlyChange?.(false) }}
                title={showCommandsOnly ? 'Show all entries' : 'Show commands and results'}
              >
                <Square size={12} /> Commands
              </button>
            )}
            {onShowBashOnlyChange && (
              <button
                class={clsx(styles.chip, showBashOnly && styles.chipCommand)}
                onClick={() => { onShowBashOnlyChange(!showBashOnly); onShowCommandsOnlyChange?.(false) }}
                title={showBashOnly ? 'Show all entries' : 'Show only Bash tool calls'}
              >
                <Code size={12} /> Bash
              </button>
            )}
            {isRaw && onExpandToggle && (
              <>
                <span class={styles.divider} />
                <button
                  class={clsx(styles.expandToggle, expanded && styles.expandToggleActive)}
                  onClick={handleExpandToggle}
                  title={expanded ? 'Collapse all tool blocks' : 'Expand all tool blocks'}
                >
                  <ChevronDown size={12} class={styles.expandChevron} /> Expand
                </button>
              </>
            )}
          </>
        )}

        {statsSlot && (
          <>
            <span class={styles.spacer} />
            <span class={styles.statsSlot}>{statsSlot}</span>
          </>
        )}
      </div>
    </div>
  )
}
