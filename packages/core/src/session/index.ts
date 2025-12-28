/**
 * Session Management Module
 * SMI-641: Session ID Storage in Claude-Flow Memory
 *
 * Provides session lifecycle management with claude-flow memory integration
 * for context restoration across sessions.
 *
 * @example
 * ```typescript
 * import { SessionManager, SessionRecovery, DefaultCommandExecutor } from '@skillsmith/core'
 *
 * const executor = new DefaultCommandExecutor()
 * const manager = new SessionManager(executor)
 *
 * // Start a new session
 * const session = await manager.startSession({
 *   issueId: 'SMI-641',
 *   worktree: 'phase-2c-session',
 *   description: 'Implementing session storage'
 * })
 *
 * // Create checkpoints
 * await manager.createCheckpoint('Completed SessionManager')
 *
 * // Record modified files
 * await manager.recordFileModified('packages/core/src/session/SessionManager.ts')
 *
 * // End session
 * await manager.endSession()
 *
 * // Later, recover session
 * const recovery = new SessionRecovery(manager, executor)
 * const result = await recovery.restoreSession()
 * ```
 */

// SessionManager - Core session lifecycle management
export {
  SessionManager,
  DefaultCommandExecutor,
  type SessionOptions,
  type MemoryResult,
  type CommandExecutor,
} from './SessionManager.js'

// SessionContext - Session state types and utilities
export {
  ActiveSessionContext,
  NullSessionContext,
  createSessionContext,
  isActiveContext,
  getSessionDuration,
  formatSessionDuration,
  getLatestCheckpoint,
  type Checkpoint,
  type SessionData,
  type SessionContext,
} from './SessionContext.js'

// SessionRecovery - Session restoration from memory
export {
  SessionRecovery,
  createSessionRecovery,
  type RecoveryStatus,
  type RecoveryResult,
  type RecoveryOptions,
} from './SessionRecovery.js'
