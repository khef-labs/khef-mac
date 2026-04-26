/**
 * Gcloud health check routes.
 * Verifies gcloud CLI is installed, authenticated, and has Drive API access.
 */

import { FastifyPluginAsync } from 'fastify'
import { GOOGLE_DRIVE_API_URL, invalidateGoogleStatusCache } from '../services/google'
import { getGeminiSettings, invalidateGeminiStatusCache } from '../services/gemini'
import {
  isGcloudInstalled,
  getGcloudAccount,
  getGcloudAccessToken,
  listGcloudAccounts,
  setGcloudAccount,
} from '../services/gcloud'

interface GcloudHealthResponse {
  healthy: boolean
  gcloud_installed: boolean
  authenticated: boolean
  drive_access: boolean
  active_account?: string
  account?: string
  vertex_account?: string
  drive_account?: string
  error?: string
  account_checks: {
    account: string
    active: boolean
    healthy: boolean
    authenticated: boolean
    drive_access: boolean
    error?: string
  }[]
  checks: {
    name: string
    passed: boolean
    message?: string
    duration_ms: number
  }[]
}

const gcloudRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/gcloud/accounts - List authenticated gcloud accounts
  fastify.get('/accounts', async (_request, reply) => {
    const gcloudInstalled = await isGcloudInstalled()
    if (!gcloudInstalled) {
      return reply.code(503).send({
        error: 'gcloud CLI not installed',
      })
    }

    try {
      const accounts = await listGcloudAccounts()
      const activeAccount = accounts.find(account => account.active)?.account || null
      return {
        accounts,
        active_account: activeAccount,
      }
    } catch (err: any) {
      return reply.code(500).send({
        error: err.message || 'Failed to list gcloud accounts',
      })
    }
  })

  // POST /api/gcloud/account - Set active gcloud account
  fastify.post<{ Body: { account?: string } }>('/account', async (request, reply) => {
    const account = request.body?.account?.trim()
    if (!account) {
      return reply.code(400).send({ error: 'account is required' })
    }

    const gcloudInstalled = await isGcloudInstalled()
    if (!gcloudInstalled) {
      return reply.code(503).send({ error: 'gcloud CLI not installed' })
    }

    try {
      await setGcloudAccount(account)

      // Clear auth-related caches so status checks and requests reflect the new principal.
      invalidateGoogleStatusCache()
      invalidateGeminiStatusCache()

      return {
        account,
        message: 'Active gcloud account updated',
      }
    } catch (err: any) {
      return reply.code(400).send({
        error: err.message || 'Failed to set gcloud account',
      })
    }
  })

  // GET /api/gcloud/health - Full health check with Drive API test
  // Always fetches a fresh token (bypasses service cache) so the check
  // reflects the current gcloud auth state and primes the cache for
  // subsequent Drive API calls.
  fastify.get('/health', async (): Promise<GcloudHealthResponse> => {
    invalidateGoogleStatusCache()
    const checks: GcloudHealthResponse['checks'] = []
    let gcloudInstalled = false

    // Check 1: gcloud installed
    const gcloudStart = Date.now()
    gcloudInstalled = await isGcloudInstalled()
    if (!gcloudInstalled) {
      checks.push({
        name: 'gcloud_installed',
        passed: false,
        message: 'gcloud CLI not found in PATH',
        duration_ms: Date.now() - gcloudStart,
      })
      return {
        healthy: false,
        gcloud_installed: false,
        authenticated: false,
        drive_access: false,
        error: 'gcloud CLI not installed',
        account_checks: [],
        checks,
      }
    }
    checks.push({
      name: 'gcloud_installed',
      passed: true,
      duration_ms: Date.now() - gcloudStart,
    })

    // Check 2: enumerate authenticated accounts
    const authStart = Date.now()
    let accounts: Array<{ account: string; active: boolean }> = []
    let actualActiveAccount: string | undefined
    try {
      accounts = await listGcloudAccounts()
      actualActiveAccount = accounts.find(a => a.active)?.account
      if (!actualActiveAccount) {
        actualActiveAccount = await getGcloudAccount() || undefined
      }
      checks.push({
        name: 'authenticated',
        passed: true,
        message: `${accounts.length} account(s); active=${actualActiveAccount || 'none'}`,
        duration_ms: Date.now() - authStart,
      })
    } catch (err: any) {
      checks.push({
        name: 'authenticated',
        passed: false,
        message: err.message || 'Failed to get account',
        duration_ms: Date.now() - authStart,
      })
      return {
        healthy: false,
        gcloud_installed: true,
        authenticated: false,
        drive_access: false,
        error: 'Failed to check authentication',
        account_checks: [],
        checks,
      }
    }

    const geminiSettings = await getGeminiSettings()
    const preferredAccounts = geminiSettings.accounts
    let accountsToCheck: Array<{ account: string; active: boolean }> = []

    if (preferredAccounts.length > 0) {
      accountsToCheck = preferredAccounts.map((account) => ({
        account,
        active: account === actualActiveAccount,
      }))
    } else if (actualActiveAccount) {
      accountsToCheck = [{ account: actualActiveAccount, active: true }]
    } else {
      return {
        healthy: false,
        gcloud_installed: true,
        authenticated: false,
        drive_access: false,
        error: 'gcloud not authenticated',
        account_checks: [],
        checks,
      }
    }

    const accountChecks: GcloudHealthResponse['account_checks'] = []
    for (const accountInfo of accountsToCheck) {
      const accountResult: GcloudHealthResponse['account_checks'][number] = {
        account: accountInfo.account,
        active: accountInfo.active,
        healthy: false,
        authenticated: false,
        drive_access: false,
      }

      const tokenStart = Date.now()
      let token: string
      try {
        token = await getGcloudAccessToken(accountInfo.account)
        if (!token) {
          accountResult.error = 'Failed to get access token'
          checks.push({
            name: `access_token:${accountInfo.account}`,
            passed: false,
            message: 'Empty token returned',
            duration_ms: Date.now() - tokenStart,
          })
          accountChecks.push(accountResult)
          continue
        }
        checks.push({
          name: `access_token:${accountInfo.account}`,
          passed: true,
          duration_ms: Date.now() - tokenStart,
        })
        accountResult.authenticated = true
      } catch (err: any) {
        accountResult.authenticated = false
        accountResult.error = err.message || 'Failed to get access token'
        checks.push({
          name: `access_token:${accountInfo.account}`,
          passed: false,
          message: accountResult.error,
          duration_ms: Date.now() - tokenStart,
        })
        accountChecks.push(accountResult)
        continue
      }

      const driveStart = Date.now()
      try {
        const res = await fetch(
          `${GOOGLE_DRIVE_API_URL}/files?pageSize=1&fields=files(id)`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        )

        if (res.ok) {
          accountResult.drive_access = true
          accountResult.healthy = true
          checks.push({
            name: `drive_api:${accountInfo.account}`,
            passed: true,
            duration_ms: Date.now() - driveStart,
          })
        } else {
          let message = `HTTP ${res.status}`
          if (res.status === 403) {
            message = 'Drive API access denied. Re-authenticate with: gcloud auth login --enable-gdrive-access'
          } else if (res.status === 401) {
            message = 'Token invalid or expired'
          }
          accountResult.error = message
          checks.push({
            name: `drive_api:${accountInfo.account}`,
            passed: false,
            message,
            duration_ms: Date.now() - driveStart,
          })
        }
      } catch (err: any) {
        accountResult.error = err.message || 'Network error'
        checks.push({
          name: `drive_api:${accountInfo.account}`,
          passed: false,
          message: accountResult.error,
          duration_ms: Date.now() - driveStart,
        })
      }

      accountChecks.push(accountResult)
    }

    const activeAccountCheck = actualActiveAccount
      ? accountChecks.find(c => c.account === actualActiveAccount)
      : undefined
    const authenticated = accountChecks.some(c => c.authenticated)
    const driveAccess = accountChecks.some(c => c.drive_access)
    const healthy = gcloudInstalled && authenticated && driveAccess
    const error = healthy
      ? undefined
      : (activeAccountCheck?.error || accountChecks.find(c => c.error)?.error || 'gcloud auth/Drive checks failed')

    return {
      healthy,
      gcloud_installed: gcloudInstalled,
      authenticated,
      drive_access: driveAccess,
      active_account: actualActiveAccount,
      account: actualActiveAccount,
      vertex_account: geminiSettings.vertexAccount || undefined,
      drive_account: geminiSettings.driveAccount || undefined,
      error,
      account_checks: accountChecks,
      checks,
    }
  })
}

export default gcloudRoutes
