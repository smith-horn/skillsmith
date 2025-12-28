/**
 * SMI-638: Checkpoint Manager
 *
 * Manages session checkpoints with auto-save functionality.
 * Integrates with claude-flow memory hooks for persistent storage.
 *
 * Security Fixes:
 * - SMI-662: Environment variable safety - minimal env passed to subprocesses
 * - SMI-664: Race condition prevention - serialized checkpoint operations
 * - SMI-665: Zombie process prevention - AbortController for subprocess timeouts
 * - SMI-666: Secure temp file handling - 0600 permissions
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { writeFile, unlink, stat, mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionCheckpoint,
  SessionCheckpointData,
  FileModification,
  TestResult,
  CheckpointTodo,
  generateSessionId,
} from './SessionCheckpoint.js'

/**
 * Checkpoint manager configuration
 */
export interface CheckpointManagerOptions {
  /** Session ID (auto-generated if not provided) */
  sessionId?: string
  /** Working directory for the session */
  workingDirectory: string
  /** Current git branch (optional) */
  branch?: string
  /** Auto-checkpoint interval in milliseconds (default: 5 minutes) */
  autoCheckpointInterval?: number
  /** Maximum checkpoint size in bytes (default: 10KB) */
  maxCheckpointSize?: number
  /** Enable auto-checkpointing on file saves (default: true) */
  autoCheckpointOnSave?: boolean
  /** Maximum checkpoints to retain in memory (default: 10) */
  maxCheckpointsRetained?: number
  /** Subprocess timeout in milliseconds (default: 10 seconds) */
  subprocessTimeout?: number
}

/**
 * Result of a memory operation
 */
export interface MemoryOperationResult {
  success: boolean
  error?: string
  memoryKey?: string
}

/**
 * SMI-662: Spawn options with minimal environment
 */
export interface SecureSpawnOptions {
  env: Record<string, string>
  shell: boolean
  signal?: AbortSignal
}

/**
 * Manages session checkpoints with auto-save and claude-flow integration
 */
export class CheckpointManager {
  private sessionId: string
  private workingDirectory: string
  private branch?: string
  private currentCheckpoint: SessionCheckpoint
  private checkpointHistory: SessionCheckpoint[] = []
  private autoCheckpointInterval: number
  private maxCheckpointSize: number
  private autoCheckpointOnSave: boolean
  private maxCheckpointsRetained: number
  private subprocessTimeout: number
  private intervalHandle?: ReturnType<typeof setInterval>
  private isRunning = false

  // SMI-665: AbortController for subprocess management
  private abortController: AbortController
  private activeProcesses: Set<ChildProcess> = new Set()
  private isAborted = false

  // SMI-664: Mutex for serializing checkpoint operations (queue of resolver functions)
  private operationQueue: Array<() => void> = []

  constructor(options: CheckpointManagerOptions) {
    this.sessionId = options.sessionId ?? generateSessionId()
    this.workingDirectory = options.workingDirectory
    this.branch = options.branch
    this.autoCheckpointInterval = options.autoCheckpointInterval ?? 5 * 60 * 1000 // 5 minutes
    this.maxCheckpointSize = options.maxCheckpointSize ?? 10240 // 10KB
    this.autoCheckpointOnSave = options.autoCheckpointOnSave ?? true
    this.maxCheckpointsRetained = options.maxCheckpointsRetained ?? 10
    this.subprocessTimeout = options.subprocessTimeout ?? 10000 // 10 seconds

    // SMI-665: Initialize AbortController
    this.abortController = new AbortController()

    // Initialize first checkpoint
    this.currentCheckpoint = new SessionCheckpoint({
      sessionId: this.sessionId,
      workingDirectory: this.workingDirectory,
      branch: this.branch,
    })
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string {
    return this.sessionId
  }

  /**
   * Get the current checkpoint
   */
  getCurrentCheckpoint(): SessionCheckpoint {
    return this.currentCheckpoint
  }

  /**
   * Get checkpoint history
   */
  getCheckpointHistory(): readonly SessionCheckpoint[] {
    return this.checkpointHistory
  }

  /**
   * SMI-662: Get secure spawn options with minimal environment
   * Only passes PATH to subprocess, no sensitive env vars
   */
  getSpawnOptions(): SecureSpawnOptions {
    return {
      env: {
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        // NODE_ENV can be useful for debugging but is not sensitive
        ...(process.env['NODE_ENV'] ? { NODE_ENV: process.env['NODE_ENV'] } : {}),
      },
      shell: false, // SMI-660: Disable shell to prevent injection
      signal: this.abortController.signal,
    }
  }

  /**
   * SMI-665: Abort all running subprocesses and mark manager as aborted
   */
  abort(): void {
    this.isAborted = true
    this.abortController.abort()
    // Kill any active processes
    for (const proc of this.activeProcesses) {
      proc.kill('SIGTERM')
    }
    this.activeProcesses.clear()
    // Reset controller for future abort signals (but isAborted remains true)
    this.abortController = new AbortController()
  }

  /**
   * Reset the aborted state to allow new operations
   */
  resetAbort(): void {
    this.isAborted = false
    this.abortController = new AbortController()
  }

  /**
   * SMI-666: Create a secure temp file with 0600 permissions
   */
  async createSecureTempFile(content: string): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), 'checkpoint-'))
    const tempFile = join(tempDir, 'data.json')

    // Write with 0600 permissions (owner read/write only)
    await writeFile(tempFile, content, { mode: 0o600 })

    return tempFile
  }

  /**
   * SMI-666: Create a secure temp directory
   */
  async createSecureTempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'checkpoint-'))
  }

  /**
   * SMI-666: Clean up a temp file and its parent directory
   */
  async cleanupTempFile(filePath: string): Promise<void> {
    try {
      await unlink(filePath)
      // Also remove the parent temp directory
      const parentDir = join(filePath, '..')
      await rmdir(parentDir)
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Start auto-checkpointing
   */
  start(): void {
    if (this.isRunning) return

    this.isRunning = true
    this.intervalHandle = setInterval(() => {
      void this.createCheckpoint()
    }, this.autoCheckpointInterval)
  }

  /**
   * Stop auto-checkpointing
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = undefined
    }
    this.isRunning = false
    this.abort() // Clean up any running processes
  }

  /**
   * Record a file modification
   */
  recordFileModification(path: string, action: FileModification['action']): void {
    this.currentCheckpoint.addFileModification({
      path,
      action,
      timestamp: new Date().toISOString(),
    })

    // Auto-checkpoint if enabled
    if (this.autoCheckpointOnSave && action !== 'deleted') {
      void this.createCheckpoint()
    }
  }

  /**
   * Record a test result
   */
  recordTestResult(name: string, passed: boolean, duration: number): void {
    this.currentCheckpoint.addTestResult({
      name,
      passed,
      duration,
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Update todos in the current checkpoint
   */
  updateTodos(todos: CheckpointTodo[]): void {
    this.currentCheckpoint.setTodos(todos)
  }

  /**
   * Set custom metadata
   */
  setMetadata(key: string, value: unknown): void {
    this.currentCheckpoint.setMetadata(key, value)
  }

  /**
   * SMI-664: Serialize async operations to prevent race conditions
   * Uses a simple queue-based mutex to ensure operations run sequentially
   */
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    // Create a promise that will be resolved when it's our turn
    const myTurn = new Promise<void>((resolve) => {
      this.operationQueue.push(resolve)
    })

    // Wait for our turn (if there are operations ahead of us)
    if (this.operationQueue.length > 1) {
      await myTurn
    } else {
      // We're first in line, resolve immediately
      this.operationQueue[0]()
    }

    try {
      return await operation()
    } finally {
      // Remove ourselves from the queue
      this.operationQueue.shift()
      // Signal the next operation in queue (if any)
      if (this.operationQueue.length > 0) {
        this.operationQueue[0]()
      }
    }
  }

  /**
   * Create a new checkpoint and optionally store to memory
   * SMI-664: Serialized to prevent race conditions
   */
  async createCheckpoint(storeToMemory = true): Promise<SessionCheckpoint> {
    return this.withLock(async () => {
      // Check size limit
      if (this.currentCheckpoint.exceedsSizeLimit(this.maxCheckpointSize)) {
        // Trim old file modifications to stay under limit
        const data = this.currentCheckpoint.getData()
        const trimmedFiles = data.filesModified.slice(-20) // Keep last 20 files
        const trimmedTests = data.testsRun.slice(-10) // Keep last 10 tests

        this.currentCheckpoint = new SessionCheckpoint({
          ...data,
          filesModified: trimmedFiles,
          testsRun: trimmedTests,
        })
      }

      // Store to history
      this.checkpointHistory.push(this.currentCheckpoint)

      // Trim history if needed
      if (this.checkpointHistory.length > this.maxCheckpointsRetained) {
        this.checkpointHistory = this.checkpointHistory.slice(-this.maxCheckpointsRetained)
      }

      // Store to claude-flow memory
      if (storeToMemory) {
        await this.storeToMemory(this.currentCheckpoint)
      }

      // Create new checkpoint
      const previousData = this.currentCheckpoint.getData()
      this.currentCheckpoint = new SessionCheckpoint({
        sessionId: this.sessionId,
        workingDirectory: this.workingDirectory,
        branch: this.branch,
        todos: previousData.todos, // Preserve todos
        metadata: previousData.metadata, // Preserve metadata
      })

      return this.checkpointHistory[this.checkpointHistory.length - 1]
    })
  }

  /**
   * Store checkpoint to claude-flow memory
   * SMI-660: Uses file-based data transfer
   * SMI-662: Uses minimal environment
   * SMI-665: Uses AbortController for timeout
   * SMI-666: Uses secure temp files
   */
  async storeToMemory(checkpoint: SessionCheckpoint): Promise<MemoryOperationResult> {
    // Check if aborted (either via abort() call or signal)
    if (this.isAborted || this.abortController.signal.aborted) {
      return { success: false, error: 'Operation aborted or cancelled' }
    }

    const memoryKey = checkpoint.toMemoryKey()
    const data = checkpoint.serialize()

    // SMI-666: Create secure temp file
    let tempFile: string | undefined
    try {
      tempFile = await this.createSecureTempFile(data)
    } catch (err) {
      return { success: false, error: `Failed to create temp file: ${err}` }
    }

    const spawnOptions = this.getSpawnOptions()

    return new Promise((resolve) => {
      // SMI-665: Handle abort before spawn
      if (this.isAborted || this.abortController.signal.aborted) {
        void this.cleanupTempFile(tempFile!)
        resolve({ success: false, error: 'Operation aborted or cancelled' })
        return
      }

      const proc = spawn(
        'npx',
        ['claude-flow@alpha', 'hooks', 'post-edit', '--memory-key', memoryKey, '--file', tempFile!],
        {
          ...spawnOptions,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )

      // Track active process
      this.activeProcesses.add(proc)

      let stderr = ''
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      const cleanup = () => {
        this.activeProcesses.delete(proc)
        void this.cleanupTempFile(tempFile!)
      }

      // SMI-665: Handle abort signal
      const abortHandler = () => {
        proc.kill('SIGTERM')
        cleanup()
        resolve({ success: false, error: 'Operation aborted or cancelled' })
      }
      this.abortController.signal.addEventListener('abort', abortHandler, { once: true })

      proc.on('close', (code) => {
        this.abortController.signal.removeEventListener('abort', abortHandler)
        cleanup()
        if (code === 0) {
          resolve({ success: true, memoryKey })
        } else {
          resolve({ success: false, error: stderr || `Exit code: ${code}` })
        }
      })

      proc.on('error', (err) => {
        this.abortController.signal.removeEventListener('abort', abortHandler)
        cleanup()
        resolve({ success: false, error: err.message })
      })

      // SMI-665: Use AbortController-based timeout
      const timeoutId = setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGTERM')
          cleanup()
          resolve({ success: false, error: 'Timeout storing to memory' })
        }
      }, this.subprocessTimeout)

      proc.on('exit', () => {
        clearTimeout(timeoutId)
      })
    })
  }

  /**
   * Restore checkpoint from claude-flow memory
   */
  async restoreFromMemory(memoryKey: string): Promise<SessionCheckpoint | null> {
    const spawnOptions = this.getSpawnOptions()

    return new Promise((resolve) => {
      const proc = spawn('npx', ['claude-flow@alpha', 'memory', 'get', memoryKey], {
        ...spawnOptions,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      this.activeProcesses.add(proc)

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      const cleanup = () => {
        this.activeProcesses.delete(proc)
      }

      proc.on('close', (code) => {
        cleanup()
        if (code === 0 && stdout.trim()) {
          try {
            const checkpoint = SessionCheckpoint.deserialize(stdout.trim())
            resolve(checkpoint)
          } catch {
            resolve(null)
          }
        } else {
          resolve(null)
        }
      })

      proc.on('error', () => {
        cleanup()
        resolve(null)
      })

      // Timeout
      const timeoutId = setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGTERM')
          cleanup()
          resolve(null)
        }
      }, this.subprocessTimeout)

      proc.on('exit', () => {
        clearTimeout(timeoutId)
      })
    })
  }

  /**
   * List available checkpoints from memory for this session
   */
  async listMemoryCheckpoints(): Promise<string[]> {
    const spawnOptions = this.getSpawnOptions()
    const pattern = `session/${this.sessionId}/checkpoint/*`

    return new Promise((resolve) => {
      const proc = spawn('npx', ['claude-flow@alpha', 'memory', 'list', '--pattern', pattern], {
        ...spawnOptions,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      this.activeProcesses.add(proc)

      let stdout = ''

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })

      const cleanup = () => {
        this.activeProcesses.delete(proc)
      }

      proc.on('close', (code) => {
        cleanup()
        if (code === 0 && stdout.trim()) {
          const keys = stdout.trim().split('\n').filter(Boolean)
          resolve(keys)
        } else {
          resolve([])
        }
      })

      proc.on('error', () => {
        cleanup()
        resolve([])
      })

      // Timeout
      const timeoutId = setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGTERM')
          cleanup()
          resolve([])
        }
      }, this.subprocessTimeout)

      proc.on('exit', () => {
        clearTimeout(timeoutId)
      })
    })
  }

  /**
   * Restore the latest checkpoint for this session
   */
  async restoreLatest(): Promise<SessionCheckpoint | null> {
    const keys = await this.listMemoryCheckpoints()
    if (keys.length === 0) return null

    // Keys are sorted by timestamp, get the last one
    const latestKey = keys[keys.length - 1]
    return this.restoreFromMemory(latestKey)
  }

  /**
   * Export session state for external use
   */
  exportSession(): SessionCheckpointData {
    return this.currentCheckpoint.getData()
  }

  /**
   * Import session state from external source
   */
  importSession(data: SessionCheckpointData): void {
    this.currentCheckpoint = SessionCheckpoint.fromData(data)
    this.sessionId = data.sessionId
    this.workingDirectory = data.workingDirectory
    this.branch = data.branch
  }
}
