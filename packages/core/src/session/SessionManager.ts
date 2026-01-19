/**
 * Session Manager for Claude-Flow Memory Integration
 * SMI-641: Session ID Storage in Claude-Flow Memory
 * SMI-1518: V3 API Migration - Use direct API calls instead of spawn
 *
 * Manages session lifecycle with persistent storage in claude-flow memory
 * to enable context restoration across sessions.
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { SessionData, Checkpoint } from './SessionContext.js'

// V3 API imports - SMI-1518, SMI-1609
// These provide direct TypeScript API access instead of spawning CLI commands
// Note: claude-flow is an optional dependency - imports are FULLY dynamic to avoid
// Node.js ESM static analysis which would fail at module load time.
// We use string concatenation to prevent static analysis of the import specifier.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let claudeFlowMemory: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let claudeFlowMcp: any = null

// Module paths are constructed dynamically to prevent ESM static analysis
const CLAUDE_FLOW_BASE = 'claude-flow'
const MEMORY_MODULE_PATH = '/v3/@claude-flow/cli/dist/src/memory/memory-initializer.js'
const MCP_MODULE_PATH = '/v3/@claude-flow/cli/dist/src/mcp-client.js'

/**
 * Lazily load claude-flow memory module
 * Returns undefined if claude-flow is not installed
 *
 * Uses string concatenation for the import path to prevent Node.js
 * ESM static analysis from resolving the module at parse time.
 */
async function getClaudeFlowMemory() {
  if (claudeFlowMemory === null) {
    try {
      // String concatenation prevents static analysis
      const modulePath = CLAUDE_FLOW_BASE + MEMORY_MODULE_PATH
      claudeFlowMemory = await import(/* webpackIgnore: true */ modulePath)
    } catch {
      claudeFlowMemory = undefined // Mark as attempted but failed
    }
  }
  return claudeFlowMemory
}

/**
 * Lazily load claude-flow MCP module
 * Returns undefined if claude-flow is not installed
 *
 * Uses string concatenation for the import path to prevent Node.js
 * ESM static analysis from resolving the module at parse time.
 */
async function getClaudeFlowMcp() {
  if (claudeFlowMcp === null) {
    try {
      // String concatenation prevents static analysis
      const modulePath = CLAUDE_FLOW_BASE + MCP_MODULE_PATH
      claudeFlowMcp = await import(/* webpackIgnore: true */ modulePath)
    } catch {
      claudeFlowMcp = undefined // Mark as attempted but failed
    }
  }
  return claudeFlowMcp
}

/**
 * Memory key patterns for session storage
 */
const MEMORY_KEYS = {
  CURRENT: 'session/current',
  SESSION_PREFIX: 'session/',
  CHECKPOINT_PREFIX: 'checkpoint/',
} as const

/**
 * SMI-1518: Feature flag to enable V3 direct API
 * Set CLAUDE_FLOW_USE_V3_API=true to use direct API calls
 * Falls back to spawn-based CLI if not set or if V3 API fails
 */
const USE_V3_API = process.env.CLAUDE_FLOW_USE_V3_API === 'true'

/**
 * Default namespace for session memory entries
 */
const MEMORY_NAMESPACE = 'skillsmith-sessions'

/**
 * Validates a memory key to prevent injection attacks
 * Only allows alphanumeric characters, hyphens, underscores, and forward slashes
 */
function validateMemoryKey(key: string): boolean {
  const SAFE_KEY_PATTERN = /^[a-zA-Z0-9/_-]+$/
  return SAFE_KEY_PATTERN.test(key) && key.length <= 256
}

/**
 * Sanitizes session data before storage
 */
function sanitizeSessionData(data: SessionData): SessionData {
  return {
    sessionId: data.sessionId,
    startedAt: data.startedAt,
    issueId: data.issueId?.replace(/[<>]/g, ''),
    worktree: data.worktree?.replace(/[<>]/g, ''),
    checkpoints: data.checkpoints.map((cp) => ({
      id: cp.id,
      timestamp: cp.timestamp,
      description: cp.description.substring(0, 500),
      memoryKey: cp.memoryKey,
    })),
    filesModified: data.filesModified.map((f) => f.substring(0, 500)),
    lastActivity: data.lastActivity,
  }
}

/**
 * Options for creating a new session
 */
export interface SessionOptions {
  issueId?: string
  worktree?: string
  description?: string
}

/**
 * Result from claude-flow memory operations
 */
export interface MemoryResult {
  success: boolean
  data?: string
  error?: string
}

/**
 * Command executor interface for dependency injection
 * Allows mocking claude-flow commands in tests
 *
 * Supports two modes:
 * - spawn(): Secure argument-array based execution (preferred)
 * - execute(): Legacy string-based execution (deprecated, for backwards compatibility)
 */
export interface CommandExecutor {
  /**
   * @deprecated Use spawn() instead for security
   */
  execute(command: string): Promise<{ stdout: string; stderr: string }>

  /**
   * Secure spawn-based execution with argument array
   * Prevents command injection by not using shell interpolation
   */
  spawn?(executable: string, args: string[]): Promise<{ stdout: string; stderr: string }>
}

/**
 * Default command executor using child_process.spawn
 * Uses argument arrays to prevent command injection
 */
export class DefaultCommandExecutor implements CommandExecutor {
  /**
   * @deprecated Legacy string-based execution - use spawn instead
   */
  async execute(command: string): Promise<{ stdout: string; stderr: string }> {
    // For backwards compatibility only - prefer spawn()
    return this.executeWithSpawn(command)
  }

  /**
   * Secure spawn-based execution with argument array
   */
  async spawn(executable: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(executable, args, {
        shell: false,
        env: { ...process.env },
        timeout: 30000,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data) => {
        stdout += data.toString()
      })

      proc.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
        } else {
          reject(new Error(stderr || `Command failed with code ${code}`))
        }
      })

      proc.on('error', (err) => {
        reject(err)
      })
    })
  }

  /**
   * Parse legacy string command and execute via spawn
   */
  private async executeWithSpawn(command: string): Promise<{ stdout: string; stderr: string }> {
    // Parse the command safely
    const parts = command.split(' ')
    const executable = parts[0]
    const args = parts.slice(1)
    return this.spawn(executable, args)
  }
}

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
   *
   * Values are passed as separate arguments, never interpolated into shell commands
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
          // Fall through to spawn if V3 API reports failure
          console.warn(`V3 storeEntry failed: ${result.error}, falling back to spawn`)
        }
      } catch (error) {
        // V3 API threw an exception, fall back to spawn
        console.warn(`V3 storeEntry exception: ${error}, falling back to spawn`)
      }
    }

    try {
      // SMI-674 FIX: Use spawn with argument array instead of string interpolation
      // This prevents command injection attacks like $(whoami) or `id`
      const args = ['claude-flow', 'memory', 'store', '--key', key, '--value', value]

      if (this.executor.spawn) {
        await this.executor.spawn('npx', args)
      } else {
        // Fallback to execute for backwards compatibility (legacy executors)
        // Note: This path should not be used in production
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
          // Fall through to spawn if V3 API reports failure
          console.warn(`V3 getEntry failed: ${result.error}, falling back to spawn`)
        }
      } catch (error) {
        // V3 API threw an exception, fall back to spawn
        console.warn(`V3 getEntry exception: ${error}, falling back to spawn`)
      }
    }

    try {
      // SMI-674 FIX: Use spawn with argument array
      const args = ['claude-flow', 'memory', 'get', '--key', key]

      let stdout: string
      if (this.executor.spawn) {
        const result = await this.executor.spawn('npx', args)
        stdout = result.stdout
      } else {
        // Fallback for backwards compatibility
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
          // Fall through to spawn if V3 API reports failure
          console.warn(`V3 memory/delete failed, falling back to spawn`)
        }
      } catch (error) {
        // V3 API threw an exception, fall back to spawn
        const mcpModule = await getClaudeFlowMcp()
        const MCPClientError = mcpModule?.MCPClientError
        if (!MCPClientError || !(error instanceof MCPClientError)) {
          console.warn(`V3 memory/delete exception: ${error}, falling back to spawn`)
        }
      }
    }

    try {
      // SMI-674 FIX: Use spawn with argument array
      const args = ['claude-flow', 'memory', 'delete', '--key', key]

      if (this.executor.spawn) {
        await this.executor.spawn('npx', args)
      } else {
        // Fallback for backwards compatibility
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
          return // Success, no need to fall back
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
        // Fallback for backwards compatibility
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
          return // Success, no need to fall back
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
        // Fallback for backwards compatibility
        const command = `npx claude-flow hooks post-task --task-id "${taskId}"`
        await this.executor.execute(command)
      }
    } catch {
      // Hooks are optional, don't fail if they don't work
    }
  }
}
