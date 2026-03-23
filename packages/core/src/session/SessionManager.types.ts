/**
 * Session Manager Type Definitions
 * @module @skillsmith/core/session/SessionManager.types
 */

import type { SessionData } from './SessionContext.js'

// ============================================================================
// Session Options and Results
// ============================================================================

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

// ============================================================================
// Command Executor Interface
// ============================================================================

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

// ============================================================================
// Sanitization Helper (Re-exported for internal use)
// ============================================================================

/**
 * Sanitizes session data before storage
 */
export function sanitizeSessionData(data: SessionData): SessionData {
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
