/**
 * @skillsmith/core - Core functionality for skill discovery
 */

// Version
export const VERSION = '0.2.0'

// ============================================================================
// Grouped Exports from Barrel Files
// ============================================================================

// Services - All service exports including optimization, session, indexer, etc.
export * from './exports/services.js'

// Repositories - Database, repositories, quarantine, migrations
export * from './exports/repositories.js'

// Types - All type definitions
export * from './exports/types.js'

// ============================================================================
// Direct Exports (modules that don't fit cleanly into grouped barrels)
// ============================================================================

// API Client (SMI-1244, SMI-1245, SMI-1300)
export {
  SkillsmithApiClient,
  createApiClient,
  generateAnonymousId,
  ApiCache,
  createCache,
  getGlobalCache,
  DEFAULT_TTL,
} from './api/index.js'

// Search
export { HybridSearch } from './search/index.js'

// Cache
export { L1Cache, L2Cache, TieredCache } from './cache/index.js'

// Security
export { SecurityScanner } from './security/index.js'

// SMI-898: Path Traversal Protection
export {
  validateDbPath,
  validateDbPathOrThrow,
  isPathSafe,
  DEFAULT_ALLOWED_DIRS,
} from './security/index.js'

// Error handling (SMI-583)
export {
  ErrorCodes,
  ErrorSuggestions,
  SkillsmithError,
  createErrorResponse,
  withErrorBoundary,
} from './errors.js'

// Enhanced error classes with cause chaining (SMI-881)
export {
  SkillsmithError as SkillsmithErrorV2,
  NetworkError,
  ApiError,
  ValidationError,
  SkillError,
  ConfigurationError,
  wrapError,
  getErrorMessage,
  isSkillsmithError,
} from './errors/index.js'

// Benchmarks (SMI-632)
export {
  BenchmarkRunner,
  SearchBenchmark,
  IndexBenchmark,
  runAllBenchmarks,
  formatReportAsJson,
  formatReportAsText,
  compareReports,
  validateSearchResults,
  validateIndexResults,
  SEARCH_TARGETS,
  INDEX_TARGETS,
  // SMI-738: Cache and embedding benchmarks
  CacheBenchmark,
  EmbeddingBenchmark,
  CACHE_TARGETS,
  EMBEDDING_TARGETS,
  validateCacheResults,
  validateEmbeddingResults,
} from './benchmarks/index.js'

// Telemetry (SMI-739)
export {
  SkillsmithTracer,
  getTracer,
  initializeTracing,
  shutdownTracing,
  traced,
  MetricsRegistry,
  getMetrics,
  initializeMetrics,
  timeAsync,
  timeSync,
  initializeTelemetry,
  shutdownTelemetry,
  LATENCY_BUCKETS,
  // SMI-1018: Prometheus metrics export
  exportToPrometheus,
  getPrometheusMetrics,
  createPrometheusHandler,
  // SMI-1184: PostHog telemetry
  initializePostHog,
  shutdownPostHog,
  flushPostHog,
  trackEvent,
  trackSkillSearch,
  trackSkillView,
  trackSkillInstall,
  trackApiError,
  identifyUser,
  isFeatureFlagEnabled,
  getPostHog,
  isPostHogEnabled,
  ALLOWED_TRAITS,
} from './telemetry/index.js'

// Analytics (Phase 4: Epic 3 & Epic 4)
export {
  UsageAnalyticsService,
  ExperimentService,
  ROIDashboardService,
  // SMI-914: Skill usage event tracking
  anonymizeUserId,
  hashProjectContext,
  AnalyticsStorage,
  UsageTracker,
} from './analytics/index.js'

// Security (SMI-730, SMI-1189: Split into modular subpackages)
export {
  RateLimiter,
  InMemoryRateLimitStorage,
  createRateLimiterFromPreset,
  RATE_LIMIT_PRESETS,
  RateLimitQueueTimeoutError,
  RateLimitQueueFullError,
} from './security/index.js'

// Audit Logging (SMI-733)
export { AuditLogger, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS } from './security/AuditLogger.js'

// Source Adapters (SMI-589)
export {
  BaseSourceAdapter,
  SourceAdapterRegistry,
  SourceIndexer,
  defaultRegistry,
  isSourceAdapter,
} from './sources/index.js'

export type {
  ISourceAdapter,
  SourceType,
  SourceConfig,
  RateLimitConfig as SourceRateLimitConfig,
  SourceAuthConfig,
  SourceLocation,
  SourceRepository,
  SkillContent,
  SourceSearchOptions,
  SourceSearchResult,
  SkillIndexResult,
  BatchIndexResult,
  SourceHealth,
  SourceAdapterFactory,
  RegistryStats,
  ParsedSkillMetadata as SourceParsedSkillMetadata,
  ISkillParser,
  ISkillRepository,
  SourceIndexerOptions,
} from './sources/index.js'

// ============================================================================
// LIVE SERVICES WORKTREE STUBS (Phase 0 - Conflict Prevention)
// ============================================================================
// These stubs are added BEFORE worktree creation to prevent merge conflicts.
// Each workstream will uncomment ONLY their export line when implementing.
// ============================================================================

// Security Scanner Enhancement (WS2: SMI-1454, SMI-1456) - to be implemented
// export * from './security/scanner-enhanced.js'

// Monitoring & Health (WS5: SMI-1447, SMI-1453) - to be implemented
// export * from './monitoring/index.js'
