import { useState, useEffect } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { getAssistant } from '../../lib/api'
import type { Assistant } from '../../types'
import { SectionNav, SECTION_KEYS_FROM_GROUPS } from '../../components/layout'
import type { NavGroup } from '../../components/layout'

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Configuration',
    items: [
      { key: 'configs', label: 'Configs' },
      { key: 'mcp', label: 'MCP Servers' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { key: 'skills', label: 'Skills' },
      { key: 'agents', label: 'Agents' },
      { key: 'commands', label: 'Commands' },
    ],
  },
  {
    label: 'Activity',
    items: [
      { key: 'sessions', label: 'Sessions' },
      { key: 'nicknames', label: 'Nicknames' },
      { key: 'repos', label: 'Repos' },
    ],
  },
  {
    label: 'Pipeline',
    items: [
      { key: 'kdag', label: 'Kdag' },
      { key: 'chat', label: 'Chat' },
    ],
  },
  {
    label: 'Resources',
    items: [
      { key: 'plans', label: 'Plans' },
      { key: 'prompts', label: 'Prompts' },
      { key: 'memory-files', label: 'Memory Files' },
    ],
  },
]

export const DEFAULT_SECTION = 'configs'

const CLAUDE_ONLY_KEYS = new Set(['skills', 'agents', 'plans', 'memory-files', 'nicknames', 'sessions', 'repos'])

export function navGroupsFor(handle: string): NavGroup[] {
  if (handle === 'codex-cli') {
    return NAV_GROUPS
      .map(group => ({ ...group, items: group.items.filter(item => !CLAUDE_ONLY_KEYS.has(item.key)) }))
      .filter(group => group.items.length > 0)
  }
  return NAV_GROUPS
}

export function sectionKeysFor(handle: string): string[] {
  return SECTION_KEYS_FROM_GROUPS(navGroupsFor(handle))
}

interface AssistantLayoutProps {
  handle: string
  section: string
  hideContentHeader?: boolean
  children: ComponentChildren
}

export function AssistantLayout({ handle, section, hideContentHeader, children }: AssistantLayoutProps) {
  const [assistant, setAssistant] = useState<Assistant | null>(null)

  useEffect(() => {
    getAssistant(handle).then(setAssistant).catch(() => {})
  }, [handle])

  return (
    <SectionNav
      groups={navGroupsFor(handle)}
      activeKey={section}
      basePath={`/assistants/${handle}`}
      title={assistant?.name || handle}
      subtitle={handle}
      hideContentHeader={hideContentHeader}
    >
      {children}
    </SectionNav>
  )
}
