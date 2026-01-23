/**
 * Session Manager for Claude-Flow Memory Integration
 * SMI-641: Session ID Storage in Claude-Flow Memory
 * SMI-1518: V3 API Migration - Use direct API calls instead of spawn
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
import {
  getClaudeFlowMemory,
  getClaudeFlowMcp,
  MEMORY_KEYS,
  USE_V3_API,
  MEMORY_NAMESPACE,
  validateMemoryKey,
  DefaultCommandExecutor,
} from './SessionManager.helpers.js'

// Re-export only public API types (SMI-1718: trimmed internal exports)
export type { CommandExecutor, MemoryResult, SessionOptions } from './SessionManager.types.js'
export { DefaultCommandExecutor } from './SessionManager.helpers.js'

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
      await this.runPreTaskHook(options.description)
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
      const checkpointResult = await this.storeMemory(
        checkpoint.memoryKey,
        JSON.stringify(checkpoint)
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
        await this.deleteMemory(checkpoint.memoryKey)

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
    await this.runPostTaskHook(this.currentSession.sessionId)

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
    const result = await this.retrieveMemory(memoryKey)

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
    const result = await this.retrieveMemory(MEMORY_KEYS.CURRENT)

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
    return this.storeMemory(memoryKey, JSON.stringify(sanitized))
  }

  /**
   * Set the current session pointer
   */
  private async setCurrentSession(sessionId: string): Promise<MemoryResult> {
    return this.storeMemory(MEMORY_KEYS.CURRENT, JSON.stringify({ sessionId }))
  }

  /**
   * Clear the current session pointer
   */
  private async clearCurrentSession(): Promise<MemoryResult> {
    return this.deleteMemory(MEMORY_KEYS.CURRENT)
  }

  /**
   * Store data in claude-flow memory
   *
   * SMI-674: Uses spawn() with argument array to prevent command injection
   * SMI-1518: V3 API Migration - Use direct storeEntry() when available
   */
  private async storeMemory(key: string, value: string): Promise<MemoryResult> {
    if (!validateMemoryKey(key)) {
      return { success: false, error: 'Invalid memory key' }
    }

    // SMI-1518, SMI-1609: Try V3 direct API first if enabled
    if (USE_V3_API) {
      try {
        const memoryModule = await getClaudeFlowMemory()
        if (memoryModule?.storeEntry) {
          const result = await memoryModule.storeEntry({
            key,
            value,
            namespace: MEMORY_NAMESPACE,
          })
          if (result.success) {
            return { success: true }
          }
          console.warn(`V3 storeEntry failed: ${result.error}, falling back to spawn`)
        }
      } catch (error) {
        console.warn(`V3 storeEntry exception: ${error}, falling back to spawn`)
      }
    }

    try {
      const args = ['claude-flow', 'memory', 'store', '--key', key, '--value', value]

      if (this.executor.spawn) {
        await this.executor.spawn('npx', args)
      } else {
        const escapedValue = value.replace(/'/g, "'\\''")
        const command = `npx claude-flow memory store --key "${key}" --value '${escapedValue}'`
        await this.executor.execute(command)
      }
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Retrieve data from claude-flow memory
   *
   * SMI-674: Uses spawn() with argument array to prevent command injection
   * SMI-1518: V3 API Migration - Use direct getEntry() when available
   */
  private async retrieveMemory(key: string): Promise<MemoryResult> {
    if (!validateMemoryKey(key)) {
      return { success: false, error: 'Invalid memory key' }
    }

    // SMI-1518, SMI-1609: Try V3 direct API first if enabled
    if (USE_V3_API) {
      try {
        const memoryModule = await getClaudeFlowMemory()
        if (memoryModule?.getEntry) {
          const result = await memoryModule.getEntry({
            key,
            namespace: MEMORY_NAMESPACE,
          })
          if (result.success && result.found && result.entry) {
            return { success: true, data: result.entry.content }
          }
          if (result.success && !result.found) {
            return { success: false, error: 'Key not found' }
          }
          console.warn(`V3 getEntry failed: ${result.error}, falling back to spawn`)
        }
      } catch (error) {
        console.warn(`V3 getEntry exception: ${error}, falling back to spawn`)
      }
    }

    try {
      const args = ['claude-flow', 'memory', 'get', '--key', key]

      let stdout: string
      if (this.executor.spawn) {
        const result = await this.executor.spawn('npx', args)
        stdout = result.stdout
      } else {
        const command = `npx claude-flow memory get --key "${key}"`
        const result = await this.executor.execute(command)
        stdout = result.stdout
      }
      return { success: true, data: stdout.trim() }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Delete data from claude-flow memory
   *
   * SMI-674: Uses spawn() with argument array to prevent command injection
   * SMI-1518: V3 API Migration - Use callMCPTool('memory/delete') when available
   */
  private async deleteMemory(key: string): Promise<MemoryResult> {
    if (!validateMemoryKey(key)) {
      return { success: false, error: 'Invalid memory key' }
    }

    // SMI-1518, SMI-1609: Try V3 MCP API first if enabled
    if (USE_V3_API) {
      try {
        const mcpModule = await getClaudeFlowMcp()
        if (mcpModule?.callMCPTool) {
          const result = (await mcpModule.callMCPTool('memory/delete', { key })) as {
            success: boolean
            deleted: boolean
          }
          if (result.success) {
            return { success: true }
          }
          console.warn(`V3 memory/delete failed, falling back to spawn`)
        }
      } catch (error) {
        const mcpModule = await getClaudeFlowMcp()
        const MCPClientError = mcpModule?.MCPClientError
        if (!MCPClientError || !(error instanceof MCPClientError)) {
          console.warn(`V3 memory/delete exception: ${error}, falling back to spawn`)
        }
      }
    }

    try {
      const args = ['claude-flow', 'memory', 'delete', '--key', key]

      if (this.executor.spawn) {
        await this.executor.spawn('npx', args)
      } else {
        const command = `npx claude-flow memory delete --key "${key}"`
        await this.executor.execute(command)
      }
      return { success: true }
    } catch {
      // Ignore delete errors (key may not exist)
      return { success: true }
    }
  }

  /**
   * Run pre-task hook
   * SMI-674: Uses spawn() with argument array to prevent command injection
   * SMI-1518: V3 API Migration - Use callMCPTool('hooks/pre-task') when available
   */
  private async runPreTaskHook(description: string): Promise<void> {
    // SMI-1518, SMI-1609: Try V3 MCP API first if enabled
    if (USE_V3_API) {
      try {
        const mcpModule = await getClaudeFlowMcp()
        if (mcpModule?.callMCPTool) {
          await mcpModule.callMCPTool('hooks/pre-task', {
            description,
            memoryKey: 'session/current',
          })
          return
        }
      } catch {
        // V3 API not available or failed, fall back to spawn
      }
    }

    try {
      const args = [
        'claude-flow',
        'hooks',
        'pre-task',
        '--description',
        description,
        '--memory-key',
        'session/current',
      ]

      if (this.executor.spawn) {
        await this.executor.spawn('npx', args)
      } else {
        const escapedDesc = description.replace(/'/g, "'\\''")
        const command = `npx claude-flow hooks pre-task --description '${escapedDesc}' --memory-key "session/current"`
        await this.executor.execute(command)
      }
    } catch {
      // Hooks are optional, don't fail if they don't work
    }
  }

  /**
   * Run post-task hook
   * SMI-674: Uses spawn() with argument array to prevent command injection
   * SMI-1518: V3 API Migration - Use callMCPTool('hooks/post-task') when available
   */
  private async runPostTaskHook(taskId: string): Promise<void> {
    // SMI-1518, SMI-1609: Try V3 MCP API first if enabled
    if (USE_V3_API) {
      try {
        const mcpModule = await getClaudeFlowMcp()
        if (mcpModule?.callMCPTool) {
          await mcpModule.callMCPTool('hooks/post-task', {
            taskId,
          })
          return
        }
      } catch {
        // V3 API not available or failed, fall back to spawn
      }
    }

    try {
      const args = ['claude-flow', 'hooks', 'post-task', '--task-id', taskId]

      if (this.executor.spawn) {
        await this.executor.spawn('npx', args)
      } else {
        const command = `npx claude-flow hooks post-task --task-id "${taskId}"`
        await this.executor.execute(command)
      }
    } catch {
      // Hooks are optional, don't fail if they don't work
    }
  }
}
