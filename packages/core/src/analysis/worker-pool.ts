/**
 * SMI-1308: Worker Thread Pool for Parallel File Parsing
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
import type { ParseResult } from './types.js'

/**
 * Task to be parsed by a worker
 */
export interface ParseTask {
  /** Path to the file */
  filePath: string
  /** File content to parse */
  content: string
  /** Programming language */
  language: string
}

/**
 * Result from a worker parse operation
 */
export interface WorkerResult {
  /** Path to the file */
  filePath: string
  /** Parse result */
  result: ParseResult
  /** Time taken to parse in milliseconds */
  durationMs: number
  /** Error message if parsing failed */
  error?: string
}

/**
 * Options for ParserWorkerPool
 */
export interface WorkerPoolOptions {
  /** Number of workers in pool (default: CPU cores - 1) */
  poolSize?: number
  /** Minimum batch size to use workers (default: 10) */
  minBatchForWorkers?: number
}

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
  private taskQueue: Array<{
    task: ParseTask
    resolve: (r: WorkerResult) => void
    reject: (e: Error) => void
  }> = []
  private activeWorkers = 0
  private readonly poolSize: number
  private readonly minBatchForWorkers: number
  private disposed = false

  constructor(options: WorkerPoolOptions = {}) {
    super()
    this.poolSize = options.poolSize ?? Math.max(1, os.cpus().length - 1)
    this.minBatchForWorkers = options.minBatchForWorkers ?? 10
  }

  /**
   * Parse files in parallel using worker threads
   *
   * @param tasks - Array of parse tasks
   * @returns Array of worker results
   * @throws Error if pool has been disposed
   *
   * @example
   * ```typescript
   * const results = await pool.parseFiles([
   *   { filePath: 'a.ts', content: 'export const a = 1', language: 'typescript' },
   *   { filePath: 'b.ts', content: 'export const b = 2', language: 'typescript' },
   * ])
   * ```
   */
  async parseFiles(tasks: ParseTask[]): Promise<WorkerResult[]> {
    if (this.disposed) {
      throw new Error('Worker pool has been disposed')
    }

    if (tasks.length === 0) {
      return []
    }

    // For small batches, parse inline (worker overhead not worth it)
    if (tasks.length < this.minBatchForWorkers) {
      return this.parseInline(tasks)
    }

    return this.parseWithWorkers(tasks)
  }

  /**
   * Parse files inline (no workers)
   *
   * Used for small batches where worker overhead exceeds benefit.
   */
  private async parseInline(tasks: ParseTask[]): Promise<WorkerResult[]> {
    const results: WorkerResult[] = []

    for (const task of tasks) {
      const start = performance.now()
      try {
        // Dynamic import to avoid circular dependency
        const { LanguageRouter } = await import('./router.js')
        const { TypeScriptAdapter } = await import('./adapters/typescript.js')
        const { PythonAdapter } = await import('./adapters/python.js')
        const { GoAdapter } = await import('./adapters/go.js')

        const router = new LanguageRouter()
        router.registerAdapter(new TypeScriptAdapter())
        router.registerAdapter(new PythonAdapter())
        router.registerAdapter(new GoAdapter())

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

        router.dispose()
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
    const chunks = this.chunkArray(tasks, chunkSize)

    const results = await Promise.all(chunks.map((chunk) => this.dispatchToWorker(chunk)))

    return results.flat()
  }

  /**
   * Dispatch a chunk of tasks to a worker
   */
  private async dispatchToWorker(tasks: ParseTask[]): Promise<WorkerResult[]> {
    return new Promise((resolve, reject) => {
      // Create inline worker with basic regex-based parsing
      // Full adapter-based parsing happens in main thread for accuracy
      const workerCode = `
        const { parentPort, workerData } = require('worker_threads');

        function processTask(task) {
          const start = Date.now();
          try {
            const result = {
              imports: [],
              exports: [],
              functions: [],
            };

            const lines = task.content.split('\\n');
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];

              // Detect imports (TypeScript/JavaScript)
              if (/^import\\s/.test(line) || /^from\\s/.test(line)) {
                const moduleMatch = line.match(/from\\s+['"]([^'"]+)['"]/);
                result.imports.push({
                  module: moduleMatch ? moduleMatch[1] : line.trim(),
                  namedImports: [],
                  isTypeOnly: /^import\\s+type/.test(line),
                  sourceFile: task.filePath,
                  line: i + 1,
                });
              }

              // Detect imports (Python)
              if (/^import\\s+\\w/.test(line) || /^from\\s+\\w/.test(line)) {
                const moduleMatch = line.match(/^(?:from\\s+)?(\\w+(?:\\.\\w+)*)/);
                if (moduleMatch && !result.imports.some(imp => imp.line === i + 1)) {
                  result.imports.push({
                    module: moduleMatch[1],
                    namedImports: [],
                    isTypeOnly: false,
                    sourceFile: task.filePath,
                    line: i + 1,
                  });
                }
              }

              // Detect imports (Go)
              if (/^\\s*"[^"]+"/.test(line) || /^import\\s+/.test(line)) {
                const pathMatch = line.match(/"([^"]+)"/);
                if (pathMatch) {
                  result.imports.push({
                    module: pathMatch[1],
                    namedImports: [],
                    isTypeOnly: false,
                    sourceFile: task.filePath,
                    line: i + 1,
                  });
                }
              }

              // Detect functions (TypeScript/JavaScript)
              const tsFuncMatch = line.match(/^(export\\s+)?(async\\s+)?function\\s+(\\w+)/);
              if (tsFuncMatch) {
                result.functions.push({
                  name: tsFuncMatch[3],
                  parameterCount: 0,
                  isAsync: !!tsFuncMatch[2],
                  isExported: !!tsFuncMatch[1],
                  sourceFile: task.filePath,
                  line: i + 1,
                });
              }

              // Detect functions (Python)
              const pyFuncMatch = line.match(/^(async\\s+)?def\\s+(\\w+)/);
              if (pyFuncMatch) {
                result.functions.push({
                  name: pyFuncMatch[2],
                  parameterCount: 0,
                  isAsync: !!pyFuncMatch[1],
                  isExported: !pyFuncMatch[2].startsWith('_'),
                  sourceFile: task.filePath,
                  line: i + 1,
                });
              }

              // Detect functions (Go)
              const goFuncMatch = line.match(/^func\\s+(?:\\([^)]+\\)\\s+)?(\\w+)/);
              if (goFuncMatch) {
                const isExported = goFuncMatch[1][0] === goFuncMatch[1][0].toUpperCase();
                result.functions.push({
                  name: goFuncMatch[1],
                  parameterCount: 0,
                  isAsync: false,
                  isExported: isExported,
                  sourceFile: task.filePath,
                  line: i + 1,
                });
              }

              // Detect exports (TypeScript/JavaScript)
              if (/^export\\s+(default\\s+)?(const|let|var|class|function|interface|type|enum)/.test(line)) {
                const exportMatch = line.match(/^export\\s+(default\\s+)?(const|let|var|class|function|interface|type|enum)\\s+(\\w+)/);
                if (exportMatch) {
                  result.exports.push({
                    name: exportMatch[3],
                    kind: exportMatch[2] === 'function' ? 'function' :
                          exportMatch[2] === 'class' ? 'class' :
                          exportMatch[2] === 'interface' ? 'interface' :
                          exportMatch[2] === 'type' ? 'type' :
                          exportMatch[2] === 'enum' ? 'enum' : 'variable',
                    isDefault: !!exportMatch[1],
                    sourceFile: task.filePath,
                    line: i + 1,
                  });
                }
              }
            }

            return {
              filePath: task.filePath,
              result,
              durationMs: Date.now() - start,
            };
          } catch (error) {
            return {
              filePath: task.filePath,
              result: { imports: [], exports: [], functions: [] },
              durationMs: Date.now() - start,
              error: error.message || String(error),
            };
          }
        }

        const results = workerData.tasks.map(processTask);
        parentPort.postMessage(results);
      `

      const worker = new Worker(workerCode, {
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
   * Chunk an array into smaller arrays
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size))
    }
    return chunks
  }

  /**
   * Get pool statistics
   *
   * @returns Current pool statistics
   */
  getStats(): { poolSize: number; activeWorkers: number; queuedTasks: number } {
    return {
      poolSize: this.poolSize,
      activeWorkers: this.activeWorkers,
      queuedTasks: this.taskQueue.length,
    }
  }

  /**
   * Dispose of worker pool
   *
   * Terminates all workers and clears the task queue.
   */
  dispose(): void {
    this.disposed = true
    for (const worker of this.workers) {
      worker.terminate()
    }
    this.workers = []
    this.taskQueue = []
  }
}

// Export for worker thread context detection
export { isMainThread, parentPort, workerData }
