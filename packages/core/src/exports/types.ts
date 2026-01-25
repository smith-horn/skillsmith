/**
 * Type Exports
 * @module exports/types
 *
 * Barrel file for type-related exports
 */

// ============================================================================
// Core Types (SMI-577)
// ============================================================================

export type {
  Skill,
  SkillCreateInput,
  SkillUpdateInput,
  PaginatedResults,
  SearchOptions,
  SearchResult,
  TrustTier,
  CacheEntry,
  // SMI-1631: Skill roles for role-based recommendations
  SkillRole,
} from '../types/skill.js'

export { SKILL_ROLES } from '../types/skill.js'

// ============================================================================
// Search Types
// ============================================================================

export type { HybridSearchOptions, SearchQuery, SearchResponse } from '../search/index.js'

// ============================================================================
// Embeddings Types (Lazy loaded module)
// ============================================================================

export type {
  EmbeddingResult,
  SimilarityResult,
  EmbeddingServiceOptions,
} from '../embeddings/index.js'

// ============================================================================
// Cache Types
// ============================================================================

export type {
  SearchCacheEntry,
  SearchResult as CachedSearchResult,
  CacheStats,
  TieredCacheOptions,
} from '../cache/index.js'

// ============================================================================
// Security Types
// ============================================================================

export type {
  SecurityFinding,
  ScanReport,
  ScannerOptions,
  PathValidationOptions,
  PathValidationResult,
} from '../security/index.js'

// ============================================================================
// MCP Types (SMI-581, SMI-582)
// ============================================================================

export {
  TrustTierDescriptions,
  type TrustTier as MCPTrustTier,
  type SkillCategory,
  type ScoreBreakdown,
  type Skill as MCPSkill,
  type SkillSearchResult,
  type SearchFilters,
  type SearchResponse as MCPSearchResponse,
  type GetSkillResponse,
} from '../types.js'

// ============================================================================
// Error Types (SMI-583, SMI-881)
// ============================================================================

export type { ErrorCategory, ErrorCode, ErrorResponse } from '../errors.js'

// ============================================================================
// API Types (SMI-1244, SMI-1245, SMI-1300)
// ============================================================================

export type {
  ApiClientConfig,
  ApiResponse,
  ApiErrorResponse,
  ApiSearchResult,
  RecommendationRequest,
  TelemetryEvent,
  CacheConfig,
  CacheStats as ApiCacheStats,
  // OpenAPI-aligned types
  ApiTrustTier,
  ApiCategory,
  ApiProjectType,
  ApiSkill,
  SearchParams,
  SearchResponse as ApiSearchResponse,
  RecommendParams,
  RecommendResponse,
  SkillResponse,
  HealthStatus,
  TelemetryEventType,
  TelemetryEventPayload,
  RateLimitInfo,
  ApiClientOptions,
} from '../api/index.js'

// ============================================================================
// Rate Limit Types (SMI-730, SMI-1189)
// ============================================================================

export type {
  RateLimitConfig,
  RateLimitResult,
  RateLimitStorage,
  RateLimitMetrics,
} from '../security/index.js'

// ============================================================================
// Telemetry Types (SMI-739, SMI-1018, SMI-1184)
// ============================================================================

export type {
  TracerConfig,
  SpanAttributes,
  SpanWrapper,
  MetricsConfig,
  MetricLabels,
  Counter,
  Histogram,
  Gauge,
  MetricsSnapshot,
  PrometheusExportOptions,
  PostHogConfig,
  SkillsmithEventType,
  SkillEventProperties,
  AllowedUserTraits,
} from '../telemetry/index.js'

// ============================================================================
// Analytics Types (Phase 4: Epic 3 & Epic 4)
// ============================================================================

export type {
  UsageEvent,
  UsageEventInput,
  UsageEventType,
  Experiment,
  ExperimentInput,
  ExperimentStatus,
  ExperimentVariant,
  ExperimentAssignment,
  ExperimentOutcome,
  OutcomeInput,
  ExperimentAnalysis,
  ROIMetrics,
  ROIMetricType,
  ValueAttribution,
  AttributionType,
  ValueDimension,
  UsageAnalyticsSummary,
  ROIDashboard,
  ExportFormat,
  ExportOptions,
  // SMI-914: Skill usage event tracking types
  SkillUsageEvent,
  SkillUsageOutcome,
  SkillMetrics,
  UsageTrackerOptions,
  // SMI-915: Metrics aggregation and export types
  MetricsAggregator,
  MetricsExporter,
  AggregationPeriod,
  GlobalMetrics,
  MetricsExport,
} from '../analytics/index.js'

// ============================================================================
// Benchmark Types (SMI-632, SMI-738)
// ============================================================================

export type {
  BenchmarkConfig,
  BenchmarkResult,
  BenchmarkStats,
  BenchmarkReport,
  BenchmarkDefinition,
  BenchmarkFn,
  MemoryStats,
  EnvironmentInfo,
  ComparisonResult,
  MetricComparison,
  SearchBenchmarkConfig,
  ValidationResult as BenchmarkValidationResult,
  IndexBenchmarkConfig,
  ThroughputResult,
  SizeImpactResult,
  IndexValidationResult,
  CLIOptions,
  CacheBenchmarkConfig,
  CacheValidationResult,
  EmbeddingBenchmarkConfig,
  EmbeddingValidationResult,
} from '../benchmarks/index.js'

// ============================================================================
// Audit Logger Types (SMI-733)
// ============================================================================

export type {
  AuditEventType,
  AuditActor,
  AuditResult,
  AuditLogEntry,
  AuditQueryFilter,
  AuditLoggerConfig,
  AuditStats,
} from '../security/AuditLogger.js'
