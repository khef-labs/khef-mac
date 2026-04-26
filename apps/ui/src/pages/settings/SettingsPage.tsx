import { Redirect } from 'wouter-preact'
import { SettingsLayout, DEFAULT_SECTION, SECTION_KEYS, LEGACY_SECTION_REDIRECTS } from './SettingsLayout'
import { LayoutSection } from './LayoutSection'
import { DiagramsSection } from './DiagramsSection'
import { ExportSection } from './ExportSection'
import { GeminiSection } from './GeminiSection'
import { GoogleDriveSection } from './GoogleDriveSection'
import { SlackSection } from './SlackSection'
import { KdagSection } from './KdagSection'
import { DefinitionsSection } from './DefinitionsSection'
import { ChatSection } from './ChatSection'
import { FilesSection } from './FilesSection'
import { DatabaseBackupsSection } from './DatabaseBackupsSection'
import { SessionFilesSection } from './SessionFilesSection'
import { RedisSection } from './RedisSection'
import { RuntimeSection } from './RuntimeSection'
import { TtsSection } from './TtsSection'
import { AgentRulesSection } from './AgentRulesSection'
import { CustomTypesSection } from './CustomTypesSection'
import { ProjectsSection } from './ProjectsSection'
import { NotificationsSection } from './NotificationsSection'
import { EditorScratchSection } from './EditorScratchSection'
import { DirtySectionsProvider } from './DirtySectionsContext'
import { useDocumentTitle } from '../../hooks'

const SECTION_MAP: Record<string, () => preact.JSX.Element> = {
  layout: LayoutSection,
  projects: ProjectsSection,
  diagrams: DiagramsSection,
  export: ExportSection,
  gemini: GeminiSection,
  'google-drive': GoogleDriveSection,
  slack: SlackSection,
  kdag: KdagSection,
  definitions: DefinitionsSection,
  chat: ChatSection,
  files: FilesSection,
  'database-backups': DatabaseBackupsSection,
  'session-files': SessionFilesSection,
  redis: RedisSection,
  runtime: RuntimeSection,
  tts: TtsSection,
  'agent-rules': AgentRulesSection,
  'custom-types': CustomTypesSection,
  notifications: NotificationsSection,
  'editor/scratch': EditorScratchSection,
}

interface SettingsPageProps {
  section?: string
}

export function SettingsPage({ section }: SettingsPageProps) {
  useDocumentTitle(section ? `Settings - ${section}` : 'Settings')

  if (!section) {
    return <Redirect to={`/settings/${DEFAULT_SECTION}`} />
  }

  const redirected = LEGACY_SECTION_REDIRECTS[section]
  if (redirected) {
    return <Redirect to={`/settings/${redirected}`} />
  }

  if (!SECTION_KEYS.includes(section)) {
    return <Redirect to={`/settings/${DEFAULT_SECTION}`} />
  }

  const SectionComponent = SECTION_MAP[section]

  return (
    <DirtySectionsProvider>
      <SettingsLayout section={section}>
        {SectionComponent ? <SectionComponent /> : null}
      </SettingsLayout>
    </DirtySectionsProvider>
  )
}
