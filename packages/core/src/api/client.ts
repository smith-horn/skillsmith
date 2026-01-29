/**
 * Skillsmith API Client
 * @module api/client
 *
 * SMI-1244: API client for fetching skills from live Supabase endpoints
 * SMI-1258: Runtime validation for API responses using zod
 *
 * Provides methods to interact with the Skillsmith API:
 * - search: Search skills with filters
 * - getSkill: Get skill by ID
 * - getRecommendations: Get skill recommendations based on tech stack
 * - recordEvent: Record telemetry event
 */

import { z } from 'zod'
import type { Skill, TrustTier, SearchOptions } from '../types/skill.js'
import { SkillsmithError, ErrorCodes } from '../errors.js'

// Import from extracted modules
import {
  SearchResponseSchema,
  SingleSkillResponseSchema,
  TelemetryResponseSchema,
} from './schemas.js'
import {
  calculateBackoff,
  buildRequestHeaders,
  DEFAULT_BASE_URL,
  PRODUCTION_ANON_KEY,
} from './utils.js'

// Re-export for backwards compatibility
export { generateAnonymousId } from './utils.js'
export {
  ApiSearchResultSchema,
  SearchResponseSchema,
  SingleSkillResponseSchema,
  TelemetryResponseSchema,
  TrustTierSchema,
} from './schemas.js'

// ============================================================================
// Types
// ============================================================================

/**
 * API response wrapper
 */
export interface ApiResponse<T> {
  data: T
  meta?: Record<string, unknown>
}

/**
 * API error response
 */
export interface ApiErrorResponse {
  error: string
  details?: Record<string, unknown>
}

/**
 * Custom error class for API client errors with retry control
 * SMI-1257: Replace string-based retry skip with custom error class
 */
export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean = false,
    public readonly statusCode?: number
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}

/**
 * Search result from API
 * SMI-1577: Made repo_url, created_at, updated_at optional to match schema
 */
export interface ApiSearchResult {
  id: string
  name: string
  description: string | null
  author: string | null
  repo_url?: string | null
  quality_score: number | null
  trust_tier: TrustTier
  tags: string[]
  stars?: number | null
  installable?: boolean | null
  created_at?: string
  updated_at?: string
}

/**
 * Recommendation request
 */
export interface RecommendationRequest {
  stack: string[]
  project_type?: string
  limit?: number
}

/**
 * Telemetry event
 */
export interface TelemetryEvent {
  event:
    | 'skill_view'
    | 'skill_install'
    | 'skill_uninstall'
    | 'skill_rate'
    | 'search'
    | 'recommend'
    | 'compare'
    | 'validate'
  skill_id?: string
  anonymous_id: string
  metadata?: Record<string, unknown>
}

/**
 * API client configuration
 */
export interface ApiClientConfig {
  /** Base URL for the API (defaults to production Supabase) */
  baseUrl?: string
  /** Supabase anon key for authentication */
  anonKey?: string
  /** API key for authenticated requests (X-API-Key header) */
  apiKey?: string
  /** Request timeout in ms (default 30000) */
  timeout?: number
  /** Max retry attempts (default 3) */
  maxRetries?: number
  /** Enable debug logging */
  debug?: boolean
  /** Enable offline mode (disables API calls) */
  offlineMode?: boolean
}

// ============================================================================
// API Client Class
// ============================================================================

/**
 * Skillsmith API Client
 *
 * @example
 * ```typescript
 * const client = new SkillsmithApiClient({
 *   anonKey: process.env.SUPABASE_ANON_KEY,
 * });
 *
 * const results = await client.search({ query: 'testing' });
 * console.log(results.data);
 * ```
 */
export class SkillsmithApiClient {
  private baseUrl: string
  private anonKey: string | undefined
  private apiKey: string | undefined
  private timeout: number
  private maxRetries: number
  private debug: boolean
  private offlineMode: boolean

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
    this.timeout = config.timeout ?? 30000
    this.maxRetries = config.maxRetries ?? 3
    this.debug = config.debug ?? false
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
  getAuthMode(): 'personal' | 'anonymous' | 'none' {
    if (this.apiKey) return 'personal'
    if (this.anonKey) return 'anonymous'
    return 'none'
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
    schema?: z.ZodType<ApiResponse<T>>
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

        const response = await fetch(url, {
          ...options,
          headers: {
            ...buildRequestHeaders(this.anonKey),
            ...(this.apiKey && { 'X-API-Key': this.apiKey }),
            ...options.headers,
          },
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
          const errorBody = (await response
            .json()
            .catch(() => ({ error: 'Unknown error' }))) as ApiErrorResponse

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
          if (!validated.success) {
            const errorMessage = validated.error.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join(', ')
            this.log('Response validation failed:', validated.error.issues)
            throw new SkillsmithError(
              ErrorCodes.NETWORK_INVALID_RESPONSE,
              `Invalid API response: ${errorMessage}`,
              {
                details: {
                  endpoint,
                  validationErrors: validated.error.issues,
                },
              }
            )
          }
          this.log('Response received and validated:', { status: response.status })
          return validated.data
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
   */
  async search(options: SearchOptions): Promise<ApiResponse<ApiSearchResult[]>> {
    const params = new URLSearchParams()
    params.set('query', options.query)

    if (options.limit) params.set('limit', String(options.limit))
    if (options.offset) params.set('offset', String(options.offset))
    if (options.trustTier) params.set('trust_tier', options.trustTier)
    if (options.minQualityScore !== undefined)
      params.set('min_score', String(options.minQualityScore))
    if (options.category) params.set('category', options.category)

    return this.request<ApiSearchResult[]>(
      `/skills-search?${params.toString()}`,
      {},
      SearchResponseSchema
    )
  }

  /**
   * Get skill by ID
   * SMI-1258: Validates response against SingleSkillResponseSchema
   */
  async getSkill(id: string): Promise<ApiResponse<ApiSearchResult>> {
    const encodedId = encodeURIComponent(id)
    return this.request<ApiSearchResult>(
      `/skills-get?id=${encodedId}`,
      {},
      SingleSkillResponseSchema
    )
  }

  /**
   * Get skill recommendations based on tech stack
   * SMI-1258: Validates response against SearchResponseSchema
   */
  async getRecommendations(
    request: RecommendationRequest
  ): Promise<ApiResponse<ApiSearchResult[]>> {
    return this.request<ApiSearchResult[]>(
      '/skills-recommend',
      {
        method: 'POST',
        body: JSON.stringify(request),
      },
      SearchResponseSchema
    )
  }

  /**
   * Record telemetry event
   * SMI-1258: Validates response against TelemetryResponseSchema
   */
  async recordEvent(event: TelemetryEvent): Promise<{ ok: boolean }> {
    try {
      const response = await this.request<{ ok: boolean }>(
        '/events',
        {
          method: 'POST',
          body: JSON.stringify(event),
        },
        TelemetryResponseSchema
      )
      return response.data
    } catch {
      // Telemetry should not throw - fail silently
      this.log('Telemetry event failed (non-blocking)')
      return { ok: false }
    }
  }

  /**
   * Check API health status
   */
  async checkHealth(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy'
    timestamp: string
    version: string
  }> {
    // In offline mode, return synthetic healthy status
    if (this.offlineMode) {
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: 'offline',
      }
    }

    try {
      // Simple health check - try to reach the API
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000) // 5s timeout for health

      const response = await fetch(`${this.baseUrl}/health`, {
        headers: buildRequestHeaders(this.anonKey),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        // Try to parse JSON response, fall back to basic healthy status
        try {
          const data = (await response.json()) as { status?: string; version?: string }
          return {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: data.version || '1.0.0',
          }
        } catch {
          return {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          }
        }
      }

      // Non-OK response indicates degraded service
      return {
        status: response.status >= 500 ? 'unhealthy' : 'degraded',
        timestamp: new Date().toISOString(),
        version: 'unknown',
      }
    } catch (error) {
      this.log('Health check failed:', error)

      // Network errors indicate unhealthy service
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        version: 'unknown',
      }
    }
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
