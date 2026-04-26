import { loadStore, saveStore } from './store'

export function getDismissedServers(): Set<string> {
  return new Set(loadStore().mcpDismissedServers)
}

export function dismissServer(name: string): void {
  const dismissed = getDismissedServers()
  dismissed.add(name)
  saveStore({ mcpDismissedServers: [...dismissed] })
}

export function restoreServer(name: string): void {
  const dismissed = getDismissedServers()
  dismissed.delete(name)
  saveStore({ mcpDismissedServers: [...dismissed] })
}

export function isServerDismissed(name: string): boolean {
  return getDismissedServers().has(name)
}
