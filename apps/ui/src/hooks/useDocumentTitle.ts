import { useEffect } from 'preact/hooks'

const DEFAULT_TITLE = 'Khef'

export function useDocumentTitle(title?: string) {
  useEffect(() => {
    if (typeof document === 'undefined') return
    document.title = title || DEFAULT_TITLE

    return () => {
      document.title = DEFAULT_TITLE
    }
  }, [title])
}
