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

// SessionHealthMonitor - SMI-761: Session health monitoring
// SMI-1189: Refactored to use TypedEventEmitter
export {
  SessionHealthMonitor,
  getHealthMonitor,
  initializeHealthMonitor,
  shutdownHealthMonitor,
  type SessionHealth,
  type SessionHealthStatus,
  type HealthMonitorConfig,
  type SessionHealthEvents,
} from './SessionHealthMonitor.js'

// TypedEventEmitter - SMI-1189: Reusable typed event emitter
export { TypedEventEmitter } from './typed-event-emitter.js'

// Health types - SMI-1189: Extracted types
export {
  type SessionHealthState,
  type RequiredHealthMonitorConfig,
  MAX_RECOVERY_ATTEMPTS,
  DEFAULT_CONFIG as DEFAULT_HEALTH_CONFIG,
} from './health-types.js'

// Health checks - SMI-1189: Extracted functions
export {
  calculateHealth,
  determineHealthStatus,
  hasStatusChanged,
  isAlertableStatus,
} from './health-checks.js'

// Metrics collector - SMI-1189: Extracted metrics functions
export {
  recordSessionCount,
  recordRecoverySuccess,
  recordHealthStatusError,
} from './metrics-collector.js'
