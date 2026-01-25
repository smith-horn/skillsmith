/**
 * Daily Index Generation Pipeline (SMI-593)
 *
 * Orchestrates the daily skill indexing process across multiple sources.
 *
 * @see pipeline-types.ts for type definitions
 */

import {
  SourceIndexer,
  type ISkillParser,
  type ISkillRepository,
} from '../sources/SourceIndexer.js'
import { QualityScorer } from '../scoring/QualityScorer.js'

// Re-export types
export type {
  PipelineStatus,
  PipelineSourceConfig,
  PipelineConfig,
  PipelineProgress,
  SourceResult,
  PipelineResult,
  PipelineSummary,
} from './pipeline-types.js'

// Import types
import type {
  PipelineStatus,
  PipelineSourceConfig,
  PipelineConfig,
  PipelineProgress,
  SourceResult,
  PipelineResult,
} from './pipeline-types.js'

/**
 * Daily Index Pipeline
 *
 * Orchestrates skill indexing across multiple sources with:
 * - Concurrent source processing
 * - Progress tracking and callbacks
 * - Error handling and recovery
 * - Run state management
 */
export class DailyIndexPipeline {
  private currentRun: {
    id: string
    status: PipelineStatus
    startTime: number
    config: PipelineConfig
    results: SourceResult[]
    processed: number
    indexed: number
    cancelled: boolean
  } | null = null

  private scorer = new QualityScorer()

  get isRunning(): boolean {
    return this.currentRun?.status === 'running'
  }

  get currentRunId(): string | null {
    return this.currentRun?.id ?? null
  }

  async run(config: PipelineConfig): Promise<PipelineResult> {
    if (this.isRunning) throw new Error('Pipeline is already running')

    const runId = config.runId ?? this.generateRunId()
    const startedAt = new Date().toISOString()
    const startTime = Date.now()

    this.currentRun = {
      id: runId,
      status: 'running',
      startTime,
      config,
      results: [],
      processed: 0,
      indexed: 0,
      cancelled: false,
    }

    const sortedSources = [...config.sources].sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100)
    )
    const maxConcurrent = config.maxConcurrentSources ?? 1

    try {
      for (let i = 0; i < sortedSources.length; i += maxConcurrent) {
        if (this.currentRun.cancelled) {
          this.currentRun.status = 'cancelled'
          break
        }

        const batch = sortedSources.slice(i, i + maxConcurrent)
        const batchPromises = batch.map((source) => this.processSource(source, config))
        const batchResults = await Promise.allSettled(batchPromises)

        for (let j = 0; j < batchResults.length; j++) {
          const result = batchResults[j]
          const sourceConfig = batch[j]

          if (result.status === 'fulfilled') {
            this.currentRun.results.push(result.value)
            if (result.value.result) {
              this.currentRun.processed += result.value.result.total
              this.currentRun.indexed += result.value.result.indexed
            }
          } else {
            const now = new Date().toISOString()
            this.currentRun.results.push({
              sourceId: sourceConfig.adapter.id,
              sourceName: sourceConfig.adapter.name,
              result: null,
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
              durationMs: 0,
              startedAt: now,
              completedAt: now,
            })
          }
        }
        this.emitProgress(config)
      }

      if (this.currentRun.status === 'running') {
        const hasFailures = this.currentRun.results.some((r) => r.error)
        this.currentRun.status = hasFailures && !config.continueOnError ? 'failed' : 'completed'
      }
    } catch (error) {
      this.currentRun.status = 'failed'
      throw error
    }

    const completedAt = new Date().toISOString()
    const result = this.buildResult(runId, startedAt, completedAt)
    const finalResult = { ...result }
    this.currentRun = null
    return finalResult
  }

  cancel(): boolean {
    if (this.currentRun && this.currentRun.status === 'running') {
      this.currentRun.cancelled = true
      return true
    }
    return false
  }

  getProgress(): PipelineProgress | null {
    if (!this.currentRun) return null

    const elapsed = Date.now() - this.currentRun.startTime
    const completed = this.currentRun.results.length
    const total = this.currentRun.config.sources.length

    let estimatedRemaining: number | undefined
    if (completed > 0 && completed < total) {
      const avgTimePerSource = elapsed / completed
      estimatedRemaining = Math.round(avgTimePerSource * (total - completed))
    }

    return {
      runId: this.currentRun.id,
      status: this.currentRun.status,
      sourcesCompleted: completed,
      totalSources: total,
      skillsProcessed: this.currentRun.processed,
      skillsIndexed: this.currentRun.indexed,
      currentSource: undefined,
      elapsedMs: elapsed,
      estimatedRemainingMs: estimatedRemaining,
    }
  }

  private async processSource(
    sourceConfig: PipelineSourceConfig,
    pipelineConfig: PipelineConfig
  ): Promise<SourceResult> {
    const { adapter } = sourceConfig
    const startedAt = new Date().toISOString()
    const startTime = Date.now()

    try {
      await adapter.initialize()
      const indexer = new SourceIndexer(adapter, pipelineConfig.parser, pipelineConfig.repository, {
        skipUnchanged: sourceConfig.incremental ?? true,
        onProgress: () => {},
      })
      const result = await indexer.indexAll(sourceConfig.searchOptions ?? {})
      const completedAt = new Date().toISOString()

      const sourceResult: SourceResult = {
        sourceId: adapter.id,
        sourceName: adapter.name,
        result,
        durationMs: Date.now() - startTime,
        startedAt,
        completedAt,
      }

      pipelineConfig.onSourceComplete?.(adapter.id, result)
      return sourceResult
    } catch (error) {
      const completedAt = new Date().toISOString()
      const errorMessage = error instanceof Error ? error.message : String(error)
      pipelineConfig.onError?.(adapter.id, error instanceof Error ? error : new Error(errorMessage))

      const sourceResult: SourceResult = {
        sourceId: adapter.id,
        sourceName: adapter.name,
        result: null,
        error: errorMessage,
        durationMs: Date.now() - startTime,
        startedAt,
        completedAt,
      }

      if (!pipelineConfig.continueOnError) throw error
      return sourceResult
    }
  }

  private emitProgress(config: PipelineConfig): void {
    const progress = this.getProgress()
    if (progress && config.onProgress) config.onProgress(progress)
  }

  private buildResult(runId: string, startedAt: string, completedAt: string): PipelineResult {
    const run = this.currentRun!
    const results = run.results

    const summary = {
      totalSources: run.config.sources.length,
      successfulSources: results.filter((r) => !r.error).length,
      failedSources: results.filter((r) => r.error).length,
      totalSkills: results.reduce((sum, r) => sum + (r.result?.total ?? 0), 0),
      skillsCreated: results.reduce((sum, r) => sum + (r.result?.created ?? 0), 0),
      skillsUpdated: results.reduce((sum, r) => sum + (r.result?.updated ?? 0), 0),
      skillsUnchanged: results.reduce((sum, r) => sum + (r.result?.unchanged ?? 0), 0),
      skillsFailed: results.reduce((sum, r) => sum + (r.result?.failed ?? 0), 0),
      totalErrors: results.reduce((sum, r) => sum + (r.result?.errors?.length ?? 0), 0),
    }

    return {
      runId,
      status: run.status,
      startedAt,
      completedAt,
      durationMs: Date.now() - run.startTime,
      sourceResults: results,
      summary,
    }
  }

  private generateRunId(): string {
    const date = new Date()
    const dateStr = date.toISOString().split('T')[0].replace(/-/g, '')
    const timeStr = date.toTimeString().split(' ')[0].replace(/:/g, '')
    const random = Math.random().toString(36).substring(2, 8)
    return `run-${dateStr}-${timeStr}-${random}`
  }
}

export function createScheduledPipeline(
  config: Omit<PipelineConfig, 'runId'>,
  options: {
    intervalMs: number
    runImmediately?: boolean
    onRunComplete?: (result: PipelineResult) => void
  }
): {
  start: () => void
  stop: () => void
  isRunning: () => boolean
  getLastResult: () => PipelineResult | null
} {
  const pipeline = new DailyIndexPipeline()
  let intervalId: ReturnType<typeof setInterval> | null = null
  let lastResult: PipelineResult | null = null
  let running = false

  const runPipeline = async () => {
    if (pipeline.isRunning) return
    try {
      running = true
      lastResult = await pipeline.run(config)
      options.onRunComplete?.(lastResult)
    } catch (error) {
      console.error('Pipeline run failed:', error)
    } finally {
      running = false
    }
  }

  return {
    start: () => {
      if (intervalId) return
      if (options.runImmediately) runPipeline()
      intervalId = setInterval(runPipeline, options.intervalMs)
    },
    stop: () => {
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }
      pipeline.cancel()
    },
    isRunning: () => running || pipeline.isRunning,
    getLastResult: () => lastResult,
  }
}

export async function runDailyIndex(
  sources: PipelineSourceConfig[],
  parser: ISkillParser,
  repository: ISkillRepository,
  options?: {
    continueOnError?: boolean
    maxConcurrentSources?: number
    onProgress?: (progress: PipelineProgress) => void
  }
): Promise<PipelineResult> {
  const pipeline = new DailyIndexPipeline()
  return pipeline.run({ sources, parser, repository, ...options })
}
