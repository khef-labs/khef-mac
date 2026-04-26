import { Redirect } from 'wouter-preact'
import { AssistantLayout, DEFAULT_SECTION, sectionKeysFor } from './AssistantLayout'
import { ConfigsSection } from './ConfigsSection'
import { McpSection } from './McpSection'
import { SkillsSection } from './SkillsSection'
import { AgentsSection } from './AgentsSection'
import { CommandsSection } from './CommandsSection'
import { SessionsSection, ReposSection } from './SessionsSection'
import { PlansSection } from './PlansSection'
import { PromptsSection } from './PromptsSection'
import { MemoryFilesSection } from './MemoryFilesSection'
import { KdagSection } from '../settings/KdagSection'
import { ChatSection } from '../settings/ChatSection'
import { NicknamesSection } from '../settings/NicknamesSection'

interface Props {
  handle: string
  section?: string
}

const SECTION_MAP: Record<string, (props: { handle: string }) => any> = {
  configs: ConfigsSection,
  mcp: McpSection,
  skills: SkillsSection,
  agents: AgentsSection,
  commands: CommandsSection,
  sessions: SessionsSection,
  nicknames: () => <NicknamesSection />,
  repos: ReposSection,
  plans: PlansSection,
  prompts: PromptsSection,
  'memory-files': MemoryFilesSection,
  kdag: () => <KdagSection />,
  chat: () => <ChatSection />,
}

export function AssistantPage({ handle, section }: Props) {
  if (!section) {
    return <Redirect to={`/assistants/${handle}/${DEFAULT_SECTION}`} />
  }

  if (!sectionKeysFor(handle).includes(section)) {
    return <Redirect to={`/assistants/${handle}/${DEFAULT_SECTION}`} />
  }

  const SectionComponent = SECTION_MAP[section]

  return (
    <AssistantLayout handle={handle} section={section}>
      {SectionComponent ? <SectionComponent handle={handle} /> : null}
    </AssistantLayout>
  )
}
