import { useMemo } from 'preact/hooks'
import type { DbxSavedQueryParam } from '../../lib/dbx-api'
import styles from './DbxPage.module.css'

interface Props {
  params: DbxSavedQueryParam[]
  values: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  disabled?: boolean
}

export function ParametersForm({ params, values, onChange, disabled }: Props) {
  const sorted = useMemo(
    () => [...params].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [params]
  )

  if (sorted.length === 0) return null

  function setValue(name: string, raw: unknown) {
    onChange({ ...values, [name]: raw })
  }

  return (
    <div class={styles.paramsForm}>
      {sorted.map((p) => {
        const current = values[p.name]
        const labelText = p.required ? `${p.name} *` : p.name
        return (
          <label key={p.name} class={styles.paramRow}>
            <span class={styles.paramLabel}>{labelText}</span>
            {renderInput(p, current, (v) => setValue(p.name, v), disabled)}
          </label>
        )
      })}
    </div>
  )
}

function renderInput(
  p: DbxSavedQueryParam,
  value: unknown,
  onChange: (v: unknown) => void,
  disabled?: boolean,
) {
  const placeholder = p.default_value ?? ''
  switch (p.value_type) {
    case 'number':
      return (
        <input
          class={styles.paramInput}
          type="number"
          disabled={disabled}
          placeholder={placeholder}
          value={value === null || value === undefined ? '' : String(value)}
          onInput={(e) => {
            const raw = (e.target as HTMLInputElement).value
            onChange(raw === '' ? null : Number(raw))
          }}
        />
      )
    case 'bool':
      return (
        <select
          class={styles.paramInput}
          disabled={disabled}
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(e) => {
            const raw = (e.target as HTMLSelectElement).value
            if (raw === '') onChange(null)
            else onChange(raw === 'true')
          }}
        >
          <option value="">{p.required ? 'Choose…' : 'unset'}</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      )
    case 'enum':
      return (
        <select
          class={styles.paramInput}
          disabled={disabled}
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(e) => {
            const raw = (e.target as HTMLSelectElement).value
            onChange(raw === '' ? null : raw)
          }}
        >
          <option value="">{p.required ? 'Choose…' : 'unset'}</option>
          {(p.options || []).map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      )
    case 'text':
    default:
      return (
        <input
          class={styles.paramInput}
          type="text"
          disabled={disabled}
          placeholder={placeholder}
          value={value === null || value === undefined ? '' : String(value)}
          onInput={(e) => {
            const raw = (e.target as HTMLInputElement).value
            onChange(raw === '' ? null : raw)
          }}
        />
      )
  }
}
