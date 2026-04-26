// API base URL resolution. Lives in its own module to avoid circular imports
// when other libs (e.g. `sseClient`) need the base without pulling all of `api`.

const isTestEnv =
  (import.meta.env.KHEF_USE_TEST_ENV as string | undefined) === '1' ||
  (import.meta.env.KHEF_USE_TEST_ENV as string | undefined) === 'true' ||
  import.meta.env.MODE === 'test'

const envApiBase = import.meta.env.KHEF_API_URL as string | undefined

// Priority:
// 1) KHEF_API_URL (explicit)
// 2) Same-origin '/api' based on window.location (respects dev server port)
// 3) Fallback to http://localhost:3000/api
export const API_BASE = (() => {
  if (isTestEnv) {
    if (!envApiBase) {
      throw new Error(
        'KHEF_API_URL must be set in test mode to avoid hitting dev API.'
      )
    }
    if (envApiBase.includes('localhost:3201') || envApiBase.includes('127.0.0.1:3200')) {
      throw new Error(`Test mode API base resolves to dev server: ${envApiBase}`)
    }
    return envApiBase
  }

  return (
    envApiBase ||
    (typeof window !== 'undefined' && window.location?.origin
      ? `${window.location.origin}/api`
      : 'http://localhost:3000/api')
  )
})()
