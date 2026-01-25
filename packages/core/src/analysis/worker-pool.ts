/**
 * SMI-1308: Worker Thread Pool for Parallel File Parsing
 * SMI-1337: Added metrics integration
 *
 * Uses Node.js worker_threads for true parallelism,
 * bypassing the single-threaded event loop limitation.
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/worker-pool
 */

import { Worker, isMainThread, parentPort, workerData } from 'worker_threads'
import os from 'os'
import { EventEmitter } from 'events'
import { getAnalysisMetrics } from './metrics.js'
import type { ParseTask, WorkerResult, WorkerPoolOptions, QueuedTask } from './worker-types.js'
import { getLanguageFromExtension, chunkArray, WORKER_PARSE_CODE } from './worker-utils.js'

// Re-export types for backwards compatibility
export type { ParseTask, WorkerResult, WorkerPoolOptions } from './worker-types.js'

// SMI-1330/1331: Import types for cached router
type LanguageRouterType = InstanceType<(typeof import('./router.js'))['LanguageRouter']>

/**
 * Worker thread pool for parallel file parsing
 *
 * Uses Node.js worker_threads for true parallelism,
 * bypassing the single-threaded event loop limitation.
 *
 * For small batches (< minBatchForWorkers), parses inline
 * to avoid worker overhead.
 *
 * @example
 * ```typescript
 * const pool = new ParserWorkerPool({ poolSize: 4 })
 *
 * const tasks = files.map(f => ({
 *   filePath: f.path,
 *   content: f.content,
 *   language: 'typescript'
 * }))
 *
 * const results = await pool.parseFiles(tasks)
 * console.log(`Parsed ${results.length} files`)
 *
 * pool.dispose()
 * ```
 */
export class ParserWorkerPool extends EventEmitter {
  private workers: Worker[] = []
  private taskQueue: QueuedTask[] = []
  private activeWorkers = 0
  private readonly poolSize: number
  private readonly minBatchForWorkers: number
  private readonly metrics: ReturnType<typeof getAnalysisMetrics>
  private disposed = false
  // SMI-1330/1331: Cache router to avoid recreation on each parseInline call
  private router: LanguageRouterType | null = null
  private routerPromise: Promise<LanguageRouterType> | null = null

  constructor(options: WorkerPoolOptions = {}) {
    super()
    this.poolSize = options.poolSize ?? Math.max(1, os.cpus().length - 1)
    this.minBatchForWorkers = options.minBatchForWorkers ?? 10
    this.metrics = options.metrics ?? getAnalysisMetrics()
  }

  /**
   * SMI-1330/1331: Get or create shared router instance
   * Lazily initializes the router on first use and caches it
   */
  private async getRouter(): Promise<LanguageRouterType> {
    if (this.router) return this.router
    if (this.routerPromise) return this.routerPromise

    this.routerPromise = this.initializeRouter()
    this.router = await this.routerPromise
    return this.router
  }

  /**
   * SMI-1330/1331: Initialize router with all adapters
   */
  private async initializeRouter(): Promise<LanguageRouterType> {
    const { LanguageRouter } = await import('./router.js')
    const { TypeScriptAdapter } = await import('./adapters/typescript.js')
    const { PythonAdapter } = await import('./adapters/python.js')
    const { GoAdapter } = await import('./adapters/go.js')
    const { RustAdapter } = await import('./adapters/rust.js')
    const { JavaAdapter } = await import('./adapters/java.js')

    const router = new LanguageRouter()
    router.registerAdapter(new TypeScriptAdapter())
    router.registerAdapter(new PythonAdapter())
    router.registerAdapter(new GoAdapter())
    router.registerAdapter(new RustAdapter())
    router.registerAdapter(new JavaAdapter())

    return router
  }

  /**
   * Parse files in parallel using worker threads
   *
   * SMI-1337: Records worker pool metrics.
   *
   * @param tasks - Array of parse tasks
   * @returns Array of worker results
   * @throws Error if pool has been disposed
   */
  async parseFiles(tasks: ParseTask[]): Promise<WorkerResult[]> {
    if (this.disposed) {
      throw new Error('Worker pool has been disposed')
    }

    if (tasks.length === 0) {
      return []
    }

    // SMI-1337: Update worker pool metrics
    this.metrics.updateWorkerPool(this.activeWorkers, this.taskQueue.length, this.poolSize)

    // For small batches, parse inline (worker overhead not worth it)
    if (tasks.length < this.minBatchForWorkers) {
      const results = await this.parseInline(tasks)
      this.recordParseMetrics(results)
      return results
    }

    const results = await this.parseWithWorkers(tasks)
    this.recordParseMetrics(results)
    return results
  }

  /**
   * Record parse metrics for completed results
   * SMI-1337: Helper to record metrics after parsing
   */
  private recordParseMetrics(results: WorkerResult[]): void {
    for (const result of results) {
      if (result.error) {
        this.metrics.recordError('worker_parse_error', result.filePath.split('.').pop())
      } else {
        // Extract language from file extension
        const ext = result.filePath.split('.').pop()?.toLowerCase()
        const language = getLanguageFromExtension(ext)
        if (language) {
          this.metrics.recordFileParsed(language)
          this.metrics.recordParseDuration(language, result.durationMs)
        }
      }
    }
    // Update memory usage after batch processing
    this.metrics.updateMemoryUsage()
  }

  /**
   * Parse files inline (no workers)
   *
   * Used for small batches where worker overhead exceeds benefit.
   * SMI-1330/1331: Uses cached router to avoid recreation overhead
   */
  private async parseInline(tasks: ParseTask[]): Promise<WorkerResult[]> {
    const results: WorkerResult[] = []
    // SMI-1330/1331: Get shared router instance
    const router = await this.getRouter()

    for (const task of tasks) {
      const start = performance.now()
      try {
        const adapter = router.tryGetAdapter(task.filePath)
        if (adapter) {
          const result = adapter.parseFile(task.content, task.filePath)
          results.push({
            filePath: task.filePath,
            result,
            durationMs: performance.now() - start,
          })
        } else {
          // Unsupported file type
          results.push({
            filePath: task.filePath,
            result: { imports: [], exports: [], functions: [] },
            durationMs: performance.now() - start,
            error: `Unsupported file type: ${task.filePath}`,
          })
        }
      } catch (error) {
        results.push({
          filePath: task.filePath,
          result: { imports: [], exports: [], functions: [] },
          durationMs: performance.now() - start,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return results
  }

  /**
   * Parse files using worker threads
   *
   * Chunks tasks across available workers for parallel processing.
   */
  private async parseWithWorkers(tasks: ParseTask[]): Promise<WorkerResult[]> {
    // Chunk tasks for workers
    const chunkSize = Math.ceil(tasks.length / this.poolSize)
    const chunks = chunkArray(tasks, chunkSize)

    const results = await Promise.all(chunks.map((chunk) => this.dispatchToWorker(chunk)))

    return results.flat()
  }

  /**
   * Dispatch a chunk of tasks to a worker
   */
  private async dispatchToWorker(tasks: ParseTask[]): Promise<WorkerResult[]> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_PARSE_CODE, {
        eval: true,
        workerData: { tasks },
      })

      const timeout = setTimeout(() => {
        worker.terminate()
        reject(new Error('Worker timed out after 30 seconds'))
      }, 30000)

      worker.on('message', (results: WorkerResult[]) => {
        clearTimeout(timeout)
        worker.terminate()
        resolve(results)
      })

      worker.on('error', (error) => {
        clearTimeout(timeout)
        worker.terminate()
        reject(error)
      })

      worker.on('exit', (code) => {
        clearTimeout(timeout)
        if (code !== 0) {
          reject(new Error(`Worker exited with code ${code}`))
        }
      })
    })
  }

  /**
   * Get pool statistics
   *
   * SMI-1337: Also updates metrics.
   *
   * @returns Current pool statistics
   */
  getStats(): {
    poolSize: number
    activeWorkers: number
    queuedTasks: number
    utilization: number
  } {
    const utilization = this.poolSize > 0 ? this.activeWorkers / this.poolSize : 0

    // SMI-1337: Update metrics when stats are requested
    this.metrics.updateWorkerPool(this.activeWorkers, this.taskQueue.length, this.poolSize)

    return {
      poolSize: this.poolSize,
      activeWorkers: this.activeWorkers,
      queuedTasks: this.taskQueue.length,
      utilization,
    }
  }

  /**
   * Dispose of worker pool
   *
   * Terminates all workers and clears the task queue.
   * SMI-1330/1331: Also disposes cached router
   */
  dispose(): void {
    this.disposed = true
    for (const worker of this.workers) {
      worker.terminate()
    }
    this.workers = []
    this.taskQueue = []
    // SMI-1330/1331: Clean up cached router
    if (this.router) {
      this.router.dispose()
      this.router = null
      this.routerPromise = null
    }
  }
}

// Export for worker thread context detection
export { isMainThread, parentPort, workerData }
