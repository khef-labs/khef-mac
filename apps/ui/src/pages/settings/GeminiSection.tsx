import { useState, useEffect, useCallback } from 'preact/hooks'
import { RotateCcw, Pencil, Check, CircleCheck, Plus, X } from 'lucide-preact'
import { useSettings } from './useSettings'
import { getGcloudHealth, setGcloudAccount as applyGcloudAccount } from '../../lib/api'
import { saveSettings, type Settings } from '../../lib/settings'
import type { GcloudHealthResponse } from '../../types'
import shared from './SettingsShared.module.css'
import styles from './GeminiSection.module.css'

function parseAccountsList(value: string): string[] {
  return value.split('\n').map(v => v.trim()).filter(Boolean)
}

export function GeminiSection() {
  const { settings, setSettings, loading, saving, error, success, save, getDescription, clearMessages } = useSettings()
  const [geminiProject, setGeminiProject] = useState('')
  const [geminiLocation, setGeminiLocation] = useState('')
  const [geminiModel, setGeminiModel] = useState('')
  const [geminiAccountsText, setGeminiAccountsText] = useState('')
  const [newGeminiAccount, setNewGeminiAccount] = useState('')
  const [isAddingAccount, setIsAddingAccount] = useState(false)
  const [geminiVertexAccount, setGeminiVertexAccount] = useState('')
  const [geminiDriveAccount, setGeminiDriveAccount] = useState('')
  const [geminiModels, setGeminiModels] = useState<Array<{ id: string; label: string }>>([])
  const [newModelId, setNewModelId] = useState('')
  const [newModelLabel, setNewModelLabel] = useState('')
  const [editingAccount, setEditingAccount] = useState<{ index: number; value: string } | null>(null)
  const [updatingGcloudAccount, setUpdatingGcloudAccount] = useState(false)
  const [gcloudAccountError, setGcloudAccountError] = useState<string | null>(null)
  const [gcloudAccountSuccess, setGcloudAccountSuccess] = useState<string | null>(null)
  const [gcloudHealth, setGcloudHealth] = useState<GcloudHealthResponse | null>(null)
  const [gcloudHealthLoading, setGcloudHealthLoading] = useState(false)

  useEffect(() => {
    if (settings) {
      setGeminiProject(settings.gemini.project)
      setGeminiLocation(settings.gemini.location)
      setGeminiModel(settings.gemini.defaultModel)
      setGeminiAccountsText(settings.gemini.accounts.join('\n'))
      setGeminiVertexAccount(settings.gemini.vertexAccount)
      setGeminiDriveAccount(settings.gemini.driveAccount)
      setGeminiModels(settings.gemini.models)
    }
  }, [settings])

  const fetchGcloudHealth = useCallback(async () => {
    setGcloudHealthLoading(true)
    try {
      const status = await getGcloudHealth()
      setGcloudHealth(status)
    } catch {
      setGcloudHealth(null)
    } finally {
      setGcloudHealthLoading(false)
    }
  }, [])

  useEffect(() => { fetchGcloudHealth() }, [fetchGcloudHealth])

  const geminiAccounts = parseAccountsList(geminiAccountsText)

  const saveAccountsList = async (accounts: string[]) => {
    const updated = await saveSettings({ gemini: { accounts } } as Partial<Settings>)
    setSettings(updated)
    setGeminiAccountsText(updated.gemini.accounts.join('\n'))
    await fetchGcloudHealth()
  }

  const handleAddGeminiAccount = async () => {
    const account = newGeminiAccount.trim()
    if (!account) return
    if (geminiAccounts.includes(account)) {
      setNewGeminiAccount('')
      setIsAddingAccount(false)
      return
    }
    const updated = [...geminiAccounts, account]
    setGeminiAccountsText(updated.join('\n'))
    setNewGeminiAccount('')
    setIsAddingAccount(false)
    await saveAccountsList(updated)
  }

  const handleCancelAddAccount = () => {
    setNewGeminiAccount('')
    setIsAddingAccount(false)
  }

  const handleRemoveGeminiAccount = async (account: string) => {
    const updated = geminiAccounts.filter((item) => item !== account)
    setGeminiAccountsText(updated.join('\n'))
    await saveAccountsList(updated)
  }

  const handleSetGcloudAccount = async (account: string) => {
    const target = account.trim()
    if (!target) return
    setUpdatingGcloudAccount(true)
    setGcloudAccountError(null)
    setGcloudAccountSuccess(null)
    try {
      const result = await applyGcloudAccount(target)
      setGcloudAccountSuccess(result.message)
      await fetchGcloudHealth()
    } catch (err: any) {
      setGcloudAccountError(err.message || 'Failed to set gcloud account')
    } finally {
      setUpdatingGcloudAccount(false)
    }
  }

  const handleSave = useCallback(async () => {
    const result = await save({
      gemini: {
        project: geminiProject.trim(),
        location: geminiLocation.trim(),
        defaultModel: geminiModel.trim(),
        accounts: geminiAccounts,
        vertexAccount: geminiVertexAccount,
        driveAccount: geminiDriveAccount,
        models: geminiModels,
      },
    })
    if (result) await fetchGcloudHealth()
  }, [geminiProject, geminiLocation, geminiModel, geminiAccounts, geminiVertexAccount, geminiDriveAccount, geminiModels, save, fetchGcloudHealth])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (settings) {
          setGeminiProject(settings.gemini.project)
          setGeminiLocation(settings.gemini.location)
          setGeminiModel(settings.gemini.defaultModel)
          setGeminiVertexAccount(settings.gemini.vertexAccount)
          setGeminiDriveAccount(settings.gemini.driveAccount)
          setGeminiModels(settings.gemini.models)
        }
        clearMessages()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSave, settings, clearMessages])

  const hasChanges = settings
    ? geminiProject !== settings.gemini.project ||
      geminiLocation !== settings.gemini.location ||
      geminiModel !== settings.gemini.defaultModel ||
      geminiVertexAccount !== settings.gemini.vertexAccount ||
      geminiDriveAccount !== settings.gemini.driveAccount ||
      JSON.stringify(geminiModels) !== JSON.stringify(settings.gemini.models)
    : false

  if (loading) return <div class={shared.description}>Loading...</div>

  return (
    <>
      <div class={shared.section}>
        <p class={shared.description}>
          Configure Vertex AI Gemini integration. Requires <code>gcloud</code> CLI authenticated
          with a GCP project that has the Vertex AI API enabled.
        </p>

        {/* Accounts */}
        <div class={shared.subsection}>
          <div class={shared.sectionTitleRow}>
            <h3 class={shared.subsectionTitle}>Accounts</h3>
            <button
              type="button"
              class={`${styles.healthBadge} ${gcloudHealthLoading ? styles.healthBadgeLoading : ''}`}
              onClick={fetchGcloudHealth}
              title="Refresh health"
              disabled={gcloudHealthLoading}
            >
              <RotateCcw size={10} />
              {gcloudHealthLoading ? 'Checking...' : 'Refresh'}
            </button>
          </div>
          <div class={shared.field}>
            {geminiAccounts.length > 0 && (
              <div class={styles.accountsList}>
                {geminiAccounts.map((account, idx) => {
                  const isActive = gcloudHealth?.active_account === account
                  const isEditing = editingAccount?.index === idx
                  const healthCheck = (gcloudHealth?.account_checks ?? []).find((c) => c.account === account)
                  return (
                    <div key={`${account}-${idx}`} class={styles.accountItem}>
                      <span
                        class={`${styles.healthDot} ${healthCheck ? (healthCheck.authenticated ? styles.healthDotHealthy : styles.healthDotUnhealthy) : styles.healthDotUnknown}`}
                        title={healthCheck ? (healthCheck.authenticated ? 'Authenticated' : `Not authenticated${healthCheck.error ? `: ${healthCheck.error}` : ''}`) : 'Not checked'}
                      />
                      {isActive ? (
                        <span class={styles.accountActiveBadge}>
                          <CircleCheck size={14} /> Active
                        </span>
                      ) : (
                        <button
                          type="button"
                          class={styles.accountMakeActiveButton}
                          disabled={updatingGcloudAccount}
                          onClick={() => handleSetGcloudAccount(account)}
                        >
                          Make Active
                        </button>
                      )}
                      {isEditing ? (
                        <input
                          type="text"
                          class={styles.accountEditInput}
                          value={editingAccount.value}
                          onInput={(e) => setEditingAccount({ index: idx, value: (e.target as HTMLInputElement).value })}
                          onKeyDown={async (e) => {
                            if (e.key === 'Enter') {
                              const trimmed = editingAccount.value.trim()
                              if (trimmed && trimmed !== account) {
                                const updated = [...geminiAccounts]
                                updated[idx] = trimmed
                                setEditingAccount(null)
                                await saveAccountsList(updated)
                              } else {
                                setEditingAccount(null)
                              }
                            } else if (e.key === 'Escape') {
                              setEditingAccount(null)
                            }
                          }}
                          autoFocus
                        />
                      ) : (
                        <span class={styles.accountId}>{account}</span>
                      )}
                      <div class={styles.accountActions}>
                        {isEditing ? (
                          <button
                            type="button"
                            class={styles.accountActionButton}
                            title="Save"
                            onClick={async () => {
                              const trimmed = editingAccount.value.trim()
                              if (trimmed && trimmed !== account) {
                                const updated = [...geminiAccounts]
                                updated[idx] = trimmed
                                setEditingAccount(null)
                                await saveAccountsList(updated)
                              } else {
                                setEditingAccount(null)
                              }
                            }}
                          >
                            <Check size={14} />
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              class={styles.accountActionButton}
                              title="Edit account"
                              onClick={() => setEditingAccount({ index: idx, value: account })}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              class={`${styles.accountActionButton} ${styles.accountDeleteButton}`}
                              title="Remove account"
                              onClick={() => handleRemoveGeminiAccount(account)}
                            >
                              &times;
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {isAddingAccount ? (
              <div class={styles.addModelRow}>
                <input
                  id="geminiAccounts"
                  type="text"
                  class={styles.addModelInput}
                  placeholder="account@example.com"
                  value={newGeminiAccount}
                  onInput={(e) => setNewGeminiAccount((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleAddGeminiAccount()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      handleCancelAddAccount()
                    }
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  class={styles.addModelButton}
                  disabled={!newGeminiAccount.trim()}
                  onClick={handleAddGeminiAccount}
                >
                  Save
                </button>
                <button
                  type="button"
                  class={styles.accountActionButton}
                  title="Cancel"
                  onClick={handleCancelAddAccount}
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                class={styles.addAccountButton}
                onClick={() => setIsAddingAccount(true)}
                title="Add account"
              >
                <Plus size={14} /> Add account
              </button>
            )}
            {gcloudAccountSuccess && <p class={shared.success}>{gcloudAccountSuccess}</p>}
            {gcloudAccountError && <p class={shared.error}>{gcloudAccountError}</p>}
          </div>
        </div>

        {/* Configuration */}
        <div class={shared.subsection}>
          <h3 class={shared.subsectionTitle}>Configuration</h3>
          <div class={shared.field}>
            <label class={shared.label} htmlFor="geminiProject">GCP Project ID</label>
            <input
              id="geminiProject"
              class={shared.input}
              type="text"
              placeholder="my-gcp-project"
              value={geminiProject}
              onInput={(e) => setGeminiProject((e.target as HTMLInputElement).value)}
            />
            {getDescription('gemini.project') && (
              <p class={shared.description}>{getDescription('gemini.project')}</p>
            )}
          </div>
          <div class={shared.field}>
            <label class={shared.label} htmlFor="geminiLocation">Region</label>
            <select
              id="geminiLocation"
              class={shared.input}
              value={geminiLocation}
              onChange={(e) => setGeminiLocation((e.target as HTMLSelectElement).value)}
            >
              <option value="us-central1">us-central1</option>
              <option value="us-east4">us-east4</option>
              <option value="us-west1">us-west1</option>
              <option value="europe-west1">europe-west1</option>
              <option value="europe-west4">europe-west4</option>
              <option value="asia-northeast1">asia-northeast1</option>
            </select>
          </div>
          <div class={shared.field}>
            <label class={shared.label} htmlFor="geminiModel">Default Model</label>
            <select
              id="geminiModel"
              class={shared.input}
              value={geminiModel}
              onChange={(e) => setGeminiModel((e.target as HTMLSelectElement).value)}
            >
              {geminiModels.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Roles */}
        {geminiAccounts.length > 0 && (
          <div class={shared.subsection}>
            <h3 class={shared.subsectionTitle}>Account Roles</h3>
            <p class={shared.description}>
              Assign which account to use for each service. "Auto" uses the first account or the active gcloud account.
            </p>
            <div class={shared.field}>
              <label class={shared.label} htmlFor="geminiVertexAccount">Vertex AI</label>
              <select
                id="geminiVertexAccount"
                class={styles.roleSelect}
                value={geminiVertexAccount}
                onChange={(e) => setGeminiVertexAccount((e.target as HTMLSelectElement).value)}
              >
                <option value="">Auto</option>
                {geminiAccounts.map((account) => (
                  <option key={account} value={account}>{account}</option>
                ))}
              </select>
            </div>
            <div class={shared.field}>
              <label class={shared.label} htmlFor="geminiDriveAccount">Google Drive</label>
              <select
                id="geminiDriveAccount"
                class={styles.roleSelect}
                value={geminiDriveAccount}
                onChange={(e) => setGeminiDriveAccount((e.target as HTMLSelectElement).value)}
              >
                <option value="">Auto</option>
                {geminiAccounts.map((account) => (
                  <option key={account} value={account}>{account}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Models */}
        <div class={shared.subsection}>
          <h3 class={shared.subsectionTitle}>Available Models</h3>
          <div class={shared.field}>
            <div class={styles.modelsList}>
              {geminiModels.map((m, idx) => (
                <div key={m.id} class={styles.modelItem}>
                  <span class={styles.modelId}>{m.id}</span>
                  <span class={styles.modelLabel}>{m.label}</span>
                  <button
                    type="button"
                    class={styles.removeModelButton}
                    onClick={() => setGeminiModels(geminiModels.filter((_, i) => i !== idx))}
                    title="Remove model"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
            <div class={styles.addModelRow}>
              <input
                type="text"
                class={styles.addModelInput}
                placeholder="Model ID (e.g., gemini-2.0-pro)"
                value={newModelId}
                onInput={(e) => setNewModelId((e.target as HTMLInputElement).value)}
              />
              <input
                type="text"
                class={styles.addModelInput}
                placeholder="Label"
                value={newModelLabel}
                onInput={(e) => setNewModelLabel((e.target as HTMLInputElement).value)}
              />
              <button
                type="button"
                class={styles.addModelButton}
                disabled={!newModelId.trim() || !newModelLabel.trim()}
                onClick={() => {
                  if (newModelId.trim() && newModelLabel.trim()) {
                    setGeminiModels([...geminiModels, { id: newModelId.trim(), label: newModelLabel.trim() }])
                    setNewModelId('')
                    setNewModelLabel('')
                  }
                }}
              >
                Add
              </button>
            </div>
            <p class={shared.description}>
              Models available in the default model dropdown and kdag step config.
            </p>
          </div>
        </div>
      </div>

      {error && <div class={shared.error}>{error}</div>}
      {success && <div class={shared.success}>Settings saved successfully</div>}

      {hasChanges && (
        <div class={shared.actions}>
          <button class={shared.saveButton} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          <span class={shared.shortcutHint}>⌘S</span>
        </div>
      )}
    </>
  )
}
