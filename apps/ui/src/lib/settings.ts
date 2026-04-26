import { getSettings as fetchSettings, updateSettings as patchSettings } from './api'
import type { SettingsResponse, SettingsMetadata } from './api'

export interface Settings {
  layout: {
    pageWidth: number
    boardMaxWidth: number
  }
  diagram: {
    defaultMaxWidth: number
  }
  files: {
    storagePath: string
    maxSizeMb: number
  }
  vector: {
    enabled: boolean
  }
  backup: {
    location: string
  }
  drive: {
    syncFolder: string
  }
  gemini: {
    project: string
    location: string
    defaultModel: string
    models: Array<{ id: string; label: string }>
    accounts: string[]
    vertexAccount: string
    driveAccount: string
  }
  desktop: {
    active: boolean
  }
  slack: {
    exportDir: string
  }
  sessions: {
    backupPath: string
    backupEnabled: boolean
    backupIntervalMinutes: number
  }
  kdag: {
    maxConcurrency: number
    allowedTools: string[]
    definitions: {
      hidden: string[]
    }
  }
  chat: {
    claudeAllowedTools: string[]
  }
  export: {
    imageTheme: string
    diagramScale: number
    pngRenderScale: number
    pngDisplayScalePercent: number
    highQualityRendering: boolean
  }
  nicknames: {
    preferred: string[]
    staleDays: number
    minLength: number
    maxLength: number
  }
  projects: {
    hidden: string[]
  }
  memory: {
    watchEnabled: boolean
    itermWarnBytes: number
  }
  sessionContext: {
    watchEnabled: boolean
    tiers: Array<{ threshold: number; severity: 'info' | 'warning' | 'error' }>
  }
  editor: {
    scratchHome: string
    scratchDrawer: {
      enabled: boolean
    }
  }
}

const DEFAULT_SETTINGS: Settings = {
  layout: {
    pageWidth: 900,
    boardMaxWidth: 1600,
  },
  diagram: {
    defaultMaxWidth: 800,
  },
  files: {
    storagePath: './uploads',
    maxSizeMb: 10,
  },
  vector: {
    enabled: false,
  },
  backup: {
    location: 'db/backups',
  },
  drive: {
    syncFolder: '',
  },
  gemini: {
    project: '',
    location: 'us-central1',
    defaultModel: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
    accounts: [],
    vertexAccount: '',
    driveAccount: '',
  },
  desktop: {
    active: false,
  },
  slack: {
    exportDir: 'chats',
  },
  sessions: {
    backupPath: '',
    backupEnabled: false,
    backupIntervalMinutes: 10,
  },
  kdag: {
    maxConcurrency: 3,
    allowedTools: [
      'mcp__khef__*',
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
    ],
    definitions: {
      hidden: [],
    },
  },
  chat: {
    claudeAllowedTools: [
      'mcp__khef__*',
      'WebSearch',
      'WebFetch',
      'Read',
      'Glob',
      'Grep',
      'Edit',
      'Write',
      'Bash',
    ],
  },
  export: {
    imageTheme: 'light',
    diagramScale: 2,
    pngRenderScale: 2,
    pngDisplayScalePercent: 100,
    highQualityRendering: true,
  },
  nicknames: {
    preferred: [],
    staleDays: 7,
    minLength: 0,
    maxLength: 0,
  },
  projects: {
    hidden: [],
  },
  memory: {
    watchEnabled: true,
    itermWarnBytes: 20 * 1024 * 1024 * 1024,
  },
  sessionContext: {
    watchEnabled: true,
    tiers: [
      { threshold: 0.5, severity: 'info' },
      { threshold: 0.75, severity: 'warning' },
      { threshold: 0.9, severity: 'error' },
    ],
  },
  editor: {
    scratchHome: '',
    scratchDrawer: {
      enabled: false,
    },
  },
}

let cachedSettings: Settings | null = null
let cachedMetadata: Record<string, SettingsMetadata> | null = null

// Parse a value based on its type
function parseValue(value: string, valueType: string): string | number | boolean {
  switch (valueType) {
    case 'int':
    case 'integer':
      return parseInt(value, 10)
    case 'float':
    case 'number':
      return parseFloat(value)
    case 'boolean':
      return value === 'true' || value === '1'
    default:
      return value
  }
}

// Convert flat key-value settings to nested Settings object
function flatToNested(
  flat: Record<string, string>,
  metadata: Record<string, SettingsMetadata> | null,
): Settings {
  const getTypedValue = (key: string, defaultValue: number): number => {
    const raw = flat[key]
    if (raw === undefined) return defaultValue
    const valueType = metadata?.[key]?.value_type ?? 'string'
    const parsed = parseValue(raw, valueType)
    return typeof parsed === 'number' && !isNaN(parsed) ? parsed : defaultValue
  }

  const getStringValue = (key: string, defaultValue: string): string => {
    return flat[key] ?? defaultValue
  }

  return {
    layout: {
      pageWidth: getTypedValue('layout.pageWidth', DEFAULT_SETTINGS.layout.pageWidth),
      boardMaxWidth: getTypedValue('layout.boardMaxWidth', DEFAULT_SETTINGS.layout.boardMaxWidth),
    },
    diagram: {
      defaultMaxWidth: getTypedValue('diagram.defaultMaxWidth', DEFAULT_SETTINGS.diagram.defaultMaxWidth),
    },
    files: {
      storagePath: getStringValue('files.storagePath', DEFAULT_SETTINGS.files.storagePath),
      maxSizeMb: getTypedValue('files.maxSizeMb', DEFAULT_SETTINGS.files.maxSizeMb),
    },
    vector: {
      enabled: flat['vector.enabled'] === 'true',
    },
    backup: {
      location: getStringValue('backup.location', DEFAULT_SETTINGS.backup.location),
    },
    drive: {
      syncFolder: getStringValue('drive.syncFolder', DEFAULT_SETTINGS.drive.syncFolder),
    },
    gemini: {
      project: getStringValue('gemini.project', DEFAULT_SETTINGS.gemini.project),
      location: getStringValue('gemini.location', DEFAULT_SETTINGS.gemini.location),
      defaultModel: getStringValue('gemini.defaultModel', DEFAULT_SETTINGS.gemini.defaultModel),
      models: (() => {
        const raw = flat['gemini.models']
        if (!raw) return DEFAULT_SETTINGS.gemini.models
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) return parsed
        } catch { /* ignore */ }
        return DEFAULT_SETTINGS.gemini.models
      })(),
      accounts: (() => {
        const raw = flat['gemini.accounts']
        if (!raw) return DEFAULT_SETTINGS.gemini.accounts
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) {
            return parsed.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean)
          }
        } catch { /* ignore */ }
        return DEFAULT_SETTINGS.gemini.accounts
      })(),
      vertexAccount: getStringValue('gemini.vertexAccount', DEFAULT_SETTINGS.gemini.vertexAccount),
      driveAccount: getStringValue('gemini.driveAccount', DEFAULT_SETTINGS.gemini.driveAccount),
    },
    desktop: {
      active: flat['desktop.active'] === 'true',
    },
    slack: {
      exportDir: getStringValue('slack.exportDir', DEFAULT_SETTINGS.slack.exportDir),
    },
    sessions: {
      backupPath: getStringValue('sessions.backupPath', DEFAULT_SETTINGS.sessions.backupPath),
      backupEnabled: flat['sessions.backupEnabled'] === 'true',
      backupIntervalMinutes: getTypedValue('sessions.backupIntervalMinutes', DEFAULT_SETTINGS.sessions.backupIntervalMinutes),
    },
    kdag: {
      maxConcurrency: getTypedValue('kdag.maxConcurrency', DEFAULT_SETTINGS.kdag.maxConcurrency),
      allowedTools: (() => {
        const raw = flat['kdag.allowedTools']
        if (!raw) return DEFAULT_SETTINGS.kdag.allowedTools
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) return parsed
        } catch { /* ignore */ }
        return DEFAULT_SETTINGS.kdag.allowedTools
      })(),
      definitions: {
        hidden: (() => {
          const raw = flat['kdag.definitions.hidden']
          if (!raw) return DEFAULT_SETTINGS.kdag.definitions.hidden
          return raw.split(',').map(k => k.trim()).filter(Boolean)
        })(),
      },
    },
    chat: {
      claudeAllowedTools: (() => {
        const raw = flat['chat.claudeAllowedTools']
        if (!raw) return DEFAULT_SETTINGS.chat.claudeAllowedTools
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) return parsed
        } catch { /* ignore */ }
        return DEFAULT_SETTINGS.chat.claudeAllowedTools
      })(),
    },
    export: {
      imageTheme: getStringValue('export.imageTheme', DEFAULT_SETTINGS.export.imageTheme),
      diagramScale: getTypedValue('export.diagramScale', DEFAULT_SETTINGS.export.diagramScale),
      pngRenderScale: getTypedValue('export.pngRenderScale', DEFAULT_SETTINGS.export.pngRenderScale),
      pngDisplayScalePercent: getTypedValue('export.pngDisplayScalePercent', DEFAULT_SETTINGS.export.pngDisplayScalePercent),
      highQualityRendering: flat['export.highQualityRendering'] !== undefined
        ? flat['export.highQualityRendering'] === 'true'
        : DEFAULT_SETTINGS.export.highQualityRendering,
    },
    nicknames: {
      preferred: (() => {
        const raw = flat['nicknames.preferred']
        if (!raw) return DEFAULT_SETTINGS.nicknames.preferred
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string')
        } catch { /* ignore */ }
        return DEFAULT_SETTINGS.nicknames.preferred
      })(),
      staleDays: getTypedValue('nicknames.staleDays', DEFAULT_SETTINGS.nicknames.staleDays),
      minLength: getTypedValue('nicknames.minLength', DEFAULT_SETTINGS.nicknames.minLength),
      maxLength: getTypedValue('nicknames.maxLength', DEFAULT_SETTINGS.nicknames.maxLength),
    },
    projects: {
      hidden: (() => {
        const raw = flat['projects.hidden']
        if (!raw) return DEFAULT_SETTINGS.projects.hidden
        return raw.split(',').map(h => h.trim()).filter(Boolean)
      })(),
    },
    memory: {
      watchEnabled: flat['memory.watch.enabled'] !== undefined
        ? flat['memory.watch.enabled'] === 'true'
        : DEFAULT_SETTINGS.memory.watchEnabled,
      itermWarnBytes: getTypedValue('memory.iterm.warn_bytes', DEFAULT_SETTINGS.memory.itermWarnBytes),
    },
    sessionContext: {
      watchEnabled: flat['session.context.watch.enabled'] !== undefined
        ? flat['session.context.watch.enabled'] === 'true'
        : DEFAULT_SETTINGS.sessionContext.watchEnabled,
      tiers: (() => {
        const raw = flat['session.context.warn.tiers']
        if (!raw) return DEFAULT_SETTINGS.sessionContext.tiers
        try {
          const parsed = JSON.parse(raw)
          if (!Array.isArray(parsed)) return DEFAULT_SETTINGS.sessionContext.tiers
          const valid = parsed
            .filter((t: unknown): t is { threshold: number; severity: string } =>
              typeof t === 'object' && t !== null &&
              typeof (t as Record<string, unknown>).threshold === 'number' &&
              typeof (t as Record<string, unknown>).severity === 'string'
            )
            .filter((t) => ['info', 'warning', 'error'].includes(t.severity))
            .map((t) => ({ threshold: t.threshold, severity: t.severity as 'info' | 'warning' | 'error' }))
            .sort((a, b) => a.threshold - b.threshold)
          return valid.length > 0 ? valid : DEFAULT_SETTINGS.sessionContext.tiers
        } catch { return DEFAULT_SETTINGS.sessionContext.tiers }
      })(),
    },
    editor: {
      scratchHome: getStringValue('editor.scratchHome', DEFAULT_SETTINGS.editor.scratchHome),
      scratchDrawer: {
        enabled: flat['editor.scratchDrawer.enabled'] === 'true',
      },
    },
  }
}

// Convert nested Settings object to flat key-value pairs
function nestedToFlat(settings: Partial<Settings>): Record<string, string> {
  const flat: Record<string, string> = {}
  if (settings.layout?.pageWidth !== undefined) {
    flat['layout.pageWidth'] = String(settings.layout.pageWidth)
  }
  if (settings.layout?.boardMaxWidth !== undefined) {
    flat['layout.boardMaxWidth'] = String(settings.layout.boardMaxWidth)
  }
  if (settings.diagram?.defaultMaxWidth !== undefined) {
    flat['diagram.defaultMaxWidth'] = String(settings.diagram.defaultMaxWidth)
  }
  if (settings.files?.storagePath !== undefined) {
    flat['files.storagePath'] = settings.files.storagePath
  }
  if (settings.files?.maxSizeMb !== undefined) {
    flat['files.maxSizeMb'] = String(settings.files.maxSizeMb)
  }
  if (settings.backup?.location !== undefined) {
    flat['backup.location'] = settings.backup.location
  }
  if (settings.drive?.syncFolder !== undefined) {
    flat['drive.syncFolder'] = settings.drive.syncFolder
  }
  if (settings.gemini?.project !== undefined) {
    flat['gemini.project'] = settings.gemini.project
  }
  if (settings.gemini?.location !== undefined) {
    flat['gemini.location'] = settings.gemini.location
  }
  if (settings.gemini?.defaultModel !== undefined) {
    flat['gemini.defaultModel'] = settings.gemini.defaultModel
  }
  if (settings.gemini?.models !== undefined) {
    flat['gemini.models'] = JSON.stringify(settings.gemini.models)
  }
  if (settings.gemini?.accounts !== undefined) {
    flat['gemini.accounts'] = JSON.stringify(settings.gemini.accounts)
  }
  if (settings.gemini?.vertexAccount !== undefined) {
    flat['gemini.vertexAccount'] = settings.gemini.vertexAccount
  }
  if (settings.gemini?.driveAccount !== undefined) {
    flat['gemini.driveAccount'] = settings.gemini.driveAccount
  }
  if (settings.desktop?.active !== undefined) {
    flat['desktop.active'] = String(settings.desktop.active)
  }
  if (settings.slack?.exportDir !== undefined) {
    flat['slack.exportDir'] = settings.slack.exportDir
  }
  if (settings.sessions?.backupPath !== undefined) {
    flat['sessions.backupPath'] = settings.sessions.backupPath
  }
  if (settings.sessions?.backupEnabled !== undefined) {
    flat['sessions.backupEnabled'] = String(settings.sessions.backupEnabled)
  }
  if (settings.sessions?.backupIntervalMinutes !== undefined) {
    flat['sessions.backupIntervalMinutes'] = String(settings.sessions.backupIntervalMinutes)
  }
  if (settings.kdag?.maxConcurrency !== undefined) {
    flat['kdag.maxConcurrency'] = String(settings.kdag.maxConcurrency)
  }
  if (settings.kdag?.allowedTools !== undefined) {
    flat['kdag.allowedTools'] = JSON.stringify(settings.kdag.allowedTools)
  }
  if (settings.kdag?.definitions?.hidden !== undefined) {
    flat['kdag.definitions.hidden'] = settings.kdag.definitions.hidden.join(',')
  }
  if (settings.chat?.claudeAllowedTools !== undefined) {
    flat['chat.claudeAllowedTools'] = JSON.stringify(settings.chat.claudeAllowedTools)
  }
  if (settings.export?.imageTheme !== undefined) {
    flat['export.imageTheme'] = settings.export.imageTheme
  }
  if (settings.export?.diagramScale !== undefined) {
    flat['export.diagramScale'] = String(settings.export.diagramScale)
  }
  if (settings.export?.pngRenderScale !== undefined) {
    flat['export.pngRenderScale'] = String(settings.export.pngRenderScale)
  }
  if (settings.export?.pngDisplayScalePercent !== undefined) {
    flat['export.pngDisplayScalePercent'] = String(settings.export.pngDisplayScalePercent)
  }
  if (settings.export?.highQualityRendering !== undefined) {
    flat['export.highQualityRendering'] = String(settings.export.highQualityRendering)
  }
  if (settings.nicknames?.preferred !== undefined) {
    flat['nicknames.preferred'] = JSON.stringify(settings.nicknames.preferred)
  }
  if (settings.nicknames?.staleDays !== undefined) {
    flat['nicknames.staleDays'] = String(settings.nicknames.staleDays)
  }
  if (settings.nicknames?.minLength !== undefined) {
    flat['nicknames.minLength'] = String(settings.nicknames.minLength)
  }
  if (settings.nicknames?.maxLength !== undefined) {
    flat['nicknames.maxLength'] = String(settings.nicknames.maxLength)
  }
  if (settings.projects?.hidden !== undefined) {
    flat['projects.hidden'] = settings.projects.hidden.join(',')
  }
  if (settings.memory?.watchEnabled !== undefined) {
    flat['memory.watch.enabled'] = String(settings.memory.watchEnabled)
  }
  if (settings.memory?.itermWarnBytes !== undefined) {
    flat['memory.iterm.warn_bytes'] = String(settings.memory.itermWarnBytes)
  }
  if (settings.sessionContext?.watchEnabled !== undefined) {
    flat['session.context.watch.enabled'] = String(settings.sessionContext.watchEnabled)
  }
  if (settings.sessionContext?.tiers !== undefined) {
    flat['session.context.warn.tiers'] = JSON.stringify(settings.sessionContext.tiers)
  }
  if (settings.editor?.scratchHome !== undefined) {
    flat['editor.scratchHome'] = settings.editor.scratchHome
  }
  if (settings.editor?.scratchDrawer?.enabled !== undefined) {
    flat['editor.scratchDrawer.enabled'] = String(settings.editor.scratchDrawer.enabled)
  }
  return flat
}

export async function loadSettings(): Promise<Settings> {
  if (cachedSettings) return cachedSettings

  try {
    const response: SettingsResponse = await fetchSettings()
    cachedMetadata = response.metadata
    cachedSettings = flatToNested(response.settings, cachedMetadata)
    applyCssVariables(cachedSettings)
    return cachedSettings
  } catch (error) {
    console.warn('Error loading settings from API, using defaults:', error)
    cachedSettings = DEFAULT_SETTINGS
    applyCssVariables(cachedSettings)
    return cachedSettings
  }
}

export async function saveSettings(settings: Partial<Settings>): Promise<Settings> {
  const flat = nestedToFlat(settings)
  const response = await patchSettings(flat)
  cachedMetadata = response.metadata
  cachedSettings = flatToNested(response.settings, cachedMetadata)
  applyCssVariables(cachedSettings)
  return cachedSettings
}

export function invalidateSettingsCache(): void {
  cachedSettings = null
  cachedMetadata = null
}

function applyCssVariables(settings: Settings): void {
  const root = document.documentElement
  root.style.setProperty('--page-max-width', `${settings.layout.pageWidth}px`)
  root.style.setProperty('--board-max-width', `${settings.layout.boardMaxWidth}px`)
}

export function getSettings(): Settings {
  return cachedSettings ?? DEFAULT_SETTINGS
}

export function getSettingsMetadata(): Record<string, SettingsMetadata> | null {
  return cachedMetadata
}

export function isDesktopApp(): boolean {
  return getSettings().desktop.active
}
