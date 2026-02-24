/**
 * Session Manager for Claude-Flow Memory Integration
 * SMI-641: Session ID Storage in Claude-Flow Memory
 * SMI-1518: V3 API Migration - Use direct API calls instead of spawn
 * SMI-2741: Split to meet 500-line standard
 *
 * Manages session lifecycle with persistent storage in claude-flow memory
 * to enable context restoration across sessions.
 */

import { randomUUID } from 'node:crypto'
import type { SessionData, Checkpoint } from './SessionContext.js'

// Import types
import type { CommandExecutor, MemoryResult, SessionOptions } from './SessionManager.types.js'
import { sanitizeSessionData } from './SessionManager.types.js'

// Import helpers
import { MEMORY_KEYS, DefaultCommandExecutor } from './SessionManager.helpers.js'

// SMI-2741: Memory and hook operations extracted to companion file
import {
  storeMemoryEntry,
  retrieveMemoryEntry,
  deleteMemoryEntry,
  runPreTaskHook,
  runPostTaskHook,
} from './SessionManager.memory.js'

// Re-export only public API types (SMI-1718: trimmed internal exports)
export type { CommandExecutor, MemoryResult, SessionOptions } from './SessionManager.types.js'
export { DefaultCommandExecutor } from './SessionManager.helpers.js'
export {
  storeMemoryEntry,
  retrieveMemoryEntry,
  deleteMemoryEntry,
  runPreTaskHook,
  runPostTaskHook,
} from './SessionManager.memory.js'

/**
 * Session Manager for claude-flow memory integration
 *
 * Provides session lifecycle management:
 * - Start sessions with unique IDs
 * - Create checkpoints for recovery points
 * - End sessions with cleanup
 * - Recover sessions from memory
 *
 * Thread Safety:
 * - Uses mutex lock for concurrent operations (SMI-675)
 * - Implements rollback on partial failures (SMI-676)
 */
export class SessionManager {
  private executor: CommandExecutor
  private currentSession: SessionData | null = null

  /**
   * Mutex lock for serializing session modifications
   * Prevents race conditions when multiple operations run concurrently
   */
  private sessionLock: Promise<void> = Promise.resolve()

  constructor(executor?: CommandExecutor) {
    this.executor = executor ?? new DefaultCommandExecutor()
  }

  /**
   * Execute a function with exclusive access to session state
   * Serializes concurrent operations to prevent race conditions
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const currentLock = this.sessionLock
    let releaseLock: () => void

    this.sessionLock = new Promise((resolve) => {
      releaseLock = resolve
    })

    await currentLock

    try {
      return await fn()
    } finally {
      releaseLock!()
    }
  }

  /**
   * Generate a unique session ID using crypto.randomUUID (per standards.md §4.8)
   */
  generateSessionId(): string {
    return randomUUID()
  }

  /**
   * Start a new session and store in claude-flow memory
   */
  async startSession(options: SessionOptions = {}): Promise<SessionData> {
    const sessionId = this.generateSessionId()
    const now = new Date().toISOString()

    const session: SessionData = {
      sessionId,
      startedAt: now,
      issueId: options.issueId,
      worktree: options.worktree,
      checkpoints: [],
      filesModified: [],
      lastActivity: now,
    }

    // Store session in memory
    await this.storeSession(session)

    // Set as current session
    await this.setCurrentSession(sessionId)

    // Run pre-task hook if description provided
    if (options.description) {
      await runPreTaskHook(options.description, this.executor)
    }

    this.currentSession = session
    return session
  }

  /**
   * Create a checkpoint in the current session
   *
   * SMI-675: Uses mutex lock to prevent race conditions
   * SMI-676: Stores checkpoint memory FIRST, rolls back on failure
   */
  async createCheckpoint(description: string): Promise<Checkpoint> {
    return this.withLock(async () => {
      if (!this.currentSession) {
        throw new Error('No active session. Call startSession() first.')
      }

      const checkpoint: Checkpoint = {
        id: this.generateSessionId(),
        timestamp: new Date().toISOString(),
        description: description.substring(0, 500),
        memoryKey: `${MEMORY_KEYS.CHECKPOINT_PREFIX}${this.currentSession.sessionId}/${Date.now()}`,
      }

      // SMI-676: Store checkpoint data FIRST (before updating session)
      const checkpointResult = await storeMemoryEntry(
        checkpoint.memoryKey,
        JSON.stringify(checkpoint),
        this.executor
      )

      if (!checkpointResult.success) {
        throw new Error(`Failed to store checkpoint: ${checkpointResult.error}`)
      }

      // Create a copy of session before modification for potential rollback
      const previousCheckpoints = [...this.currentSession.checkpoints]
      const previousLastActivity = this.currentSession.lastActivity

      // Update session state
      this.currentSession.checkpoints.push(checkpoint)
      this.currentSession.lastActivity = checkpoint.timestamp

      // Try to store updated session
      try {
        const sessionResult = await this.storeSession(this.currentSession)
        if (!sessionResult.success) {
          throw new Error(`Failed to store session: ${sessionResult.error}`)
        }
      } catch (err) {
        // SMI-676: Rollback - restore previous session state
        this.currentSession.checkpoints = previousCheckpoints
        this.currentSession.lastActivity = previousLastActivity

        // Clean up the checkpoint from memory
        await deleteMemoryEntry(checkpoint.memoryKey, this.executor)

        throw err
      }

      return checkpoint
    })
  }

  /**
   * Record a modified file in the current session
   * SMI-675: Uses mutex lock to prevent race conditions
   */
  async recordFileModified(filePath: string): Promise<void> {
    return this.withLock(async () => {
      if (!this.currentSession) {
        throw new Error('No active session. Call startSession() first.')
      }

      // Avoid duplicates
      if (!this.currentSession.filesModified.includes(filePath)) {
        this.currentSession.filesModified.push(filePath)
        this.currentSession.lastActivity = new Date().toISOString()
        await this.storeSession(this.currentSession)
      }
    })
  }

  /**
   * End the current session
   */
  async endSession(): Promise<void> {
    if (!this.currentSession) {
      return
    }

    this.currentSession.lastActivity = new Date().toISOString()
    await this.storeSession(this.currentSession)

    // Run post-task hook
    await runPostTaskHook(this.currentSession.sessionId, this.executor)

    // Clear current session pointer
    await this.clearCurrentSession()

    this.currentSession = null
  }

  /**
   * Get the current active session
   */
  getCurrentSession(): SessionData | null {
    return this.currentSession
  }

  /**
   * Retrieve a session from memory by ID
   */
  async getSession(sessionId: string): Promise<SessionData | null> {
    const memoryKey = `${MEMORY_KEYS.SESSION_PREFIX}${sessionId}`
    const result = await retrieveMemoryEntry(memoryKey, this.executor)

    if (!result.success || !result.data) {
      return null
    }

    try {
      return JSON.parse(result.data) as SessionData
    } catch {
      return null
    }
  }

  /**
   * Get the ID of the current session from memory
   */
  async getCurrentSessionId(): Promise<string | null> {
    const result = await retrieveMemoryEntry(MEMORY_KEYS.CURRENT, this.executor)

    if (!result.success || !result.data) {
      return null
    }

    try {
      const data = JSON.parse(result.data)
      return data.sessionId ?? null
    } catch {
      return null
    }
  }

  /**
   * Store session data in claude-flow memory
   */
  private async storeSession(session: SessionData): Promise<MemoryResult> {
    const memoryKey = `${MEMORY_KEYS.SESSION_PREFIX}${session.sessionId}`
    const sanitized = sanitizeSessionData(session)
    return storeMemoryEntry(memoryKey, JSON.stringify(sanitized), this.executor)
  }

  /**
   * Set the current session pointer
   */
  private async setCurrentSession(sessionId: string): Promise<MemoryResult> {
    return storeMemoryEntry(MEMORY_KEYS.CURRENT, JSON.stringify({ sessionId }), this.executor)
  }

  /**
   * Clear the current session pointer
   */
  private async clearCurrentSession(): Promise<MemoryResult> {
    return deleteMemoryEntry(MEMORY_KEYS.CURRENT, this.executor)
  }
}
