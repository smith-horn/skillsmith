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
  ApiClientError,
  type ApiClientConfig,
  type ApiResponse,
  type ApiErrorResponse,
  type ApiSearchResult,
  type RecommendationRequest,
  type TelemetryEvent,
} from './client.js'

// SMI-5905 Wave 4: private-registry content fetch — the CLI's only transport
// to `private_registry_skills.content` (see client.private-registry.ts header).
export {
  getPrivateRegistrySkillContent,
  type PrivateRegistrySkillContent,
  type PrivateRegistryGetErrorCode,
  type PrivateRegistryGetResult,
  type GetPrivateRegistrySkillContentParams,
} from './client.private-registry.js'

// SMI-4119: Event batching
export {
  EventBatcher,
  createEventBatcher,
  type EventBatcherOptions,
  type BatchFlushFn,
} from './event-batcher.js'

// SMI-5897 (C-15): shared security-summary derivation — CLI (`toSkill()`)
// and MCP tool call sites both import this instead of independently
// reconstructing the passed/riskScore/findingsCount/scannedAt logic.
// SMI-5897 (Wave 4 fix): sibling `deriveSecuritySummaryFromSkillRow()` for
// the local-DB-shaped (pre-computed field) call sites.
export {
  deriveSecuritySummaryFromApiSkill,
  deriveSecuritySummaryFromSkillRow,
} from './security-summary.js'

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

export { API_TRUST_TIERS, API_CATEGORIES } from './types.js'

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
