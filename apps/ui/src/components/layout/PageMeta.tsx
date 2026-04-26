import { createContext } from 'preact'
import { useContext, useEffect, useMemo, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'

export interface PageMetaState {
  label?: string
  templateFiles: string[]
}

interface PageMetaContextValue {
  meta: PageMetaState
  setMeta: (next: PageMetaState) => void
}

const PageMetaContext = createContext<PageMetaContextValue | null>(null)

export function PageMetaProvider({ children }: { children: ComponentChildren }) {
  const [meta, setMeta] = useState<PageMetaState>({ templateFiles: [] })

  const value = useMemo<PageMetaContextValue>(() => ({
    meta,
    setMeta,
  }), [meta])

  return (
    <PageMetaContext.Provider value={value}>
      {children}
    </PageMetaContext.Provider>
  )
}

export function usePageMeta(): PageMetaContextValue {
  const ctx = useContext(PageMetaContext)
  if (!ctx) {
    throw new Error('usePageMeta must be used within a PageMetaProvider')
  }
  return ctx
}

interface PageMetaProps {
  label?: string
  templateFiles?: string[]
  children: ComponentChildren
}

export function PageMeta({ label, templateFiles = [], children }: PageMetaProps) {
  const { setMeta } = usePageMeta()
  const filesKey = templateFiles.join('|')

  useEffect(() => {
    setMeta({ label, templateFiles })
    return () => {
      setMeta({ label: undefined, templateFiles: [] })
    }
  }, [filesKey, label, setMeta])

  return <>{children}</>
}
