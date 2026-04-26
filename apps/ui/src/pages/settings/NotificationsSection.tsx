import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { Plus, Trash2, HardDrive, Clock } from 'lucide-preact'
import clsx from 'clsx'
import { useSettings } from './useSettings'
import sharedStyles from './SettingsShared.module.css'
import styles from './NotificationsSection.module.css'

const BYTES_PER_GB = 1024 * 1024 * 1024

type Severity = 'info' | 'warning' | 'error'

const SEVERITY_VAR: Record<Severity, string> = {
  info: 'var(--info, var(--brand-blue))',
  warning: 'var(--warning)',
  error: 'var(--error)',
}

interface TierDraft {
  percent: string
  severity: Severity
}

function bytesToGB(bytes: number): string {
  return (bytes / BYTES_PER_GB).toFixed(1)
}

function gbToBytes(gb: number): number {
  return Math.round(gb * BYTES_PER_GB)
}

function tiersToDraft(tiers: Array<{ threshold: number; severity: Severity }>): TierDraft[] {
  return tiers.map((t) => ({ percent: String(Math.round(t.threshold * 100)), severity: t.severity }))
}

function draftToTiers(drafts: TierDraft[]): Array<{ threshold: number; severity: Severity }> {
  const out: Array<{ threshold: number; severity: Severity }> = []
  for (const d of drafts) {
    const pct = parseFloat(d.percent)
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) continue
    out.push({ threshold: pct / 100, severity: d.severity })
  }
  return out.sort((a, b) => a.threshold - b.threshold)
}

function tiersEqual(
  a: Array<{ threshold: number; severity: Severity }>,
  b: Array<{ threshold: number; severity: Severity }>
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].threshold !== b[i].threshold || a[i].severity !== b[i].severity) return false
  }
  return true
}

interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}

function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      class={clsx(styles.switch, checked && styles.switchOn)}
      onClick={() => onChange(!checked)}
    />
  )
}

export function NotificationsSection() {
  const { settings, loading, saving, error, success, save, clearMessages } = useSettings()

  const [watchEnabled, setWatchEnabled] = useState(true)
  const [itermWarnGb, setItermWarnGb] = useState('20')
  const [sessionContextEnabled, setSessionContextEnabled] = useState(true)
  const [tierDrafts, setTierDrafts] = useState<TierDraft[]>([])

  useEffect(() => {
    if (settings) {
      setWatchEnabled(settings.memory.watchEnabled)
      setItermWarnGb(bytesToGB(settings.memory.itermWarnBytes))
      setSessionContextEnabled(settings.sessionContext.watchEnabled)
      setTierDrafts(tiersToDraft(settings.sessionContext.tiers))
    }
  }, [settings])

  const handleSave = useCallback(async () => {
    const gb = parseFloat(itermWarnGb)
    if (!Number.isFinite(gb) || gb <= 0) return
    const nextTiers = draftToTiers(tierDrafts)
    await save({
      memory: {
        watchEnabled,
        itermWarnBytes: gbToBytes(gb),
      },
      sessionContext: {
        watchEnabled: sessionContextEnabled,
        tiers: nextTiers,
      },
    })
  }, [watchEnabled, itermWarnGb, sessionContextEnabled, tierDrafts, save])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (settings) {
          setWatchEnabled(settings.memory.watchEnabled)
          setItermWarnGb(bytesToGB(settings.memory.itermWarnBytes))
          setSessionContextEnabled(settings.sessionContext.watchEnabled)
          setTierDrafts(tiersToDraft(settings.sessionContext.tiers))
        }
        clearMessages()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSave, settings, clearMessages])

  const tiersDirty = settings
    ? !tiersEqual(draftToTiers(tierDrafts), settings.sessionContext.tiers)
    : false

  const hasChanges = settings
    ? watchEnabled !== settings.memory.watchEnabled ||
      gbToBytes(parseFloat(itermWarnGb) || 0) !== settings.memory.itermWarnBytes ||
      sessionContextEnabled !== settings.sessionContext.watchEnabled ||
      tiersDirty
    : false

  const updateTier = (idx: number, patch: Partial<TierDraft>) => {
    setTierDrafts((prev) => prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)))
  }

  const addTier = () => {
    setTierDrafts((prev) => [...prev, { percent: '75', severity: 'warning' }])
  }

  const removeTier = (idx: number) => {
    setTierDrafts((prev) => prev.filter((_, i) => i !== idx))
  }

  // Build a sorted copy of the tier drafts for the escalation preview bar.
  const previewTiers = useMemo(() => {
    const valid = tierDrafts
      .map((t) => ({ pct: parseFloat(t.percent), severity: t.severity }))
      .filter((t) => Number.isFinite(t.pct) && t.pct > 0 && t.pct < 100)
      .sort((a, b) => a.pct - b.pct)
    return valid
  }, [tierDrafts])

  if (loading) return <div class={sharedStyles.description}>Loading...</div>

  return (
    <div class={styles.page}>
      <div class={styles.header}>
        <p class={styles.pageSubtitle}>
          Banner alerts triggered by background watchers. Each watcher can be toggled and tuned independently.
        </p>
      </div>

      {/* Memory watcher */}
      <section class={styles.card}>
        <header class={styles.cardHeader}>
          <div class={styles.cardHeaderLeft}>
            <span class={styles.cardIcon}><HardDrive size={16} /></span>
            <div>
              <h2 class={styles.cardTitle}>Memory watcher</h2>
              <div class={styles.cardSubtitle}>Alerts when tracked apps exceed a resident-memory threshold</div>
            </div>
          </div>
          <Toggle checked={watchEnabled} onChange={setWatchEnabled} label="Enable memory watcher" />
        </header>
        <div class={clsx(styles.cardBody, !watchEnabled && styles.cardBodyDimmed)}>
          <div class={styles.field}>
            <label class={styles.fieldLabel} htmlFor="itermWarnGb">iTerm warning threshold</label>
            <div class={styles.inlineField}>
              <input
                id="itermWarnGb"
                class={styles.input}
                type="number"
                min="0.5"
                step="0.5"
                value={itermWarnGb}
                onInput={(e) => setItermWarnGb((e.target as HTMLInputElement).value)}
                disabled={!watchEnabled}
              />
              <span class={styles.unit}>GB</span>
            </div>
            <p class={styles.fieldHelp}>
              A banner appears when iTerm's total resident memory (across all tabs) crosses this value. Long Claude
              Code sessions can leak scrollback into many GB — default is 20 GB. Dismissing keeps the banner hidden
              until RSS grows 25% past the dismiss point.
            </p>
          </div>
        </div>
      </section>

      {/* Session context */}
      <section class={styles.card}>
        <header class={styles.cardHeader}>
          <div class={styles.cardHeaderLeft}>
            <span class={styles.cardIcon}><Clock size={16} /></span>
            <div>
              <h2 class={styles.cardTitle}>Session context</h2>
              <div class={styles.cardSubtitle}>Alerts at percentage tiers of a session's context window</div>
            </div>
          </div>
          <Toggle
            checked={sessionContextEnabled}
            onChange={setSessionContextEnabled}
            label="Enable session context notifications"
          />
        </header>
        <div class={clsx(styles.cardBody, !sessionContextEnabled && styles.cardBodyDimmed)}>
          {previewTiers.length > 0 && (
            <div class={styles.escPreviewWrap}>
              <div class={styles.escPreviewLabel}>Escalation preview</div>
              <div class={styles.escalation}>
                {previewTiers.map((t) => (
                  <span key={`${t.pct}-${t.severity}`}>
                    <span
                      class={styles.escMark}
                      style={{ left: `${t.pct}%`, background: SEVERITY_VAR[t.severity] }}
                    />
                    <span
                      class={styles.escLabel}
                      style={{ left: `${t.pct}%`, color: SEVERITY_VAR[t.severity] }}
                    >
                      {t.pct}% · {t.severity}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div class={styles.field}>
            <label class={styles.fieldLabel}>Context tiers</label>
            <div class={styles.tierStack}>
              {tierDrafts.length === 0 && (
                <div class={styles.emptyTiers}>No tiers configured — notifications will never fire.</div>
              )}
              {tierDrafts.map((t, idx) => {
                const severityVar = SEVERITY_VAR[t.severity]
                const rowStyle = { '--severity': severityVar } as Record<string, string>
                return (
                  <div key={idx} class={styles.tierRow} style={rowStyle}>
                    <span class={styles.tierDot} />
                    <input
                      class={styles.tierPct}
                      type="number"
                      min="1"
                      max="99"
                      step="1"
                      value={t.percent}
                      onInput={(e) => updateTier(idx, { percent: (e.target as HTMLInputElement).value })}
                      disabled={!sessionContextEnabled}
                      aria-label="Threshold percent"
                    />
                    <span class={styles.tierPctSign}>%</span>
                    <select
                      class={styles.tierSev}
                      value={t.severity}
                      onChange={(e) => updateTier(idx, { severity: (e.target as HTMLSelectElement).value as Severity })}
                      disabled={!sessionContextEnabled}
                      aria-label="Severity"
                    >
                      <option value="info">info</option>
                      <option value="warning">warning</option>
                      <option value="error">error</option>
                    </select>
                    <span class={styles.tierSpacer} />
                    <button
                      type="button"
                      class={styles.tierDelete}
                      onClick={() => removeTier(idx)}
                      disabled={!sessionContextEnabled}
                      title="Remove tier"
                      aria-label="Remove tier"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )
              })}
              <button
                type="button"
                class={styles.addTier}
                onClick={addTier}
                disabled={!sessionContextEnabled}
              >
                <Plus size={14} /> Add tier
              </button>
            </div>
            <p class={styles.fieldHelp}>
              Each tier fires when the session's used context crosses the threshold. Dismissing a tier keeps the banner
              hidden until the session reaches a higher tier.
            </p>
          </div>
        </div>
      </section>

      {error && <div class={styles.error}>{error}</div>}
      {success && <div class={styles.success}>Settings saved successfully</div>}

      {hasChanges && (
        <div class={styles.actions}>
          <span class={styles.shortcutHint}>⌘S</span>
          <button class={styles.saveButton} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save settings'}
          </button>
        </div>
      )}
    </div>
  )
}
