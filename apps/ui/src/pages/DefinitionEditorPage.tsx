import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { Plus, Trash2, Shield, Save, ChevronDown, ChevronUp, ChevronRight, FileCode, Play, List, Download, ExternalLink } from 'lucide-preact'
import clsx from 'clsx'
import {
  getJobDefinition,
  createJobDefinition,
  updateJobDefinition,
  exportJobDefinition,
  getPrompts,
  listKdagInputTypes,
} from '../lib/api'
import type { JobDefinitionStep, JobDefinitionInput, KdagInputType, Prompt } from '../types'
import { setEditorDeepLink } from '../lib/editorDeepLink'
import { useToast, ModelCombobox, CopyButton } from '../components/ui'
import { PageHeader } from '../components/layout'
import { useKdagBackends } from '../hooks/useKdagBackends'
import { RunModal } from '../components/kdag/RunModal'
import { useDocumentTitle } from '../hooks'
import styles from './DefinitionEditorPage.module.css'

const STEP_TYPES = ['prompt', 'map_reduce', 'code']
const INPUT_SOURCES = ['job_input', 'previous_step', 'template']
// Dynamic ASSISTANTS built from useKdagBackends in the component

const FIELD_HELP: Record<string, string> = {
  name: 'Human-readable name shown in the UI and job list.',
  key: 'Unique kebab-case identifier. Used in API calls and URL paths. Cannot be changed after creation.',
  description: 'Explains what this pipeline does. Shown on the definition card.',
  required_inputs: 'Declare what data jobs need when they run this definition. "req" means the job will fail without it; "opt" means it can be omitted.',
  step_name: 'Display name for this step. Shows in the step list and job run details.',
  step_key: 'Identifier used to reference this step\'s output from later steps (e.g., {{step.this_key}}).',
  step_type: '"prompt" runs a single LLM call. "map_reduce" splits input into chunks, processes each, then synthesizes. "code" runs a script as a subprocess (no LLM).',
  agent: 'Which LLM backend runs this step. "Inherit" uses the job-level assistant chosen at run time.',
  timeout: 'Max time this step can run before being canceled.',
  prompt: 'Which prompt template to use. "From job input" uses the prompt text provided when the job is created.',
  input_source: '"job input" reads from the job\'s declared inputs. "previous step" uses another step\'s output. "template" lets you compose text from multiple sources.',
  input_type: 'Which job input to feed into this step (e.g., prompt, transcript).',
  step_key_ref: 'Key of the earlier step whose output becomes this step\'s input.',
  template: 'Compose input from multiple sources. {{job_input.TYPE}} inserts a job input. {{step.KEY}} inserts a prior step\'s output. {{job.model}} / {{job.assistant}} insert run-level info. {{meta.KEY.model}} / {{meta.KEY.backend}} / {{meta.KEY.script}} insert metadata about a prior step.',
  script_path: 'Path to the script file (relative to project root or absolute). .ts files run via tsx, .py via python3, others via node.',
  split_mode: 'How to split input into batches. "Characters" splits by character count at paragraph boundaries. "CSV row" splits by CSV rows (first row is header). "Line" splits by newlines.',
  batch_size_rows: 'Number of rows per batch for CSV row or line split modes. Leave empty to put all rows in a single batch.',
  chunk_size: 'Target character count per chunk when splitting input. Splits at paragraph boundaries.',
  threshold: 'Input must exceed this character count to trigger splitting. Set to 0 to always split.',
  batch_prompt: 'Prompt template for processing each individual chunk. Different from the synthesis prompt.',
  merge_template: 'How to join chunk outputs before synthesis. {{index}} is the chunk number, {{output}} is the chunk result.',
  skip_synthesis: 'Skip the final LLM synthesis call. Batch outputs are concatenated directly using the merge template. Use when outputs are already structured (CSV, JSON).',
  batch_timeout: 'Per-batch timeout override for the fan-out loop. Each batch LLM call gets this budget independently. Leave as "Inherit from step" to use the step-level timeout.',
  synthesis_timeout: 'Timeout override for the final synthesis LLM call that merges batch outputs. Leave as "Inherit from step" to use the step-level timeout. Useful when synthesis needs more time than individual batches.',
}

const TIMEOUT_OPTIONS: { value: number; label: string }[] = [
  { value: 60_000, label: '1 min' },
  { value: 120_000, label: '2 min' },
  { value: 300_000, label: '5 min' },
  { value: 600_000, label: '10 min' },
  { value: 900_000, label: '15 min' },
  { value: 1_200_000, label: '20 min' },
  { value: 1_800_000, label: '30 min' },
]

function formatTimeoutMs(ms: number): string {
  const match = TIMEOUT_OPTIONS.find(o => o.value === ms)
  if (match) return match.label
  return `${Math.round(ms / 1000)}s`
}

function FieldLabel({ text, help }: { text: string; help?: string }) {
  if (!help) return <label class={styles.label}>{text}</label>
  return (
    <label class={clsx(styles.label, styles.labelTip)} data-tip={help}>
      {text}
    </label>
  )
}

interface Props {
  defKey?: string
  isNew?: boolean
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function emptyStep(index: number): JobDefinitionStep {
  return {
    step_index: index,
    key: '',
    name: '',
    step_type: 'prompt',
    assistant_handle: null,
    model: null,
    prompt_handle: null,
    input_source: 'job_input',
    input_config: { input_type: 'prompt' },
    config: {},
    timeout_ms: 120000,
  }
}

export function DefinitionEditorPage({ defKey, isNew }: Props) {
  const [, setLocation] = useLocation()
  const { showToast } = useToast()
  const { backends } = useKdagBackends()
  const ASSISTANTS = useMemo(() => [
    { value: '', label: 'Inherit from job' },
    ...backends.filter(b => b.available).map(b => ({ value: b.key, label: b.name })),
  ], [backends])

  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showRunModal, setShowRunModal] = useState(false)
  const [isSystem, setIsSystem] = useState(false)

  // Form state
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  useDocumentTitle(
    isNew ? 'Definition - New' : name ? `Definition - ${name}` : 'Definition - Loading',
  )
  const [steps, setSteps] = useState<JobDefinitionStep[]>([emptyStep(0)])
  const [inputs, setInputs] = useState<JobDefinitionInput[]>([])
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set([0]))

  // Prompt + input type options
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [registeredInputTypes, setRegisteredInputTypes] = useState<KdagInputType[]>([])

  // Merged list of input type keys: registered types + any extras from the loaded definition
  const inputTypeKeys = useMemo(() => {
    const keys = registeredInputTypes.map(t => t.key)
    for (const inp of inputs) {
      if (!keys.includes(inp.input_type)) keys.push(inp.input_type)
    }
    return keys
  }, [registeredInputTypes, inputs])

  // Load definition if editing
  useEffect(() => {
    if (isNew) return

    async function load() {
      try {
        const [defData, promptsData, inputTypesData] = await Promise.all([
          getJobDefinition(defKey!),
          getPrompts({ limit: 200 }),
          listKdagInputTypes(),
        ])

        const { definition, steps: defSteps, inputs: defInputs } = defData
        setKey(definition.key)
        setName(definition.name)
        setDescription(definition.description || '')
        setIsSystem(definition.is_system)
        setSteps(defSteps.length > 0 ? defSteps : [emptyStep(0)])
        setInputs(defInputs)
        setPrompts(promptsData.prompts)
        setRegisteredInputTypes(inputTypesData.input_types)
        setExpandedSteps(new Set())
      } catch {
        setError('Failed to load definition')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [defKey, isNew])

  // Load prompts + input types for new definitions
  useEffect(() => {
    if (!isNew) return
    Promise.all([
      getPrompts({ limit: 200 }),
      listKdagInputTypes(),
    ]).then(([promptsData, inputTypesData]) => {
      setPrompts(promptsData.prompts)
      setRegisteredInputTypes(inputTypesData.input_types)
    }).catch(() => {})
  }, [isNew])

  // Auto-generate key from name
  const handleNameChange = useCallback((val: string) => {
    setName(val)
    if (isNew) {
      setKey(slugify(val))
    }
  }, [isNew])

  // Step helpers
  const updateStep = useCallback((index: number, patch: Partial<JobDefinitionStep>) => {
    setSteps(prev => prev.map((s, i) => i === index ? { ...s, ...patch } : s))
  }, [])

  const addStep = useCallback(() => {
    setSteps(prev => {
      const next = [...prev, emptyStep(prev.length)]
      setExpandedSteps(exp => new Set([...exp, prev.length]))
      return next
    })
  }, [])

  const removeStep = useCallback((index: number) => {
    setSteps(prev => {
      const next = prev.filter((_, i) => i !== index).map((s, i) => ({ ...s, step_index: i }))
      return next.length > 0 ? next : [emptyStep(0)]
    })
  }, [])

  const moveStep = useCallback((index: number, direction: -1 | 1) => {
    setSteps(prev => {
      const next = [...prev]
      const target = index + direction
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next.map((s, i) => ({ ...s, step_index: i }))
    })
  }, [])

  // Input declaration helpers
  const toggleInput = useCallback((inputType: string) => {
    setInputs(prev => {
      const exists = prev.find(i => i.input_type === inputType)
      if (exists) return prev.filter(i => i.input_type !== inputType)
      return [...prev, { input_type: inputType, required: true, description: null }]
    })
  }, [])

  const toggleInputRequired = useCallback((inputType: string) => {
    setInputs(prev => prev.map(i =>
      i.input_type === inputType ? { ...i, required: !i.required } : i
    ))
  }, [])

  const toggleStepExpanded = useCallback((index: number) => {
    setExpandedSteps(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  const allExpanded = expandedSteps.size === steps.length
  const toggleAllSteps = useCallback(() => {
    setExpandedSteps(prev =>
      prev.size === steps.length ? new Set() : new Set(steps.map((_, i) => i))
    )
  }, [steps])

  // Save
  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    if (!key.trim()) {
      setError('Key is required')
      return
    }
    if (steps.some(s => !s.key.trim() || !s.name.trim())) {
      setError('All steps need a key and name')
      return
    }

    setSaving(true)
    setError(null)

    try {
      const stepsPayload = steps.map((s) => ({
        key: s.key,
        name: s.name,
        step_type: s.step_type,
        assistant_handle: s.assistant_handle || undefined,
        model: s.model || undefined,
        prompt_handle: s.prompt_handle || undefined,
        input_source: s.input_source,
        input_config: s.input_config,
        config: s.config,
        timeout_ms: s.timeout_ms,
      }))

      if (isNew) {
        const result = await createJobDefinition({
          key,
          name,
          description: description || undefined,
          steps: stepsPayload as JobDefinitionStep[],
          inputs: inputs.length > 0 ? inputs : undefined,
        })
        showToast('Definition created')
        setLocation(`/kdag/definitions/${result.definition.key}`)
      } else {
        await updateJobDefinition(defKey!, {
          name,
          description: description || undefined,
          steps: stepsPayload as JobDefinitionStep[],
          inputs,
        })
        showToast('Definition updated')
      }
    } catch (err: any) {
      const message = err?.response ? await err.response.text().catch(() => err.message) : err?.message
      setError(typeof message === 'string' ? message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [name, key, description, steps, inputs, isNew, defKey, setLocation, showToast])

  if (loading) {
    return <div class={styles.page}><div class={styles.loading}>Loading...</div></div>
  }

  // Get previous step keys for input_source=previous_step
  const stepKeys = steps.map(s => s.key).filter(Boolean)

  return (
    <div class={styles.page}>
      {/* Header */}
      <PageHeader
        title={isNew ? 'New Definition' : (name || defKey || '')}
        breadcrumbs={[{ label: 'Kdag', href: '/kdag' }, { label: 'Definitions', href: '/kdag/definitions' }]}
      />
      <div class={styles.header}>
        <div class={styles.headerTop}>
          <h1 class={styles.title}>
            {isNew ? 'New Definition' : name}
            {isSystem && (
              <span class={styles.systemBadge}><Shield size={10} /> System</span>
            )}
          </h1>
          <div class={styles.headerActions}>
            {!isNew && (
              <a
                href={`/kdag/jobs?definition_key=${defKey}`}
                class={styles.jobsLink}
                onClick={(e) => { e.preventDefault(); setLocation(`/kdag/jobs?definition_key=${defKey}`) }}
              >
                <List size={14} /> Jobs
              </a>
            )}
            {!isNew && (
              <button
                class={styles.exportBtn}
                disabled={exporting}
                onClick={async () => {
                  setExporting(true)
                  try {
                    const blob = await exportJobDefinition(defKey!)
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = `${defKey}-export.zip`
                    a.click()
                    URL.revokeObjectURL(url)
                    showToast('Definition exported')
                  } catch {
                    showToast('Export failed')
                  } finally {
                    setExporting(false)
                  }
                }}
              >
                <Download size={14} /> {exporting ? 'Exporting...' : 'Export'}
              </button>
            )}
            {!isNew && (
              <button
                class={styles.runBtn}
                onClick={() => setShowRunModal(true)}
              >
                <Play size={14} /> Run
              </button>
            )}
            <button
              class={styles.saveBtn}
              disabled={saving}
              onClick={handleSave}
            >
              <Save size={14} /> {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {error && <div class={styles.error}>{error}</div>}

      {/* Basic info */}
      <div class={styles.section}>
        <div class={styles.fieldRow}>
          <div class={styles.field}>
            <FieldLabel text="Name" help={FIELD_HELP.name} />
            <input
              class={styles.input}
              value={name}
              onInput={(e) => handleNameChange((e.target as HTMLInputElement).value)}
              placeholder="e.g. Session Summary"
            />
          </div>
          <div class={styles.field}>
            <FieldLabel text="Key" help={FIELD_HELP.key} />
            <input
              class={clsx(styles.input, styles.inputMono)}
              value={key}
              onInput={(e) => setKey((e.target as HTMLInputElement).value)}
              placeholder="e.g. session-summary"
              disabled={!isNew}
            />
          </div>
        </div>
        <div class={styles.field}>
          <FieldLabel text="Description" help={FIELD_HELP.description} />
          <textarea
            class={styles.textarea}
            value={description}
            onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
            rows={2}
            placeholder="What does this pipeline do?"
          />
        </div>
      </div>

      {/* Required inputs */}
      <div class={styles.section}>
        <h2 class={clsx(styles.sectionTitle, styles.labelTip)} data-tip={FIELD_HELP.required_inputs}>
          Required Inputs
        </h2>
        <div class={styles.inputGroups}>
          {inputs.length > 0 && (
            <div class={styles.inputGroup}>
              <span class={styles.inputGroupLabel}>Selected ({inputs.length})</span>
              <div class={styles.inputChips}>
                {inputTypeKeys.filter(t => inputs.some(i => i.input_type === t)).map(type => {
                  const isRequired = inputs.find(i => i.input_type === type)?.required ?? true
                  return (
                    <div key={type} class={styles.inputChipWrap}>
                      <button
                        class={clsx(styles.inputChip, styles.inputChipActive)}
                        onClick={() => toggleInput(type)}
                      >
                        {type.replace(/_/g, ' ')}
                      </button>
                      <button
                        class={clsx(styles.requiredToggle, !isRequired && styles.requiredToggleOff)}
                        onClick={() => toggleInputRequired(type)}
                        title={isRequired ? 'Required' : 'Optional'}
                      >
                        {isRequired ? 'req' : 'opt'}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          {inputTypeKeys.some(t => !inputs.some(i => i.input_type === t)) && (
            <div class={styles.inputGroup}>
              <span class={styles.inputGroupLabel}>Available</span>
              <div class={styles.inputChips}>
                {inputTypeKeys.filter(t => !inputs.some(i => i.input_type === t)).map(type => (
                  <div key={type} class={styles.inputChipWrap}>
                    <button
                      class={styles.inputChip}
                      onClick={() => toggleInput(type)}
                    >
                      {type.replace(/_/g, ' ')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Steps */}
      <div class={styles.section}>
        <div class={styles.sectionHeader}>
          <h2 class={styles.sectionTitle}>Steps</h2>
          <div class={styles.stepHeaderActions}>
            <button class={styles.collapseAllBtn} onClick={toggleAllSteps}>
              {allExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {allExpanded ? 'Collapse All' : 'Expand All'}
            </button>
            <button class={styles.addStepBtn} onClick={addStep}>
              <Plus size={12} /> Add Step
            </button>
          </div>
        </div>

        <div class={styles.stepsList}>
          {steps.map((step, idx) => {
            const expanded = expandedSteps.has(idx)
            return (
              <div key={idx} class={styles.stepCard}>
                <div class={styles.stepCardHeader} onClick={() => toggleStepExpanded(idx)}>
                  {expanded ? <ChevronDown size={14} class={styles.expandIcon} /> : <ChevronRight size={14} class={styles.expandIcon} />}
                  <span class={styles.stepIndex}>{idx + 1}</span>
                  <span class={styles.stepName}>{step.name || 'Untitled step'}</span>
                  <span class={styles.stepTypeBadge}>
                    {step.step_type}
                    {step.step_type === 'map_reduce' && step.config.split_mode && (
                      <span class={styles.splitModeSuffix}> · {(step.config.split_mode as string).replace(/_/g, ' ')}</span>
                    )}
                  </span>
                  <div class={styles.stepActions}>
                    <button
                      class={styles.stepMoveBtn}
                      disabled={idx === 0}
                      onClick={(e) => { e.stopPropagation(); moveStep(idx, -1) }}
                      title="Move up"
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      class={styles.stepMoveBtn}
                      disabled={idx === steps.length - 1}
                      onClick={(e) => { e.stopPropagation(); moveStep(idx, 1) }}
                      title="Move down"
                    >
                      <ChevronDown size={12} />
                    </button>
                    {steps.length > 1 && (
                      <button
                        class={styles.stepRemoveBtn}
                        onClick={(e) => { e.stopPropagation(); removeStep(idx) }}
                        title="Remove step"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>

                {expanded && (
                  <div class={styles.stepBody}>
                    <div class={styles.fieldRow}>
                      <div class={styles.field}>
                        <FieldLabel text="Name" help={FIELD_HELP.step_name} />
                        <input
                          class={styles.input}
                          value={step.name}
                          onInput={(e) => {
                            const val = (e.target as HTMLInputElement).value
                            updateStep(idx, { name: val, key: step.key || slugify(val) })
                          }}
                          placeholder="e.g. Summarize Transcript"
                        />
                      </div>
                      <div class={styles.field}>
                        <FieldLabel text="Key" help={FIELD_HELP.step_key} />
                        <input
                          class={clsx(styles.input, styles.inputMono)}
                          value={step.key}
                          onInput={(e) => updateStep(idx, { key: (e.target as HTMLInputElement).value })}
                          placeholder="e.g. summarize"
                        />
                      </div>
                    </div>

                    <div class={styles.fieldRow}>
                      <div class={styles.field}>
                        <FieldLabel text="Step Type" help={FIELD_HELP.step_type} />
                        <select
                          class={styles.select}
                          value={step.step_type}
                          onChange={(e) => updateStep(idx, { step_type: (e.target as HTMLSelectElement).value })}
                        >
                          {STEP_TYPES.map(t => (
                            <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
                          ))}
                        </select>
                      </div>
                      {step.step_type !== 'code' && (
                        <div class={styles.field}>
                          <FieldLabel text="Agent" help={FIELD_HELP.agent} />
                          <select
                            class={styles.select}
                            value={step.assistant_handle || ''}
                            onChange={(e) => updateStep(idx, {
                              assistant_handle: (e.target as HTMLSelectElement).value || null,
                              model: null,
                            })}
                          >
                            {ASSISTANTS.map(a => (
                              <option key={a.value} value={a.value}>{a.label}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      {step.step_type !== 'code' && (
                        <div class={styles.field}>
                          <FieldLabel text="Model" help="Specific model for this step. Leave empty to use the run-level model or backend default." />
                          <ModelCombobox
                            value={step.model || ''}
                            onChange={(m) => updateStep(idx, { model: m || null })}
                            models={backends.find(b => b.key === step.assistant_handle)?.models || backends.flatMap(b => b.models)}
                          />
                        </div>
                      )}
                      <div class={styles.field}>
                        <FieldLabel text="Timeout" help={FIELD_HELP.timeout} />
                        <select
                          class={styles.select}
                          value={step.timeout_ms}
                          onChange={(e) => updateStep(idx, { timeout_ms: parseInt((e.target as HTMLSelectElement).value, 10) })}
                        >
                          <option value={60000}>1 min</option>
                          <option value={120000}>2 min</option>
                          <option value={300000}>5 min</option>
                          <option value={600000}>10 min</option>
                          <option value={900000}>15 min</option>
                          <option value={1200000}>20 min</option>
                          <option value={1800000}>30 min</option>
                        </select>
                      </div>
                    </div>

                    {step.step_type === 'code' && (
                      <div class={styles.field}>
                        <FieldLabel text="Script Path" help={FIELD_HELP.script_path} />
                        <div class={styles.scriptPathRow}>
                          <input
                            class={clsx(styles.input, styles.inputMono, styles.scriptPathInput)}
                            value={(step.config.script_path as string) || ''}
                            onInput={(e) => updateStep(idx, {
                              config: { ...step.config, script_path: (e.target as HTMLInputElement).value },
                            })}
                            placeholder="e.g. scripts/kdag/my-script.ts"
                          />
                          {(step.config.script_path as string) && (
                            <>
                              <CopyButton
                                text={step.config.script_path as string}
                                title="Copy script path"
                                size={14}
                                className={styles.openEditorBtn}
                              />
                              <button
                                class={styles.openEditorBtn}
                                title="Open in Editor"
                                onClick={() => {
                                  setEditorDeepLink({ path: step.config.script_path as string })
                                  window.open('/editor', '_blank')
                                }}
                              >
                                <FileCode size={14} />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    )}

                    <div class={styles.fieldRow}>
                      {step.step_type !== 'code' && (
                        <div class={styles.field}>
                          <FieldLabel text="Prompt" help={FIELD_HELP.prompt} />
                          <div class={styles.selectWithLink}>
                            <select
                              class={styles.select}
                              value={step.prompt_handle || ''}
                              onChange={(e) => updateStep(idx, {
                                prompt_handle: (e.target as HTMLSelectElement).value || null,
                              })}
                            >
                              <option value="">From job input</option>
                              {prompts.map(p => (
                                <option key={p.handle} value={p.handle}>{p.title} ({p.handle})</option>
                              ))}
                            </select>
                            {step.prompt_handle && (() => {
                              const p = prompts.find(pr => pr.handle === step.prompt_handle)
                              return p ? (
                                <a
                                  class={styles.openPromptLink}
                                  href={`/prompts/${p.id}`}
                                  target="_blank"
                                  rel="noopener"
                                  title="Open prompt in new tab"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <ExternalLink size={14} />
                                </a>
                              ) : null
                            })()}
                          </div>
                        </div>
                      )}
                      <div class={styles.field}>
                        <FieldLabel text="Input Source" help={FIELD_HELP.input_source} />
                        <select
                          class={styles.select}
                          value={step.input_source}
                          onChange={(e) => {
                            const source = (e.target as HTMLSelectElement).value
                            let inputConfig: Record<string, unknown> = {}
                            if (source === 'job_input') inputConfig = { input_type: 'prompt' }
                            if (source === 'previous_step') inputConfig = { step_key: stepKeys[idx - 1] || '' }
                            if (source === 'template') inputConfig = { template: '' }
                            updateStep(idx, { input_source: source, input_config: inputConfig })
                          }}
                        >
                          {INPUT_SOURCES
                            .filter(s => idx > 0 || s !== 'previous_step')
                            .map(s => (
                              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                            ))}
                        </select>
                      </div>
                    </div>

                    {/* Input config fields based on source */}
                    {step.input_source === 'job_input' && (
                      <div class={styles.field}>
                        <FieldLabel text="Input Type" help={FIELD_HELP.input_type} />
                        <select
                          class={styles.select}
                          value={(step.input_config.input_type as string) || 'prompt'}
                          onChange={(e) => updateStep(idx, {
                            input_config: { ...step.input_config, input_type: (e.target as HTMLSelectElement).value },
                          })}
                        >
                          {inputTypeKeys.map(t => (
                            <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {step.input_source === 'previous_step' && (
                      <div class={styles.field}>
                        <FieldLabel text="Step Key" help={FIELD_HELP.step_key_ref} />
                        <select
                          class={styles.select}
                          value={(step.input_config.step_key as string) || ''}
                          onChange={(e) => updateStep(idx, {
                            input_config: { ...step.input_config, step_key: (e.target as HTMLSelectElement).value },
                          })}
                        >
                          <option value="">Select step...</option>
                          {steps.slice(0, idx).map(s => (
                            <option key={s.key} value={s.key}>{s.name || s.key}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {step.input_source === 'template' && (() => {
                      const priorKeys = stepKeys.slice(0, idx).filter(Boolean)
                      const activeInputs = inputs.map(i => i.input_type)
                      const metaVars = priorKeys.flatMap(k => {
                        const priorStep = steps.find(s => s.key === k)
                        if (priorStep?.step_type === 'code') {
                          return [`{{meta.${k}.backend}}`, `{{meta.${k}.script}}`]
                        }
                        return [`{{meta.${k}.backend}}`, `{{meta.${k}.model}}`]
                      })
                      return (
                        <div class={styles.field}>
                          <FieldLabel text="Template" help={FIELD_HELP.template} />
                          <p class={styles.sectionHint}>
                            Available variables:{' '}
                            {[
                              ...activeInputs.map(t => `{{job_input.${t}}}`),
                              ...priorKeys.map(k => `{{step.${k}}}`),
                              '{{job.model}}',
                              '{{job.assistant}}',
                              ...metaVars,
                            ].map((v, i) => (
                              <>{i > 0 && ', '}<code key={v}>{v}</code></>
                            ))}
                          </p>
                          <textarea
                            class={clsx(styles.textarea, styles.textareaMono)}
                            value={(step.input_config.template as string) || ''}
                            onInput={(e) => updateStep(idx, {
                              input_config: { ...step.input_config, template: (e.target as HTMLTextAreaElement).value },
                            })}
                            rows={4}
                          />
                        </div>
                      )
                    })()}

                    {/* Map-reduce config */}
                    {step.step_type === 'map_reduce' && (
                      <div class={styles.mapReduceConfig}>
                        <h4 class={styles.configHeading}>Map-Reduce Config</h4>
                        <div class={styles.fieldRow}>
                          <div class={styles.field}>
                            <FieldLabel text="Split Mode" help={FIELD_HELP.split_mode} />
                            <select
                              class={styles.select}
                              value={(step.config.split_mode as string) || ''}
                              onChange={(e) => {
                                const mode = (e.target as HTMLSelectElement).value || undefined
                                const patch: Record<string, unknown> = { ...step.config, split_mode: mode }
                                // Clear batch_size when switching away from row-based modes
                                if (!mode) delete patch.batch_size
                                updateStep(idx, { config: patch })
                              }}
                            >
                              <option value="">Characters (default)</option>
                              <option value="csv_row">CSV row</option>
                              <option value="line">Line</option>
                            </select>
                          </div>
                          {((step.config.split_mode as string) === 'csv_row' || (step.config.split_mode as string) === 'line') && (
                            <div class={styles.field}>
                              <FieldLabel text="Batch Size (rows)" help={FIELD_HELP.batch_size_rows} />
                              <input
                                class={styles.input}
                                type="number"
                                value={(step.config.batch_size as number) || ''}
                                onInput={(e) => {
                                  const val = parseInt((e.target as HTMLInputElement).value, 10)
                                  updateStep(idx, {
                                    config: { ...step.config, batch_size: val || undefined },
                                  })
                                }}
                                placeholder="All rows in one batch"
                              />
                            </div>
                          )}
                        </div>
                        <div class={styles.fieldRow}>
                          <div class={styles.field}>
                            <FieldLabel text="Chunk Size" help={FIELD_HELP.chunk_size} />
                            <input
                              class={styles.input}
                              type="number"
                              value={(step.config.chunk_size as number) || 50000}
                              onInput={(e) => updateStep(idx, {
                                config: { ...step.config, chunk_size: parseInt((e.target as HTMLInputElement).value, 10) || 50000 },
                              })}
                            />
                          </div>
                          <div class={styles.field}>
                            <FieldLabel text="Threshold" help={FIELD_HELP.threshold} />
                            <input
                              class={styles.input}
                              type="number"
                              value={(step.config.threshold as number) ?? 100000}
                              onInput={(e) => updateStep(idx, {
                                config: { ...step.config, threshold: parseInt((e.target as HTMLInputElement).value, 10) },
                              })}
                            />
                          </div>
                        </div>
                        <div class={styles.field}>
                          <FieldLabel text="Batch Prompt" help={FIELD_HELP.batch_prompt} />
                          <div class={styles.selectWithLink}>
                            <select
                              class={styles.select}
                              value={(step.config.batch_prompt_handle as string) || ''}
                              onChange={(e) => updateStep(idx, {
                                config: { ...step.config, batch_prompt_handle: (e.target as HTMLSelectElement).value || undefined },
                              })}
                            >
                              <option value="">From chunk_prompt job input</option>
                              {prompts.map(p => (
                                <option key={p.handle} value={p.handle}>{p.title} ({p.handle})</option>
                              ))}
                            </select>
                            {(step.config.batch_prompt_handle as string) && (() => {
                              const p = prompts.find(pr => pr.handle === step.config.batch_prompt_handle)
                              return p ? (
                                <a
                                  class={styles.openPromptLink}
                                  href={`/prompts/${p.id}`}
                                  target="_blank"
                                  rel="noopener"
                                  title="Open prompt in new tab"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <ExternalLink size={14} />
                                </a>
                              ) : null
                            })()}
                          </div>
                        </div>
                        <div class={styles.field}>
                          <FieldLabel text="Merge Template" help={FIELD_HELP.merge_template} />
                          <input
                            class={clsx(styles.input, styles.inputMono)}
                            value={(step.config.merge_template as string) || '## Segment {{index}}\n\n{{output}}'}
                            onInput={(e) => updateStep(idx, {
                              config: { ...step.config, merge_template: (e.target as HTMLInputElement).value },
                            })}
                          />
                        </div>
                        <div class={styles.field}>
                          <label class={styles.checkboxLabel} data-tip={FIELD_HELP.skip_synthesis}>
                            <input
                              type="checkbox"
                              checked={!!step.config.skip_synthesis}
                              onChange={(e) => updateStep(idx, {
                                config: { ...step.config, skip_synthesis: (e.target as HTMLInputElement).checked },
                              })}
                            />
                            Skip synthesis (concatenate batch outputs directly)
                          </label>
                        </div>
                        <div class={styles.fieldRow}>
                          <div class={styles.field}>
                            <FieldLabel text="Batch Timeout" help={FIELD_HELP.batch_timeout} />
                            <select
                              class={styles.select}
                              value={
                                typeof step.config.batch_timeout_ms === 'number'
                                  ? String(step.config.batch_timeout_ms)
                                  : ''
                              }
                              onChange={(e) => {
                                const raw = (e.target as HTMLSelectElement).value
                                const nextConfig = { ...step.config }
                                if (raw === '') {
                                  delete nextConfig.batch_timeout_ms
                                } else {
                                  nextConfig.batch_timeout_ms = parseInt(raw, 10)
                                }
                                updateStep(idx, { config: nextConfig })
                              }}
                            >
                              <option value="">Inherit from step ({formatTimeoutMs(step.timeout_ms)})</option>
                              {TIMEOUT_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                          </div>
                          <div class={styles.field}>
                            <FieldLabel text="Synthesis Timeout" help={FIELD_HELP.synthesis_timeout} />
                            <select
                              class={styles.select}
                              value={
                                typeof step.config.synthesis_timeout_ms === 'number'
                                  ? String(step.config.synthesis_timeout_ms)
                                  : ''
                              }
                              disabled={!!step.config.skip_synthesis}
                              onChange={(e) => {
                                const raw = (e.target as HTMLSelectElement).value
                                const nextConfig = { ...step.config }
                                if (raw === '') {
                                  delete nextConfig.synthesis_timeout_ms
                                } else {
                                  nextConfig.synthesis_timeout_ms = parseInt(raw, 10)
                                }
                                updateStep(idx, { config: nextConfig })
                              }}
                            >
                              <option value="">Inherit from step ({formatTimeoutMs(step.timeout_ms)})</option>
                              {TIMEOUT_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {showRunModal && defKey && (
        <RunModal
          definitionKey={defKey}
          definitionName={name}
          inputs={inputs}
          onClose={() => setShowRunModal(false)}
          onCreated={(jobId) => {
            setShowRunModal(false)
            showToast('Job started')
            setLocation(`/kdag/jobs/${jobId}`)
          }}
        />
      )}
    </div>
  )
}
