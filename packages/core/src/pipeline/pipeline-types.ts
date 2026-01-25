/**
 * Type definitions for DailyIndexPipeline
 * @module @skillsmith/core/pipeline/pipeline-types
 */

import type { ISourceAdapter } from '../sources/ISourceAdapter.js'
import type { SourceSearchOptions, BatchIndexResult } from '../sources/types.js'
import type { ISkillParser, ISkillRepository } from '../sources/SourceIndexer.js'

/**
 * Pipeline execution status
 */
export type PipelineStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * Source configuration for the pipeline
 */
export interface PipelineSourceConfig {
  /** Source adapter instance */
  adapter: ISourceAdapter
  /** Search options for this source */
  searchOptions?: SourceSearchOptions
  /** Whether to enable incremental updates (skip unchanged) */
  incremental?: boolean
  /** Priority (lower runs first) */
  priority?: number
}

/**
 * Pipeline run configuration
 */
export interface PipelineConfig {
  /** Sources to index */
  sources: PipelineSourceConfig[]
  /** Skill content parser */
  parser: ISkillParser
  /** Skill repository for persistence */
  repository: ISkillRepository
  /** Maximum concurrent source processing */
  maxConcurrentSources?: number
  /** Callback for progress updates */
  onProgress?: (progress: PipelineProgress) => void
  /** Callback for source completion */
  onSourceComplete?: (sourceId: string, result: BatchIndexResult) => void
  /** Callback for errors */
  onError?: (sourceId: string, error: Error) => void
  /** Whether to continue on source errors */
  continueOnError?: boolean
  /** Run identifier */
  runId?: string
}

/**
 * Progress information
 */
export interface PipelineProgress {
  /** Current run ID */
  runId: string
  /** Current status */
  status: PipelineStatus
  /** Sources completed */
  sourcesCompleted: number
  /** Total sources */
  totalSources: number
  /** Skills processed so far */
  skillsProcessed: number
  /** Skills indexed (created + updated) */
  skillsIndexed: number
  /** Current source being processed */
  currentSource?: string
  /** Elapsed time in milliseconds */
  elapsedMs: number
  /** Estimated remaining time in milliseconds */
  estimatedRemainingMs?: number
}

/**
 * Source result
 */
export interface SourceResult {
  /** Source identifier */
  sourceId: string
  /** Source name */
  sourceName: string
  /** Index result */
  result: BatchIndexResult | null
  /** Error if failed */
  error?: string
  /** Duration in milliseconds */
  durationMs: number
  /** Start time */
  startedAt: string
  /** End time */
  completedAt: string
}

/**
 * Pipeline run result
 */
export interface PipelineResult {
  /** Run identifier */
  runId: string
  /** Final status */
  status: PipelineStatus
  /** When the run started */
  startedAt: string
  /** When the run completed */
  completedAt: string
  /** Total duration in milliseconds */
  durationMs: number
  /** Results per source */
  sourceResults: SourceResult[]
  /** Aggregate statistics */
  summary: PipelineSummary
}

/**
 * Pipeline summary statistics
 */
export interface PipelineSummary {
  /** Total sources processed */
  totalSources: number
  /** Sources that succeeded */
  successfulSources: number
  /** Sources that failed */
  failedSources: number
  /** Total skills found */
  totalSkills: number
  /** Skills created */
  skillsCreated: number
  /** Skills updated */
  skillsUpdated: number
  /** Skills unchanged */
  skillsUnchanged: number
  /** Skills failed */
  skillsFailed: number
  /** Total errors */
  totalErrors: number
}
