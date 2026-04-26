import type { ComponentChildren } from 'preact'
import { SectionNav, SECTION_KEYS_FROM_GROUPS } from '../../components/layout'
import type { NavGroup } from '../../components/layout'
import { useDirtySections } from './DirtySectionsContext'

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Appearance',
    items: [
      { key: 'layout', label: 'Layout' },
      { key: 'projects', label: 'Projects' },
      { key: 'diagrams', label: 'Diagrams' },
      { key: 'export', label: 'Export' },
    ],
  },
  {
    label: 'Integrations',
    items: [
      { key: 'gemini', label: 'Gemini' },
      { key: 'google-drive', label: 'Google Drive' },
      { key: 'slack', label: 'Slack' },
    ],
  },
  {
    label: 'Pipeline',
    items: [
      { key: 'kdag', label: 'Kdag' },
      { key: 'definitions', label: 'Definitions' },
      { key: 'chat', label: 'Chat' },
    ],
  },
  {
    label: 'Backups',
    items: [
      { key: 'database-backups', label: 'Database' },
      { key: 'session-files', label: 'Session Files' },
    ],
  },
  {
    label: 'System',
    items: [
      { key: 'files', label: 'Files' },
      { key: 'redis', label: 'Redis' },
      { key: 'runtime', label: 'Runtime' },
      { key: 'notifications', label: 'Notifications' },
    ],
  },
  {
    label: 'Editor',
    items: [
      { key: 'editor/scratch', label: 'Scratch' },
    ],
  },
  {
    label: 'Other',
    items: [
      { key: 'tts', label: 'Text-to-Speech' },
      { key: 'agent-rules', label: 'Agent Rules' },
      { key: 'custom-types', label: 'Custom Types' },
    ],
  },
]

export const DEFAULT_SECTION = 'layout'

export const SECTION_KEYS = SECTION_KEYS_FROM_GROUPS(NAV_GROUPS)

export const LEGACY_SECTION_REDIRECTS: Record<string, string> = {
  backups: 'database-backups',
  sessions: 'session-files',
}

interface SettingsLayoutProps {
  section: string
  hideContentHeader?: boolean
  children: ComponentChildren
}

export function SettingsLayout({ section, hideContentHeader, children }: SettingsLayoutProps) {
  const { dirtyKeys } = useDirtySections()
  return (
    <SectionNav
      groups={NAV_GROUPS}
      activeKey={section}
      basePath="/settings"
      title="Settings"
      hideContentHeader={hideContentHeader}
      dirtyKeys={dirtyKeys}
    >
      {children}
    </SectionNav>
  )
}
