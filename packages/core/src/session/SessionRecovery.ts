/**
 * Session Recovery for Claude-Flow Memory
 * SMI-641: Session ID Storage in Claude-Flow Memory
 *
 * Provides session recovery capabilities:
 * - Find latest session from memory
 * - Restore session context
 * - Resume from last checkpoint
 * - Merge with new session if needed
 */

import type { SessionData, Checkpoint, SessionContext } from './SessionContext.js'
import { createSessionContext, getLatestCheckpoint } from './SessionContext.js'
import type { SessionManager, CommandExecutor, SessionOptions } from './SessionManager.js'

/**
 * Recovery result status
 */
export type RecoveryStatus = 'restored' | 'merged' | 'not_found' | 'error'

/**
 * Result of a session recovery attempt
 */
export interface RecoveryResult {
  status: RecoveryStatus
  session: SessionData | null
  checkpoint: Checkpoint | null
  message: string
}

/**
 * Options for session recovery
 */
export interface RecoveryOptions {
  /** Session ID to recover (uses current if not specified) */
  sessionId?: string
  /** Whether to merge with a new session if recovery fails */
  mergeOnFailure?: boolean
  /** Options for new session if merging */
  newSessionOptions?: SessionOptions
}

/**
 * Session Recovery handles restoring sessions from claude-flow memory
 */
export class SessionRecovery {
  private manager: SessionManager
  private executor: CommandExecutor

  constructor(manager: SessionManager, executor: CommandExecutor) {
    this.manager = manager
    this.executor = executor
  }

  /**
   * Find the latest session from memory
   */
  async findLatestSession(): Promise<SessionData | null> {
    // First try to get current session pointer
    const currentId = await this.manager.getCurrentSessionId()

    if (currentId) {
      const session = await this.manager.getSession(currentId)
      if (session) {
        return session
      }
    }

    // If no current session, try to list recent sessions
    return this.searchForRecentSession()
  }

  /**
   * Search for recent sessions in memory
   */
  private async searchForRecentSession(): Promise<SessionData | null> {
    try {
      // Use claude-flow memory list to find session keys
      const command = 'npx claude-flow@alpha memory list --pattern "session/*"'
      const { stdout } = await this.executor.execute(command)

      // Parse output to find session keys
      const lines = stdout.trim().split('\n').filter(Boolean)
      const sessionKeys = lines.filter(
        (line) => line.includes('session/') && !line.includes('session/current')
      )

      if (sessionKeys.length === 0) {
        return null
      }

      // Get all sessions and find the most recent
      const sessions: SessionData[] = []

      for (const keyLine of sessionKeys) {
        // Extract session ID from key (format varies by claude-flow version)
        const match = keyLine.match(/session\/([a-f0-9-]+)/i)
        if (match) {
          const sessionId = match[1]
          const session = await this.manager.getSession(sessionId)
          if (session) {
            sessions.push(session)
          }
        }
      }

      if (sessions.length === 0) {
        return null
      }

      // Return the most recently active session
      return sessions.reduce((latest, current) => {
        const latestTime = new Date(latest.lastActivity).getTime()
        const currentTime = new Date(current.lastActivity).getTime()
        return currentTime > latestTime ? current : latest
      })
    } catch {
      // Memory list may not be supported or empty
      return null
    }
  }

  /**
   * Restore session context from memory
   */
  async restoreSession(options: RecoveryOptions = {}): Promise<RecoveryResult> {
    try {
      let session: SessionData | null = null

      // Try to get specific session or find latest
      if (options.sessionId) {
        session = await this.manager.getSession(options.sessionId)
      } else {
        session = await this.findLatestSession()
      }

      if (!session) {
        // No session found
        if (options.mergeOnFailure && options.newSessionOptions) {
          // Create a new session instead
          const newSession = await this.manager.startSession(options.newSessionOptions)
          return {
            status: 'merged',
            session: newSession,
            checkpoint: null,
            message: 'No previous session found. Created new session.',
          }
        }

        return {
          status: 'not_found',
          session: null,
          checkpoint: null,
          message: 'No session found to restore.',
        }
      }

      // Get the latest checkpoint for resume information
      const latestCheckpoint = getLatestCheckpoint(session)

      // Run session restore hook
      await this.runSessionRestoreHook(session.sessionId)

      return {
        status: 'restored',
        session,
        checkpoint: latestCheckpoint,
        message: `Session ${session.sessionId} restored from memory.`,
      }
    } catch (error) {
      return {
        status: 'error',
        session: null,
        checkpoint: null,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Resume from the last checkpoint in a session
   */
  async resumeFromCheckpoint(session: SessionData, checkpointId?: string): Promise<RecoveryResult> {
    try {
      // Find the checkpoint to resume from
      let checkpoint: Checkpoint | null = null

      if (checkpointId) {
        checkpoint = session.checkpoints.find((cp) => cp.id === checkpointId) ?? null
      } else {
        checkpoint = getLatestCheckpoint(session)
      }

      if (!checkpoint) {
        return {
          status: 'not_found',
          session,
          checkpoint: null,
          message: 'No checkpoint found to resume from.',
        }
      }

      // Retrieve checkpoint data from memory
      const checkpointData = await this.retrieveCheckpointData(checkpoint.memoryKey)

      if (!checkpointData) {
        return {
          status: 'error',
          session,
          checkpoint,
          message: `Checkpoint data not found at ${checkpoint.memoryKey}`,
        }
      }

      return {
        status: 'restored',
        session,
        checkpoint,
        message: `Resumed from checkpoint: ${checkpoint.description}`,
      }
    } catch (error) {
      return {
        status: 'error',
        session,
        checkpoint: null,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Merge a previous session with a new one
   *
   * This is useful when starting a new session but wanting to
   * preserve context from a previous incomplete session.
   */
  async mergeWithNewSession(
    previousSession: SessionData,
    newSessionOptions: SessionOptions
  ): Promise<RecoveryResult> {
    try {
      // Create new session
      const newSession = await this.manager.startSession({
        ...newSessionOptions,
        // Preserve issue ID if not specified
        issueId: newSessionOptions.issueId ?? previousSession.issueId,
        // Preserve worktree if not specified
        worktree: newSessionOptions.worktree ?? previousSession.worktree,
      })

      // Copy relevant context from previous session
      for (const file of previousSession.filesModified) {
        await this.manager.recordFileModified(file)
      }

      // Create a merge checkpoint
      await this.manager.createCheckpoint(
        `Merged from previous session ${previousSession.sessionId}`
      )

      return {
        status: 'merged',
        session: this.manager.getCurrentSession(),
        checkpoint: null,
        message: `New session created with context from ${previousSession.sessionId}`,
      }
    } catch (error) {
      return {
        status: 'error',
        session: null,
        checkpoint: null,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Create a session context from recovery result
   */
  createContext(result: RecoveryResult): SessionContext {
    return createSessionContext(result.session)
  }

  /**
   * Retrieve checkpoint data from memory
   */
  private async retrieveCheckpointData(memoryKey: string): Promise<Checkpoint | null> {
    try {
      const command = `npx claude-flow@alpha memory get --key "${memoryKey}"`
      const { stdout } = await this.executor.execute(command)

      if (!stdout.trim()) {
        return null
      }

      return JSON.parse(stdout.trim()) as Checkpoint
    } catch {
      return null
    }
  }

  /**
   * Run session restore hook
   */
  private async runSessionRestoreHook(sessionId: string): Promise<void> {
    try {
      const command = `npx claude-flow@alpha hooks session-restore --session-id "${sessionId}"`
      await this.executor.execute(command)
    } catch {
      // Hooks are optional
    }
  }
}

/**
 * Factory function to create SessionRecovery with default dependencies
 */
export function createSessionRecovery(
  manager: SessionManager,
  executor: CommandExecutor
): SessionRecovery {
  return new SessionRecovery(manager, executor)
}
