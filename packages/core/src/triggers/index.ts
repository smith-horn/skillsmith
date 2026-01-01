/**
 * @fileoverview Trigger System - Proactive skill suggestion detection
 * @module @skillsmith/core/triggers
 * @see Phase 4: Trigger System Architecture
 */

export {
  TriggerDetector,
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
} from './TriggerDetector.js'

export {
  ContextScorer,
  type ContextScore,
  type ContextScoringWeights,
  type ContextScorerOptions,
} from './ContextScorer.js'
