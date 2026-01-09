/**
 * API Types matching OpenAPI specification
 * @module api/types
 *
 * These types are aligned with docs/api/openapi.yaml for type-safe API interactions.
 * Uses snake_case for API wire format compatibility.
 */

// ============================================================================
// Trust Tier (matches OpenAPI trust_tier enum)
// ============================================================================

/**
 * Trust tier levels from API
 */
export type ApiTrustTier = 'verified' | 'community' | 'experimental' | 'unknown'

// ============================================================================
// Category (matches OpenAPI category enum)
// ============================================================================

/**
 * Skill category filter values
 */
export type ApiCategory =
  | 'Development'
  | 'Testing'
  | 'DevOps'
  | 'Documentation'
  | 'Productivity'
  | 'Security'

// ============================================================================
// Project Type (matches OpenAPI project_type enum)
// ============================================================================

/**
 * Project type for recommendations
 */
export type ApiProjectType = 'web' | 'api' | 'cli' | 'mobile' | 'data' | 'ml'

// ============================================================================
// Skill Entity (matches OpenAPI Skill schema)
// ============================================================================

/**
 * Skill entity from API
 *
 * Represents a skill record with all properties.
 * Uses snake_case to match API wire format.
 */
export interface ApiSkill {
  /** Unique skill identifier (UUID) */
  id: string
  /** Skill name */
  name: string
  /** Skill description */
  description: string | null
  /** Skill author */
  author: string | null
  /** Source repository URL */
  repo_url: string | null
  /** Quality score (0-1 scale) */
  quality_score: number | null
  /** Trust level */
  trust_tier: ApiTrustTier
  /** Tags for categorization */
  tags: string[]
  /** GitHub stars count */
  stars: number | null
  /** Creation timestamp (ISO 8601) */
  created_at: string
  /** Last update timestamp (ISO 8601) */
  updated_at: string
  /** Associated category names */
  categories?: string[]
}

// ============================================================================
// Search Types (matches OpenAPI SearchResult, SearchResponse schemas)
// ============================================================================

/**
 * Search result from API (Skill with rank)
 */
export interface ApiSearchResult extends ApiSkill {
  /** Search relevance rank */
  rank?: number
}

/**
 * Search parameters for skills-search endpoint
 */
export interface SearchParams {
  /** Search query (minimum 2 characters) */
  query: string
  /** Filter by category name */
  category?: ApiCategory
  /** Filter by trust level */
  trust_tier?: ApiTrustTier
  /** Minimum quality score (0-100) */
  min_score?: number
  /** Maximum results to return (default 20, max 100) */
  limit?: number
  /** Pagination offset (default 0) */
  offset?: number
}

/**
 * Search response metadata
 */
export interface SearchResponseMeta {
  /** Original search query */
  query: string
  /** Total matching results */
  total: number
  /** Results limit */
  limit: number
  /** Pagination offset */
  offset: number
  /** Applied filters */
  filters: {
    category: string | null
    trust_tier: string | null
    min_score: number | null
  }
}

/**
 * Search response from API
 */
export interface SearchResponse {
  /** Search results */
  data: ApiSearchResult[]
  /** Response metadata */
  meta: SearchResponseMeta
}

// ============================================================================
// Recommendation Types (matches OpenAPI RecommendRequest, RecommendResponse)
// ============================================================================

/**
 * Recommended skill with relevance score
 */
export interface RecommendedSkill extends ApiSkill {
  /** Relevance score for the given stack */
  relevance_score?: number
}

/**
 * Recommendation request parameters
 */
export interface RecommendParams {
  /** Technology stack (1-10 items) */
  stack: string[]
  /** Type of project */
  project_type?: ApiProjectType
  /** Maximum recommendations (default 10, max 50) */
  limit?: number
}

/**
 * Recommendation response metadata
 */
export interface RecommendResponseMeta {
  /** Technology stack from request */
  stack: string[]
  /** Project type from request */
  project_type: string | null
  /** Total recommendations */
  total: number
  /** Results limit */
  limit: number
}

/**
 * Recommendation response from API
 */
export interface RecommendResponse {
  /** Recommended skills */
  data: RecommendedSkill[]
  /** Response metadata */
  meta: RecommendResponseMeta
}

// ============================================================================
// Get Skill Types (matches OpenAPI SkillResponse)
// ============================================================================

/**
 * Get skill response from API
 */
export interface SkillResponse {
  /** Skill data */
  data: ApiSkill
}

// ============================================================================
// Health Check Types
// ============================================================================

/**
 * Health status response
 */
export interface HealthStatus {
  /** Service status */
  status: 'healthy' | 'degraded' | 'unhealthy'
  /** Status timestamp (ISO 8601) */
  timestamp: string
  /** API version */
  version: string
}

// ============================================================================
// Telemetry Types (matches OpenAPI TelemetryEvent)
// ============================================================================

/**
 * Telemetry event types
 */
export type TelemetryEventType =
  | 'skill_view'
  | 'skill_install'
  | 'skill_uninstall'
  | 'skill_rate'
  | 'search'
  | 'recommend'
  | 'compare'
  | 'validate'

/**
 * Telemetry event metadata
 */
export interface TelemetryMetadata {
  /** Search query */
  query?: string
  /** Number of results */
  results_count?: number
  /** Operation duration in ms */
  duration_ms?: number
  /** Client version */
  version?: string
  /** Client platform */
  platform?: string
}

/**
 * Telemetry event payload
 */
export interface TelemetryEventPayload {
  /** Event type */
  event: TelemetryEventType
  /** Associated skill ID */
  skill_id?: string
  /** Anonymous client identifier (hex string) */
  anonymous_id: string
  /** Optional event metadata */
  metadata?: TelemetryMetadata
}

/**
 * Telemetry response
 */
export interface TelemetryResponse {
  /** Success indicator */
  ok: boolean
}

// ============================================================================
// Error Types (matches OpenAPI Error schema)
// ============================================================================

/**
 * API error response
 */
export interface ApiErrorResponse {
  /** Error message */
  error: string
  /** Additional error details */
  details?: Record<string, unknown>
}

// ============================================================================
// Rate Limit Headers
// ============================================================================

/**
 * Rate limit information from response headers
 */
export interface RateLimitInfo {
  /** Maximum requests per minute */
  limit: number
  /** Remaining requests in current window */
  remaining: number
  /** Unix timestamp when limit resets */
  reset: number
  /** Request tracking ID */
  requestId?: string
}

// ============================================================================
// API Client Options
// ============================================================================

/**
 * API client configuration options
 */
export interface ApiClientOptions {
  /** Base URL for API (default: https://api.skillsmith.app) */
  baseUrl?: string
  /** Request timeout in ms (default: 10000) */
  timeout?: number
  /** Cache TTL in ms (default: 86400000 - 24h) */
  cacheTtl?: number
  /** Enable offline mode */
  offlineMode?: boolean
  /** Supabase anon key for authentication */
  anonKey?: string
  /** Max retry attempts (default: 3) */
  maxRetries?: number
  /** Enable debug logging */
  debug?: boolean
}

// ============================================================================
// Generic API Response Wrapper
// ============================================================================

/**
 * Generic API response wrapper
 */
export interface ApiResponse<T> {
  /** Response data */
  data: T
  /** Response metadata */
  meta?: Record<string, unknown>
}
