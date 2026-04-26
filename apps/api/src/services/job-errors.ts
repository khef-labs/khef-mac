import { getRedis, isRedisHealthy } from './redis'

export interface JobErrorRecord {
  id: string
  timestamp: string
  jobId: string
  runId: string
  stepKey: string
  stepName: string
  definitionKey: string
  error: string
  model?: string
  backend?: string
  durationMs?: number
  promptExcerpt?: string
}

const KEY = 'kdag:errors'
const TTL_SECONDS = 86400 * 3 // 3 days
const MAX_ENTRIES = 100

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Store a kdag job step error in Redis for quick agent retrieval.
 * Capped at MAX_ENTRIES with 3-day TTL.
 */
export async function storeJobError(record: Omit<JobErrorRecord, 'id' | 'timestamp'>): Promise<void> {
  const healthy = await isRedisHealthy()
  if (!healthy) return

  const redis = getRedis()
  const entry: JobErrorRecord = {
    ...record,
    id: generateId(),
    timestamp: new Date().toISOString(),
  }

  await redis.lpush(KEY, JSON.stringify(entry))
  await redis.ltrim(KEY, 0, MAX_ENTRIES - 1)
  await redis.expire(KEY, TTL_SECONDS)
}

/**
 * Retrieve recent kdag job errors from Redis.
 * Optionally filter by jobId or definitionKey.
 */
export async function getJobErrors(opts?: {
  limit?: number
  jobId?: string
  definitionKey?: string
}): Promise<JobErrorRecord[]> {
  const healthy = await isRedisHealthy()
  if (!healthy) return []

  const redis = getRedis()
  // Fetch more than limit to allow filtering
  const fetchCount = Math.min((opts?.limit || 20) * 3, MAX_ENTRIES)
  const raw = await redis.lrange(KEY, 0, fetchCount - 1)
  let records = raw.map(r => JSON.parse(r) as JobErrorRecord)

  if (opts?.jobId) {
    records = records.filter(r => r.jobId === opts.jobId)
  }
  if (opts?.definitionKey) {
    records = records.filter(r => r.definitionKey === opts.definitionKey)
  }

  return records.slice(0, opts?.limit || 20)
}

/**
 * Clear all stored job error records.
 */
export async function clearJobErrors(): Promise<number> {
  const healthy = await isRedisHealthy()
  if (!healthy) return 0

  const redis = getRedis()
  const count = await redis.llen(KEY)
  await redis.del(KEY)
  return count
}
