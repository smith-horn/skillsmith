/**
 * API module exports
 * @module api
 *
 * SMI-1244: API client for Skillsmith
 * SMI-1245: API response caching
 * SMI-1300: API types matching OpenAPI spec
 */

// ============================================================================
// API Client
// ============================================================================

export {
  SkillsmithApiClient,
  createApiClient,
  generateAnonymousId,
  type ApiClientConfig,
  type ApiResponse,
  type ApiErrorResponse,
  type ApiSearchResult,
  type RecommendationRequest,
  type TelemetryEvent,
} from './client.js'

// ============================================================================
// API Cache
// ============================================================================

export {
  ApiCache,
  createCache,
  getGlobalCache,
  DEFAULT_TTL,
  type CacheConfig,
  type CacheStats,
} from './cache.js'

// ============================================================================
// API Types (OpenAPI-aligned)
// ============================================================================

export type {
  // Trust tier and enums
  ApiTrustTier,
  ApiCategory,
  ApiProjectType,
  // Skill entities
  ApiSkill,
  ApiSearchResult as OpenApiSearchResult,
  RecommendedSkill,
  // Search types
  SearchParams,
  SearchResponse,
  SearchResponseMeta,
  // Recommendation types
  RecommendParams,
  RecommendResponse,
  RecommendResponseMeta,
  // Get skill types
  SkillResponse,
  // Health check
  HealthStatus,
  // Telemetry types
  TelemetryEventType,
  TelemetryMetadata,
  TelemetryEventPayload,
  TelemetryResponse,
  // Error types
  ApiErrorResponse as OpenApiErrorResponse,
  // Rate limit
  RateLimitInfo,
  // Client options
  ApiClientOptions,
  // Generic response
  ApiResponse as OpenApiResponse,
} from './types.js'
