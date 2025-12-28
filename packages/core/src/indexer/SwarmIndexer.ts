/**
 * SMI-643: SwarmIndexer - Parallel repository indexing with swarm coordination
 *
 * Provides:
 * - Partition repositories by letter range (A-F, G-L, M-R, S-Z)
 * - Spawn parallel indexer workers
 * - Coordinate via claude-flow swarm
 * - Aggregate results to shared database
 * - Rate limit coordination across workers
 */

import {
  GitHubIndexer,
  type GitHubIndexerOptions,
  type IndexResult,
  type GitHubRepository,
} from './GitHubIndexer.js'
import {
  PartitionStrategy,
  type Partition,
  type PartitionStats,
  type PartitionOptions,
} from './PartitionStrategy.js'
import type { SkillCreateInput } from '../types/skill.js'

/**
 * Worker status for tracking parallel execution
 */
export type WorkerStatus = 'idle' | 'running' | 'completed' | 'failed'

/**
 * Individual worker state
 */
export interface WorkerState {
  id: string
  partition: Partition
  status: WorkerStatus
  startedAt?: Date
  completedAt?: Date
  result?: IndexResult
  error?: string
}

/**
 * Options for swarm indexing
 */
export interface SwarmIndexerOptions extends GitHubIndexerOptions {
  /** Partition strategy options */
  partition?: PartitionOptions
  /** Maximum concurrent workers (default: 4) */
  maxConcurrentWorkers?: number
  /** Global rate limit per second across all workers */
  globalRateLimit?: number
  /** Whether to use claude-flow swarm coordination */
  useSwarmCoordination?: boolean
  /** Callback for worker status updates */
  onWorkerUpdate?: (worker: WorkerState) => void
  /** Callback for progress updates */
  onProgress?: (progress: SwarmProgress) => void
}

/**
 * Progress tracking for swarm indexing
 */
export interface SwarmProgress {
  totalWorkers: number
  completedWorkers: number
  runningWorkers: number
  failedWorkers: number
  totalRepositories: number
  indexedRepositories: number
  percentage: number
}

/**
 * Aggregated result from all workers
 */
export interface SwarmIndexResult {
  /** Total execution time in ms */
  duration: number
  /** Individual worker results */
  workers: WorkerState[]
  /** Aggregated index result */
  aggregated: IndexResult
  /** Partition statistics */
  partitionStats: PartitionStats
  /** Rate limit information */
  rateLimitInfo: RateLimitInfo
}

/**
 * Rate limit tracking
 */
export interface RateLimitInfo {
  totalRequests: number
  requestsPerSecond: number
  throttledRequests: number
  remainingQuota: number
}

/**
 * Coordinates parallel repository indexing across multiple workers
 */
export class SwarmIndexer {
  private indexer: GitHubIndexer
  private strategy: PartitionStrategy
  private options: SwarmIndexerOptions
  private workers: Map<string, WorkerState>
  private rateLimitTokens: number
  private lastTokenRefill: number

  constructor(options: SwarmIndexerOptions = {}) {
    this.options = {
      maxConcurrentWorkers: 4,
      globalRateLimit: 30, // 30 requests/second total across all workers
      useSwarmCoordination: false,
      ...options,
    }

    this.indexer = new GitHubIndexer(options)
    this.strategy = new PartitionStrategy(options.partition)
    this.workers = new Map()
    this.rateLimitTokens = this.options.globalRateLimit ?? 30
    this.lastTokenRefill = Date.now()
  }

  /**
   * Get rate limit token for a request
   */
  private async acquireRateLimitToken(): Promise<void> {
    const now = Date.now()
    const elapsed = now - this.lastTokenRefill

    // Refill tokens based on elapsed time
    if (elapsed >= 1000) {
      const refillCount = Math.floor(elapsed / 1000)
      this.rateLimitTokens = Math.min(
        this.rateLimitTokens + refillCount * (this.options.globalRateLimit ?? 30),
        this.options.globalRateLimit ?? 30
      )
      this.lastTokenRefill = now
    }

    // Wait if no tokens available
    if (this.rateLimitTokens <= 0) {
      const waitTime = 1000 - (now - this.lastTokenRefill)
      await this.delay(waitTime)
      this.rateLimitTokens = this.options.globalRateLimit ?? 30
      this.lastTokenRefill = Date.now()
    }

    this.rateLimitTokens--
  }

  /**
   * Delay helper
   */
  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Update worker state and notify callbacks
   */
  private updateWorkerState(workerId: string, updates: Partial<WorkerState>): void {
    const worker = this.workers.get(workerId)
    if (worker) {
      Object.assign(worker, updates)
      this.options.onWorkerUpdate?.(worker)
      this.notifyProgress()
    }
  }

  /**
   * Calculate and notify progress
   */
  private notifyProgress(): void {
    if (!this.options.onProgress) return

    const workers = Array.from(this.workers.values())
    const completed = workers.filter((w) => w.status === 'completed').length
    const running = workers.filter((w) => w.status === 'running').length
    const failed = workers.filter((w) => w.status === 'failed').length

    let indexed = 0
    let total = 0
    for (const worker of workers) {
      if (worker.result) {
        indexed += worker.result.indexed
        total += worker.result.found
      }
    }

    this.options.onProgress({
      totalWorkers: workers.length,
      completedWorkers: completed,
      runningWorkers: running,
      failedWorkers: failed,
      totalRepositories: total,
      indexedRepositories: indexed,
      percentage: workers.length > 0 ? (completed / workers.length) * 100 : 0,
    })
  }

  /**
   * Index repositories for a single partition
   */
  private async indexPartition(partition: Partition): Promise<IndexResult> {
    await this.acquireRateLimitToken()

    return this.indexer.indexByLetterRange(partition.startLetter, partition.endLetter)
  }

  /**
   * Run a single worker
   */
  private async runWorker(worker: WorkerState): Promise<void> {
    this.updateWorkerState(worker.id, {
      status: 'running',
      startedAt: new Date(),
    })

    try {
      const result = await this.indexPartition(worker.partition)
      this.updateWorkerState(worker.id, {
        status: 'completed',
        completedAt: new Date(),
        result,
      })
    } catch (error) {
      this.updateWorkerState(worker.id, {
        status: 'failed',
        completedAt: new Date(),
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  /**
   * Run workers with concurrency control
   */
  private async runWorkersWithConcurrency(
    workers: WorkerState[],
    maxConcurrent: number
  ): Promise<void> {
    const queue = [...workers]
    const running: Promise<void>[] = []

    while (queue.length > 0 || running.length > 0) {
      // Start new workers up to max concurrency
      while (running.length < maxConcurrent && queue.length > 0) {
        const worker = queue.shift()
        if (worker) {
          const promise = this.runWorker(worker).then(() => {
            running.splice(running.indexOf(promise), 1)
          })
          running.push(promise)
        }
      }

      // Wait for at least one worker to complete
      if (running.length > 0) {
        await Promise.race(running)
      }
    }
  }

  /**
   * Aggregate results from all workers
   */
  private aggregateResults(workers: WorkerState[]): IndexResult {
    const aggregated: IndexResult = {
      found: 0,
      indexed: 0,
      failed: 0,
      errors: [],
      repositories: [],
    }

    const seenUrls = new Set<string>()

    for (const worker of workers) {
      if (worker.result) {
        aggregated.found += worker.result.found
        aggregated.failed += worker.result.failed
        aggregated.errors.push(...worker.result.errors)

        for (const repo of worker.result.repositories) {
          if (!seenUrls.has(repo.url)) {
            seenUrls.add(repo.url)
            aggregated.repositories.push(repo)
            aggregated.indexed++
          }
        }
      }

      if (worker.error) {
        aggregated.errors.push(`Worker ${worker.id}: ${worker.error}`)
        aggregated.failed++
      }
    }

    return aggregated
  }

  /**
   * Generate claude-flow swarm command (for external execution)
   */
  generateSwarmCommand(): string {
    const partitions = this.strategy.createEmptyPartitions()
    const tasks = partitions.map((p) => `index ${p.range}`).join(', ')

    return `./claude-flow swarm "Index repositories: ${tasks}" --strategy development --mode distributed --max-agents ${partitions.length} --parallel`
  }

  /**
   * Run parallel indexing across all partitions
   */
  async indexAll(): Promise<SwarmIndexResult> {
    const startTime = Date.now()

    // Create partitions and workers
    const partitions = this.strategy.createEmptyPartitions()
    this.workers.clear()

    for (const partition of partitions) {
      const worker: WorkerState = {
        id: `worker-${partition.id}`,
        partition,
        status: 'idle',
      }
      this.workers.set(worker.id, worker)
    }

    // Run workers with concurrency control
    const workers = Array.from(this.workers.values())
    await this.runWorkersWithConcurrency(workers, this.options.maxConcurrentWorkers ?? 4)

    // Aggregate results
    const completedWorkers = Array.from(this.workers.values())
    const aggregated = this.aggregateResults(completedWorkers)

    // Calculate partition stats
    const partitionsWithRepos = completedWorkers.map((w) => ({
      ...w.partition,
      repositories: w.result?.repositories ?? [],
    }))
    const partitionStats = this.strategy.getPartitionStats(partitionsWithRepos)

    const duration = Date.now() - startTime
    const requestsPerSecond = duration > 0 ? (aggregated.indexed / duration) * 1000 : 0

    return {
      duration,
      workers: completedWorkers,
      aggregated,
      partitionStats,
      rateLimitInfo: {
        totalRequests: aggregated.indexed + aggregated.failed,
        requestsPerSecond,
        throttledRequests: 0, // Would be tracked in acquireRateLimitToken
        remainingQuota: this.rateLimitTokens,
      },
    }
  }

  /**
   * Index a specific partition (for external worker coordination)
   */
  async indexPartitionById(partitionId: string): Promise<IndexResult> {
    const partitions = this.strategy.createEmptyPartitions()
    const partition = partitions.find((p) => p.id === partitionId)

    if (!partition) {
      return {
        found: 0,
        indexed: 0,
        failed: 1,
        errors: [`Partition not found: ${partitionId}`],
        repositories: [],
      }
    }

    return this.indexPartition(partition)
  }

  /**
   * Convert all indexed repositories to SkillCreateInput
   */
  convertToSkills(result: SwarmIndexResult): SkillCreateInput[] {
    return result.aggregated.repositories.map((repo) => this.indexer.repositoryToSkill(repo))
  }

  /**
   * Get the partition strategy
   */
  getStrategy(): PartitionStrategy {
    return this.strategy
  }

  /**
   * Get current worker states
   */
  getWorkerStates(): WorkerState[] {
    return Array.from(this.workers.values())
  }

  /**
   * Reset the indexer state
   */
  reset(): void {
    this.workers.clear()
    this.rateLimitTokens = this.options.globalRateLimit ?? 30
    this.lastTokenRefill = Date.now()
  }
}

/**
 * Create a SwarmIndexer with default options
 */
export function createSwarmIndexer(options?: SwarmIndexerOptions): SwarmIndexer {
  return new SwarmIndexer(options)
}

/**
 * Create a SwarmIndexer configured for claude-flow coordination
 */
export function createClaudeFlowSwarmIndexer(token?: string): SwarmIndexer {
  return new SwarmIndexer({
    token,
    useSwarmCoordination: true,
    maxConcurrentWorkers: 4,
    globalRateLimit: 30,
  })
}
