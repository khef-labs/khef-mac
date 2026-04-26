import { createContext } from 'preact'
import { useCallback, useContext, useEffect, useState } from 'preact/hooks'

interface DirtySectionsContextValue {
  dirtyKeys: ReadonlySet<string>
  setDirty: (key: string, dirty: boolean) => void
}

const DirtySectionsContext = createContext<DirtySectionsContextValue | null>(null)

export function DirtySectionsProvider({ children }: { children: preact.ComponentChildren }) {
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set())

  const setDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((prev) => {
      const isCurrentlyDirty = prev.has(key)
      if (dirty && isCurrentlyDirty) return prev
      if (!dirty && !isCurrentlyDirty) return prev
      const next = new Set(prev)
      if (dirty) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  return (
    <DirtySectionsContext.Provider value={{ dirtyKeys, setDirty }}>
      {children}
    </DirtySectionsContext.Provider>
  )
}

export function useDirtySections(): DirtySectionsContextValue {
  const ctx = useContext(DirtySectionsContext)
  if (!ctx) {
    return {
      dirtyKeys: new Set(),
      setDirty: () => { /* no-op outside provider */ },
    }
  }
  return ctx
}

/**
 * Register a section's dirty state with the parent provider.
 * Cleans up automatically when the section unmounts.
 */
export function useRegisterDirtySection(key: string, dirty: boolean): void {
  const { setDirty } = useDirtySections()
  useEffect(() => {
    setDirty(key, dirty)
  }, [key, dirty, setDirty])
  useEffect(() => {
    return () => { setDirty(key, false) }
  }, [key, setDirty])
}
