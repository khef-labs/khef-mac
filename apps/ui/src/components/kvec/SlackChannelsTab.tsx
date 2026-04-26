import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import { RefreshCw, Loader, Check, AlertTriangle, Hash, Plus, X, Pencil } from 'lucide-preact'
import { listRegisteredSlackChannels, syncSlackChannel, registerSlackChannel, updateSlackChannel, getKdagJob } from '../../lib/api'
import type { SlackChannel, KvecCollection } from '../../types'
import { formatTimeAgo } from './kvec-utils'
import styles from './SlackChannelsTab.module.css'

interface SyncState {
  status: 'running' | 'completed' | 'failed'
  jobId: string
  error?: string | null
}

interface Props {
  onCollectionRefresh: (collection: KvecCollection) => void
}

const CHANNEL_TYPES = ['channel', 'dm', 'group', 'mpim'] as const

export function SlackChannelsTab({ onCollectionRefresh: _onCollectionRefresh }: Props) {
  const [channels, setChannels] = useState<SlackChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [syncStates, setSyncStates] = useState<Record<string, SyncState>>({})
  const [showForm, setShowForm] = useState(false)
  const [editingChannel, setEditingChannel] = useState<SlackChannel | null>(null)
  const [registering, setRegistering] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [formFields, setFormFields] = useState({
    channel_id: '',
    workspace_id: '',
    channel_name: '',
    workspace_name: '',
    channel_type: 'channel',
    export_path: '',
  })
  const pollRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({})

  const loadChannels = useCallback(() => {
    listRegisteredSlackChannels()
      .then((data) => setChannels(data.channels))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    let mounted = true
    listRegisteredSlackChannels()
      .then((data) => {
        if (mounted) setChannels(data.channels)
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => { mounted = false }
  }, [])

  // Clean up polls on unmount
  useEffect(() => {
    const refs = pollRefs.current
    return () => {
      for (const id of Object.keys(refs)) {
        clearInterval(refs[id])
      }
    }
  }, [])

  const startPolling = useCallback((channelId: string, jobId: string) => {
    // Clear existing poll for this channel
    if (pollRefs.current[channelId]) {
      clearInterval(pollRefs.current[channelId])
    }

    pollRefs.current[channelId] = setInterval(async () => {
      try {
        const data = await getKdagJob(jobId)
        // Status lives on the latest run, not the job itself
        const latestRun = data.runs.length > 0 ? data.runs[data.runs.length - 1] : null
        const status = latestRun?.status
        if (status === 'completed' || status === 'failed') {
          clearInterval(pollRefs.current[channelId])
          delete pollRefs.current[channelId]
          setSyncStates(prev => ({
            ...prev,
            [channelId]: {
              status: status as 'completed' | 'failed',
              jobId,
              error: latestRun?.error || null,
            },
          }))
          // Refresh channel list to get updated last_exported_at
          if (status === 'completed') {
            loadChannels()
          }
        }
      } catch {
        // Poll failed, keep trying
      }
    }, 3000)
  }, [loadChannels])

  const handleSync = useCallback(async (channel: SlackChannel) => {
    setSyncStates(prev => ({
      ...prev,
      [channel.id]: { status: 'running', jobId: '' },
    }))

    try {
      const result = await syncSlackChannel(channel.id)
      setSyncStates(prev => ({
        ...prev,
        [channel.id]: { status: 'running', jobId: result.job_id },
      }))
      startPolling(channel.id, result.job_id)
    } catch (err: any) {
      setSyncStates(prev => ({
        ...prev,
        [channel.id]: { status: 'failed', jobId: '', error: err?.message || 'Failed to start sync' },
      }))
    }
  }, [startPolling])

  const closeForm = () => {
    setShowForm(false)
    setEditingChannel(null)
    setFormError(null)
    setFormFields({ channel_id: '', workspace_id: '', channel_name: '', workspace_name: '', channel_type: 'channel', export_path: '' })
  }

  const handleEdit = (ch: SlackChannel) => {
    setEditingChannel(ch)
    setFormFields({
      channel_id: ch.channel_id,
      workspace_id: ch.workspace_id,
      channel_name: ch.channel_name,
      workspace_name: ch.workspace_name || '',
      channel_type: ch.channel_type || 'channel',
      export_path: ch.export_path || '',
    })
    setFormError(null)
    setShowForm(true)
  }

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    setFormError(null)

    const { channel_name } = formFields
    if (!channel_name.trim()) {
      setFormError('Channel Name is required')
      return
    }

    if (editingChannel) {
      // Edit mode — PATCH only editable fields
      setRegistering(true)
      try {
        const body: Parameters<typeof updateSlackChannel>[1] = {}
        if (formFields.channel_name.trim() !== editingChannel.channel_name) body.channel_name = formFields.channel_name.trim()
        if (formFields.workspace_name.trim() !== (editingChannel.workspace_name || '')) body.workspace_name = formFields.workspace_name.trim()
        if (formFields.channel_type !== editingChannel.channel_type) body.channel_type = formFields.channel_type
        if (formFields.export_path.trim() !== (editingChannel.export_path || '')) body.export_path = formFields.export_path.trim()

        if (Object.keys(body).length === 0) {
          closeForm()
          return
        }

        await updateSlackChannel(editingChannel.id, body)
        loadChannels()
        closeForm()
      } catch (err: any) {
        setFormError(err?.message || 'Failed to update channel')
      } finally {
        setRegistering(false)
      }
      return
    }

    // Register mode
    const { channel_id, workspace_id } = formFields
    if (!channel_id.trim() || !workspace_id.trim()) {
      setFormError('Channel ID, Workspace ID, and Channel Name are required')
      return
    }

    setRegistering(true)
    try {
      const body: Parameters<typeof registerSlackChannel>[0] = {
        channel_id: channel_id.trim(),
        workspace_id: workspace_id.trim(),
        channel_name: channel_name.trim(),
      }
      if (formFields.workspace_name.trim()) body.workspace_name = formFields.workspace_name.trim()
      if (formFields.channel_type) body.channel_type = formFields.channel_type
      if (formFields.export_path.trim()) body.export_path = formFields.export_path.trim()

      await registerSlackChannel(body)
      loadChannels()
      closeForm()
    } catch (err: any) {
      setFormError(err?.message || 'Failed to register channel')
    } finally {
      setRegistering(false)
    }
  }

  const updateField = (field: string) => (e: Event) => {
    setFormFields(prev => ({ ...prev, [field]: (e.target as HTMLInputElement).value }))
  }

  if (loading) {
    return <div class={styles.loading}>Loading channels...</div>
  }

  const isEditing = !!editingChannel

  const channelForm = (
    <form class={styles.registerForm} onSubmit={handleSubmit}>
      <div class={styles.formHeader}>
        <span class={styles.formTitle}>{isEditing ? 'Edit Channel' : 'Register Channel'}</span>
        <button type="button" class={styles.closeButton} onClick={closeForm}>
          <X size={14} />
        </button>
      </div>

      {formError && <div class={styles.formError}>{formError}</div>}

      <div class={styles.formGrid}>
        <label class={styles.formField}>
          <span class={styles.fieldLabel}>Channel Name <span class={styles.required}>*</span></span>
          <input
            type="text"
            class={styles.input}
            value={formFields.channel_name}
            onInput={updateField('channel_name')}
            placeholder="general"
          />
        </label>
        <label class={styles.formField}>
          <span class={styles.fieldLabel}>Channel ID {!isEditing && <span class={styles.required}>*</span>}</span>
          <input
            type="text"
            class={styles.input}
            value={formFields.channel_id}
            onInput={updateField('channel_id')}
            placeholder="C01ABCDEF"
            disabled={isEditing}
          />
        </label>
        <label class={styles.formField}>
          <span class={styles.fieldLabel}>Workspace ID {!isEditing && <span class={styles.required}>*</span>}</span>
          <input
            type="text"
            class={styles.input}
            value={formFields.workspace_id}
            onInput={updateField('workspace_id')}
            placeholder="T01ABCDEF"
            disabled={isEditing}
          />
        </label>
        <label class={styles.formField}>
          <span class={styles.fieldLabel}>Workspace Name</span>
          <input
            type="text"
            class={styles.input}
            value={formFields.workspace_name}
            onInput={updateField('workspace_name')}
            placeholder="My Workspace"
          />
        </label>
        <label class={styles.formField}>
          <span class={styles.fieldLabel}>Type</span>
          <select class={styles.input} value={formFields.channel_type} onChange={updateField('channel_type')}>
            {CHANNEL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label class={styles.formField}>
          <span class={styles.fieldLabel}>Export Path</span>
          <input
            type="text"
            class={styles.input}
            value={formFields.export_path}
            onInput={updateField('export_path')}
            placeholder="/path/to/exports"
          />
        </label>
      </div>

      <div class={styles.formActions}>
        <button type="button" class={styles.cancelButton} onClick={closeForm}>
          Cancel
        </button>
        <button type="submit" class={styles.submitButton} disabled={registering}>
          {registering
            ? <><Loader size={12} class={styles.spinning} /> {isEditing ? 'Saving...' : 'Registering...'}</>
            : isEditing ? 'Save' : 'Register'
          }
        </button>
      </div>
    </form>
  )

  if (channels.length === 0 && !showForm) {
    return (
      <div class={styles.tabContent}>
        <div class={styles.empty}>
          <Hash size={32} class={styles.emptyIcon} />
          <div>No registered channels</div>
          <div class={styles.emptyHint}>Register a Slack channel to enable syncing and embedding.</div>
          <button type="button" class={styles.addButton} onClick={() => setShowForm(true)}>
            <Plus size={14} /> Register Channel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div class={styles.tabContent}>
      {showForm && channelForm}

      <div class={styles.toolbar}>
        <button type="button" class={styles.addButton} onClick={() => { if (showForm && !editingChannel) { closeForm() } else { closeForm(); setShowForm(true) } }}>
          <Plus size={14} /> Register Channel
        </button>
      </div>

      {channels.length > 0 && (
        <div class={styles.tableWrap}>
          <table class={styles.table}>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Workspace</th>
                <th class={styles.numCell}>Messages</th>
                <th class={styles.dateCell}>Last Exported</th>
                <th class={styles.actionCell} />
              </tr>
            </thead>
            <tbody>
              {channels.map((ch) => {
                const sync = syncStates[ch.id]
                return (
                  <tr key={ch.id}>
                    <td>
                      <span class={styles.channelName}>#{ch.channel_name}</span>
                      {ch.channel_type && ch.channel_type !== 'channel' && (
                        <span class={styles.channelType}>{ch.channel_type}</span>
                      )}
                    </td>
                    <td>{ch.workspace_name || ch.workspace_id}</td>
                    <td class={styles.numCell}>{ch.message_count}</td>
                    <td class={styles.dateCell}>
                      {ch.last_exported_at ? formatTimeAgo(ch.last_exported_at) : '—'}
                    </td>
                    <td class={styles.actionCell}>
                      <button
                        class={styles.editButton}
                        onClick={() => handleEdit(ch)}
                        title="Edit channel"
                      >
                        <Pencil size={12} />
                      </button>
                      {!sync && (
                        <button
                          class={styles.syncButton}
                          onClick={() => handleSync(ch)}
                          title="Sync this channel"
                        >
                          <RefreshCw size={12} />
                          Sync
                        </button>
                      )}
                      {sync?.status === 'running' && (
                        <span class={styles.statusRunning}>
                          <Loader size={12} class={styles.spinning} />
                          Syncing...
                        </span>
                      )}
                      {sync?.status === 'completed' && (
                        <span class={styles.statusDone}>
                          <Check size={12} />
                          Done
                        </span>
                      )}
                      {sync?.status === 'failed' && (
                        <span class={styles.statusFailed} title={sync.error || 'Sync failed'}>
                          <AlertTriangle size={12} />
                          Failed
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
