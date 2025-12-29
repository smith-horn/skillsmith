/**
 * Pipeline Module
 *
 * Provides orchestration for skill indexing pipelines.
 *
 * @module pipeline
 */

export {
  DailyIndexPipeline,
  createScheduledPipeline,
  runDailyIndex,
  type PipelineStatus,
  type PipelineSourceConfig,
  type PipelineConfig,
  type PipelineProgress,
  type SourceResult,
  type PipelineResult,
} from './DailyIndexPipeline.js'
