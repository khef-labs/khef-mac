import { useState, useEffect, useCallback } from 'preact/hooks'
import { useSettings } from './useSettings'
import styles from './SettingsShared.module.css'

const TOOL_GROUPS = [
  {
    label: 'Khef MCP',
    tools: [{ name: 'mcp__khef__*', label: 'All khef tools (memories, search, pipelines, etc.)' }],
  },
  {
    label: 'Web',
    tools: [
      { name: 'WebSearch', label: 'Web search' },
      { name: 'WebFetch', label: 'Web fetch' },
    ],
  },
  {
    label: 'Filesystem',
    tools: [
      { name: 'Read', label: 'Read files' },
      { name: 'Glob', label: 'Find files (glob)' },
      { name: 'Grep', label: 'Search file contents (grep)' },
      { name: 'Edit', label: 'Edit files' },
      { name: 'Write', label: 'Write files' },
      { name: 'Bash', label: 'Run shell commands' },
    ],
  },
]

const BUILTIN_TOOLS = new Set([
  'mcp__khef__*', 'WebSearch', 'WebFetch',
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash',
])

export function KdagSection() {
  const { settings, loading, saving, error, success, save, getDescription, clearMessages } = useSettings()
  const [kdagMaxConcurrency, setKdagMaxConcurrency] = useState('')
  const [kdagAllowedTools, setKdagAllowedTools] = useState<string[]>([])

  useEffect(() => {
    if (settings) {
      setKdagMaxConcurrency(String(settings.kdag.maxConcurrency))
      setKdagAllowedTools(settings.kdag.allowedTools)
    }
  }, [settings])

  const handleSave = useCallback(async () => {
    await save({
      kdag: {
        maxConcurrency: Math.max(1, parseInt(kdagMaxConcurrency, 10) || 1),
        allowedTools: kdagAllowedTools,
        definitions: settings?.kdag.definitions ?? { hidden: [] },
      },
    })
  }, [kdagMaxConcurrency, kdagAllowedTools, settings, save])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (settings) {
          setKdagMaxConcurrency(String(settings.kdag.maxConcurrency))
          setKdagAllowedTools(settings.kdag.allowedTools)
        }
        clearMessages()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSave, settings, clearMessages])

  const hasChanges = settings
    ? kdagMaxConcurrency !== String(settings.kdag.maxConcurrency) ||
      JSON.stringify(kdagAllowedTools) !== JSON.stringify(settings.kdag.allowedTools)
    : false

  if (loading) return <div class={styles.description}>Loading...</div>

  const customTools = kdagAllowedTools.filter((t) => !BUILTIN_TOOLS.has(t))

  return (
    <>
      <div class={styles.section}>
        <div class={styles.field}>
          <label class={styles.label} htmlFor="kdagMaxConcurrency">Max Concurrent Jobs</label>
          <input
            id="kdagMaxConcurrency"
            class={styles.input}
            type="number"
            min="1"
            max="20"
            step="1"
            value={kdagMaxConcurrency}
            onInput={(e) => setKdagMaxConcurrency((e.target as HTMLInputElement).value)}
          />
          {getDescription('kdag.maxConcurrency') && (
            <p class={styles.description}>{getDescription('kdag.maxConcurrency')}</p>
          )}
        </div>
        <p class={styles.description}>
          Tools Claude is allowed to use when executing kdag pipeline steps.
          These are passed via <code>--allowedTools</code> to the Claude CLI.
        </p>
        {TOOL_GROUPS.map((group) => (
          <div key={group.label} class={styles.field}>
            <label class={styles.label}>{group.label}</label>
            <div class={styles.toolCheckboxes}>
              {group.tools.map((tool) => (
                <label key={tool.name} class={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={kdagAllowedTools.includes(tool.name)}
                    onChange={() => {
                      setKdagAllowedTools((prev) =>
                        prev.includes(tool.name)
                          ? prev.filter((t) => t !== tool.name)
                          : [...prev, tool.name]
                      )
                    }}
                  />
                  <span>{tool.label}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
        <div class={styles.field}>
          <label class={styles.label}>Custom</label>
          {customTools.length > 0 && (
            <div class={styles.customToolChips}>
              {customTools.map((tool) => (
                <span key={tool} class={styles.customToolChip}>
                  <code>{tool}</code>
                  <button
                    type="button"
                    class={styles.customToolRemove}
                    onClick={() => setKdagAllowedTools((prev) => prev.filter((t) => t !== tool))}
                  >
                    &times;
                  </button>
                </span>
              ))}
            </div>
          )}
          <form
            class={styles.customToolForm}
            onSubmit={(e) => {
              e.preventDefault()
              const form = e.currentTarget
              const input = form.elements.namedItem('kdagCustomTool') as HTMLInputElement
              const value = input.value.trim()
              if (value && !kdagAllowedTools.includes(value)) {
                setKdagAllowedTools((prev) => [...prev, value])
                input.value = ''
              }
            }}
          >
            <input
              name="kdagCustomTool"
              type="text"
              class={styles.input}
              placeholder="e.g. mcp__github__*, NotebookEdit"
            />
            <button type="submit" class={styles.addButton}>Add</button>
          </form>
        </div>
      </div>

      {error && <div class={styles.error}>{error}</div>}
      {success && <div class={styles.success}>Settings saved successfully</div>}

      {hasChanges && (
        <div class={styles.actions}>
          <button class={styles.saveButton} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          <span class={styles.shortcutHint}>⌘S</span>
        </div>
      )}
    </>
  )
}
