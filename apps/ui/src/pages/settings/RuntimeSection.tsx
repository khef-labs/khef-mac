import { useState, useEffect, useCallback } from 'preact/hooks'
import { getSettingsRuntime } from '../../lib/api'
import type { SettingsRuntimeResponse } from '../../types'
import shared from './SettingsShared.module.css'
import styles from './RuntimeSection.module.css'

function parseSizeToBytes(size: string | null | undefined): number | null {
  if (!size) return null
  const normalized = size.trim().toUpperCase().replace(/\s+/g, '')
  const match = normalized.match(/^([\d.]+)(B|KB|MB|GB|TB|PB)$/)
  if (!match) return null
  const value = Number.parseFloat(match[1])
  if (!Number.isFinite(value)) return null
  const multipliers: Record<string, number> = {
    B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5,
  }
  return Math.round(value * multipliers[match[2]])
}

export function RuntimeSection() {
  const [runtimeStatus, setRuntimeStatus] = useState<SettingsRuntimeResponse | null>(null)
  const [runtimeLoading, setRuntimeLoading] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)

  const fetchRuntimeStatus = useCallback(async () => {
    setRuntimeLoading(true)
    setRuntimeError(null)
    try {
      const status = await getSettingsRuntime()
      setRuntimeStatus(status)
    } catch (err: any) {
      setRuntimeStatus(null)
      setRuntimeError(err.message || 'Failed to load runtime status')
    } finally {
      setRuntimeLoading(false)
    }
  }, [])

  useEffect(() => { fetchRuntimeStatus() }, [fetchRuntimeStatus])

  return (
    <div class={shared.section}>
      <p class={shared.description}>
        Active local ports and Docker resources currently used by Khef.
      </p>
      <div class={shared.field}>
        <div class={shared.actions}>
          <button
            type="button"
            class={shared.syncButton}
            onClick={fetchRuntimeStatus}
            disabled={runtimeLoading}
          >
            {runtimeLoading ? 'Refreshing runtime...' : 'Refresh runtime'}
          </button>
          {runtimeStatus?.generated_at && (
            <span class={shared.shortcutHint}>
              Updated: {new Date(runtimeStatus.generated_at).toLocaleTimeString()}
            </span>
          )}
        </div>
        {runtimeError && <p class={shared.error}>{runtimeError}</p>}
      </div>

      <div class={shared.field}>
        <label class={shared.label}>Active Ports</label>
        {runtimeStatus && runtimeStatus.ports.length > 0 ? (
          <div class={styles.runtimeList}>
            {runtimeStatus.ports.map((port) => (
              <div key={`${port.host}:${port.host_port}-${port.protocol}-${port.service}`} class={styles.runtimeItem}>
                <div class={styles.runtimePrimary}>
                  <code>{port.host}:{port.host_port}</code>
                  <span>{port.service}</span>
                </div>
                <div class={styles.runtimeMeta}>
                  <span>{port.source}</span>
                  <span>{port.protocol}</span>
                  {port.container_name && port.container_port && (
                    <span>{port.container_name}:{port.container_port}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p class={shared.description}>No active Khef ports detected.</p>
        )}
      </div>

      <div class={shared.field}>
        <label class={shared.label}>Docker Containers</label>
        {!runtimeStatus?.docker.available ? (
          <p class={shared.description}>
            Docker unavailable{runtimeStatus?.docker.error ? `: ${runtimeStatus.docker.error}` : '.'}
          </p>
        ) : runtimeStatus.docker.containers.length === 0 ? (
          <p class={shared.description}>No running Khef containers detected.</p>
        ) : (
          <div class={styles.runtimeList}>
            {runtimeStatus.docker.containers.map((container) => (
              <div key={container.id || container.name} class={styles.runtimeItem}>
                <div class={styles.runtimePrimary}>
                  <code>{container.name}</code>
                  <span>{container.image}</span>
                </div>
                <div class={styles.runtimeMeta}>
                  <span>{container.status}</span>
                  {container.ports && <span>{container.ports}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div class={shared.field}>
        <label class={shared.label}>Docker Images</label>
        {!runtimeStatus?.docker.available ? (
          <p class={shared.description}>Docker image data unavailable.</p>
        ) : runtimeStatus.docker.images.length === 0 ? (
          <p class={shared.description}>No Khef images detected from Docker.</p>
        ) : (
          <div class={styles.runtimeList}>
            {[...runtimeStatus.docker.images]
              .sort((a, b) => {
                const aSize = parseSizeToBytes(a.size) ?? -1
                const bSize = parseSizeToBytes(b.size) ?? -1
                if (aSize !== bSize) return bSize - aSize
                return `${a.repository}:${a.tag}`.localeCompare(`${b.repository}:${b.tag}`)
              })
              .map((image) => (
                <div key={`${image.repository}:${image.tag}`} class={styles.runtimeItem}>
                  <div class={styles.runtimePrimary}>
                    <code>{image.repository}:{image.tag}</code>
                    <span>{image.size}</span>
                  </div>
                  <div class={styles.runtimeMeta}>
                    <span>{image.created_since}</span>
                    <span>{image.in_use ? 'in use' : 'installed'}</span>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>

      <div class={shared.field}>
        <label class={shared.label}>Docker Volumes</label>
        {!runtimeStatus?.docker.available ? (
          <p class={shared.description}>Docker volume data unavailable.</p>
        ) : runtimeStatus.docker.volumes.length === 0 ? (
          <p class={shared.description}>No attached volumes detected.</p>
        ) : (
          <div class={styles.runtimeList}>
            {[...runtimeStatus.docker.volumes]
              .sort((a, b) => {
                const aSize = a.size_bytes ?? -1
                const bSize = b.size_bytes ?? -1
                if (aSize !== bSize) return bSize - aSize
                return a.name.localeCompare(b.name)
              })
              .map((volume) => (
                <div key={`${volume.type}:${volume.name}:${volume.destination}`} class={styles.runtimeItem}>
                  <div class={styles.runtimePrimary}>
                    <code>{volume.name}</code>
                    <span>{volume.size || 'size unavailable'}</span>
                  </div>
                  <div class={styles.runtimeMeta}>
                    <span>{volume.type}</span>
                    <span>{volume.destination}</span>
                    {volume.driver && <span>{volume.driver}</span>}
                    {volume.containers.length > 0 && (
                      <span>attached: {volume.containers.join(', ')}</span>
                    )}
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>

      <div class={shared.field}>
        <label class={shared.label}>Hugging Face Models</label>
        {!runtimeStatus ? (
          <p class={shared.description}>Loading Hugging Face cache data...</p>
        ) : (
          <>
            <div class={styles.runtimeMeta}>
              <span>embed server: {runtimeStatus.huggingface.embed_server_available ? 'available' : 'unavailable'}</span>
              {runtimeStatus.huggingface.active_model && (
                <span>active model: {runtimeStatus.huggingface.active_model}</span>
              )}
              {runtimeStatus.huggingface.dimensions && (
                <span>{runtimeStatus.huggingface.dimensions} dims</span>
              )}
            </div>
            <p class={shared.description}>
              Cache: <code>{runtimeStatus.huggingface.cache_dir}</code>{' '}
              ({runtimeStatus.huggingface.cache_size || 'size unavailable'})
            </p>
            {!runtimeStatus.huggingface.cache_exists ? (
              <p class={shared.description}>Hugging Face cache folder not found.</p>
            ) : runtimeStatus.huggingface.models.length === 0 ? (
              <p class={shared.description}>No cached Hugging Face models detected.</p>
            ) : (
              <div class={styles.runtimeList}>
                {runtimeStatus.huggingface.models.map((model) => (
                  <div key={model.cache_path} class={styles.runtimeItem}>
                    <div class={styles.runtimePrimary}>
                      <code>{model.model}</code>
                      <span>{model.size || 'size unavailable'}</span>
                    </div>
                    <div class={styles.runtimeMeta}>
                      <span>{model.cache_path}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
