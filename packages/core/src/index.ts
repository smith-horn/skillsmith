/**
 * @skillsmith/core - Core functionality for skill discovery
 */

// Version
export const VERSION = '0.1.0'

// Database (SMI-577)
export {
  SCHEMA_VERSION,
  createDatabase,
  closeDatabase,
  initializeSchema,
  getSchemaVersion,
  runMigrations,
} from './db/schema.js'

// Repositories (SMI-578, SMI-628)
export { SkillRepository } from './repositories/SkillRepository.js'
export { CacheRepository } from './repositories/CacheRepository.js'
export { IndexerRepository } from './repositories/IndexerRepository.js'
export type {
  IndexedSkill,
  UpsertResult,
  BatchUpsertResult,
} from './repositories/IndexerRepository.js'

// Services (SMI-579)
export { SearchService } from './services/SearchService.js'

// Types (SMI-577)
export type {
  Skill,
  SkillCreateInput,
  SkillUpdateInput,
  PaginatedResults,
  SearchOptions,
  SearchResult,
  TrustTier,
  CacheEntry,
} from './types/skill.js'

// Search
export { HybridSearch } from './search/index.js'
export type { HybridSearchOptions, SearchQuery, SearchResponse } from './search/index.js'

// Embeddings
export { EmbeddingService } from './embeddings/index.js'
export type { EmbeddingResult, SimilarityResult } from './embeddings/index.js'

// Cache
export { L1Cache, L2Cache, TieredCache } from './cache/index.js'
export type {
  SearchCacheEntry,
  SearchResult as CachedSearchResult,
  CacheStats,
  TieredCacheOptions,
} from './cache/index.js'

// Security
export { SecurityScanner } from './security/index.js'
export type { SecurityFinding, ScanReport, ScannerOptions } from './security/index.js'

// Error handling (SMI-583)
export {
  ErrorCodes,
  ErrorSuggestions,
  SkillsmithError,
  createErrorResponse,
  withErrorBoundary,
  type ErrorCategory,
  type ErrorCode,
  type ErrorResponse,
} from './errors.js'

// MCP types (SMI-581, SMI-582)
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
} from './types.js'

// Indexer (SMI-628)
export { SkillParser, GitHubIndexer } from './indexer/index.js'
export type {
  SkillFrontmatter,
  ParsedSkillMetadata,
  ValidationResult,
  SkillParserOptions,
  GitHubIndexerOptions,
  IndexResult,
  SkillMetadata,
} from './indexer/index.js'

// Session Management (SMI-641)
export {
  SessionManager,
  DefaultCommandExecutor,
  SessionRecovery,
  createSessionRecovery,
  ActiveSessionContext,
  NullSessionContext,
  createSessionContext,
  isActiveContext,
  getSessionDuration,
  formatSessionDuration,
  getLatestCheckpoint,
} from './session/index.js'
export type {
  SessionOptions,
  MemoryResult,
  CommandExecutor,
  Checkpoint,
  SessionData,
  SessionContext,
  RecoveryStatus,
  RecoveryResult,
  RecoveryOptions,
} from './session/index.js'

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
  type BenchmarkConfig,
  type BenchmarkResult,
  type BenchmarkStats,
  type BenchmarkReport,
  type BenchmarkDefinition,
  type BenchmarkFn,
  type MemoryStats,
  type EnvironmentInfo,
  type ComparisonResult,
  type MetricComparison,
  type SearchBenchmarkConfig,
  type ValidationResult as BenchmarkValidationResult,
  type IndexBenchmarkConfig,
  type ThroughputResult,
  type SizeImpactResult,
  type IndexValidationResult,
  type CLIOptions,
  // SMI-738: Cache and embedding benchmarks
  CacheBenchmark,
  EmbeddingBenchmark,
  CACHE_TARGETS,
  EMBEDDING_TARGETS,
  validateCacheResults,
  validateEmbeddingResults,
  type CacheBenchmarkConfig,
  type CacheValidationResult,
  type EmbeddingBenchmarkConfig,
  type EmbeddingValidationResult,
} from './benchmarks/index.js'

// Webhooks (SMI-645)
export {
  WebhookHandler,
  WebhookQueue,
  isSkillFile,
  extractSkillChanges,
  parseWebhookPayload,
} from './webhooks/index.js'
export type {
  WebhookEventType,
  RepositoryAction,
  GitUser,
  PushCommit,
  RepositoryOwner,
  WebhookRepository,
  WebhookSender,
  PushEventPayload,
  RepositoryEventPayload,
  PingEventPayload,
  WebhookPayload,
  ParsedWebhookEvent,
  SignatureVerificationResult,
  SkillFileChange,
  WebhookHandlerOptions,
  WebhookHandleResult,
  QueueItemType,
  QueuePriority,
  WebhookQueueItem,
  QueueProcessResult,
  QueueStats,
  WebhookQueueOptions,
} from './webhooks/index.js'

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
  RateLimitConfig,
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

// Quality Scoring (SMI-592)
export { QualityScorer, quickScore, scoreFromRepository } from './scoring/index.js'
export type { QualityScoringInput, QualityScoreBreakdown, ScoringWeights } from './scoring/index.js'

// Pipeline (SMI-593)
export { DailyIndexPipeline, createScheduledPipeline, runDailyIndex } from './pipeline/index.js'
export type {
  PipelineStatus,
  PipelineSourceConfig,
  PipelineConfig,
  PipelineProgress,
  SourceResult,
  PipelineResult,
} from './pipeline/index.js'

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
  type TracerConfig,
  type SpanAttributes,
  type SpanWrapper,
  type MetricsConfig,
  type MetricLabels,
  type Counter,
  type Histogram,
  type Gauge,
  type MetricsSnapshot,
} from './telemetry/index.js'

// Codebase Analysis (SMI-600)
export {
  CodebaseAnalyzer,
  type CodebaseContext,
  type ImportInfo,
  type ExportInfo,
  type FunctionInfo,
  type FrameworkInfo,
  type DependencyInfo,
  type AnalyzeOptions,
} from './analysis/index.js'
