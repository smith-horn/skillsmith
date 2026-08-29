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
 * SMI-4240: Added categories, security_score, last_scanned_at, security_findings
 *   to match the full `...skill` spread returned by skills-get (present on
 *   get-skill responses, omitted on skills-search responses).
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
  /**
   * SMI-6033 Wave 2 (Gap 8): true when the most recent scan could not cover
   * every candidate file (count/size cap, transient fetch failure, tree-fetch
   * failure, tree truncation, or tree-budget exhaustion). Informational only
   * — never blocks installability.
   */
  scan_coverage_incomplete?: boolean
  /** SMI-6033 Wave 2 (Gap 8): '; '-joined machine-readable cause token(s), or null when complete. */
  scan_coverage_note?: string | null
  /** SHA-256 hash of SKILL.md content at index time */
  content_hash?: string | null
  /** SMI-3672: Raw SKILL.md content (only when include_content=true) */
  content?: string | null
  created_at?: string
  updated_at?: string
  /** SMI-4240: Category display names joined from skill_categories */
  categories?: string[]
  /** SMI-4240: Security score 0-100 (lower is safer); null until first scan */
  security_score?: number | null
  /** SMI-4240: ISO 8601 timestamp of last security scan; null until first scan */
  last_scanned_at?: string | null
  /** SMI-4240: Security findings array (jsonb); length drives findingsCount */
  security_findings?: unknown[] | null
  /**
   * SMI-5327: SPDX license identifier surfaced by skills-get / skills-search.
   * Null means "unknown / not detected" — NOT public domain or "no restrictions".
   */
  license?: string | null
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
 * Options for `GET /registry-sync` — Team/Enterprise-tier-gated bulk
 * enumeration of the skill registry (see supabase/functions/registry-sync).
 * All fields optional; omitted fields fall back to the edge function's own
 * defaults (limit 100, offset 0, no `since` filter).
 */
export interface RegistrySyncOptions {
  limit?: number
  offset?: number
  /** ISO-8601 timestamp; only rows with `updated_at > since` are returned. */
  since?: string
}

/**
 * Platform statistics from `GET /stats` (basic, non-detailed response —
 * see supabase/functions/stats). The `detailed=true` diagnostic dashboard
 * shape is not modeled here; this client only calls the basic endpoint.
 */
export interface PlatformStats {
  skillCount: number
  githubTotal: number
  lastUpdated: string
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
  /** SMI-4402: JWT Bearer token from device-code flow (takes precedence over apiKey) */
  jwtToken?: string
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
