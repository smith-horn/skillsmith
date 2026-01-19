/**
 * Session Manager Tests
 * SMI-641: Session ID Storage in Claude-Flow Memory
 *
 * Tests session management with mocked claude-flow commands
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  SessionManager,
  SessionRecovery,
  createSessionContext,
  getSessionDuration,
  formatSessionDuration,
  getLatestCheckpoint,
  type CommandExecutor,
  type SessionData,
  type Checkpoint,
} from '../src/session/index.js'

/**
 * Mock command executor for testing
 */
class MockCommandExecutor implements CommandExecutor {
  private memory: Map<string, string> = new Map()
  public commands: string[] = []

  async execute(command: string): Promise<{ stdout: string; stderr: string }> {
    this.commands.push(command)

    // Parse command
    if (command.includes('memory store')) {
      const keyMatch = command.match(/--key "([^"]+)"/)
      const valueMatch = command.match(/--value '([^']*(?:\\'[^']*)*)'/)
      if (keyMatch && valueMatch) {
        // Handle escaped quotes in value
        const value = valueMatch[1].replace(/\\'/g, "'")
        this.memory.set(keyMatch[1], value)
      }
      return { stdout: 'OK', stderr: '' }
    }

    if (command.includes('memory get')) {
      const keyMatch = command.match(/--key "([^"]+)"/)
      if (keyMatch) {
        const value = this.memory.get(keyMatch[1]) ?? ''
        return { stdout: value, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }

    if (command.includes('memory delete')) {
      const keyMatch = command.match(/--key "([^"]+)"/)
      if (keyMatch) {
        this.memory.delete(keyMatch[1])
      }
      return { stdout: 'OK', stderr: '' }
    }

    if (command.includes('memory list')) {
      const keys = Array.from(this.memory.keys())
      return { stdout: keys.join('\n'), stderr: '' }
    }

    if (command.includes('hooks')) {
      return { stdout: 'OK', stderr: '' }
    }

    return { stdout: '', stderr: '' }
  }

  getMemory(key: string): string | undefined {
    return this.memory.get(key)
  }

  setMemory(key: string, value: string): void {
    this.memory.set(key, value)
  }

  clearMemory(): void {
    this.memory.clear()
    this.commands = []
  }
}

describe('SessionManager', () => {
  let executor: MockCommandExecutor
  let manager: SessionManager

  beforeEach(() => {
    executor = new MockCommandExecutor()
    manager = new SessionManager(executor)
  })

  describe('generateSessionId', () => {
    it('should generate a valid UUID', () => {
      const id = manager.generateSessionId()
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    })

    it('should generate unique IDs', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 100; i++) {
        ids.add(manager.generateSessionId())
      }
      expect(ids.size).toBe(100)
    })
  })

  describe('startSession', () => {
    it('should create a new session with unique ID', async () => {
      const session = await manager.startSession()

      expect(session.sessionId).toBeDefined()
      expect(session.startedAt).toBeDefined()
      expect(session.checkpoints).toEqual([])
      expect(session.filesModified).toEqual([])
    })

    it('should store session in memory', async () => {
      const session = await manager.startSession({ issueId: 'SMI-641' })

      const storedSession = executor.getMemory(`session/${session.sessionId}`)
      expect(storedSession).toBeDefined()

      const parsed = JSON.parse(storedSession!)
      expect(parsed.sessionId).toBe(session.sessionId)
      expect(parsed.issueId).toBe('SMI-641')
    })

    it('should set current session pointer', async () => {
      const session = await manager.startSession()

      const current = executor.getMemory('session/current')
      expect(current).toBeDefined()

      const parsed = JSON.parse(current!)
      expect(parsed.sessionId).toBe(session.sessionId)
    })

    it('should accept optional parameters', async () => {
      const session = await manager.startSession({
        issueId: 'SMI-641',
        worktree: 'phase-2c-session',
        description: 'Test session',
      })

      expect(session.issueId).toBe('SMI-641')
      expect(session.worktree).toBe('phase-2c-session')
    })

    it('should run pre-task hook when description provided', async () => {
      await manager.startSession({ description: 'Test task' })

      const hookCommand = executor.commands.find((c) => c.includes('hooks pre-task'))
      expect(hookCommand).toBeDefined()
      expect(hookCommand).toContain('Test task')
    })
  })

  describe('createCheckpoint', () => {
    it('should create a checkpoint with unique ID', async () => {
      await manager.startSession()
      const checkpoint = await manager.createCheckpoint('Test checkpoint')

      expect(checkpoint.id).toBeDefined()
      expect(checkpoint.timestamp).toBeDefined()
      expect(checkpoint.description).toBe('Test checkpoint')
      expect(checkpoint.memoryKey).toContain('checkpoint/')
    })

    it('should add checkpoint to session', async () => {
      await manager.startSession()
      await manager.createCheckpoint('First checkpoint')
      await manager.createCheckpoint('Second checkpoint')

      const currentSession = manager.getCurrentSession()
      expect(currentSession?.checkpoints).toHaveLength(2)
      expect(currentSession?.checkpoints[0].description).toBe('First checkpoint')
      expect(currentSession?.checkpoints[1].description).toBe('Second checkpoint')
    })

    it('should store checkpoint in memory', async () => {
      await manager.startSession()
      const checkpoint = await manager.createCheckpoint('Test checkpoint')

      const stored = executor.getMemory(checkpoint.memoryKey)
      expect(stored).toBeDefined()
    })

    it('should throw if no active session', async () => {
      await expect(manager.createCheckpoint('Test')).rejects.toThrow('No active session')
    })

    it('should truncate long descriptions', async () => {
      await manager.startSession()
      const longDescription = 'a'.repeat(1000)
      const checkpoint = await manager.createCheckpoint(longDescription)

      expect(checkpoint.description.length).toBeLessThanOrEqual(500)
    })
  })

  describe('recordFileModified', () => {
    it('should add file to modified list', async () => {
      await manager.startSession()
      await manager.recordFileModified('/path/to/file.ts')

      const session = manager.getCurrentSession()
      expect(session?.filesModified).toContain('/path/to/file.ts')
    })

    it('should not add duplicates', async () => {
      await manager.startSession()
      await manager.recordFileModified('/path/to/file.ts')
      await manager.recordFileModified('/path/to/file.ts')

      const session = manager.getCurrentSession()
      expect(session?.filesModified).toHaveLength(1)
    })

    it('should update lastActivity', async () => {
      const session = await manager.startSession()
      const initialActivity = session.lastActivity

      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10))
      await manager.recordFileModified('/path/to/file.ts')

      const updatedSession = manager.getCurrentSession()
      expect(new Date(updatedSession!.lastActivity).getTime()).toBeGreaterThan(
        new Date(initialActivity).getTime()
      )
    })

    it('should throw if no active session', async () => {
      await expect(manager.recordFileModified('/path/to/file.ts')).rejects.toThrow(
        'No active session'
      )
    })
  })

  describe('endSession', () => {
    it('should clear current session', async () => {
      await manager.startSession()
      await manager.endSession()

      expect(manager.getCurrentSession()).toBeNull()
    })

    it('should run post-task hook', async () => {
      const session = await manager.startSession()
      await manager.endSession()

      const hookCommand = executor.commands.find((c) => c.includes('hooks post-task'))
      expect(hookCommand).toBeDefined()
      expect(hookCommand).toContain(session.sessionId)
    })

    it('should clear current session pointer', async () => {
      await manager.startSession()
      await manager.endSession()

      // Delete command should have been called
      const deleteCommand = executor.commands.find(
        (c) => c.includes('memory delete') && c.includes('session/current')
      )
      expect(deleteCommand).toBeDefined()
    })

    it('should be safe to call without active session', async () => {
      await expect(manager.endSession()).resolves.not.toThrow()
    })
  })

  describe('getSession', () => {
    it('should retrieve session by ID', async () => {
      const original = await manager.startSession({ issueId: 'SMI-641' })

      // Create new manager instance to simulate fresh start
      const newManager = new SessionManager(executor)
      const retrieved = await newManager.getSession(original.sessionId)

      expect(retrieved).not.toBeNull()
      expect(retrieved?.sessionId).toBe(original.sessionId)
      expect(retrieved?.issueId).toBe('SMI-641')
    })

    it('should return null for non-existent session', async () => {
      const session = await manager.getSession('non-existent-id')
      expect(session).toBeNull()
    })
  })

  describe('getCurrentSessionId', () => {
    it('should return current session ID', async () => {
      const session = await manager.startSession()
      const currentId = await manager.getCurrentSessionId()

      expect(currentId).toBe(session.sessionId)
    })

    it('should return null when no current session', async () => {
      const currentId = await manager.getCurrentSessionId()
      expect(currentId).toBeNull()
    })
  })
})

describe('SessionRecovery', () => {
  let executor: MockCommandExecutor
  let manager: SessionManager
  let recovery: SessionRecovery

  beforeEach(() => {
    executor = new MockCommandExecutor()
    manager = new SessionManager(executor)
    recovery = new SessionRecovery(manager, executor)
  })

  describe('findLatestSession', () => {
    it('should find current session', async () => {
      const session = await manager.startSession({ issueId: 'SMI-641' })
      await manager.endSession()

      // Restore current pointer for test
      executor.setMemory('session/current', JSON.stringify({ sessionId: session.sessionId }))

      const found = await recovery.findLatestSession()
      expect(found?.sessionId).toBe(session.sessionId)
    })

    it('should return null when no sessions exist', async () => {
      const found = await recovery.findLatestSession()
      expect(found).toBeNull()
    })
  })

  describe('restoreSession', () => {
    it('should restore session by ID', async () => {
      const session = await manager.startSession({ issueId: 'SMI-641' })
      const sessionId = session.sessionId
      await manager.endSession()

      const result = await recovery.restoreSession({ sessionId })

      expect(result.status).toBe('restored')
      expect(result.session?.sessionId).toBe(sessionId)
    })

    it('should return not_found for non-existent session', async () => {
      const result = await recovery.restoreSession({ sessionId: 'non-existent' })

      expect(result.status).toBe('not_found')
      expect(result.session).toBeNull()
    })

    it('should merge with new session on failure if requested', async () => {
      const result = await recovery.restoreSession({
        sessionId: 'non-existent',
        mergeOnFailure: true,
        newSessionOptions: { issueId: 'SMI-641' },
      })

      expect(result.status).toBe('merged')
      expect(result.session).not.toBeNull()
      expect(result.session?.issueId).toBe('SMI-641')
    })
  })

  describe('resumeFromCheckpoint', () => {
    it('should resume from latest checkpoint', async () => {
      await manager.startSession()
      await manager.createCheckpoint('First checkpoint')
      const lastCheckpoint = await manager.createCheckpoint('Last checkpoint')

      const currentSession = manager.getCurrentSession()!
      const result = await recovery.resumeFromCheckpoint(currentSession)

      expect(result.status).toBe('restored')
      expect(result.checkpoint?.id).toBe(lastCheckpoint.id)
    })

    it('should resume from specific checkpoint', async () => {
      await manager.startSession()
      const firstCheckpoint = await manager.createCheckpoint('First checkpoint')
      await manager.createCheckpoint('Last checkpoint')

      const currentSession = manager.getCurrentSession()!
      const result = await recovery.resumeFromCheckpoint(currentSession, firstCheckpoint.id)

      expect(result.status).toBe('restored')
      expect(result.checkpoint?.id).toBe(firstCheckpoint.id)
    })

    it('should return not_found when no checkpoints exist', async () => {
      await manager.startSession()
      const currentSession = manager.getCurrentSession()!

      const result = await recovery.resumeFromCheckpoint(currentSession)

      expect(result.status).toBe('not_found')
    })
  })

  describe('mergeWithNewSession', () => {
    it('should create new session with previous context', async () => {
      const previousSession = await manager.startSession({ issueId: 'SMI-640' })
      await manager.recordFileModified('/path/to/file.ts')
      await manager.endSession()

      const result = await recovery.mergeWithNewSession(previousSession, {
        issueId: 'SMI-641',
      })

      expect(result.status).toBe('merged')
      expect(result.session?.issueId).toBe('SMI-641')
      expect(result.session?.filesModified).toContain('/path/to/file.ts')
    })

    it('should preserve issue ID if not specified', async () => {
      const previousSession = await manager.startSession({ issueId: 'SMI-640' })
      await manager.endSession()

      const result = await recovery.mergeWithNewSession(previousSession, {})

      expect(result.session?.issueId).toBe('SMI-640')
    })
  })
})

describe('SessionContext utilities', () => {
  describe('createSessionContext', () => {
    it('should create active context for valid session', () => {
      const session: SessionData = {
        sessionId: 'test-id',
        startedAt: new Date().toISOString(),
        issueId: 'SMI-641',
        worktree: 'test',
        checkpoints: [],
        filesModified: ['/path/to/file.ts'],
        lastActivity: new Date().toISOString(),
      }

      const context = createSessionContext(session)

      expect(context.isActive()).toBe(true)
      expect(context.getCurrentIssueId()).toBe('SMI-641')
      expect(context.getModifiedFiles()).toContain('/path/to/file.ts')
    })

    it('should create null context for null session', () => {
      const context = createSessionContext(null)

      expect(context.isActive()).toBe(false)
      expect(context.getSessionData()).toBeNull()
    })
  })

  describe('getSessionDuration', () => {
    it('should calculate duration in milliseconds', () => {
      const startTime = new Date('2025-01-15T10:00:00Z')
      const endTime = new Date('2025-01-15T10:30:00Z')

      const session: SessionData = {
        sessionId: 'test',
        startedAt: startTime.toISOString(),
        checkpoints: [],
        filesModified: [],
        lastActivity: endTime.toISOString(),
      }

      const duration = getSessionDuration(session)
      expect(duration).toBe(30 * 60 * 1000) // 30 minutes in ms
    })
  })

  describe('formatSessionDuration', () => {
    it('should format hours and minutes', () => {
      const session: SessionData = {
        sessionId: 'test',
        startedAt: new Date('2025-01-15T10:00:00Z').toISOString(),
        checkpoints: [],
        filesModified: [],
        lastActivity: new Date('2025-01-15T12:30:00Z').toISOString(),
      }

      const formatted = formatSessionDuration(session)
      expect(formatted).toBe('2h 30m')
    })

    it('should format minutes and seconds for short sessions', () => {
      const session: SessionData = {
        sessionId: 'test',
        startedAt: new Date('2025-01-15T10:00:00Z').toISOString(),
        checkpoints: [],
        filesModified: [],
        lastActivity: new Date('2025-01-15T10:05:30Z').toISOString(),
      }

      const formatted = formatSessionDuration(session)
      expect(formatted).toBe('5m 30s')
    })

    it('should format seconds only for very short sessions', () => {
      const session: SessionData = {
        sessionId: 'test',
        startedAt: new Date('2025-01-15T10:00:00Z').toISOString(),
        checkpoints: [],
        filesModified: [],
        lastActivity: new Date('2025-01-15T10:00:45Z').toISOString(),
      }

      const formatted = formatSessionDuration(session)
      expect(formatted).toBe('45s')
    })
  })

  describe('getLatestCheckpoint', () => {
    it('should return null for empty checkpoints', () => {
      const session: SessionData = {
        sessionId: 'test',
        startedAt: new Date().toISOString(),
        checkpoints: [],
        filesModified: [],
        lastActivity: new Date().toISOString(),
      }

      expect(getLatestCheckpoint(session)).toBeNull()
    })

    it('should return the most recent checkpoint', () => {
      const checkpoints: Checkpoint[] = [
        {
          id: '1',
          timestamp: new Date('2025-01-15T10:00:00Z').toISOString(),
          description: 'First',
          memoryKey: 'checkpoint/1',
        },
        {
          id: '3',
          timestamp: new Date('2025-01-15T12:00:00Z').toISOString(),
          description: 'Third',
          memoryKey: 'checkpoint/3',
        },
        {
          id: '2',
          timestamp: new Date('2025-01-15T11:00:00Z').toISOString(),
          description: 'Second',
          memoryKey: 'checkpoint/2',
        },
      ]

      const session: SessionData = {
        sessionId: 'test',
        startedAt: new Date().toISOString(),
        checkpoints,
        filesModified: [],
        lastActivity: new Date().toISOString(),
      }

      const latest = getLatestCheckpoint(session)
      expect(latest?.id).toBe('3')
      expect(latest?.description).toBe('Third')
    })
  })
})
