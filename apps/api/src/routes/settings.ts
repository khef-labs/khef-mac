import { FastifyPluginAsync } from 'fastify';
import { execFile } from 'child_process';
import { readdir } from 'node:fs/promises';
import * as net from 'net';
import * as os from 'os';
import { join } from 'node:path';
import { promisify } from 'util';
import { query } from '../db/client';
import { isPlaywrightAvailable } from '../services/diagram';
import { checkEmbedServerHealth } from '../services/kvec-embed-worker';
import { reloadConcurrency, invalidateAllowedToolsCache } from '../services/kdag-executor';

const execFileAsync = promisify(execFile);

interface Setting {
  key: string;
  value: string;
  description: string | null;
  value_type: string;
  created_at: string;
  updated_at: string;
}

// Settings that should not be exposed via API (internal/server-side only)
const HIDDEN_SETTINGS = new Set<string>([]);

interface RuntimePort {
  service: string;
  host: string;
  host_port: number;
  protocol: 'tcp' | 'udp';
  source: 'host' | 'docker';
  container_name?: string;
  container_port?: number;
}

interface RuntimeContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
  labels: string;
}

interface RuntimeImage {
  repository: string;
  tag: string;
  id: string;
  created_since: string;
  size: string;
  in_use: boolean;
}

interface RuntimeVolume {
  name: string;
  type: string;
  source: string;
  destination: string;
  driver: string | null;
  size: string | null;
  size_bytes: number | null;
  containers: string[];
}

interface RuntimeVolumeMountRef {
  container_name: string;
  destination: string;
}

interface RuntimeHuggingFaceModel {
  model: string;
  cache_path: string;
  size: string | null;
  size_bytes: number | null;
}

interface RuntimeHuggingFaceStatus {
  embed_server_available: boolean;
  active_model: string | null;
  dimensions: number | null;
  cache_dir: string;
  cache_exists: boolean;
  cache_size: string | null;
  cache_size_bytes: number | null;
  models: RuntimeHuggingFaceModel[];
}

const KHEF_IMAGE_REFERENCES = new Set([
  'pgvector/pgvector:pg17',
  'yuzutech/kroki:latest',
  'yuzutech/kroki-mermaid:latest',
]);

function normalizeHost(host: string): string {
  if (host === '0.0.0.0' || host === '[::]' || host === '::') return '127.0.0.1';
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

async function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeoutMs = 300;
    const targetHost = normalizeHost(host);

    const done = (result: boolean) => {
      if (!socket.destroyed) socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, targetHost);
  });
}

function parseDockerPortMappings(ports: string, containerName: string): RuntimePort[] {
  const mappings: RuntimePort[] = [];
  const parts = ports.split(',').map((part) => part.trim()).filter(Boolean);

  for (const part of parts) {
    const match = part.match(/(?:(\[.*?\]|[^:]+):)?(\d+)->(\d+)\/(tcp|udp)/);
    if (!match) continue;

    const host = match[1] || '127.0.0.1';
    const hostPort = Number.parseInt(match[2], 10);
    const containerPort = Number.parseInt(match[3], 10);
    const protocol = match[4] as 'tcp' | 'udp';
    if (!Number.isFinite(hostPort) || !Number.isFinite(containerPort)) continue;

    mappings.push({
      service: containerName,
      host,
      host_port: hostPort,
      protocol,
      source: 'docker',
      container_name: containerName,
      container_port: containerPort,
    });
  }

  return mappings;
}

function parseDockerJsonLines(stdout: string): Array<Record<string, any>> {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, any>;
      } catch {
        return {};
      }
    });
}

function parseSizeToBytes(size: string | undefined): number | null {
  if (!size) return null;
  const normalized = size.trim().toUpperCase().replace(/\s+/g, '');
  const match = normalized.match(/^([\d.]+)(B|KB|MB|GB|TB|PB)$/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2];
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
    PB: 1024 ** 5,
  };
  return Math.round(value * multipliers[unit]);
}

async function getDockerVolumeSizeMap(): Promise<Map<string, { size: string; size_bytes: number | null }>> {
  const sizeMap = new Map<string, { size: string; size_bytes: number | null }>();
  try {
    const { stdout } = await execFileAsync('docker', [
      'system',
      'df',
      '-v',
      '--format',
      '{{json .}}',
    ]);
    const rows = parseDockerJsonLines(stdout);
    for (const row of rows) {
      const name = row.Name || row['VOLUME NAME'] || '';
      const size = row.Size || row.SIZE || '';
      if (!name || !size) continue;
      sizeMap.set(name, { size, size_bytes: parseSizeToBytes(size) });
    }
  } catch {
    // Best-effort only
  }
  return sizeMap;
}

async function getPathSize(path: string): Promise<{ size: string; size_bytes: number | null } | null> {
  try {
    const { stdout } = await execFileAsync('du', ['-sk', path], { timeout: 5000 });
    const kibStr = stdout.trim().split(/\s+/)[0];
    const kib = Number.parseInt(kibStr, 10);
    if (!Number.isFinite(kib) || kib < 0) return null;
    const bytes = kib * 1024;
    return { size: formatBytes(bytes), size_bytes: bytes };
  } catch {
    return null;
  }
}

function getHuggingFaceCacheDir(): string {
  const hfHome = process.env.HF_HOME;
  if (hfHome) return join(hfHome, 'hub');
  const xdgCacheHome = process.env.XDG_CACHE_HOME;
  if (xdgCacheHome) return join(xdgCacheHome, 'huggingface', 'hub');
  return join(os.homedir(), '.cache', 'huggingface', 'hub');
}

function decodeModelName(cacheFolderName: string): string {
  return cacheFolderName.replace(/^models--/, '').replace(/--/g, '/');
}

async function getHuggingFaceStatus(): Promise<RuntimeHuggingFaceStatus> {
  const embedHealth = await checkEmbedServerHealth();
  const cacheDir = getHuggingFaceCacheDir();

  let cacheExists = false;
  let cacheSize: string | null = null;
  let cacheSizeBytes: number | null = null;
  let models: RuntimeHuggingFaceModel[] = [];

  try {
    const entries = await readdir(cacheDir, { withFileTypes: true });
    cacheExists = true;
    const cacheSizeResult = await getPathSize(cacheDir);
    cacheSize = cacheSizeResult?.size ?? null;
    cacheSizeBytes = cacheSizeResult?.size_bytes ?? null;

    const modelDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('models--'))
      .map((entry) => entry.name);
    const modelRows = await Promise.all(
      modelDirs.map(async (modelDir) => {
        const fullPath = join(cacheDir, modelDir);
        const sizeInfo = await getPathSize(fullPath);
        return {
          model: decodeModelName(modelDir),
          cache_path: fullPath,
          size: sizeInfo?.size ?? null,
          size_bytes: sizeInfo?.size_bytes ?? null,
        } satisfies RuntimeHuggingFaceModel;
      })
    );
    models = modelRows.sort((a, b) => {
      const aSize = a.size_bytes ?? -1;
      const bSize = b.size_bytes ?? -1;
      if (aSize !== bSize) return bSize - aSize;
      return a.model.localeCompare(b.model);
    });
  } catch {
    cacheExists = false;
  }

  return {
    embed_server_available: embedHealth.available,
    active_model: embedHealth.model ?? null,
    dimensions: embedHealth.dimensions ?? null,
    cache_dir: cacheDir,
    cache_exists: cacheExists,
    cache_size: cacheSize,
    cache_size_bytes: cacheSizeBytes,
    models,
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

async function getVolumeSizeFromContainer(
  containerName: string,
  destination: string
): Promise<{ size: string; size_bytes: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['exec', containerName, 'sh', '-lc', `du -sk ${JSON.stringify(destination)} 2>/dev/null | awk '{print $1}'`],
      { timeout: 3000 }
    );
    const kib = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(kib) || kib < 0) return null;
    const bytes = kib * 1024;
    return {
      size: formatBytes(bytes),
      size_bytes: bytes,
    };
  } catch {
    return null;
  }
}

function getConfiguredHostPorts(): RuntimePort[] {
  const apiPort = Number.parseInt(process.env.PORT || '3100', 10);
  const uiPort = Number.parseInt(process.env.UI_PORT || '5174', 10);
  const postgresPort = Number.parseInt(process.env.POSTGRES_PORT || '5532', 10);
  const krokiPort = Number.parseInt(process.env.KROKI_PORT || '8100', 10);
  const testPostgresPort = Number.parseInt(process.env.TEST_POSTGRES_PORT || '5434', 10);

  const candidatePorts: RuntimePort[] = [
    { service: 'API', host: process.env.HOST || '127.0.0.1', host_port: apiPort, protocol: 'tcp', source: 'host' },
    { service: 'UI', host: '127.0.0.1', host_port: uiPort, protocol: 'tcp', source: 'host' },
    { service: 'Postgres', host: '127.0.0.1', host_port: postgresPort, protocol: 'tcp', source: 'host' },
    { service: 'Kroki', host: '127.0.0.1', host_port: krokiPort, protocol: 'tcp', source: 'host' },
    { service: 'Test Postgres', host: '127.0.0.1', host_port: testPostgresPort, protocol: 'tcp', source: 'host' },
  ];

  return candidatePorts.filter((entry) => Number.isFinite(entry.host_port));
}

const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/settings/export - Export-related settings and capabilities
  fastify.get('/export', async () => {
    const rows = await query<Setting>(
      "SELECT key, value, description, value_type FROM settings WHERE key IN ('export.imageTheme', 'export.diagramScale', 'export.pngRenderScale', 'export.pngDisplayScalePercent')"
    );

    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }

    const pngRenderEnabled =
      (process.env.PNG_RENDERING_ENABLED || '').toLowerCase() !== 'false';
    const playwrightAvailable = isPlaywrightAvailable();

    return {
      export: {
        imageTheme: {
          value: settings['export.imageTheme'],
          options: ['dark', 'light', 'neutral', 'forest', 'ocean'],
        },
        diagramScale: {
          value: settings['export.diagramScale'],
          min: 1,
          max: 4,
          legacy: true,
        },
        pngRenderScale: {
          value: settings['export.pngRenderScale'],
          min: 1,
          max: 4,
        },
        pngDisplayScalePercent: {
          value: settings['export.pngDisplayScalePercent'],
          min: 10,
          max: 300,
        },
      },
      flags: {
        pngRenderPlaywrightEnabled: pngRenderEnabled,
        pngRenderPlaywrightAvailable: playwrightAvailable,
      },
      highQualityImageRenderingAvailable:
        pngRenderEnabled && playwrightAvailable,
    };
  });

  // GET /api/settings/runtime - Runtime status (ports + Docker containers/images)
  fastify.get('/runtime', async () => {
    const configuredPorts = getConfiguredHostPorts();
    let dockerAvailable = false;
    let dockerError: string | undefined;
    let containers: RuntimeContainer[] = [];
    let images: RuntimeImage[] = [];
    let volumes: RuntimeVolume[] = [];
    let dockerMappedPorts: RuntimePort[] = [];
    const huggingface = await getHuggingFaceStatus();

    try {
      const psResult = await execFileAsync('docker', [
        'ps',
        '--format',
        '{{json .}}',
      ]);
      dockerAvailable = true;
      const rows = parseDockerJsonLines(psResult.stdout);
      containers = rows
        .map((row) => ({
          id: row.ID || '',
          name: row.Names || '',
          image: row.Image || '',
          status: row.Status || '',
          ports: row.Ports || '',
          labels: row.Labels || '',
        }))
        .filter((row) => {
          const lowerName = row.name.toLowerCase();
          const labels = row.labels.toLowerCase();
          return (
            lowerName.includes('khef') ||
            labels.includes('com.docker.compose.project=khef') ||
            labels.includes('com.docker.compose.project=khef-test') ||
            labels.includes('com.docker.compose.project=khef-desktop')
          );
        });

      dockerMappedPorts = containers.flatMap((container) =>
        parseDockerPortMappings(container.ports, container.name)
      );

      const imageRows = parseDockerJsonLines(
        (await execFileAsync('docker', ['images', '--format', '{{json .}}'])).stdout
      );
      const imagesInUse = new Set(containers.map((container) => container.image));
      images = imageRows
        .map((row) => {
          const repository = row.Repository || '';
          const tag = row.Tag || '';
          return {
            repository,
            tag,
            id: row.ID || '',
            created_since: row.CreatedSince || '',
            size: row.Size || '',
            in_use: imagesInUse.has(`${repository}:${tag}`) || imagesInUse.has(repository),
          };
        })
        .filter((row) =>
          imagesInUse.has(`${row.repository}:${row.tag}`) ||
          imagesInUse.has(row.repository) ||
          KHEF_IMAGE_REFERENCES.has(`${row.repository}:${row.tag}`)
        );

      const volumeSizeMap = await getDockerVolumeSizeMap();
      const containerIds = containers.map((container) => container.id).filter(Boolean);
      const volumeMountRefs = new Map<string, RuntimeVolumeMountRef[]>();
      if (containerIds.length > 0) {
        const inspectRows = parseDockerJsonLines(
          (await execFileAsync('docker', ['inspect', ...containerIds, '--format', '{{json .}}'])).stdout
        );
        const byKey = new Map<string, RuntimeVolume>();

        for (const row of inspectRows) {
          const containerName = String(row.Name || '').replace(/^\//, '') || String(row.Id || '').slice(0, 12);
          const mountsRaw = row.Mounts;
          const mounts = Array.isArray(mountsRaw) ? mountsRaw : [];
          for (const mount of mounts) {
            const mountType = String(mount?.Type || '');
            const source = String(mount?.Source || '');
            const destination = String(mount?.Destination || '');
            const driver = mount?.Driver ? String(mount.Driver) : null;
            const name = String(mount?.Name || source || destination);
            if (!name) continue;

            if (mountType === 'volume' && destination && containerName) {
              const refs = volumeMountRefs.get(name) ?? [];
              if (!refs.some((ref) => ref.container_name === containerName && ref.destination === destination)) {
                refs.push({ container_name: containerName, destination });
                volumeMountRefs.set(name, refs);
              }
            }

            const key = `${mountType}:${name}:${destination}`;
            const sizeInfo = mountType === 'volume' ? volumeSizeMap.get(name) : undefined;
            const existing = byKey.get(key);
            if (existing) {
              if (!existing.containers.includes(containerName)) {
                existing.containers.push(containerName);
              }
              continue;
            }

            byKey.set(key, {
              name,
              type: mountType || 'unknown',
              source,
              destination,
              driver,
              size: sizeInfo?.size ?? null,
              size_bytes: sizeInfo?.size_bytes ?? null,
              containers: containerName ? [containerName] : [],
            });
          }
        }

        volumes = Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name));

        // Fallback: if Docker did not provide named-volume size, estimate with `du` inside an attached container.
        for (const volume of volumes) {
          if (volume.type !== 'volume' || volume.size !== null) continue;
          const refs = volumeMountRefs.get(volume.name) ?? [];
          for (const ref of refs) {
            const measured = await getVolumeSizeFromContainer(ref.container_name, ref.destination);
            if (measured) {
              volume.size = measured.size;
              volume.size_bytes = measured.size_bytes;
              break;
            }
          }
        }
      }
    } catch (error: any) {
      dockerAvailable = false;
      dockerError = error?.message || 'Failed to query Docker';
    }

    const activePorts: RuntimePort[] = [];
    const seen = new Set<string>();
    for (const port of [...configuredPorts, ...dockerMappedPorts]) {
      const key = `${port.host}:${port.host_port}/${port.protocol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (await isPortOpen(port.host, port.host_port)) {
        activePorts.push(port);
      }
    }

    return {
      generated_at: new Date().toISOString(),
      ports: activePorts.sort((a, b) => a.host_port - b.host_port),
      docker: {
        available: dockerAvailable,
        error: dockerError,
        containers,
        images,
        volumes,
      },
      huggingface,
    };
  });

  // GET /api/settings - Get all settings as key-value object
  fastify.get('/', async () => {
    const rows = await query<Setting>(
      'SELECT key, value, description, value_type FROM settings ORDER BY key'
    );

    const settings: Record<string, string> = {};
    const metadata: Record<string, { description: string | null; value_type: string }> = {};

    for (const row of rows) {
      // Skip hidden/internal settings
      if (HIDDEN_SETTINGS.has(row.key)) continue;

      settings[row.key] = row.value;
      metadata[row.key] = {
        description: row.description,
        value_type: row.value_type,
      };
    }

    return {
      settings,
      metadata,
    };
  });

  // PATCH /api/settings - Update one or more settings
  fastify.patch('/', async (request, reply) => {
    const updates = request.body as Record<string, string>;

    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return reply.code(400).send({ error: 'Request body must be an object of key-value pairs' });
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) {
      return reply.code(400).send({ error: 'No settings provided to update' });
    }

    // Block updates to hidden settings
    const hiddenKeys = keys.filter((key) => HIDDEN_SETTINGS.has(key));
    if (hiddenKeys.length > 0) {
      return reply.code(400).send({
        error: 'Cannot update internal settings via API',
        invalid_keys: hiddenKeys,
      });
    }

    // Validate that all keys exist
    const existingKeys = await query<{ key: string }>(
      'SELECT key FROM settings WHERE key = ANY($1)',
      [keys]
    );

    const existingKeySet = new Set(existingKeys.map((row) => row.key));
    const invalidKeys = keys.filter((key) => !existingKeySet.has(key));

    if (invalidKeys.length > 0) {
      return reply.code(400).send({
        error: 'Unknown settings keys',
        invalid_keys: invalidKeys,
      });
    }

    // Update each setting
    for (const [key, value] of Object.entries(updates)) {
      await query(
        'UPDATE settings SET value = $1, updated_at = NOW() WHERE key = $2',
        [String(value), key]
      );
    }

    // Reload kdag concurrency if it was changed
    if ('kdag.maxConcurrency' in updates) {
      await reloadConcurrency();
    }

    // Invalidate kdag allowed tools cache if changed
    if ('kdag.allowedTools' in updates) {
      invalidateAllowedToolsCache();
    }

    // Return updated settings (excluding hidden)
    const rows = await query<Setting>(
      'SELECT key, value, description, value_type FROM settings ORDER BY key'
    );

    const settings: Record<string, string> = {};
    const metadata: Record<string, { description: string | null; value_type: string }> = {};

    for (const row of rows) {
      if (HIDDEN_SETTINGS.has(row.key)) continue;

      settings[row.key] = row.value;
      metadata[row.key] = {
        description: row.description,
        value_type: row.value_type,
      };
    }

    return { settings, metadata };
  });
};

export default settingsRoutes;
