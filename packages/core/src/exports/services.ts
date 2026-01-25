/**
 * Service Exports
 * @module exports/services
 *
 * Barrel file for service-related exports
 */

// ============================================================================
// Core Services
// ============================================================================

export { SearchService } from '../services/SearchService.js'

// ============================================================================
// Optimization Services (Skillsmith Optimization Layer)
// ============================================================================

export {
  analyzeSkill,
  quickTransformCheck,
  type SkillAnalysis,
  type ToolUsageAnalysis,
  type TaskPatternAnalysis,
  type ExtractableSection,
  type OptimizationRecommendation,
} from '../services/SkillAnalyzer.js'

export {
  decomposeSkill,
  parallelizeTaskCalls,
  type DecompositionResult,
  type DecomposedSkill,
  type SubSkill,
  type DecompositionStats,
  type DecomposerOptions,
} from '../services/SkillDecomposer.js'

export {
  generateSubagent,
  generateMinimalSubagent,
  CLAUDE_MODELS,
  type SubagentDefinition,
  type SubagentGenerationResult,
  type ClaudeModel,
} from '../services/SubagentGenerator.js'

export {
  TransformationService,
  transformSkill,
  type TransformationResult,
  type TransformationStats,
  type TransformationServiceOptions,
} from '../services/TransformationService.js'

// ============================================================================
// Session Management (SMI-641)
// ============================================================================

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
} from '../session/index.js'

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
} from '../session/index.js'

// ============================================================================
// Indexer (SMI-628)
// ============================================================================

export { SkillParser, GitHubIndexer } from '../indexer/index.js'

export type {
  SkillFrontmatter,
  ParsedSkillMetadata,
  ValidationResult,
  SkillParserOptions,
  GitHubIndexerOptions,
  IndexResult,
  SkillMetadata,
} from '../indexer/index.js'

// ============================================================================
// Webhooks (SMI-645)
// ============================================================================

export {
  WebhookHandler,
  WebhookQueue,
  isSkillFile,
  extractSkillChanges,
  parseWebhookPayload,
} from '../webhooks/index.js'

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
} from '../webhooks/index.js'

// ============================================================================
// Source Adapters (SMI-589)
// ============================================================================

export {
  BaseSourceAdapter,
  SourceAdapterRegistry,
  SourceIndexer,
  defaultRegistry,
  isSourceAdapter,
} from '../sources/index.js'

// Note: Source adapter types are exported directly from sources/index.js
// to avoid duplicate type definitions causing TypeScript conflicts.
// Import directly from '@skillsmith/core/sources' for source-related types.

// ============================================================================
// Quality Scoring (SMI-592)
// ============================================================================

export { QualityScorer, quickScore, scoreFromRepository } from '../scoring/index.js'

export type {
  QualityScoringInput,
  QualityScoreBreakdown,
  ScoringWeights,
} from '../scoring/index.js'

// ============================================================================
// Pipeline (SMI-593)
// ============================================================================

export { DailyIndexPipeline, createScheduledPipeline, runDailyIndex } from '../pipeline/index.js'

export type {
  PipelineStatus,
  PipelineSourceConfig,
  PipelineConfig,
  PipelineProgress,
  SourceResult,
  PipelineResult,
} from '../pipeline/index.js'

// ============================================================================
// Codebase Analysis (SMI-600)
// ============================================================================

export {
  CodebaseAnalyzer,
  type CodebaseContext,
  type ImportInfo,
  type ExportInfo,
  type FunctionInfo,
  type FrameworkInfo,
  type DependencyInfo,
  type AnalyzeOptions,
} from '../analysis/index.js'

// ============================================================================
// Skill Matching (SMI-602, SMI-604)
// ============================================================================

export {
  SkillMatcher,
  OverlapDetector,
  type MatchableSkill,
  type SkillMatchResult,
  type SkillMatcherOptions,
  type TriggerPhraseSkill,
  type OverlapResult,
  type FilteredSkillsResult,
  type OverlapDetectorOptions,
} from '../matching/index.js'

// ============================================================================
// Trigger System (Phase 4)
// ============================================================================

export {
  TriggerDetector,
  ContextScorer,
  DEFAULT_FILE_TRIGGERS,
  DEFAULT_COMMAND_TRIGGERS,
  DEFAULT_ERROR_TRIGGERS,
  DEFAULT_PROJECT_TRIGGERS,
  type TriggerType,
  type FilePatternTrigger,
  type CommandTrigger,
  type ErrorTrigger,
  type ProjectTrigger,
  type DetectedTrigger,
  type TriggerDetectionOptions,
  type ContextScore,
  type ContextScoringWeights,
  type ContextScorerOptions,
} from '../triggers/index.js'

// ============================================================================
// Skill Activation (Phase 4)
// ============================================================================

export {
  ActivationManager,
  ZeroConfigActivator,
  type ActivationOptions,
  type ActivationResult,
  type SkillConfigSchema,
  type ConfigField,
  type ConfigStatus,
  type ZeroConfigOptions,
} from '../activation/index.js'

// ============================================================================
// Registry Sync
// ============================================================================

export {
  SyncConfigRepository,
  SyncHistoryRepository,
  SyncEngine,
  BackgroundSyncService,
  createBackgroundSyncService,
  FREQUENCY_INTERVALS,
  type SyncConfig,
  type SyncConfigUpdate,
  type SyncFrequency,
  type SyncHistoryEntry,
  type SyncStatus,
  type SyncRunResult,
  type SyncOptions,
  type SyncProgress,
  type SyncResult,
  type BackgroundSyncOptions,
  type BackgroundSyncState,
} from '../sync/index.js'

// ============================================================================
// Billing (SMI-1062 to SMI-1070)
// ============================================================================

export {
  StripeClient,
  BillingService,
  StripeWebhookHandler,
  GDPRComplianceService,
  StripeReconciliationJob,
  BillingError,
  type StripeClientConfig,
  type TierPriceConfigs,
  type BillingServiceConfig,
  type StripeWebhookHandlerConfig,
  type GDPRComplianceServiceConfig,
  type CustomerDataExport,
  type SubscriptionExportData,
  type InvoiceExportData,
  type LicenseKeyExportData,
  type WebhookEventExportData,
  type DeletionResult,
  type StripeReconciliationJobConfig,
  type DiscrepancyType,
  type Discrepancy,
  type ReconciliationResult,
  type StripeCustomerId,
  type StripeSubscriptionId,
  type StripePriceId,
  type StripeInvoiceId,
  type StripeEventId,
  type StripeCheckoutSessionId,
  type SubscriptionStatus,
  type BillingPeriod,
  type Subscription,
  type Invoice,
  type InvoiceStatus,
  type WebhookEvent,
  type WebhookProcessResult,
  type CreateCheckoutSessionRequest,
  type CreateCheckoutSessionResponse,
  type CreatePortalSessionRequest,
  type CreatePortalSessionResponse,
  type UpdateSeatsRequest,
  type UpdateSeatsResponse,
  type BillingErrorCode,
  type LicenseTier,
} from '../billing/index.js'
