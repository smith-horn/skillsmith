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
// Quarantine Service (SMI-2269: Authenticated Quarantine Operations)
// ============================================================================

export {
  QuarantineService,
  QuarantineServiceError,
  hasPermission,
  isSessionValid,
  requirePermission,
  type QuarantinePermission,
  type AuthenticatedSession,
  type ApprovalRecord,
  type MultiApprovalStatus,
  type AuthenticatedReviewInput,
  type AuthenticatedReviewResult,
  type QuarantineServiceErrorCode,
} from '../services/quarantine/index.js'

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

// SMI-5456 Wave 1 Step 4: multi-target portable agent-pack generator.
export {
  generateAgentPack,
  renderAgentSkillMd,
  renderAgentSkillBody,
  renderClaudeShim,
  renderCodexToml,
  renderCopilotShim,
  renderOpenCodeShim,
  renderSessionStartHook,
  renderSessionEndHook,
  AGENT_PACK_SKILL_NAME,
  AGENT_PACK_DISPLAY_NAME,
  AGENT_PACK_SCHEMA_VERSION,
  HOOK_HARNESSES,
  SHIM_DESCRIPTION,
  PACK_DESCRIPTION,
  JOBS as AGENT_PACK_JOBS,
  TRUST_CLAUSES,
  PAYWALL_TRIGGERS,
  type AgentPackArtifact,
  type AgentPackInput,
  type AgentArtifactKind,
  type HarnessId,
  type JobDefinition,
  type TrustClause,
  type PaywallTrigger,
} from '../services/agent-pack/index.js'

export {
  TransformationService,
  transformSkill,
  type TransformationResult,
  type TransformationStats,
  type TransformationServiceOptions,
} from '../services/TransformationService.js'

export {
  TaskRunner,
  createTaskRunner,
  getGlobalTaskRunner,
  setGlobalTaskRunner,
  disposeGlobalTaskRunner,
  DEFAULT_TASK_TIMEOUT_MS,
  SIGKILL_GRACE_PERIOD_MS,
  WARNING_THRESHOLD_RATIO,
  type TaskRunnerConfig,
  type TaskStatus,
  type TrackedTask,
  type CleanupResult,
} from '../services/TaskRunner.js'

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
  // Cross-harness inventory payload contract (SMI-5389)
  INVENTORY_LIMITS,
  INVENTORY_UPDATE_POLICIES,
  type InventoryDevice,
  type InventorySkillEntry,
  type InventoryUpdatePolicy,
  type InventoryUploadPayload,
  type InventoryUploadResult,
  // Cross-harness inventory service — shared local agent (SMI-5392)
  collectDeviceSkills,
  buildInventoryDevice,
  buildInventoryPayload,
  uploadInventory,
  pushInventory,
  maybeAutoPush,
  InventoryAuthError,
  InventoryConflictError,
  InventoryValidationError,
  InventoryUploadError,
  type BuildInventoryDeviceOptions,
  type PushInventoryOptions,
  type MaybeAutoPushOptions,
} from '../sync/index.js'

// ============================================================================
// Dependency Intelligence (SMI-3145, SMI-3146)
// ============================================================================

export {
  extractMcpReferences,
  type McpReference,
  type McpExtractionResult,
} from '../analysis/McpReferenceExtractor.js'

export { mergeDependencies, type MergedDependency } from '../analysis/DependencyMerger.js'

// ============================================================================
// Billing (SMI-1062 to SMI-1070) — RELOCATED in SMI-5006 (core 0.7.0)
// ============================================================================
//
// BREAKING: The billing module was moved to `@smith-horn/enterprise/billing`.
// Both the root re-exports that previously lived here and the `./billing`
// subpath shim were removed. Consumers must update imports:
//
//   - Before: import { StripeWebhookHandler } from '@skillsmith/core/billing'
//   - After:  import { StripeWebhookHandler } from '@smith-horn/enterprise/billing'
//
// Stripe is no longer a runtime dependency of @skillsmith/core (removed in a
// follow-up wave); applications wanting billing functionality must depend on
// @smith-horn/enterprise directly. createLogger / Logger are exported from the
// core barrel (see ../index.ts) to support enterprise's billing consumers.

// ============================================================================
// Skill Installation (SMI-3483: Wave 0)
// ============================================================================

export {
  SkillInstallationService,
  type SkillInstallationServiceParams,
} from '../services/skill-installation.service.js'

export { ManifestManager } from '../services/skill-manifest.js'

export {
  TRUST_TIER_SCANNER_OPTIONS as INSTALL_TRUST_TIER_SCANNER_OPTIONS,
  type ProgressCallback,
  type InstallOptions,
  type InstallResult as CoreInstallResult,
  type InstallErrorCode,
  type UninstallOptions,
  type UninstallResult as CoreUninstallResult,
  type SkillManifest,
  type SkillManifestEntry,
  type RegistrySkillInfo,
  type RegistryLookup,
  type CoInstallRecorder,
  type DepIntelResult,
  type OptimizationInfo as CoreOptimizationInfo,
  type ConflictAction as CoreConflictAction,
  type AiDefenceFeedback,
} from '../services/skill-installation.types.js'

export {
  recordAiDefenceFeedback,
  collectTrendWarnings,
} from '../services/skill-installation.feedback.js'
