/**
 * Gemini API service using Vertex AI.
 * Uses gcloud CLI for authentication.
 */

import { query } from '../db/client'
import { getGcloudAccessToken, isGcloudInstalled, getGcloudAccount } from './gcloud'
import { logger } from '../lib/logger'

const log = logger.child({ component: 'gemini' })
const DEBUG_GEMINI = process.env.DEBUG_GEMINI === 'true'

interface GeminiSettings {
  project: string
  location: string
  defaultModel: string
  accounts: string[]
  vertexAccount: string
  driveAccount: string
}

interface GeminiContentPart {
  text?: string
  thought?: boolean
  inlineData?: {
    mimeType: string
    data: string
  }
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiContentPart[]
}

interface GeminiRequest {
  contents: GeminiContent[]
  systemInstruction?: {
    parts: Array<{ text: string }>
  }
  generationConfig?: {
    temperature?: number
    maxOutputTokens?: number
    topP?: number
    topK?: number
    responseModalities?: string[]
    thinkingConfig?: {
      thinkingBudget?: number
      includeThoughts?: boolean
    }
  }
  tools?: Array<{
    googleSearch?: Record<string, never>
    urlContext?: Record<string, never>
  }>
}

interface GroundingMetadata {
  webSearchQueries?: string[]
  searchEntryPoint?: {
    renderedContent?: string
  }
  groundingChunks?: Array<{
    web?: {
      uri?: string
      title?: string
    }
  }>
  groundingSupports?: Array<{
    segment?: {
      startIndex?: number
      endIndex?: number
      text?: string
    }
    groundingChunkIndices?: number[]
    confidenceScores?: number[]
  }>
}

interface UrlContextMetadata {
  urlMetadata?: Array<{
    retrievedUrl?: string
    urlRetrievalStatus?: string
  }>
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      role: string
      parts: GeminiContentPart[]
    }
    finishReason: string
    groundingMetadata?: GroundingMetadata
    urlContextMetadata?: UrlContextMetadata
  }>
  usageMetadata: {
    promptTokenCount: number
    candidatesTokenCount: number
    totalTokenCount: number
    thoughtsTokenCount?: number
  }
}

export interface GroundingSource {
  uri: string
  title: string
}

export interface UrlContextFetched {
  url: string
  status: string
}

export interface ResponsePart {
  type: 'text' | 'inline_data'
  text?: string
  mimeType?: string
  data?: string
}

export interface GenerateResult {
  response: string
  responseParts?: ResponsePart[]
  inputTokens: number
  outputTokens: number
  model: string
  grounding?: {
    searchQueries: string[]
    sources: GroundingSource[]
  }
  urlContext?: {
    fetched: UrlContextFetched[]
  }
  thinking?: {
    text: string
    tokenCount: number
  }
}

/**
 * Get Gemini settings from database.
 */
export async function getGeminiSettings(): Promise<GeminiSettings> {
  const rows = await query<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key LIKE 'gemini.%'"
  )

  const settings: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.replace('gemini.', '')
    settings[key] = row.value
  }

  return {
    project: settings.project || '',
    location: settings.location || 'us-central1',
    defaultModel: settings.defaultModel || 'gemini-2.5-flash',
    accounts: (() => {
      const raw = settings.accounts || '[]'
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          return parsed.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean)
        }
      } catch {
        // ignore invalid JSON and fall back to empty
      }
      return []
    })(),
    vertexAccount: settings.vertexAccount || '',
    driveAccount: settings.driveAccount || '',
  }
}

// Cache for status check (30 second TTL)
let statusCache: {
  result: {
    available: boolean
    reason?: string
    project?: string
    location?: string
    model?: string
    account?: string
  }
  expires: number
} | null = null

export function invalidateGeminiStatusCache(): void {
  statusCache = null
}

/**
 * Check if Gemini is properly configured.
 * Results are cached for 30 seconds to avoid slow gcloud calls.
 */
export async function checkGeminiStatus(): Promise<{
  available: boolean
  reason?: string
  project?: string
  location?: string
  model?: string
  account?: string
}> {
  // Return cached result if valid
  if (statusCache && Date.now() < statusCache.expires) {
    return statusCache.result
  }

  // Check gcloud CLI
  const gcloudInstalled = await isGcloudInstalled()
  if (!gcloudInstalled) {
    const result = { available: false, reason: 'gcloud CLI not installed' }
    statusCache = { result, expires: Date.now() + 30000 }
    return result
  }

  // Check gcloud auth
  const activeAccount = await getGcloudAccount()
  if (!activeAccount) {
    const result = { available: false, reason: 'gcloud not authenticated' }
    statusCache = { result, expires: Date.now() + 30000 }
    return result
  }

  // Check settings
  const settings = await getGeminiSettings()
  if (!settings.project) {
    const result = {
      available: false,
      reason: 'gemini.project setting not configured',
      account: activeAccount,
    }
    statusCache = { result, expires: Date.now() + 30000 }
    return result
  }

  const result = {
    available: true,
    project: settings.project,
    location: settings.location,
    model: settings.defaultModel,
    account: activeAccount,
  }
  statusCache = { result, expires: Date.now() + 30000 }
  return result
}

/** Model name patterns that support native image generation. */
const IMAGE_MODEL_PATTERNS = [
  /image/i,           // gemini-2.5-flash-image, gemini-2.0-flash-preview-image-generation
  /flash-exp/i,       // gemini-2.0-flash-exp (multimodal with image output)
  /imagen/i,          // imagen-3.0-generate
]

/**
 * Auto-detect responseModalities for image-capable models.
 * Returns ["TEXT", "IMAGE"] for known image models, undefined otherwise.
 */
function detectResponseModalities(model: string): string[] | undefined {
  if (IMAGE_MODEL_PATTERNS.some(p => p.test(model))) {
    return ['TEXT', 'IMAGE']
  }
  return undefined
}

/**
 * Generate content using Gemini API.
 */
export async function generateContent(
  prompt: string,
  options?: {
    model?: string
    temperature?: number
    maxOutputTokens?: number
    responseModalities?: string[]
    useGoogleSearch?: boolean
    useThinking?: boolean
    thinkingBudget?: number
    systemPrompt?: string
    contents?: GeminiContent[]
    maxRetries?: number
    useUrlContext?: boolean
  }
): Promise<GenerateResult> {
  const maxRetries = options?.maxRetries ?? 2
  const settings = await getGeminiSettings()

  if (!settings.project) {
    throw new Error('gemini.project setting not configured')
  }

  const model = options?.model || settings.defaultModel
  const activeAccount = settings.vertexAccount || (settings.accounts.length > 0 ? settings.accounts[0] : undefined)
  const accessToken = await getGcloudAccessToken(activeAccount)

  const endpoint = `https://${settings.location}-aiplatform.googleapis.com/v1/projects/${settings.project}/locations/${settings.location}/publishers/google/models/${model}:generateContent`

  const requestBody: GeminiRequest = {
    contents: options?.contents || [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
  }

  if (options?.temperature !== undefined || options?.maxOutputTokens !== undefined || options?.useThinking) {
    requestBody.generationConfig = {}
    if (options.temperature !== undefined) {
      requestBody.generationConfig.temperature = options.temperature
    }
    if (options.maxOutputTokens !== undefined) {
      requestBody.generationConfig.maxOutputTokens = options.maxOutputTokens
    }
  }

  // Set responseModalities — explicit option, or auto-detect for image models
  const modalities = options?.responseModalities || detectResponseModalities(model)
  if (modalities) {
    if (!requestBody.generationConfig) requestBody.generationConfig = {}
    requestBody.generationConfig.responseModalities = modalities
  }

  // Enable thinking if requested (Gemini 2.5+ models)
  if (options?.useThinking) {
    if (!requestBody.generationConfig) requestBody.generationConfig = {}
    requestBody.generationConfig.thinkingConfig = {
      includeThoughts: true,
      ...(options.thinkingBudget !== undefined && { thinkingBudget: options.thinkingBudget }),
    }
  }

  // Set system instruction if provided
  if (options?.systemPrompt) {
    requestBody.systemInstruction = {
      parts: [{ text: options.systemPrompt }],
    }
  }

  // Enable tools (Google Search grounding, URL context)
  if (options?.useGoogleSearch || options?.useUrlContext) {
    const tools: GeminiRequest['tools'] = []
    if (options?.useGoogleSearch) tools.push({ googleSearch: {} })
    if (options?.useUrlContext) tools.push({ urlContext: {} })
    requestBody.tools = tools
  }

  // Retry loop for transient empty responses
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Gemini API error (${response.status}, model=${model}): ${errorText}`)
    }

    const data = await response.json() as GeminiResponse

    if (DEBUG_GEMINI) {
      log.info({ rawResponse: JSON.stringify(data) }, 'Gemini raw response')
    }

    if (!data.candidates || data.candidates.length === 0) {
      log.warn({ rawResponse: JSON.stringify(data), model, attempt }, 'Gemini returned no candidates')
      throw new Error('No response candidates from Gemini')
    }

    const candidate = data.candidates[0]
    const finishReason = candidate.finishReason
    const responseText = candidate.content.parts
      .filter(p => p.text && !p.thought)
      .map(p => p.text)
      .join('')

    // Check for multimodal content (images, audio)
    const hasMultimodal = candidate.content.parts.some(p => p.inlineData)

    // Detect empty responses and surface the reason (allow image-only responses)
    if (!responseText.trim() && !hasMultimodal) {
      const partsSnapshot = JSON.stringify(candidate.content.parts)
      const diag: string[] = [`finishReason=${finishReason}`, `model=${model}`, `attempt=${attempt + 1}/${maxRetries + 1}`]
      if (data.usageMetadata) {
        diag.push(`tokens(in=${data.usageMetadata.promptTokenCount}, out=${data.usageMetadata.candidatesTokenCount})`)
      }
      const detail = diag.join(', ')

      // Always log raw response on empty text for diagnostics
      log.warn({ rawParts: partsSnapshot, finishReason, model, attempt, usageMetadata: data.usageMetadata }, 'Gemini returned empty text')

      // Non-retryable failures — throw immediately
      if (finishReason === 'SAFETY') {
        throw new Error(`Gemini response blocked by safety filters (${detail})`)
      }
      if (finishReason === 'RECITATION') {
        throw new Error(`Gemini response blocked for recitation/copyright (${detail})`)
      }
      if (finishReason === 'MAX_TOKENS') {
        throw new Error(`Gemini response hit max token limit with no output (${detail})`)
      }

      // Retryable: STOP with empty text, or unknown finish reasons
      if (attempt < maxRetries) {
        const delay = 1000 * (attempt + 1)
        log.info({ attempt, delay, finishReason, model }, 'Retrying Gemini request after empty response')
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }

      // Exhausted retries
      if (finishReason !== 'STOP') {
        throw new Error(`Gemini returned empty response after ${maxRetries + 1} attempts (${detail}). Raw parts: ${partsSnapshot}`)
      }
      throw new Error(`Gemini returned empty text despite finishReason=STOP after ${maxRetries + 1} attempts (${detail}). Raw parts: ${partsSnapshot}`)
    }

    // Extract thinking content if present
    const thinkingParts = candidate.content.parts.filter(p => p.thought && p.text)
    let thinking: GenerateResult['thinking']
    if (thinkingParts.length > 0) {
      thinking = {
        text: thinkingParts.map(p => p.text).join(''),
        tokenCount: data.usageMetadata?.thoughtsTokenCount || 0,
      }
    }

    // Build structured parts if any non-text content exists
    let responseParts: ResponsePart[] | undefined
    if (hasMultimodal) {
      responseParts = candidate.content.parts.map(p => {
        if (p.inlineData) {
          return {
            type: 'inline_data' as const,
            mimeType: p.inlineData.mimeType,
            data: p.inlineData.data,
          }
        }
        return {
          type: 'text' as const,
          text: p.text || '',
        }
      })
    }

    // Extract grounding metadata if present
    let grounding: GenerateResult['grounding']
    if (candidate.groundingMetadata) {
      const meta = candidate.groundingMetadata
      const sources: GroundingSource[] = (meta.groundingChunks || [])
        .filter(chunk => chunk.web?.uri && chunk.web?.title)
        .map(chunk => ({
          uri: chunk.web!.uri!,
          title: chunk.web!.title!,
        }))

      grounding = {
        searchQueries: meta.webSearchQueries || [],
        sources,
      }
    }

    // Extract url_context metadata (URLs Gemini fetched live via the urlContext tool)
    let urlContext: GenerateResult['urlContext']
    if (candidate.urlContextMetadata?.urlMetadata?.length) {
      urlContext = {
        fetched: candidate.urlContextMetadata.urlMetadata
          .filter(m => m.retrievedUrl)
          .map(m => ({
            url: m.retrievedUrl!,
            status: m.urlRetrievalStatus ?? 'UNKNOWN',
          })),
      }
    }

    if (attempt > 0) {
      log.info({ attempt, model }, 'Gemini retry succeeded')
    }

    return {
      response: responseText,
      responseParts,
      inputTokens: data.usageMetadata?.promptTokenCount || 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
      model,
      grounding,
      urlContext,
      thinking,
    }
  }

  // Should never reach here, but TypeScript needs it
  throw new Error('Gemini generateContent: unexpected end of retry loop')
}
