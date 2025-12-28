/**
 * SMI-660 through SMI-666: Session Checkpoint Security Tests
 *
 * TDD London School approach - These tests define the security contracts
 * that the SessionCheckpoint and CheckpointManager must satisfy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SessionCheckpoint,
  generateCheckpointId,
  generateSessionId,
  type SessionCheckpointData,
} from '../src/session/SessionCheckpoint.js'
import { CheckpointManager } from '../src/session/CheckpointManager.js'
import * as crypto from 'node:crypto'

describe('SessionCheckpoint Security', () => {
  /**
   * SMI-660: Command Injection Prevention
   *
   * The toHookCommand() method must NOT interpolate user data into shell commands.
   * Data should be passed via secure temp files or array-based arguments.
   */
  describe('Command Injection Prevention (SMI-660)', () => {
    it('should not interpolate data into shell commands', () => {
      const maliciousData: Partial<SessionCheckpointData> & {
        sessionId: string
        workingDirectory: string
      } = {
        sessionId: 'sess_test',
        workingDirectory: '/test',
        timestamp: new Date().toISOString(),
        filesModified: [
          { path: 'file.ts; rm -rf /', action: 'modified', timestamp: new Date().toISOString() },
        ],
        todos: [],
      }

      const checkpoint = new SessionCheckpoint(maliciousData)
      const command = checkpoint.toHookCommand()

      // Command should NOT contain the malicious payload interpolated
      // It should use file-based data transfer or properly escaped args
      expect(command).not.toContain('rm -rf')
      expect(command).not.toContain('; ')
      expect(command).not.toContain('$(')
      expect(command).not.toContain('`')
    })

    it('should escape or reject shell metacharacters in session IDs', () => {
      const maliciousSessionId = 'sess_$(whoami)_test'

      const checkpoint = new SessionCheckpoint({
        sessionId: maliciousSessionId,
        workingDirectory: '/test',
      })

      const command = checkpoint.toHookCommand()

      // Should not allow command substitution
      expect(command).not.toContain('$(whoami)')
    })

    it('should escape backtick command substitution', () => {
      const maliciousData: Partial<SessionCheckpointData> & {
        sessionId: string
        workingDirectory: string
      } = {
        sessionId: 'sess_test',
        workingDirectory: '/test`id`',
      }

      const checkpoint = new SessionCheckpoint(maliciousData)
      const command = checkpoint.toHookCommand()

      expect(command).not.toContain('`id`')
    })

    it('should use array-based arguments for subprocess', () => {
      const checkpoint = new SessionCheckpoint({
        sessionId: 'sess_test',
        workingDirectory: '/test',
      })

      // The hook command should indicate file-based data transfer
      const command = checkpoint.toHookCommand()
      expect(command).toContain('--file')
    })
  })

  /**
   * SMI-661: Prototype Pollution Prevention
   *
   * The deserialize/fromJSON methods must reject payloads containing
   * __proto__, constructor, or prototype keys.
   */
  describe('Prototype Pollution Prevention (SMI-661)', () => {
    it('should reject payloads with __proto__', () => {
      // NOTE: JSON.stringify strips __proto__, so we must use raw JSON string
      const maliciousJson =
        '{"id":"ckpt_test","timestamp":"2024-01-01T00:00:00.000Z","sessionId":"sess_test","workingDirectory":"/test","filesModified":[],"testsRun":[],"todos":[],"__proto__":{"polluted":true}}'

      expect(() => SessionCheckpoint.deserialize(maliciousJson)).toThrow(
        /invalid|prohibited|dangerous/i
      )
    })

    it('should reject payloads with constructor pollution', () => {
      // NOTE: constructor may be stripped/modified by JSON.stringify, use raw string
      const maliciousJson =
        '{"id":"ckpt_test","timestamp":"2024-01-01T00:00:00.000Z","sessionId":"sess_test","workingDirectory":"/test","filesModified":[],"testsRun":[],"todos":[],"constructor":{"prototype":{"polluted":true}}}'

      expect(() => SessionCheckpoint.deserialize(maliciousJson)).toThrow(
        /invalid|prohibited|dangerous/i
      )
    })

    it('should reject nested __proto__ in metadata', () => {
      // NOTE: JSON.stringify strips __proto__, so we must use raw JSON string
      const maliciousJson =
        '{"id":"ckpt_test","timestamp":"2024-01-01T00:00:00.000Z","sessionId":"sess_test","workingDirectory":"/test","filesModified":[],"testsRun":[],"todos":[],"metadata":{"__proto__":{"polluted":true}}}'

      expect(() => SessionCheckpoint.deserialize(maliciousJson)).toThrow(
        /invalid|prohibited|dangerous/i
      )
    })

    it('should reject prototype pollution in array items', () => {
      // NOTE: JSON.stringify strips __proto__, so we must use raw JSON string
      const maliciousJson =
        '{"id":"ckpt_test","timestamp":"2024-01-01T00:00:00.000Z","sessionId":"sess_test","workingDirectory":"/test","filesModified":[],"testsRun":[],"todos":[{"id":"1","content":"test","status":"pending","__proto__":{"polluted":true}}]}'

      expect(() => SessionCheckpoint.deserialize(maliciousJson)).toThrow(
        /invalid|prohibited|dangerous/i
      )
    })
  })

  /**
   * SMI-662: Environment Variable Safety
   *
   * Subprocesses must NOT receive the full process.env.
   * Only minimal required environment variables should be passed.
   */
  describe('Environment Variable Safety (SMI-662)', () => {
    it('should not pass full process.env to subprocesses', () => {
      const manager = new CheckpointManager({
        sessionId: 'sess_test',
        workingDirectory: '/test',
        autoCheckpointOnSave: false,
      })

      const checkpoint = manager.getCurrentCheckpoint()
      const spawnOptions = manager.getSpawnOptions()

      // Should NOT include sensitive env vars
      expect(spawnOptions.env).not.toHaveProperty('HOME')
      expect(spawnOptions.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
      expect(spawnOptions.env).not.toHaveProperty('AWS_ACCESS_KEY_ID')
      expect(spawnOptions.env).not.toHaveProperty('GITHUB_TOKEN')
      expect(spawnOptions.env).not.toHaveProperty('NPM_TOKEN')
      expect(spawnOptions.env).not.toHaveProperty('DATABASE_URL')

      manager.stop()
    })

    it('should not pass data via CHECKPOINT_DATA env var', () => {
      const manager = new CheckpointManager({
        sessionId: 'sess_test',
        workingDirectory: '/test',
        autoCheckpointOnSave: false,
      })

      const spawnOptions = manager.getSpawnOptions()

      // Data should be passed via temp file, not env var
      expect(spawnOptions.env).not.toHaveProperty('CHECKPOINT_DATA')

      manager.stop()
    })

    it('should only pass PATH to subprocess', () => {
      const manager = new CheckpointManager({
        sessionId: 'sess_test',
        workingDirectory: '/test',
        autoCheckpointOnSave: false,
      })

      const spawnOptions = manager.getSpawnOptions()

      // Should only have PATH (and maybe NODE_ENV for debugging)
      const allowedKeys = ['PATH', 'NODE_ENV']
      const envKeys = Object.keys(spawnOptions.env ?? {})

      for (const key of envKeys) {
        expect(allowedKeys).toContain(key)
      }

      manager.stop()
    })
  })

  /**
   * SMI-663: Cryptographically Secure ID Generation
   *
   * IDs must use crypto.randomUUID() instead of Math.random().
   */
  describe('Cryptographically Secure ID Generation (SMI-663)', () => {
    it('should generate checkpoint IDs using crypto.randomUUID', () => {
      const id = generateCheckpointId()

      // Should be a valid UUID format (with ckpt_ prefix)
      expect(id).toMatch(
        /^ckpt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
    })

    it('should generate session IDs using crypto.randomUUID', () => {
      const id = generateSessionId()

      // Should be a valid UUID format (with sess_ prefix)
      expect(id).toMatch(
        /^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
    })

    it('should not use Math.random for ID generation', () => {
      // Spy on Math.random to ensure it's not called
      const mathRandomSpy = vi.spyOn(Math, 'random')

      generateCheckpointId()
      generateSessionId()

      expect(mathRandomSpy).not.toHaveBeenCalled()

      mathRandomSpy.mockRestore()
    })

    it('should generate unique IDs', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 1000; i++) {
        ids.add(generateCheckpointId())
        ids.add(generateSessionId())
      }
      expect(ids.size).toBe(2000)
    })
  })

  /**
   * SMI-664: Race Condition Prevention
   *
   * Concurrent checkpoint operations must be properly synchronized.
   */
  describe('Race Condition Prevention (SMI-664)', () => {
    it('should serialize concurrent checkpoint creations', async () => {
      const manager = new CheckpointManager({
        sessionId: 'sess_test',
        workingDirectory: '/test',
        autoCheckpointOnSave: false,
      })

      // Record file modifications first
      for (let i = 0; i < 10; i++) {
        manager.recordFileModification(`/test/file${i}.ts`, 'modified')
      }

      // Create multiple checkpoints concurrently (without storing to memory)
      const promises = Array.from({ length: 10 }, () => {
        return manager.createCheckpoint(false)
      })

      const checkpoints = await Promise.all(promises)

      // All checkpoints should have unique IDs
      const ids = checkpoints.map((c) => c.id)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(10)

      // History should be consistent
      const history = manager.getCheckpointHistory()
      expect(history.length).toBe(10)

      manager.stop()
    }, 30000) // Increase timeout for concurrent operations

    it('should handle concurrent file modification recordings', () => {
      const manager = new CheckpointManager({
        sessionId: 'sess_test',
        workingDirectory: '/test',
        autoCheckpointOnSave: false,
      })

      // Simulate rapid file modifications
      for (let i = 0; i < 100; i++) {
        manager.recordFileModification(`/test/file${i}.ts`, 'modified')
      }

      const data = manager.getCurrentCheckpoint().getData()
      expect(data.filesModified.length).toBe(100)

      manager.stop()
    })
  })

  /**
   * SMI-665: Zombie Process Prevention
   *
   * Subprocesses must be properly terminated using AbortController.
   */
  describe('Zombie Process Prevention (SMI-665)', () => {
    it('should use AbortController for subprocess timeout', async () => {
      const manager = new CheckpointManager({
        sessionId: 'sess_test',
        workingDirectory: '/test',
        autoCheckpointOnSave: false,
      })

      // The manager should expose abort capability
      expect(typeof manager.abort).toBe('function')

      manager.stop()
    })

    it('should clean up processes on abort', async () => {
      const manager = new CheckpointManager({
        sessionId: 'sess_test',
        workingDirectory: '/test',
        autoCheckpointOnSave: false,
      })

      // Abort BEFORE starting an operation
      manager.abort()

      // Now try to store - should fail because abort was called
      const result = await manager.storeToMemory(manager.getCurrentCheckpoint())

      // Should resolve with error, not hang
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/abort|cancel/i)

      manager.stop()
    })
  })

  /**
   * SMI-666: Secure Temp File Handling
   *
   * Temp files must be created with restricted permissions (0600).
   */
  describe('Secure Temp File Handling (SMI-666)', () => {
    it('should create temp files with 0600 permissions', async () => {
      const manager = new CheckpointManager({
        sessionId: 'sess_test',
        workingDirectory: '/test',
        autoCheckpointOnSave: false,
      })

      const tempFilePath = await manager.createSecureTempFile('test data')

      // Verify the file was created with restricted permissions
      const fs = await import('node:fs/promises')
      const stats = await fs.stat(tempFilePath)

      // 0600 = owner read/write only (33152 in decimal on Unix)
      // The mode includes file type bits, so we mask with 0o777
      const permissions = stats.mode & 0o777
      expect(permissions).toBe(0o600)

      // Clean up
      await fs.unlink(tempFilePath)
      manager.stop()
    })

    it('should use mkdtemp for secure temp directory creation', async () => {
      const manager = new CheckpointManager({
        sessionId: 'sess_test',
        workingDirectory: '/test',
        autoCheckpointOnSave: false,
      })

      const tempDir = await manager.createSecureTempDir()

      // Verify the directory was created
      const fs = await import('node:fs/promises')
      const stats = await fs.stat(tempDir)
      expect(stats.isDirectory()).toBe(true)

      // Should be in system temp directory
      const os = await import('node:os')
      expect(tempDir.startsWith(os.tmpdir())).toBe(true)

      // Clean up
      await fs.rmdir(tempDir)
      manager.stop()
    })

    it('should clean up temp files after use', async () => {
      const manager = new CheckpointManager({
        sessionId: 'sess_test',
        workingDirectory: '/test',
        autoCheckpointOnSave: false,
      })

      const tempFilePath = await manager.createSecureTempFile('test data')

      // Use the temp file
      await manager.cleanupTempFile(tempFilePath)

      // Verify file was deleted
      const fs = await import('node:fs/promises')
      await expect(fs.access(tempFilePath)).rejects.toThrow()

      manager.stop()
    })
  })
})
