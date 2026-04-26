import { useState } from 'preact/hooks'
import { syncProjectRules, type SyncRulesResponse } from '../../lib/api'
import styles from './SettingsShared.module.css'

export function AgentRulesSection() {
  const [syncingRules, setSyncingRules] = useState(false)
  const [syncRulesResult, setSyncRulesResult] = useState<SyncRulesResponse | null>(null)
  const [syncRulesError, setSyncRulesError] = useState<string | null>(null)

  const handleSyncUserRules = async () => {
    setSyncingRules(true)
    setSyncRulesResult(null)
    setSyncRulesError(null)
    try {
      const result = await syncProjectRules('user')
      setSyncRulesResult(result)
      setTimeout(() => setSyncRulesResult(null), 5000)
    } catch (err: any) {
      setSyncRulesError(err.message || 'Failed to sync rules')
    } finally {
      setSyncingRules(false)
    }
  }

  return (
    <div class={styles.section}>
      <p class={styles.description}>
        Sync assistant-rule memories from the "user" project to your local config files
        (~/.claude/KF-RULES.md and ~/.codex/AGENTS.md).
      </p>
      <div class={styles.field}>
        <button
          type="button"
          class={styles.syncButton}
          onClick={handleSyncUserRules}
          disabled={syncingRules}
        >
          {syncingRules ? 'Syncing...' : 'Sync User Rules'}
        </button>
        {syncRulesResult && (
          <div class={styles.syncResult}>
            Synced {syncRulesResult.rulesCount} rules.
            {syncRulesResult.results.length > 0
              ? ` Updated: ${syncRulesResult.results.map((r) => r.target.split('/').pop()).join(', ')}`
              : ' No changes needed.'}
          </div>
        )}
        {syncRulesError && <div class={styles.error}>{syncRulesError}</div>}
      </div>
    </div>
  )
}
