/**
 * SMI-638: Session Checkpoint Tests
 *
 * Tests for checkpoint creation, serialization, and restore functionality.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  SessionCheckpoint,
  generateCheckpointId,
  generateSessionId,
  type SessionCheckpointData,
  type CheckpointTodo,
} from '../src/session/SessionCheckpoint.js'
import {
  CheckpointManager,
  type CheckpointManagerOptions,
} from '../src/session/CheckpointManager.js'

describe('SessionCheckpoint', () => {
  describe('generateCheckpointId', () => {
    it('should generate unique IDs with ckpt_ prefix and UUID format', () => {
      const id1 = generateCheckpointId()
      const id2 = generateCheckpointId()

      // SMI-663: Now uses crypto.randomUUID format
      expect(id1).toMatch(
        /^ckpt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
      expect(id2).toMatch(
        /^ckpt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
      expect(id1).not.toBe(id2)
    })
  })

  describe('generateSessionId', () => {
    it('should generate unique IDs with sess_ prefix and UUID format', () => {
      const id1 = generateSessionId()
      const id2 = generateSessionId()

      // SMI-663: Now uses crypto.randomUUID format
      expect(id1).toMatch(
        /^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
      expect(id2).toMatch(
        /^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
      expect(id1).not.toBe(id2)
    })
  })

  describe('constructor', () => {
    it('should create checkpoint with required fields', () => {
      const checkpoint = new SessionCheckpoint({
        sessionId: 'sess_test123',
        workingDirectory: '/test/dir',
      })

      expect(checkpoint.sessionId).toBe('sess_test123')
      expect(checkpoint.id).toMatch(/^ckpt_[0-9a-f-]+$/i)
      expect(checkpoint.timestamp).toBeDefined()
    })

    it('should create checkpoint with all fields', () => {
      const timestamp = new Date().toISOString()
      const checkpoint = new SessionCheckpoint({
        id: 'ckpt_custom',
        timestamp,
        sessionId: 'sess_test',
        workingDirectory: '/test',
        branch: 'main',
        filesModified: [{ path: '/test/file.ts', action: 'modified', timestamp }],
        testsRun: [{ name: 'test1', passed: true, duration: 100, timestamp }],
        todos: [{ id: '1', content: 'Test todo', status: 'pending' }],
        metadata: { key: 'value' },
      })

      const data = checkpoint.getData()
      expect(data.id).toBe('ckpt_custom')
      expect(data.branch).toBe('main')
      expect(data.filesModified).toHaveLength(1)
      expect(data.testsRun).toHaveLength(1)
      expect(data.todos).toHaveLength(1)
      expect(data.metadata).toEqual({ key: 'value' })
    })
  })

  describe('addFileModification', () => {
    it('should add file modification', () => {
      const checkpoint = new SessionCheckpoint({
        sessionId: 'sess_test',
        workingDirectory: '/test',
      })

      checkpoint.addFileModification({
        path: '/test/file.ts',
        action: 'created',
        timestamp: new Date().toISOString(),
      })

      expect(checkpoint.getData().filesModified).toHaveLength(1)
      expect(checkpoint.getData().filesModified[0].path).toBe('/test/file.ts')
    })

    it('should replace existing modification for same file', () => {
      const checkpoint = new SessionCheckpoint({
        sessionId: 'sess_test',
        workingDirectory: '/test',
      })

      checkpoint.addFileModification({
        path: '/test/file.ts',
        action: 'created',
        timestamp: new Date().toISOString(),
      })

      checkpoint.addFileModification({
        path: '/test/file.ts',
        action: 'modified',
        timestamp: new Date().toISOString(),
      })

      expect(checkpoint.getData().filesModified).toHaveLength(1)
      expect(checkpoint.getData().filesModified[0].action).toBe('modified')
    })
  })

  describe('addTestResult', () => {
    it('should add test result', () => {
      const checkpoint = new SessionCheckpoint({
        sessionId: 'sess_test',
        workingDirectory: '/test',
      })

      checkpoint.addTestResult({
        name: 'mytest',
        passed: true,
        duration: 50,
        timestamp: new Date().toISOString(),
      })

      expect(checkpoint.getData().testsRun).toHaveLength(1)
      expect(checkpoint.getData().testsRun[0].name).toBe('mytest')
    })
  })

  describe('setTodos', () => {
    it('should set todos snapshot', () => {
      const checkpoint = new SessionCheckpoint({
        sessionId: 'sess_test',
        workingDirectory: '/test',
      })

      const todos: CheckpointTodo[] = [
        { id: '1', content: 'First', status: 'completed' },
        { id: '2', content: 'Second', status: 'in_progress' },
      ]

      checkpoint.setTodos(todos)
      expect(checkpoint.getData().todos).toHaveLength(2)
    })
  })

  describe('setMetadata', () => {
    it('should set metadata key-value pairs', () => {
      const checkpoint = new SessionCheckpoint({
        sessionId: 'sess_test',
        workingDirectory: '/test',
      })

      checkpoint.setMetadata('issue', 'SMI-638')
      checkpoint.setMetadata('phase', 2)

      const metadata = checkpoint.getData().metadata
      expect(metadata?.issue).toBe('SMI-638')
      expect(metadata?.phase).toBe(2)
    })
  })

  describe('serialization', () => {
    it('should serialize to JSON', () => {
      const checkpoint = new SessionCheckpoint({
        sessionId: 'sess_test',
        workingDirectory: '/test',
        branch: 'main',
      })

      const json = checkpoint.serialize()
      expect(typeof json).toBe('string')

      const parsed = JSON.parse(json) as SessionCheckpointData
      expect(parsed.sessionId).toBe('sess_test')
      expect(parsed.branch).toBe('main')
    })

    it('should deserialize from JSON', () => {
      const original = new SessionCheckpoint({
        sessionId: 'sess_test',
        workingDirectory: '/test',
        branch: 'feature',
      })

      const json = original.serialize()
      const restored = SessionCheckpoint.deserialize(json)

      expect(restored.sessionId).toBe(original.sessionId)
      expect(restored.getData().branch).toBe('feature')
    })

    it('should handle round-trip with all fields', () => {
      const timestamp = new Date().toISOString()
      const original = new SessionCheckpoint({
        sessionId: 'sess_test',
        workingDirectory: '/test',
        branch: 'main',
        filesModified: [{ path: '/f1.ts', action: 'modified', timestamp }],
        testsRun: [{ name: 'test1', passed: true, duration: 100, timestamp }],
        todos: [{ id: '1', content: 'Todo', status: 'pending' }],
        metadata: { key: 'value' },
      })

      const restored = SessionCheckpoint.deserialize(original.serialize())
      const data = restored.getData()

      expect(data.filesModified).toHaveLength(1)
      expect(data.testsRun).toHaveLength(1)
      expect(data.todos).toHaveLength(1)
      expect(data.metadata?.key).toBe('value')
    })
  })

  describe('size management', () => {
    it('should report serialized size', () => {
      const checkpoint = new SessionCheckpoint({
        sessionId: 'sess_test',
        workingDirectory: '/test',
      })

      const size = checkpoint.getSerializedSize()
      expect(typeof size).toBe('number')
      expect(size).toBeGreaterThan(0)
    })

    it('should detect when size exceeds limit', () => {
      const checkpoint = new SessionCheckpoint({
        sessionId: 'sess_test',
        workingDirectory: '/test',
      })

      // Small checkpoint should not exceed limit
      expect(checkpoint.exceedsSizeLimit(10240)).toBe(false)

      // Very small limit should be exceeded
      expect(checkpoint.exceedsSizeLimit(10)).toBe(true)
    })
  })

  describe('memory key generation', () => {
    it('should generate correct memory key format', () => {
      const checkpoint = new SessionCheckpoint({
        id: 'ckpt_abc123',
        sessionId: 'sess_xyz789',
        workingDirectory: '/test',
      })

      const key = checkpoint.toMemoryKey()
      expect(key).toBe('session/sess_xyz789/checkpoint/ckpt_abc123')
    })
  })

  describe('hook command generation', () => {
    it('should generate valid hook command', () => {
      const checkpoint = new SessionCheckpoint({
        sessionId: 'sess_test',
        workingDirectory: '/test',
      })

      const cmd = checkpoint.toHookCommand()
      expect(cmd).toContain('npx claude-flow@alpha hooks post-edit')
      expect(cmd).toContain('--memory-key')
      expect(cmd).toContain('session/sess_test/checkpoint/')
    })
  })
})

describe('CheckpointManager', () => {
  let manager: CheckpointManager

  beforeEach(() => {
    manager = new CheckpointManager({
      workingDirectory: '/test/project',
      branch: 'main',
      autoCheckpointInterval: 60000, // 1 minute for tests
      autoCheckpointOnSave: false, // Disable auto-checkpoint for deterministic tests
    })
  })

  afterEach(() => {
    manager.stop()
  })

  describe('constructor', () => {
    it('should generate session ID if not provided', () => {
      const mgr = new CheckpointManager({
        workingDirectory: '/test',
      })

      expect(mgr.getSessionId()).toMatch(/^sess_[0-9a-f-]+$/i)
      mgr.stop()
    })

    it('should use provided session ID', () => {
      const mgr = new CheckpointManager({
        sessionId: 'sess_custom',
        workingDirectory: '/test',
      })

      expect(mgr.getSessionId()).toBe('sess_custom')
      mgr.stop()
    })
  })

  describe('recordFileModification', () => {
    it('should record file modifications', () => {
      manager.recordFileModification('/test/file.ts', 'modified')

      const checkpoint = manager.getCurrentCheckpoint()
      const data = checkpoint.getData()

      expect(data.filesModified).toHaveLength(1)
      expect(data.filesModified[0].path).toBe('/test/file.ts')
    })
  })

  describe('recordTestResult', () => {
    it('should record test results', () => {
      manager.recordTestResult('my.test', true, 150)

      const checkpoint = manager.getCurrentCheckpoint()
      const data = checkpoint.getData()

      expect(data.testsRun).toHaveLength(1)
      expect(data.testsRun[0].name).toBe('my.test')
      expect(data.testsRun[0].passed).toBe(true)
    })
  })

  describe('updateTodos', () => {
    it('should update todos in checkpoint', () => {
      const todos: CheckpointTodo[] = [
        { id: '1', content: 'Task 1', status: 'completed' },
        { id: '2', content: 'Task 2', status: 'in_progress' },
      ]

      manager.updateTodos(todos)

      const checkpoint = manager.getCurrentCheckpoint()
      expect(checkpoint.getData().todos).toHaveLength(2)
    })
  })

  describe('createCheckpoint', () => {
    it('should create checkpoint and add to history', async () => {
      manager.recordFileModification('/test/a.ts', 'modified')

      const checkpoint = await manager.createCheckpoint(false)

      expect(checkpoint.getData().filesModified).toHaveLength(1)
      expect(manager.getCheckpointHistory()).toHaveLength(1)
    })

    it('should preserve todos across checkpoints', async () => {
      manager.updateTodos([{ id: '1', content: 'Keep me', status: 'pending' }])

      await manager.createCheckpoint(false)

      const current = manager.getCurrentCheckpoint()
      expect(current.getData().todos).toHaveLength(1)
      expect(current.getData().todos[0].content).toBe('Keep me')
    })

    it('should limit checkpoint history size', async () => {
      const mgr = new CheckpointManager({
        workingDirectory: '/test',
        maxCheckpointsRetained: 3,
        autoCheckpointOnSave: false,
      })

      for (let i = 0; i < 5; i++) {
        await mgr.createCheckpoint(false)
      }

      expect(mgr.getCheckpointHistory()).toHaveLength(3)
      mgr.stop()
    })
  })

  describe('exportSession / importSession', () => {
    it('should export and import session state', () => {
      manager.recordFileModification('/test/file.ts', 'created')
      manager.updateTodos([{ id: '1', content: 'Todo', status: 'pending' }])

      const exported = manager.exportSession()

      const newManager = new CheckpointManager({
        workingDirectory: '/other',
        autoCheckpointOnSave: false,
      })
      newManager.importSession(exported)

      const imported = newManager.getCurrentCheckpoint().getData()
      expect(imported.filesModified).toHaveLength(1)
      expect(imported.todos).toHaveLength(1)

      newManager.stop()
    })
  })

  describe('start / stop', () => {
    it('should start and stop auto-checkpointing', () => {
      vi.useFakeTimers()

      const mgr = new CheckpointManager({
        workingDirectory: '/test',
        autoCheckpointInterval: 1000,
        autoCheckpointOnSave: false,
      })

      mgr.start()
      // Second start should be no-op
      mgr.start()

      mgr.stop()
      // Second stop should be no-op
      mgr.stop()

      vi.useRealTimers()
    })
  })
})
