/**
 * @fileoverview Learning Module Exports
 * @module @skillsmith/core/learning
 *
 * Exports for the recommendation learning system including:
 * - Signal collection and user preferences
 * - ReasoningBank integration for trajectory learning
 * - PatternStore with EWC++ for pattern preservation
 */

// Types
export type {
  SignalType,
  SignalEvent,
  SignalFilter,
  SignalMetadata,
  RecommendationContext,
  DismissReason,
  SkillCategory,
  UserPreferenceProfile,
  LearningConfig,
  PersonalizedRecommendation,
  AggregateStats,
  UserDataExport,
  LearningEvents,
} from './types.js'

export { SIGNAL_WEIGHTS, DEFAULT_LEARNING_CONFIG, COLD_START_WEIGHTS } from './types.js'

// Interfaces
export type {
  ISignalCollector,
  IPreferenceLearner,
  IPrivacyManager,
  IPersonalizationEngine,
  IUserPreferenceRepository,
} from './interfaces.js'

// ReasoningBank Integration (SMI-1520)
export {
  ReasoningBankIntegration,
  createReasoningBankIntegration,
  hasConfidentVerdict,
  indicatesPreference,
  indicatesRejection,
  type ReasoningBankIntegrationConfig,
  type IntelligenceConfig,
  type TrajectoryStep,
  type TrajectoryVerdict,
  type SkillVerdict,
  type BatchVerdictResult,
  type IReasoningBank,
  TRAJECTORY_REWARDS,
  CONFIDENCE_THRESHOLDS,
  DEFAULT_CONFIG as DEFAULT_REASONING_BANK_CONFIG,
} from './ReasoningBankIntegration.js'

// PatternStore with EWC++ (SMI-1522)
export {
  PatternStore,
  createPatternStore,
  FisherInformationMatrix,
  type EWCConfig,
  type PatternStoreConfig,
  type PatternOutcomeType,
  type PatternOutcome,
  type PatternRecommendationContext,
  type SkillFeatures,
  type Pattern,
  type StoredPattern,
  type PatternQuery,
  type SimilarPattern,
  type ConsolidationResult,
  type PatternStoreMetrics,
  type IFisherInformationMatrix,
  DEFAULT_EWC_CONFIG,
  DEFAULT_PATTERN_STORE_CONFIG,
  PATTERN_REWARDS,
} from './PatternStore.js'
