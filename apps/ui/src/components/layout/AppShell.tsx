import { Link, useLocation } from 'wouter-preact'
import { useEffect, useMemo } from 'preact/hooks'
import { Search, FolderKanban, Bot, ChartBarBig, Settings, Sparkles, MessageSquare, Database, Zap, FileCode, HardDrive, ScrollText, Users, Send } from 'lucide-preact'
import clsx from 'clsx'
import type { ComponentChildren } from 'preact'
import { useFetch } from '../../hooks'
import { getMcpServersHealth } from '../../lib/api'
import { getDismissedServers } from '../../lib/mcpDismissed'
import { isDesktopApp } from '../../lib/settings'
import { PageMetaFooter } from './PageMetaFooter'
import { NotificationsBanner } from '../shared/NotificationsBanner'
import { QuestionHost } from '../agent-questions'
import styles from './AppShell.module.css'

interface Props {
  children: ComponentChildren
}

export function AppShell({ children }: Props) {
  const [location] = useLocation()

  // Fetch MCP server health for nav badge
  const { data: mcpHealth } = useFetch(
    'mcp-servers-health',
    getMcpServersHealth,
    { staleTime: 60000 } // Check every minute
  )

  // Filter out dismissed servers from issue count
  const activeIssues = useMemo(() => {
    if (!mcpHealth) return 0
    const dismissed = getDismissedServers()
    let count = 0
    for (const assistant of mcpHealth.assistants) {
      for (const server of assistant.servers) {
        if ((server.status === 'stale' || server.status === 'unavailable') && !dismissed.has(server.name)) {
          count++
        }
      }
    }
    return count
  }, [mcpHealth])

  useEffect(() => {
    if (location.startsWith('/memories/')) return
    if (typeof window === 'undefined') return
    window.sessionStorage.setItem('khefLastLocation', location)
  }, [location])

  return (
    <div class={styles.shell}>
      <aside class={styles.sidebar}>
        <Link href="/" class={styles.logo}>
          <img src="/favicon.png?v=2" alt="" class={styles.logoIcon} />
          Khef
        </Link>
        <nav class={styles.nav}>
          <Link
            href="/search"
            class={clsx(
              styles.navLink,
              location.startsWith('/search') && styles.navLinkActive
            )}
            data-testid="nav--search"
          >
            <Search size={18} />
            Search
          </Link>
          <Link
            href="/projects"
            class={clsx(
              styles.navLink,
              location.startsWith('/projects') && styles.navLinkActive
            )}
            data-testid="nav--projects"
          >
            <FolderKanban size={18} />
            Projects
          </Link>
          <Link
            href="/assistants"
            class={clsx(
              styles.navLink,
              location.startsWith('/assistants') && styles.navLinkActive
            )}
            data-testid="nav--assistants"
          >
            <Bot size={18} />
            Assistants
            {activeIssues > 0 && (
              <span class={styles.badge}>{activeIssues}</span>
            )}
          </Link>
          <Link
            href="/sessions"
            class={clsx(
              styles.navLink,
              location.startsWith('/sessions') && styles.navLinkActive
            )}
            data-testid="nav--sessions"
          >
            <ScrollText size={18} />
            Sessions
          </Link>
          <Link
            href="/teams"
            class={clsx(
              styles.navLink,
              location.startsWith('/teams') && styles.navLinkActive
            )}
            data-testid="nav--teams"
          >
            <Users size={18} />
            Teams
          </Link>
          <Link
            href="/prompts"
            class={clsx(
              styles.navLink,
              location.startsWith('/prompts') && styles.navLinkActive
            )}
            data-testid="nav--prompts"
          >
            <Sparkles size={18} />
            Prompts
          </Link>
          <Link
            href="/chat"
            class={clsx(
              styles.navLink,
              location.startsWith('/chat') && styles.navLinkActive
            )}
            data-testid="nav--chat"
          >
            <MessageSquare size={18} />
            Chat
          </Link>
          <Link
            href="/kvec"
            class={clsx(
              styles.navLink,
              location.startsWith('/kvec') && styles.navLinkActive
            )}
            data-testid="nav--kvec"
          >
            <Database size={18} />
            Kvec
          </Link>
          <Link
            href="/kdag"
            class={clsx(
              styles.navLink,
              location.startsWith('/kdag') && styles.navLinkActive
            )}
            data-testid="nav--kdag"
          >
            <Zap size={18} />
            Kdag
          </Link>
          <Link
            href="/kapi"
            class={clsx(
              styles.navLink,
              (location === '/kapi' || location.endsWith('/kapi')) && styles.navLinkActive
            )}
            data-testid="nav--kapi"
          >
            <Send size={18} />
            Kapi
          </Link>
          <Link
            href="/editor"
            class={clsx(
              styles.navLink,
              location.startsWith('/editor') && styles.navLinkActive
            )}
            data-testid="nav--editor"
          >
            <FileCode size={18} />
            Editor
          </Link>
          <Link
            href="/database"
            class={clsx(
              styles.navLink,
              location.startsWith('/database') && styles.navLinkActive
            )}
            data-testid="nav--database"
          >
            <HardDrive size={18} />
            DB
          </Link>
          <Link
            href="/stats"
            class={clsx(
              styles.navLink,
              location.startsWith('/stats') && styles.navLinkActive
            )}
            data-testid="nav--stats"
          >
            <ChartBarBig size={18} />
            Stats
          </Link>
          <Link
            href="/settings"
            class={clsx(
              styles.navLink,
              location.startsWith('/settings') && styles.navLinkActive
            )}
            data-testid="nav--settings"
          >
            <Settings size={18} />
            Settings
          </Link>
        </nav>
        <footer class={styles.footer}>Khef</footer>
      </aside>
      <main class={styles.main}>
        <NotificationsBanner />
        <div class={styles.content}>{children}</div>
        {!isDesktopApp() && <PageMetaFooter />}
      </main>
      <QuestionHost />
    </div>
  )
}
