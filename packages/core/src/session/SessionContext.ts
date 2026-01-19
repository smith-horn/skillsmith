/**
 * Session Context Types and Utilities
 * SMI-641: Session ID Storage in Claude-Flow Memory
 *
 * Defines types for session state tracking including:
 * - Current task/issue being worked on
 * - Files modified in session
 * - Checkpoints created
 * - Memory keys used
 */

/**
 * A checkpoint represents a recovery point in a session
 */
export interface Checkpoint {
  /** Unique checkpoint ID (crypto.randomUUID) */
  id: string
  /** ISO timestamp when checkpoint was created */
  timestamp: string
  /** Human-readable description of the checkpoint */
  description: string
  /** Memory key where checkpoint data is stored */
  memoryKey: string
}

/**
 * Session data stored in claude-flow memory
 */
export interface SessionData {
  /** Unique session ID (crypto.randomUUID per standards.md §4.8) */
  sessionId: string
  /** ISO timestamp when session started */
  startedAt: string
  /** Optional issue ID being worked on (e.g., "SMI-641") */
  issueId?: string
  /** Optional worktree name (e.g., "phase-2c-session") */
  worktree?: string
  /** List of checkpoints created during session */
  checkpoints: Checkpoint[]
  /** List of files modified during session */
  filesModified: string[]
  /** ISO timestamp of last activity */
  lastActivity: string
}

/**
 * Session context provides access to current session state
 * and utilities for managing session data
 */
export interface SessionContext {
  /** Get the current session data */
  getSessionData(): SessionData | null

  /** Get the current issue ID being worked on */
  getCurrentIssueId(): string | undefined

  /** Get the current worktree name */
  getCurrentWorktree(): string | undefined

  /** Get files modified in this session */
  getModifiedFiles(): readonly string[]

  /** Get checkpoints created in this session */
  getCheckpoints(): readonly Checkpoint[]

  /** Get memory keys used in this session */
  getMemoryKeys(): readonly string[]

  /** Check if session is active */
  isActive(): boolean
}

/**
 * Implementation of SessionContext for active sessions
 */
export class ActiveSessionContext implements SessionContext {
  private session: SessionData

  constructor(session: SessionData) {
    this.session = session
  }

  getSessionData(): SessionData {
    return { ...this.session }
  }

  getCurrentIssueId(): string | undefined {
    return this.session.issueId
  }

  getCurrentWorktree(): string | undefined {
    return this.session.worktree
  }

  getModifiedFiles(): readonly string[] {
    return [...this.session.filesModified]
  }

  getCheckpoints(): readonly Checkpoint[] {
    return [...this.session.checkpoints]
  }

  getMemoryKeys(): readonly string[] {
    const keys: string[] = [`session/${this.session.sessionId}`, 'session/current']

    // Add checkpoint memory keys
    for (const checkpoint of this.session.checkpoints) {
      keys.push(checkpoint.memoryKey)
    }

    return keys
  }

  isActive(): boolean {
    return true
  }

  /**
   * Update session data (used internally by SessionManager)
   */
  updateSession(updates: Partial<SessionData>): void {
    this.session = { ...this.session, ...updates }
  }
}

/**
 * Null context for when no session is active
 */
export class NullSessionContext implements SessionContext {
  getSessionData(): SessionData | null {
    return null
  }

  getCurrentIssueId(): string | undefined {
    return undefined
  }

  getCurrentWorktree(): string | undefined {
    return undefined
  }

  getModifiedFiles(): readonly string[] {
    return []
  }

  getCheckpoints(): readonly Checkpoint[] {
    return []
  }

  getMemoryKeys(): readonly string[] {
    return []
  }

  isActive(): boolean {
    return false
  }
}

/**
 * Factory function to create appropriate session context
 */
export function createSessionContext(session: SessionData | null): SessionContext {
  if (session) {
    return new ActiveSessionContext(session)
  }
  return new NullSessionContext()
}

/**
 * Type guard to check if context is active
 */
export function isActiveContext(context: SessionContext): context is ActiveSessionContext {
  return context.isActive()
}

/**
 * Calculate session duration in milliseconds
 */
export function getSessionDuration(session: SessionData): number {
  const start = new Date(session.startedAt).getTime()
  const end = new Date(session.lastActivity).getTime()
  return end - start
}

/**
 * Format session duration as human-readable string
 */
export function formatSessionDuration(session: SessionData): string {
  const durationMs = getSessionDuration(session)
  const seconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`
  }
  return `${seconds}s`
}

/**
 * Get the latest checkpoint from a session
 *
 * When timestamps are equal (created within same millisecond),
 * prefers the later item in the array (more recently added).
 */
export function getLatestCheckpoint(session: SessionData): Checkpoint | null {
  if (session.checkpoints.length === 0) {
    return null
  }

  return session.checkpoints.reduce((latest, current, _index, _array) => {
    const latestTime = new Date(latest.timestamp).getTime()
    const currentTime = new Date(current.timestamp).getTime()
    // Prefer current if time is greater OR equal (later in array = more recent)
    return currentTime >= latestTime ? current : latest
  })
}
