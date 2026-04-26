import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { Play } from 'lucide-preact'
import {
  getJobDefinition,
  createKdagJob,
  runKdagJob,
} from '../../lib/api'
import type { JobDefinitionInput } from '../../types'
import { ModelCombobox } from '../ui'
import { useKdagBackends } from '../../hooks/useKdagBackends'
import styles from './RunModal.module.css'

export interface RunModalProps {
  definitionKey: string
  definitionName: string
  inputs?: JobDefinitionInput[]
  onClose: () => void
  onCreated: (jobId: string) => void
}

function inputLabel(key: string) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function RunModal({ definitionKey, definitionName, inputs: inputsProp, onClose, onCreated }: RunModalProps) {
  const [defInputs, setDefInputs] = useState<JobDefinitionInput[]>(inputsProp || [])
  const [loading, setLoading] = useState(!inputsProp)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    if (inputsProp) {
      for (const inp of inputsProp) initial[inp.input_type] = ''
    }
    return initial
  })
  const { backends } = useKdagBackends()
  const availableBackends = useMemo(() => {
    const available = backends.filter(b => b.available)
    return available.length > 0 ? available : [{ key: 'claude-code', name: 'Claude Code', available: true, models: [] as string[] }]
  }, [backends])
  const [assistant, setAssistant] = useState('claude-code')
  const [model, setModel] = useState('')
  const selectedBackend = useMemo(() => backends.find(b => b.key === assistant), [backends, assistant])

  useEffect(() => {
    if (inputsProp) return
    async function load() {
      try {
        const data = await getJobDefinition(definitionKey)
        setDefInputs(data.inputs)
        const initial: Record<string, string> = {}
        for (const inp of data.inputs) {
          initial[inp.input_type] = ''
        }
        setValues(initial)
      } catch {
        setError('Failed to load definition inputs')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [definitionKey, inputsProp])

  const handleSubmit = useCallback(async () => {
    for (const inp of defInputs) {
      if (inp.required && !values[inp.input_type]?.trim()) {
        setError(`"${inp.input_type.replace(/_/g, ' ')}" is required`)
        return
      }
    }

    setSubmitting(true)
    setError(null)

    try {
      const modelOpt = model || undefined
      const result = await createKdagJob({
        definition_key: definitionKey,
        assistant_handle: assistant,
        model: modelOpt,
        inputs: values,
      })
      await runKdagJob(result.job.id, { model: modelOpt })
      onCreated(result.job.id)
    } catch (err: any) {
      const msg = err?.response ? await err.response.text().catch(() => err.message) : err?.message
      setError(typeof msg === 'string' ? msg : 'Failed to create job')
      setSubmitting(false)
    }
  }, [defInputs, values, definitionKey, assistant, model, onCreated])

  return (
    <div class={styles.overlay} onClick={onClose}>
      <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div class={styles.modalHeader}>
          <h2 class={styles.modalTitle}>Run: {definitionName}</h2>
        </div>

        <div class={styles.assistant}>
          <label class={styles.label}>Assistant</label>
          <select
            class={styles.select}
            value={assistant}
            onChange={(e) => {
              setAssistant((e.target as HTMLSelectElement).value)
              setModel('')
            }}
          >
            {availableBackends.map(b => (
              <option key={b.key} value={b.key}>{b.name}</option>
            ))}
          </select>
          <ModelCombobox
            value={model}
            onChange={setModel}
            models={selectedBackend?.models || []}
          />
        </div>

        {loading ? (
          <div class={styles.loading}>Loading inputs...</div>
        ) : defInputs.length === 0 ? (
          <p class={styles.hint}>No declared inputs. Will run with defaults.</p>
        ) : (
          <div class={styles.body}>
            {defInputs.map(inp => (
              <div key={inp.input_type} class={styles.field}>
                <label class={styles.label}>
                  {inputLabel(inp.input_type)}
                  {inp.required ? (
                    <span class={styles.req}>required</span>
                  ) : (
                    <span class={styles.opt}>optional</span>
                  )}
                </label>
                <textarea
                  class={styles.textarea}
                  value={values[inp.input_type] || ''}
                  onInput={(e) => setValues(prev => ({
                    ...prev,
                    [inp.input_type]: (e.target as HTMLTextAreaElement).value,
                  }))}
                  rows={inp.input_type === 'transcript' ? 8 : 4}
                  placeholder={`Enter ${inputLabel(inp.input_type).toLowerCase()}...`}
                />
              </div>
            ))}
          </div>
        )}

        {error && <div class={styles.error}>{error}</div>}

        <div class={styles.actions}>
          <button class={styles.cancelBtn} onClick={onClose} disabled={submitting}>Cancel</button>
          <button class={styles.runBtn} onClick={handleSubmit} disabled={loading || submitting}>
            <Play size={12} />
            {submitting ? 'Starting...' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  )
}
