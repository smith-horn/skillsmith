/**
 * Skillsmith API Client
 * @module api/client
 *
 * SMI-1244: API client for Supabase endpoints. SMI-1258: Zod response validation.
 * SMI-4119: `recordEvent` batches via EventBatcher (see client.events.ts).
 */

import { z } from 'zod'
import type { Skill, SearchOptions } from '../types/skill.js'
import { SkillsmithError, ErrorCodes } from '../errors.js'
import {
  ApiClientError,
  type ApiResponse,
  type ApiErrorResponse,
  type ApiSearchResult,
  type ApiClientConfig,
  type RecommendationRequest,
  type TelemetryEvent,
} from './client.types.js'

export {
  ApiClientError,
  type ApiResponse,
  type ApiErrorResponse,
  type ApiSearchResult,
  type ApiClientConfig,
  type RecommendationRequest,
  type TelemetryEvent,
} from './client.types.js'

// Import from extracted modules
import { SearchResponseSchema, SingleSkillResponseSchema } from './schemas.js'
import {
  calculateBackoff,
  buildRequestHeaders,
  DEFAULT_BASE_URL,
  PRODUCTION_ANON_KEY,
} from './utils.js'
import { checkApiHealth } from './client.health.js'
import type { EventBatcher } from './event-batcher.js'
import { buildClientEventBatcher } from './client.events.js'
import { ApiCache } from './cache.js'
import { buildResponseCache, withResponseCache, type CallCacheOptions } from './client.cache.js'
import { tryRefreshToken } from './client.token-refresh.js'

export type { CallCacheOptions } from './client.cache.js'

// Re-export for backwards compatibility
export { generateAnonymousId } from './utils.js'
export { checkApiHealth } from './client.health.js'
export {
  ApiSearchResultSchema,
  SearchResponseSchema,
  SingleSkillResponseSchema,
  TelemetryResponseSchema,
  TrustTierSchema,
} from './schemas.js'

// ============================================================================
// API Client Class
// ============================================================================

/**
 * Skillsmith API Client. See module docstring for SMI refs.
 */
export class SkillsmithApiClient {
  private baseUrl: string
  private anonKey: string | undefined
  private apiKey: string | undefined
  private jwtToken: string | undefined
  private timeout: number
  private maxRetries: number
  private debug: boolean
  private offlineMode: boolean
  /** SMI-4119: Lazily-initialized batcher for telemetry events. */
  private eventBatcher: EventBatcher | null = null
  /** SMI-4120: Response cache (null when disabled). */
  private responseCache: ApiCache | null = null

  constructor(config: ApiClientConfig = {}) {
    // SMI-1948: DEFAULT_BASE_URL now always has a value (production URL fallback)
    // Priority: config.baseUrl > DEFAULT_BASE_URL (which checks env vars internally)
    const baseUrl = config.baseUrl || DEFAULT_BASE_URL

    // Offline mode must now be explicitly enabled via config or env var
    // SMI-1948: Previously, missing SUPABASE_URL caused implicit offline mode
    const explicitOfflineMode = config.offlineMode ?? process.env.SKILLSMITH_OFFLINE_MODE === 'true'
    this.offlineMode = explicitOfflineMode

    this.baseUrl = baseUrl
    // SMI-1949: Use production anon key as final fallback so users get authenticated access
    this.anonKey = config.anonKey || process.env.SUPABASE_ANON_KEY || PRODUCTION_ANON_KEY
    this.apiKey = config.apiKey || process.env.SKILLSMITH_API_KEY
    // SMI-4402: JWT Bearer token from device-code flow (takes precedence over apiKey)
    this.jwtToken = config.jwtToken
    this.timeout = config.timeout ?? 30000
    this.maxRetries = config.maxRetries ?? 3
    this.debug = config.debug ?? false
    this.responseCache = buildResponseCache(config.cache)
  }

  /** SMI-4120: Expose the response cache (null when disabled). */
  getResponseCache(): ApiCache | null {
    return this.responseCache
  }

  /**
   * Check if client is running in offline mode
   */
  isOffline(): boolean {
    return this.offlineMode
  }

  /**
   * Check if a personal API key is configured
   * SMI-1953: Allows users to verify their API key is being used
   *
   * @returns True if SKILLSMITH_API_KEY env var or config.apiKey is set
   */
  hasPersonalApiKey(): boolean {
    return !!this.apiKey
  }

  /**
   * Get the authentication mode being used
   * SMI-1953: Helps users understand which auth method is active
   *
   * @returns 'personal' if API key configured, 'anonymous' if using anon key, 'none' if no auth
   */
  getAuthMode(): 'jwt' | 'personal' | 'anonymous' | 'none' {
    if (this.jwtToken) return 'jwt'
    if (this.apiKey) return 'personal'
    if (this.anonKey) return 'anonymous'
    return 'none'
  }

  /** SMI-4402: Update the JWT token (e.g. after a refresh). */
  setJwtToken(token: string): void {
    this.jwtToken = token
  }

  /**
   * Log debug message
   */
  private log(message: string, data?: unknown): void {
    if (this.debug) {
      console.log(`[SkillsmithApiClient] ${message}`, data ?? '')
    }
  }

  /**
   * Make API request with retry logic and optional schema validation
   * SMI-1258: Added runtime validation for API responses
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    // Use structural typing for Zod v3/v4 compatibility
    schema?: {
      safeParse(data: unknown): { success: boolean; data?: ApiResponse<T>; error?: z.ZodError }
    }
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${endpoint}`
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        this.log(`Request attempt ${attempt + 1}:`, {
          url,
          method: options.method || 'GET',
          authMode: this.getAuthMode(),
        })

        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), this.timeout)

        // SMI-4402: JWT Bearer takes precedence over X-API-Key (legacy)
        const authHeader: Record<string, string> = {}
        if (this.jwtToken) {
          authHeader['Authorization'] = `Bearer ${this.jwtToken}`
        } else if (this.apiKey) {
          authHeader['X-API-Key'] = this.apiKey
        }

        const response = await fetch(url, {
          ...options,
          headers: {
            ...buildRequestHeaders(this.anonKey),
            ...authHeader,
            ...options.headers,
          },
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
          const errorBody = (await response
            .json()
            .catch(() => ({ error: 'Unknown error' }))) as ApiErrorResponse

          // SMI-4402: Refresh JWT on 401 expired_token, retry once
          if (
            response.status === 401 &&
            this.jwtToken &&
            (errorBody.error === 'expired_token' || errorBody.error === 'JWT expired')
          ) {
            const newToken = await tryRefreshToken()
            if (newToken) {
              this.jwtToken = newToken
              continue
            }
          }

          // Don't retry on client errors (4xx) - not retryable
          if (response.status >= 400 && response.status < 500) {
            throw new ApiClientError(
              errorBody.error || `API error: ${response.status}`,
              false, // not retryable
              response.status
            )
          }

          // Retry on server errors (5xx) and rate limits (429) - retryable
          if (response.status === 429 || response.status >= 500) {
            throw new ApiClientError(`Server error: ${response.status}`, true, response.status)
          }

          // Default: not retryable
          throw new ApiClientError(
            errorBody.error || `API error: ${response.status}`,
            false,
            response.status
          )
        }

        const rawData: unknown = await response.json()

        // SMI-1258: Validate response against schema if provided
        if (schema) {
          const validated = schema.safeParse(rawData)
          if (!validated.success && validated.error) {
            const issues = validated.error.issues
            const errorMessage = issues
              .map((issue: z.ZodIssue) => `${issue.path.join('.')}: ${issue.message}`)
              .join(', ')
            this.log('Response validation failed:', issues)
            throw new SkillsmithError(
              ErrorCodes.NETWORK_INVALID_RESPONSE,
              `Invalid API response: ${errorMessage}`,
              {
                details: {
                  endpoint,
                  validationErrors: issues,
                },
              }
            )
          }
          if (validated.success && validated.data) {
            this.log('Response received and validated:', { status: response.status })
            return validated.data
          }
          // Fallback if validation passed but no data (shouldn't happen, but type-safe)
          throw new SkillsmithError(
            ErrorCodes.NETWORK_INVALID_RESPONSE,
            'Validation passed but no data returned',
            { details: { endpoint } }
          )
        }

        // Fallback: return unvalidated data (for backwards compatibility)
        this.log('Response received:', { status: response.status })
        return rawData as ApiResponse<T>
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        this.log(`Attempt ${attempt + 1} failed:`, lastError.message)

        // Don't retry on abort errors
        if (lastError.name === 'AbortError') {
          throw lastError
        }

        // Don't retry on validation errors - malformed responses won't fix themselves
        if (
          lastError instanceof SkillsmithError &&
          lastError.code === ErrorCodes.NETWORK_INVALID_RESPONSE
        ) {
          throw lastError
        }

        // SMI-1257: Use custom error class instead of string matching
        // Don't retry on non-retryable API errors
        if (lastError instanceof ApiClientError && !lastError.retryable) {
          throw lastError
        }

        if (attempt < this.maxRetries) {
          const delay = calculateBackoff(attempt)
          this.log(`Retrying in ${delay}ms...`)
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    throw lastError || new Error('Request failed after retries')
  }

  /**
   * Search for skills
   * SMI-1258: Validates response against SearchResponseSchema
   * SMI-4120: Client LRU cache; opt-out via `{ cache: 'no-store' }`.
   */
  async search(
    options: SearchOptions,
    callOptions?: CallCacheOptions
  ): Promise<ApiResponse<ApiSearchResult[]>> {
    const params = new URLSearchParams()
    params.set('query', options.query)

    if (options.limit) params.set('limit', String(options.limit))
    if (options.offset) params.set('offset', String(options.offset))
    if (options.trustTier) params.set('trust_tier', options.trustTier)
    if (options.minQualityScore !== undefined)
      params.set('min_score', String(options.minQualityScore))
    if (options.category) params.set('category', options.category)

    const endpoint = `/skills-search?${params.toString()}`
    return withResponseCache(
      this.responseCache,
      'search',
      endpoint,
      callOptions?.cache === 'no-store',
      () => this.request<ApiSearchResult[]>(endpoint, {}, SearchResponseSchema)
    )
  }

  /**
   * Get skill by ID
   * SMI-1258: Validates response against SingleSkillResponseSchema
   * SMI-3672: Added includeContent option to fetch SKILL.md content
   * SMI-4120: Client LRU cache; opt-out via `{ cache: 'no-store' }`.
   */
  async getSkill(
    id: string,
    options?: { includeContent?: boolean } & CallCacheOptions
  ): Promise<ApiResponse<ApiSearchResult>> {
    const encodedId = encodeURIComponent(id)
    const contentParam = options?.includeContent ? '&include_content=true' : ''
    const endpoint = `/skills-get?id=${encodedId}${contentParam}`
    return withResponseCache(
      this.responseCache,
      'getSkill',
      endpoint,
      options?.cache === 'no-store',
      () => this.request<ApiSearchResult>(endpoint, {}, SingleSkillResponseSchema)
    )
  }

  /**
   * Get skill recommendations based on tech stack
   * SMI-1258: Validates response against SearchResponseSchema
   * SMI-4120: Client LRU cache; opt-out via `{ cache: 'no-store' }`.
   */
  async getRecommendations(
    request: RecommendationRequest,
    callOptions?: CallCacheOptions
  ): Promise<ApiResponse<ApiSearchResult[]>> {
    const cacheKey = ApiCache.createKey('/skills-recommend', {
      stack: [...request.stack].sort(),
      project_type: request.project_type ?? null,
      limit: request.limit ?? null,
    })
    return withResponseCache(
      this.responseCache,
      'recommend',
      cacheKey,
      callOptions?.cache === 'no-store',
      () =>
        this.request<ApiSearchResult[]>(
          '/skills-recommend',
          {
            method: 'POST',
            body: JSON.stringify(request),
          },
          SearchResponseSchema
        )
    )
  }

  /**
   * Record telemetry event
   * SMI-4119: Enqueue to in-memory batcher instead of POSTing immediately.
   * Returns `{ ok: true }` synchronously — batcher handles failures silently,
   * matching the prior "fail silently" contract for telemetry.
   */
  async recordEvent(event: TelemetryEvent): Promise<{ ok: boolean }> {
    if (this.offlineMode) return { ok: true }
    this.getOrCreateBatcher().enqueue(event)
    return { ok: true }
  }

  /** SMI-4119: Flush queued telemetry events (drain the batcher). */
  async flushEvents(): Promise<void> {
    if (this.eventBatcher) await this.eventBatcher.flush()
  }

  /** SMI-4119: Dispose batcher (detach exit listeners, clear timers). */
  disposeEventBatcher(): void {
    if (this.eventBatcher) {
      this.eventBatcher.dispose()
      this.eventBatcher = null
    }
  }

  private getOrCreateBatcher(): EventBatcher {
    if (!this.eventBatcher) {
      this.eventBatcher = buildClientEventBatcher(() => ({
        baseUrl: this.baseUrl,
        anonKey: this.anonKey,
        apiKey: this.apiKey,
        timeout: this.timeout,
      }))
    }
    return this.eventBatcher
  }

  /**
   * Check API health status
   */
  async checkHealth(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy'
    timestamp: string
    version: string
  }> {
    return checkApiHealth(this.baseUrl, this.anonKey, this.offlineMode)
  }

  /**
   * Convert API result to Skill type
   * SMI-1577: Handle optional fields with sensible defaults
   * SMI-825: Added security scan fields
   */
  static toSkill(result: ApiSearchResult): Skill {
    // Sentinel value for missing timestamps - clearly indicates unknown date
    const UNKNOWN_DATE = '1970-01-01T00:00:00.000Z'
    return {
      id: result.id,
      name: result.name,
      description: result.description,
      author: result.author,
      repoUrl: result.repo_url ?? null,
      qualityScore: result.quality_score,
      trustTier: result.trust_tier,
      tags: result.tags || [],
      installable: result.installable ?? false,
      // SMI-825: Security scan fields (default to not scanned for API results)
      riskScore: null,
      securityFindingsCount: 0,
      securityScannedAt: null,
      securityPassed: null,
      createdAt: result.created_at ?? UNKNOWN_DATE,
      updatedAt: result.updated_at ?? UNKNOWN_DATE,
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a default API client instance
 */
export function createApiClient(config?: ApiClientConfig): SkillsmithApiClient {
  return new SkillsmithApiClient(config)
}

export default SkillsmithApiClient
