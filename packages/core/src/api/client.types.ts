/**
 * API client types & error class
 * @module api/client.types
 *
 * SMI-4120: Extracted from client.ts to keep the client under the 500-line
 * pre-commit gate (scripts/check-file-length.mjs).
 */

import type { TrustTier } from '../types/skill.js'
import type { ClientCacheSetting } from './client.cache.js'

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
  quarantined?: boolean
  /** SHA-256 hash of SKILL.md content at index time */
  content_hash?: string | null
  /** SMI-3672: Raw SKILL.md content (only when include_content=true) */
  content?: string | null
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
  /**
   * SMI-4120: Response cache config. Provide a pre-built ApiCache, a config
   * object, or `false` to disable. `SKILLSMITH_DISABLE_CLIENT_CACHE=1` also
   * disables (takes precedence).
   */
  cache?: ClientCacheSetting
}
