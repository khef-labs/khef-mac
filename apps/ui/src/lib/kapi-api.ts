import ky from 'ky'
import type {
  KapiCollection,
  KapiDefinition,
  KapiEnvVar,
  KapiEnvironment,
  KapiHttpMethod,
  KapiKeyValue,
  KapiRequest,
  KapiRun,
} from '../types/kapi'

const API_BASE = (() => {
  const envApiBase = import.meta.env.VITE_API_BASE_URL as string | undefined
  return (
    envApiBase ||
    (typeof window !== 'undefined' && window.location?.origin
      ? `${window.location.origin}/api`
      : 'http://localhost:3000/api')
  )
})()

const client = ky.create({
  prefixUrl: API_BASE,
  timeout: 30000,
  hooks: {
    beforeError: [
      async (error) => {
        const { response } = error
        if (response) {
          try {
            const body = (await response.clone().json()) as { error?: string }
            if (body?.error) error.message = body.error
          } catch {
            /* noop */
          }
        }
        return error
      },
    ],
  },
})

// ---------- Collections ----------
export async function listKapiCollections(): Promise<KapiCollection[]> {
  const res = await client
    .get(`kapi/collections`)
    .json<{ collections: KapiCollection[] }>()
  return res.collections
}

export async function createKapiCollection(input: {
  handle: string
  name: string
  description?: string | null
}): Promise<KapiCollection> {
  const res = await client
    .post(`kapi/collections`, { json: input })
    .json<{ collection: KapiCollection }>()
  return res.collection
}

export async function updateKapiCollection(
  id: string,
  input: Partial<Pick<KapiCollection, 'handle' | 'name' | 'description' | 'allow_insecure_tls'>>
): Promise<KapiCollection> {
  const res = await client
    .patch(`kapi/collections/${id}`, { json: input })
    .json<{ collection: KapiCollection }>()
  return res.collection
}

export async function deleteKapiCollection(id: string): Promise<void> {
  await client.delete(`kapi/collections/${id}`)
}

// ---------- Definitions ----------
export async function listKapiDefinitions(collectionId: string): Promise<KapiDefinition[]> {
  const res = await client
    .get(`kapi/collections/${collectionId}/definitions`)
    .json<{ definitions: KapiDefinition[] }>()
  return res.definitions
}

export async function createKapiDefinition(
  collectionId: string,
  input: {
    handle: string
    name: string
    description?: string | null
    base_url?: string | null
  }
): Promise<KapiDefinition> {
  const res = await client
    .post(`kapi/collections/${collectionId}/definitions`, { json: input })
    .json<{ definition: KapiDefinition }>()
  return res.definition
}

export async function updateKapiDefinition(
  id: string,
  input: Partial<Pick<KapiDefinition, 'handle' | 'name' | 'description' | 'base_url'>>
): Promise<KapiDefinition> {
  const res = await client
    .patch(`kapi/definitions/${id}`, { json: input })
    .json<{ definition: KapiDefinition }>()
  return res.definition
}

export async function deleteKapiDefinition(id: string): Promise<void> {
  await client.delete(`kapi/definitions/${id}`)
}

// ---------- Requests ----------
export async function listKapiRequests(definitionId: string): Promise<KapiRequest[]> {
  const res = await client
    .get(`kapi/definitions/${definitionId}/requests`)
    .json<{ requests: KapiRequest[] }>()
  return res.requests
}

export async function createKapiRequest(
  definitionId: string,
  input: {
    name: string
    method: KapiHttpMethod
    path?: string
    headers?: KapiKeyValue[]
    query_params?: KapiKeyValue[]
    body_type?: string
    body_content?: string
    body_language?: string
  }
): Promise<KapiRequest> {
  const res = await client
    .post(`kapi/definitions/${definitionId}/requests`, { json: input })
    .json<{ request: KapiRequest }>()
  return res.request
}

export async function updateKapiRequest(
  id: string,
  input: Partial<KapiRequest>
): Promise<KapiRequest> {
  const res = await client
    .patch(`kapi/requests/${id}`, { json: input })
    .json<{ request: KapiRequest }>()
  return res.request
}

export async function deleteKapiRequest(id: string): Promise<void> {
  await client.delete(`kapi/requests/${id}`)
}

// ---------- Environments & vars ----------
export async function listKapiEnvironments(collectionId: string): Promise<KapiEnvironment[]> {
  const res = await client
    .get(`kapi/collections/${collectionId}/environments`)
    .json<{ environments: KapiEnvironment[] }>()
  return res.environments
}

export async function createKapiEnvironment(
  collectionId: string,
  input: { handle: string; name: string; is_active?: boolean }
): Promise<KapiEnvironment> {
  const res = await client
    .post(`kapi/collections/${collectionId}/environments`, { json: input })
    .json<{ environment: KapiEnvironment }>()
  return res.environment
}

export async function updateKapiEnvironment(
  id: string,
  input: Partial<Pick<KapiEnvironment, 'handle' | 'name'>>
): Promise<KapiEnvironment> {
  const res = await client
    .patch(`kapi/environments/${id}`, { json: input })
    .json<{ environment: KapiEnvironment }>()
  return res.environment
}

export async function deleteKapiEnvironment(id: string): Promise<void> {
  await client.delete(`kapi/environments/${id}`)
}

export async function activateKapiEnvironment(id: string): Promise<KapiEnvironment> {
  const res = await client
    .post(`kapi/environments/${id}/activate`)
    .json<{ environment: KapiEnvironment }>()
  return res.environment
}

export async function listKapiEnvVars(environmentId: string): Promise<KapiEnvVar[]> {
  const res = await client
    .get(`kapi/environments/${environmentId}/vars`)
    .json<{ vars: KapiEnvVar[] }>()
  return res.vars
}

export async function upsertKapiEnvVar(
  environmentId: string,
  input: { key: string; value: string; is_secret?: boolean; description?: string | null }
): Promise<KapiEnvVar> {
  const res = await client
    .post(`kapi/environments/${environmentId}/vars`, { json: input })
    .json<{ var: KapiEnvVar }>()
  return res.var
}

export async function deleteKapiEnvVar(environmentId: string, key: string): Promise<void> {
  await client.delete(`kapi/environments/${environmentId}/vars/${encodeURIComponent(key)}`)
}

export async function renameKapiEnvVar(
  environmentId: string,
  oldKey: string,
  newKey: string
): Promise<KapiEnvVar> {
  const res = await client
    .patch(
      `kapi/environments/${environmentId}/vars/${encodeURIComponent(oldKey)}/rename`,
      { json: { new_key: newKey } }
    )
    .json<{ var: KapiEnvVar }>()
  return res.var
}

// ---------- Runner ----------
export async function runKapiRequest(
  requestId: string,
  options?: { allow_insecure_tls?: boolean; timeout_ms?: number },
  signal?: AbortSignal
): Promise<KapiRun> {
  const res = await client
    .post(`kapi/requests/${requestId}/run`, { json: options ?? {}, signal })
    .json<{ run: KapiRun }>()
  return res.run
}

export async function runKapiAdHoc(
  collectionId: string,
  input: {
    method: KapiHttpMethod
    url: string
    headers?: KapiKeyValue[]
    body?: string | null
    environment_id?: string | null
  }
): Promise<KapiRun> {
  const res = await client
    .post(`kapi/collections/${collectionId}/runs`, { json: input })
    .json<{ run: KapiRun }>()
  return res.run
}

export async function listKapiRuns(
  collectionId: string,
  params?: { request_id?: string; limit?: number }
): Promise<KapiRun[]> {
  const searchParams = new URLSearchParams()
  if (params?.request_id) searchParams.set('request_id', params.request_id)
  if (params?.limit) searchParams.set('limit', String(params.limit))
  const res = await client
    .get(`kapi/collections/${collectionId}/runs`, { searchParams })
    .json<{ runs: KapiRun[] }>()
  return res.runs
}
