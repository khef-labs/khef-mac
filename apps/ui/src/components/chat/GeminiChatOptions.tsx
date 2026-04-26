import { useState, useRef, useEffect } from 'preact/hooks'
import { Brain, Globe, ScrollText, ChevronDown, X } from 'lucide-preact'
import styles from './GeminiChatOptions.module.css'

export interface GeminiOptions {
  useThinking: boolean
  thinkingBudget: number
  useGoogleSearch: boolean
  systemPrompt: string
}

interface Props {
  options: GeminiOptions
  onChange: (options: GeminiOptions) => void
  disabled?: boolean
}

const BUDGET_PRESETS = [
  { value: 1024, label: '1K' },
  { value: 4096, label: '4K' },
  { value: 8192, label: '8K' },
  { value: 16384, label: '16K' },
  { value: 24576, label: '24K' },
]

const DEFAULT_BUDGET = 8192

export function GeminiChatOptions({ options, onChange, disabled }: Props) {
  const [systemOpen, setSystemOpen] = useState(false)
  const [budgetOpen, setBudgetOpen] = useState(false)
  const systemRef = useRef<HTMLTextAreaElement>(null)
  const budgetRef = useRef<HTMLDivElement>(null)

  const hasSystemContent = options.systemPrompt.trim().length > 0

  // Auto-focus system textarea when opened
  useEffect(() => {
    if (systemOpen && systemRef.current) {
      systemRef.current.focus()
    }
  }, [systemOpen])

  // Close budget dropdown on outside click
  useEffect(() => {
    if (!budgetOpen) return
    const handleClick = (e: MouseEvent) => {
      if (budgetRef.current && !budgetRef.current.contains(e.target as Node)) {
        setBudgetOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [budgetOpen])

  const toggleThinking = () => {
    const next = !options.useThinking
    onChange({
      ...options,
      useThinking: next,
      thinkingBudget: next && !options.thinkingBudget ? DEFAULT_BUDGET : options.thinkingBudget,
    })
    if (!next) setBudgetOpen(false)
  }

  const toggleSearch = () => {
    onChange({ ...options, useGoogleSearch: !options.useGoogleSearch })
  }

  const toggleSystem = () => {
    setSystemOpen(prev => !prev)
  }

  const setBudget = (value: number) => {
    onChange({ ...options, thinkingBudget: value })
    setBudgetOpen(false)
  }

  const currentPreset = BUDGET_PRESETS.find(p => p.value === options.thinkingBudget)
  const budgetLabel = currentPreset?.label || `${Math.round(options.thinkingBudget / 1024)}K`

  return (
    <div class={styles.root}>
      {/* Chip row */}
      <div class={styles.chips}>
        {/* Thinking toggle with budget dropdown */}
        <div class={styles.chipGroup} ref={budgetRef}>
          <button
            type="button"
            class={`${styles.chip} ${options.useThinking ? styles.chipActive : ''}`}
            onClick={toggleThinking}
            disabled={disabled}
            title={options.useThinking ? 'Disable thinking mode' : 'Enable thinking mode (extended reasoning)'}
          >
            <Brain size={12} />
            <span>Thinking</span>
          </button>
          {options.useThinking && (
            <button
              type="button"
              class={`${styles.budgetToggle} ${budgetOpen ? styles.budgetToggleOpen : ''}`}
              onClick={() => setBudgetOpen(prev => !prev)}
              disabled={disabled}
              title="Set thinking budget"
            >
              <span class={styles.budgetValue}>{budgetLabel}</span>
              <ChevronDown size={10} />
            </button>
          )}
          {budgetOpen && (
            <div class={styles.budgetDropdown}>
              <div class={styles.budgetLabel}>Thinking budget</div>
              {BUDGET_PRESETS.map(preset => (
                <button
                  key={preset.value}
                  type="button"
                  class={`${styles.budgetOption} ${options.thinkingBudget === preset.value ? styles.budgetOptionActive : ''}`}
                  onClick={() => setBudget(preset.value)}
                >
                  <span>{preset.label}</span>
                  <span class={styles.budgetTokens}>{preset.value.toLocaleString()} tokens</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Google Search toggle */}
        <button
          type="button"
          class={`${styles.chip} ${options.useGoogleSearch ? styles.chipActive : ''}`}
          onClick={toggleSearch}
          disabled={disabled}
          title={options.useGoogleSearch ? 'Disable Google Search grounding' : 'Enable Google Search grounding'}
        >
          <Globe size={12} />
          <span>Search</span>
        </button>

        {/* System instructions toggle */}
        <div class={styles.chipGroup}>
          <button
            type="button"
            class={`${styles.chip} ${systemOpen ? styles.chipActive : ''} ${!systemOpen && hasSystemContent ? styles.chipHasContent : ''}`}
            onClick={toggleSystem}
            disabled={disabled}
            title={systemOpen ? 'Hide system instructions' : 'Set system instructions'}
          >
            <ScrollText size={12} />
            <span>System</span>
            {!systemOpen && hasSystemContent && <span class={styles.contentDot} />}
          </button>
          {!systemOpen && hasSystemContent && (
            <button
              type="button"
              class={styles.chipClear}
              onClick={() => onChange({ ...options, systemPrompt: '' })}
              disabled={disabled}
              title="Clear system instructions"
            >
              <X size={10} />
            </button>
          )}
        </div>
      </div>

      {/* System instructions panel */}
      {systemOpen && (
        <div class={styles.systemPanel}>
          <textarea
            ref={systemRef}
            class={styles.systemTextarea}
            value={options.systemPrompt}
            onInput={e => onChange({ ...options, systemPrompt: (e.target as HTMLTextAreaElement).value })}
            placeholder="Give the model context to understand the task and provide tailored responses..."
            disabled={disabled}
            rows={3}
          />
          {hasSystemContent && (
            <button
              type="button"
              class={styles.clearBtn}
              onClick={() => onChange({ ...options, systemPrompt: '' })}
              title="Clear system instructions"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  )
}
