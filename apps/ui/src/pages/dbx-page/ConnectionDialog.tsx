import { useState } from 'preact/hooks'
import clsx from 'clsx'
import {
  createConnection, updateConnection, deleteConnection, testConnectionConfig,
  type DbxConnection,
} from '../../lib/dbx-api'
import { ConfirmModal } from '../../components/ui'
import styles from './DbxPage.module.css'

interface ConnectionDialogProps {
  existing: DbxConnection | null
  onClose: () => void
  onSaved: () => void
}

export function ConnectionDialog({ existing, onClose, onSaved }: ConnectionDialogProps) {
  const [name, setName] = useState(existing?.name || '')
  const [host, setHost] = useState(existing?.config?.host || 'localhost')
  const [port, setPort] = useState(existing?.config?.port ? String(existing.config.port) : '')
  const [database, setDatabase] = useState(existing?.config?.database || '')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [ssl, setSsl] = useState(existing?.options?.ssl || false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; version?: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testConnectionConfig({
        driver: 'postgres',
        config: { host, port: parseInt(port, 10) || 5432, database },
        credentials: username ? { username, password: password || undefined } : undefined,
        options: ssl ? { ssl: true } : undefined,
      })
      setTestResult(result)
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    if (!name || !database) return
    setSaving(true)
    try {
      const data = {
        name,
        config: { host, port: parseInt(port, 10) || 5432, database },
        credentials: username ? { username, password: password || undefined } : undefined,
        options: ssl ? { ssl: true } : {},
      }
      if (existing) {
        await updateConnection(existing.id, data)
      } else {
        await createConnection({ driver: 'postgres', ...data })
      }
      onSaved()
    } catch (err: any) {
      alert(err.message || 'Failed to save connection')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class={styles.dialogOverlay} onClick={onClose}>
      <div class={styles.dialog} onClick={e => e.stopPropagation()}>
        <div class={styles.dialogTitle}>{existing ? 'Edit Connection' : 'New Connection'}</div>

        <div class={styles.formGroup}>
          <label class={styles.formLabel}>Connection Name</label>
          <input class={styles.formInput} value={name} onInput={e => setName((e.target as HTMLInputElement).value)} placeholder="my-database" />
        </div>

        <div class={styles.formRow}>
          <div class={styles.formGroup}>
            <label class={styles.formLabel}>Host</label>
            <input class={styles.formInput} value={host} onInput={e => setHost((e.target as HTMLInputElement).value)} />
          </div>
          <div class={styles.formGroup} style={{ maxWidth: '100px' }}>
            <label class={styles.formLabel}>Port</label>
            <input class={styles.formInput} value={port} onInput={e => setPort((e.target as HTMLInputElement).value)} placeholder="5432" />
          </div>
        </div>

        <div class={styles.formGroup}>
          <label class={styles.formLabel}>Database</label>
          <input class={styles.formInput} value={database} onInput={e => setDatabase((e.target as HTMLInputElement).value)} placeholder="my_database" />
        </div>

        <div class={styles.formRow}>
          <div class={styles.formGroup}>
            <label class={styles.formLabel}>Username</label>
            <input class={styles.formInput} value={username} onInput={e => setUsername((e.target as HTMLInputElement).value)} placeholder="postgres" />
          </div>
          <div class={styles.formGroup}>
            <label class={styles.formLabel}>Password</label>
            <input class={styles.formInput} type="password" value={password} onInput={e => setPassword((e.target as HTMLInputElement).value)} />
          </div>
        </div>

        <div class={styles.formGroup} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input type="checkbox" id="ssl-toggle" checked={ssl} onChange={e => setSsl((e.target as HTMLInputElement).checked)} />
          <label htmlFor="ssl-toggle" style={{ fontSize: 'var(--text-sm)', color: 'var(--fg)', cursor: 'pointer' }}>Use SSL</label>
        </div>

        {testResult && (
          <div class={clsx(styles.testResult, testResult.ok ? styles.testSuccess : styles.testError)}>
            {testResult.ok ? `Connected: ${testResult.version?.split(' ').slice(0, 2).join(' ')}` : `Error: ${testResult.error}`}
          </div>
        )}

        <div class={styles.dialogActions}>
          {existing && !existing.is_builtin && (
            <button class={styles.btnDanger} onClick={() => setConfirmDelete(true)}>Delete</button>
          )}
          <button class={styles.btnSecondary} onClick={handleTest} disabled={testing}>
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          <div class={styles.spacer} />
          <button class={styles.btnSecondary} onClick={onClose}>Cancel</button>
          <button class={styles.btnPrimary} onClick={handleSave} disabled={saving || !name || !database}>
            {saving ? 'Saving...' : existing ? 'Save' : 'Create'}
          </button>
        </div>
      </div>

      {confirmDelete && existing && (
        <ConfirmModal
          title="Delete Connection"
          message={`Delete "${existing.name}"? All saved scripts linked to this connection will be unlinked.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={async () => {
            await deleteConnection(existing.id)
            setConfirmDelete(false)
            onSaved()
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}
