import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { FastifyInstance } from 'fastify'

const mocks = vi.hoisted(() => ({
  mockIsGcloudInstalled: vi.fn(),
  mockGetGcloudAccessToken: vi.fn(),
  mockGetGeminiSettings: vi.fn(),
  mockListGcloudAccounts: vi.fn(),
  mockSetGcloudAccount: vi.fn(),
  mockInvalidateGoogleStatusCache: vi.fn(),
  mockInvalidateGeminiStatusCache: vi.fn(),
  mockFetch: vi.fn(),
}))

vi.mock('../../src/services/google', () => ({
  GOOGLE_DRIVE_API_URL: 'https://www.googleapis.com/drive/v3',
  invalidateGoogleStatusCache: mocks.mockInvalidateGoogleStatusCache,
}))

vi.mock('../../src/services/gemini', () => ({
  getGeminiSettings: mocks.mockGetGeminiSettings,
  invalidateGeminiStatusCache: mocks.mockInvalidateGeminiStatusCache,
}))

vi.mock('../../src/services/gcloud', () => ({
  isGcloudInstalled: mocks.mockIsGcloudInstalled,
  getGcloudAccount: vi.fn(),
  getGcloudAccessToken: mocks.mockGetGcloudAccessToken,
  listGcloudAccounts: mocks.mockListGcloudAccounts,
  setGcloudAccount: mocks.mockSetGcloudAccount,
}))

import gcloudRoutes from '../../src/routes/gcloud'

describe('Gcloud routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify()
    app.register(gcloudRoutes, { prefix: '/api/gcloud' })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mocks.mockFetch)
  })

  afterAll(async () => {
    await app.close()
  })

  it('lists accounts and active account', async () => {
    mocks.mockIsGcloudInstalled.mockResolvedValue(true)
    mocks.mockListGcloudAccounts.mockResolvedValue([
      { account: 'alice@example.com', active: false },
      { account: 'principal://iam.googleapis.com/locations/global/workforcePools/example', active: true },
    ])

    const res = await app.inject({
      method: 'GET',
      url: '/api/gcloud/accounts',
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.active_account).toBe('principal://iam.googleapis.com/locations/global/workforcePools/example')
    expect(body.accounts).toHaveLength(2)
  })

  it('sets active account and invalidates caches', async () => {
    mocks.mockIsGcloudInstalled.mockResolvedValue(true)
    mocks.mockSetGcloudAccount.mockResolvedValue(undefined)

    const res = await app.inject({
      method: 'POST',
      url: '/api/gcloud/account',
      payload: {
        account: 'principal://iam.googleapis.com/locations/global/workforcePools/example',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(mocks.mockSetGcloudAccount).toHaveBeenCalledWith('principal://iam.googleapis.com/locations/global/workforcePools/example')
    expect(mocks.mockInvalidateGoogleStatusCache).toHaveBeenCalledTimes(1)
    expect(mocks.mockInvalidateGeminiStatusCache).toHaveBeenCalledTimes(1)
  })

  it('validates account payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/gcloud/account',
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error).toBe('account is required')
  })

  it('checks health for all configured accounts and marks healthy when one passes', async () => {
    mocks.mockIsGcloudInstalled.mockResolvedValue(true)
    mocks.mockGetGeminiSettings.mockResolvedValue({
      project: '',
      location: 'us-central1',
      defaultModel: 'gemini-2.5-flash',
      accounts: ['okta@example.com', 'personal@example.com'],
    })
    mocks.mockListGcloudAccounts.mockResolvedValue([
      { account: 'okta@example.com', active: true },
      { account: 'personal@example.com', active: false },
    ])
    mocks.mockGetGcloudAccessToken.mockImplementation(async (account: string) => {
      if (account === 'okta@example.com') return 'token-okta'
      return 'token-personal'
    })
    mocks.mockFetch
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValueOnce({ ok: true, status: 200 })

    const res = await app.inject({
      method: 'GET',
      url: '/api/gcloud/health',
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.healthy).toBe(true)
    expect(body.gcloud_installed).toBe(true)
    expect(body.account).toBe('okta@example.com')
    expect(body.active_account).toBe('okta@example.com')
    expect(body.account_checks).toHaveLength(2)
    expect(body.account_checks[0]).toMatchObject({
      account: 'okta@example.com',
      active: true,
      healthy: false,
    })
    expect(body.account_checks[1]).toMatchObject({
      account: 'personal@example.com',
      active: false,
      healthy: true,
      drive_access: true,
    })
  })

  it('checks only active account when accounts list is empty', async () => {
    mocks.mockIsGcloudInstalled.mockResolvedValue(true)
    mocks.mockGetGeminiSettings.mockResolvedValue({
      project: '',
      location: 'us-central1',
      defaultModel: 'gemini-2.5-flash',
      accounts: [],
    })
    mocks.mockListGcloudAccounts.mockResolvedValue([
      { account: 'okta@example.com', active: true },
      { account: 'personal@example.com', active: false },
    ])
    mocks.mockGetGcloudAccessToken.mockResolvedValue('token-okta')
    mocks.mockFetch.mockResolvedValue({ ok: true, status: 200 })

    const res = await app.inject({
      method: 'GET',
      url: '/api/gcloud/health',
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.account_checks).toHaveLength(1)
    expect(body.account_checks[0].account).toBe('okta@example.com')
    expect(body.healthy).toBe(true)
  })

  it('returns unhealthy when no authenticated accounts are configured', async () => {
    mocks.mockIsGcloudInstalled.mockResolvedValue(true)
    mocks.mockGetGeminiSettings.mockResolvedValue({
      project: '',
      location: 'us-central1',
      defaultModel: 'gemini-2.5-flash',
      accounts: [],
    })
    mocks.mockListGcloudAccounts.mockResolvedValue([])

    const res = await app.inject({
      method: 'GET',
      url: '/api/gcloud/health',
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.healthy).toBe(false)
    expect(body.authenticated).toBe(false)
    expect(body.account_checks).toEqual([])
    expect(body.error).toBe('gcloud not authenticated')
  })
})
