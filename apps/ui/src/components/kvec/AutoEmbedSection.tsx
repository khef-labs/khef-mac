import { useState, useEffect, useRef, useMemo } from 'preact/hooks'
import { Plus, Trash2, Play, X, GitFork, Clock, AlertCircle, Code, GitCommitHorizontal, Check } from 'lucide-preact'
import clsx from 'clsx'
import {
  getAutoEmbedConfigs,
  createAutoEmbedConfig,
  updateAutoEmbedConfig,
  deleteAutoEmbedConfig,
  runAutoEmbedNow,
  getEmbedGitInfo,
} from '../../lib/api'
import { formatTimeAgo } from './kvec-utils'
import type { AutoEmbedConfig, AutoEmbedJobType, KvecRepo } from '../../types'
import styles from './AutoEmbedSection.module.css'

interface Props {
  repos: KvecRepo[]
  /** Filter configs to a specific job type. Shows all if omitted. */
  jobType?: AutoEmbedJobType
  /** Called after Run Now queues jobs so the job list can refresh. */
  onJobsChanged?: () => void
}

interface RepoGroup {
  repoPath: string
  repoName: string
  configs: AutoEmbedConfig[]
}

export function AutoEmbedSection({ repos, jobType, onJobsChanged }: Props) {
  const [allConfigs, setAllConfigs] = useState<AutoEmbedConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<string | null>(null)

  // Track which branch tab is active per repo (repoPath -> configId)
  const [activeBranch, setActiveBranch] = useState<Record<string, string>>({})

  // Add-branch inline form state (repoPath that's adding, or null)
  const [addingBranchRepo, setAddingBranchRepo] = useState<string | null>(null)
  const [addBranchValue, setAddBranchValue] = useState('')
  const [addBranchOptions, setAddBranchOptions] = useState<string[]>([])
  const [addBranchLoading, setAddBranchLoading] = useState(false)
  const [addBranchSaving, setAddBranchSaving] = useState(false)

  // Add form state
  const [addPath, setAddPath] = useState('')
  const [addBranch, setAddBranch] = useState('main')
  const [addJobType, setAddJobType] = useState<AutoEmbedJobType>(jobType || 'commits')
  const [addDelay, setAddDelay] = useState(1000)
  const [addSaving, setAddSaving] = useState(false)
  const [localBranches, setLocalBranches] = useState<string[]>([])
  const [remoteBranches, setRemoteBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const branchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Filter configs by job type if specified
  const configs = jobType ? allConfigs.filter((c) => c.job_type === jobType) : allConfigs

  // Group configs by repo_path
  const repoGroups = useMemo(() => {
    const map = new Map<string, RepoGroup>()
    for (const config of configs) {
      let group = map.get(config.repo_path)
      if (!group) {
        group = {
          repoPath: config.repo_path,
          repoName: config.repo_path.split('/').pop() || config.repo_path,
          configs: [],
        }
        map.set(config.repo_path, group)
      }
      group.configs.push(config)
    }
    return Array.from(map.values())
  }, [configs])

  const loadConfigs = async () => {
    try {
      const data = await getAutoEmbedConfigs()
      setAllConfigs(data.configs)
    } catch (err: any) {
      setError(err?.message || 'Failed to load auto-embed configs')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadConfigs() }, [])

  // Fetch branches when add path changes
  useEffect(() => {
    if (!addPath.trim()) {
      setLocalBranches([])
      setRemoteBranches([])
      return
    }
    if (branchDebounceRef.current) clearTimeout(branchDebounceRef.current)
    branchDebounceRef.current = setTimeout(() => {
      setBranchesLoading(true)
      getEmbedGitInfo(addPath.trim())
        .then((info) => {
          setLocalBranches(info.localBranches)
          setRemoteBranches(info.remoteBranches)
          if (info.localBranches.includes('main')) setAddBranch('main')
          else if (info.currentBranch) setAddBranch(info.currentBranch)
        })
        .catch(() => {
          setLocalBranches([])
          setRemoteBranches([])
        })
        .finally(() => setBranchesLoading(false))
    }, 400)
    return () => { if (branchDebounceRef.current) clearTimeout(branchDebounceRef.current) }
  }, [addPath])

  const getActiveConfig = (group: RepoGroup): AutoEmbedConfig => {
    const activeId = activeBranch[group.repoPath]
    return group.configs.find((c) => c.id === activeId) || group.configs[0]
  }

  const handleAdd = async () => {
    if (!addPath.trim()) return
    setAddSaving(true)
    setError(null)
    try {
      await createAutoEmbedConfig({
        repo_path: addPath.trim(),
        branch: addBranch || 'main',
        job_type: addJobType,
        batch_delay_ms: addDelay,
      })
      setShowAdd(false)
      setAddPath('')
      setAddBranch('main')
      setAddJobType(jobType || 'commits')
      setAddDelay(1000)
      await loadConfigs()
    } catch (err: any) {
      setError(err?.message || 'Failed to create config')
    } finally {
      setAddSaving(false)
    }
  }

  const handleRepoToggle = async (e: Event, group: RepoGroup) => {
    e.stopPropagation()
    const anyEnabled = group.configs.some((c) => c.enabled)
    try {
      await Promise.all(
        group.configs.map((c) => updateAutoEmbedConfig(c.id, { enabled: !anyEnabled }))
      )
      await loadConfigs()
    } catch (err: any) {
      setError(err?.message || 'Failed to update config')
    }
  }

  const handleDelete = async (e: Event, group: RepoGroup) => {
    e.stopPropagation()
    const active = getActiveConfig(group)
    try {
      if (group.configs.length <= 1) {
        // Last branch — remove entire repo
        await deleteAutoEmbedConfig(active.id)
      } else {
        // Remove active branch only
        await deleteAutoEmbedConfig(active.id)
        // Clear the active selection so it falls back to first
        setActiveBranch((prev) => {
          const next = { ...prev }
          delete next[group.repoPath]
          return next
        })
      }
      await loadConfigs()
    } catch (err: any) {
      setError(err?.message || 'Failed to delete config')
    }
  }

  const handleStartAddBranch = (group: RepoGroup) => {
    setAddingBranchRepo(group.repoPath)
    setAddBranchValue('')
    setAddBranchOptions([])
    setAddBranchLoading(true)
    getEmbedGitInfo(group.repoPath)
      .then((info) => {
        const existing = new Set(group.configs.map((c) => c.branch))
        const available = [...info.localBranches, ...info.remoteBranches].filter(
          (b) => !existing.has(b)
        )
        setAddBranchOptions(available)
        if (available.length > 0) setAddBranchValue(available[0])
      })
      .catch(() => setAddBranchOptions([]))
      .finally(() => setAddBranchLoading(false))
  }

  const handleSaveAddBranch = async (group: RepoGroup) => {
    if (!addBranchValue.trim()) return
    setAddBranchSaving(true)
    setError(null)
    try {
      // Copy settings from the first config in the group
      const ref = group.configs[0]
      const result = await createAutoEmbedConfig({
        repo_path: group.repoPath,
        branch: addBranchValue.trim(),
        job_type: ref.job_type,
        batch_delay_ms: ref.batch_delay_ms,
      })
      setAddingBranchRepo(null)
      await loadConfigs()
      // Select the newly added branch
      setActiveBranch((prev) => ({ ...prev, [group.repoPath]: result.config.id }))
    } catch (err: any) {
      setError(err?.message || 'Failed to add branch')
    } finally {
      setAddBranchSaving(false)
    }
  }

  const handleRunNow = async () => {
    setRunning(true)
    setRunResult(null)
    setError(null)
    try {
      const result = await runAutoEmbedNow()
      setRunResult(`Checked ${result.checked}, queued ${result.queued}${result.errors ? `, ${result.errors} error(s)` : ''}`)
      await loadConfigs()
      if (result.queued > 0) onJobsChanged?.()
    } catch (err: any) {
      setError(err?.message || 'Failed to run')
    } finally {
      setRunning(false)
    }
  }

  const allBranches = [...localBranches, ...remoteBranches]
  const showJobTypeSelector = !jobType

  return (
    <div class={styles.section}>
      <div class={styles.header}>
        <div class={styles.headerLeft}>
          <Clock size={16} />
          <h3>Auto-Embed</h3>
          <span class={styles.headerHint}>Every 30 min, up to 3 repos per cycle</span>
        </div>
        <div class={styles.headerActions}>
          {repoGroups.length > 0 && (
            <button
              type="button"
              class={styles.runButton}
              disabled={running}
              onClick={handleRunNow}
            >
              <Play size={12} />
              {running ? 'Running...' : 'Run Now'}
            </button>
          )}
          <button
            type="button"
            class={styles.addButton}
            onClick={() => setShowAdd(!showAdd)}
          >
            {showAdd ? <X size={14} /> : <Plus size={14} />}
            {showAdd ? 'Cancel' : 'Add'}
          </button>
        </div>
      </div>

      {error && (
        <div class={styles.error} onClick={() => setError(null)}>
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {runResult && (
        <div class={styles.runResult} onClick={() => setRunResult(null)}>
          {runResult}
        </div>
      )}

      {showAdd && (
        <div class={styles.addForm}>
          <div class={styles.addField}>
            <label>Repository path</label>
            <input
              type="text"
              placeholder="/path/to/git/repo"
              value={addPath}
              onInput={(e) => setAddPath((e.target as HTMLInputElement).value)}
            />
          </div>

          {repos.length > 0 && !addPath && (
            <div class={styles.repoPicks}>
              {repos.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  class={styles.repoPick}
                  onClick={() => setAddPath(r.root_path)}
                >
                  <GitFork size={12} /> {r.name}
                </button>
              ))}
            </div>
          )}

          <div class={styles.addRow}>
            {showJobTypeSelector && (
              <div class={styles.addField}>
                <label>Type</label>
                <div class={styles.typeToggle}>
                  <button
                    type="button"
                    class={clsx(styles.typeButton, addJobType === 'commits' && styles.typeButtonActive)}
                    onClick={() => setAddJobType('commits')}
                  >
                    <GitCommitHorizontal size={12} /> Commits
                  </button>
                  <button
                    type="button"
                    class={clsx(styles.typeButton, addJobType === 'source' && styles.typeButtonActive)}
                    onClick={() => setAddJobType('source')}
                  >
                    <Code size={12} /> Source
                  </button>
                </div>
              </div>
            )}
            <div class={styles.addField}>
              <label>Branch {branchesLoading && <span class={styles.branchLoading}>(detecting...)</span>}</label>
              {allBranches.length > 0 ? (
                <select
                  value={addBranch}
                  onChange={(e) => setAddBranch((e.target as HTMLSelectElement).value)}
                >
                  {localBranches.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                  {remoteBranches.length > 0 && (
                    <optgroup label="Remote">
                      {remoteBranches.map((b) => (
                        <option key={b} value={b}>{b}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              ) : (
                <input
                  type="text"
                  placeholder="main"
                  value={addBranch}
                  onInput={(e) => setAddBranch((e.target as HTMLInputElement).value)}
                />
              )}
            </div>
            <div class={styles.addField}>
              <label>Pacing <span class={styles.paceValue}>{(addDelay / 1000).toFixed(1)}s</span></label>
              <input
                type="range"
                min={500}
                max={3000}
                step={100}
                value={addDelay}
                onInput={(e) => setAddDelay(Number((e.target as HTMLInputElement).value))}
              />
            </div>
          </div>

          <button
            type="button"
            class={styles.saveButton}
            disabled={!addPath.trim() || addSaving}
            onClick={handleAdd}
          >
            {addSaving ? 'Saving...' : 'Add Config'}
          </button>
        </div>
      )}

      {loading ? (
        <div class={styles.empty}>Loading...</div>
      ) : repoGroups.length === 0 && !showAdd ? (
        <div class={styles.empty}>No auto-embed configs yet. Add one to start scheduling.</div>
      ) : (
        <div class={styles.repoList}>
          {repoGroups.map((group) => {
            const active = getActiveConfig(group)
            const anyEnabled = group.configs.some((c) => c.enabled)
            const isStale = !!active.last_error

            return (
              <div
                key={group.repoPath}
                class={clsx(styles.repoCard, !anyEnabled && styles.repoCardDisabled)}
              >
                {/* Repo header */}
                <div class={styles.repoHeader}>
                  <div class={styles.repoLeft}>
                    <button
                      type="button"
                      class={clsx(styles.toggle, anyEnabled && styles.toggleOn)}
                      onClick={(e) => handleRepoToggle(e, group)}
                      title={anyEnabled ? 'Disable all branches' : 'Enable all branches'}
                    />
                    <div class={styles.repoInfo}>
                      <div class={styles.repoName}>{group.repoName}</div>
                      <div class={styles.repoMeta}>
                        <span>{(active.batch_delay_ms / 1000).toFixed(1)}s pacing</span>
                        {active.last_run_at && (
                          <span>Last run: {formatTimeAgo(active.last_run_at)}</span>
                        )}
                        {active.last_commit_hash && (
                          <span title={active.last_commit_hash}>
                            {active.last_commit_hash.slice(0, 7)}
                          </span>
                        )}
                        {!active.last_run_at && <span>Never run</span>}
                        {!jobType && (
                          <span class={styles.configType}>{active.job_type}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div class={styles.repoRight}>
                    {group.configs.length > 1 && (
                      <span class={styles.deleteContext}>{active.branch}</span>
                    )}
                    <button
                      type="button"
                      class={styles.deleteButton}
                      title={group.configs.length <= 1 ? 'Remove repo' : `Remove ${active.branch}`}
                      onClick={(e) => handleDelete(e, group)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Branch tabs */}
                <div class={styles.branchBar}>
                  {group.configs.map((config) => {
                    const isActive = config.id === active.id
                    const hasError = !!config.last_error
                    return (
                      <button
                        key={config.id}
                        type="button"
                        class={clsx(styles.branchTab, isActive && styles.branchTabActive)}
                        onClick={() =>
                          setActiveBranch((prev) => ({ ...prev, [group.repoPath]: config.id }))
                        }
                      >
                        <span
                          class={clsx(styles.branchDot, hasError && styles.branchDotStale)}
                        />
                        {config.branch}
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    class={styles.addBranchBtn}
                    title="Add branch"
                    onClick={() =>
                      addingBranchRepo === group.repoPath
                        ? setAddingBranchRepo(null)
                        : handleStartAddBranch(group)
                    }
                  >
                    {addingBranchRepo === group.repoPath ? <X size={10} /> : '+'}
                  </button>
                </div>

                {/* Branch detail — shown when active branch has an error */}
                {isStale && (
                  <div class={styles.branchDetail}>
                    {active.last_run_at && (
                      <span>Last run: {formatTimeAgo(active.last_run_at)}</span>
                    )}
                    {active.last_commit_hash && (
                      <span>{active.last_commit_hash.slice(0, 7)}</span>
                    )}
                    <span class={styles.staleNote}>branch not found</span>
                  </div>
                )}

                {/* Add branch inline form */}
                {addingBranchRepo === group.repoPath && (
                  <div class={styles.addBranchForm}>
                    {addBranchLoading ? (
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>
                        Detecting branches...
                      </span>
                    ) : addBranchOptions.length > 0 ? (
                      <select
                        value={addBranchValue}
                        onChange={(e) =>
                          setAddBranchValue((e.target as HTMLSelectElement).value)
                        }
                      >
                        {addBranchOptions.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        placeholder="branch name"
                        value={addBranchValue}
                        onInput={(e) =>
                          setAddBranchValue((e.target as HTMLInputElement).value)
                        }
                      />
                    )}
                    <button
                      type="button"
                      class={styles.addBranchSave}
                      disabled={!addBranchValue.trim() || addBranchSaving}
                      onClick={() => handleSaveAddBranch(group)}
                    >
                      <Check size={10} />
                      {addBranchSaving ? 'Adding...' : 'Add'}
                    </button>
                    <button
                      type="button"
                      class={styles.addBranchCancel}
                      onClick={() => setAddingBranchRepo(null)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
