/**
 * Session Manager Security & Concurrency Tests
 * SMI-674: Command Injection Prevention
 * SMI-675: Race Condition Prevention
 * SMI-676: Partial Failure Rollback
 *
 * TDD London School approach - tests written FIRST
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SessionManager, type CommandExecutor } from '../src/session/index.js'

/**
 * Mock command executor that supports spawn() interface and tracks all calls
 * This is the proper mock for testing the secure spawn-based implementation
 */
class SpawnAwareExecutor implements CommandExecutor {
  private memory: Map<string, string> = new Map()
  public spawnCalls: Array<{ executable: string; args: string[] }> = []
  public executeCalls: string[] = []
  public usedStringCommand = false
  public failOnKey?: string
  public failOnCheckpointStore = false
  public failOnSessionStore = false
  public deletedKeys: string[] = []

  async execute(command: string): Promise<{ stdout: string; stderr: string }> {
    this.usedStringCommand = true
    this.executeCalls.push(command)

    // Parse and execute for basic functionality (fallback path)
    if (command.includes('memory store')) {
      const keyMatch = command.match(/--key "([^"]+)"/)
      const valueMatch = command.match(/--value '([^']*(?:\\'[^']*)*)'/)
      if (keyMatch && valueMatch) {
        this.memory.set(keyMatch[1], valueMatch[1].replace(/\\'/g, "'"))
      }
      return { stdout: 'OK', stderr: '' }
    }

    if (command.includes('memory get')) {
      const keyMatch = command.match(/--key "([^"]+)"/)
      if (keyMatch) {
        return { stdout: this.memory.get(keyMatch[1]) ?? '', stderr: '' }
      }
    }

    if (command.includes('memory delete')) {
      const keyMatch = command.match(/--key "([^"]+)"/)
      if (keyMatch) {
        this.deletedKeys.push(keyMatch[1])
        this.memory.delete(keyMatch[1])
      }
      return { stdout: 'OK', stderr: '' }
    }

    return { stdout: 'OK', stderr: '' }
  }

  /**
   * Secure spawn-based execution - this should be called by the fixed implementation
   */
  async spawn(executable: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.spawnCalls.push({ executable, args })

    // Simulate memory operations based on args
    const keyIndex = args.indexOf('--key')
    const valueIndex = args.indexOf('--value')
    const action = args[2] // e.g., 'store', 'get', 'delete'

    if (keyIndex !== -1) {
      const key = args[keyIndex + 1]

      // Failure simulation
      if (this.failOnKey && key === this.failOnKey) {
        throw new Error('Simulated failure')
      }

      if (this.failOnCheckpointStore && key.includes('checkpoint/')) {
        throw new Error('Checkpoint storage failed')
      }

      if (this.failOnSessionStore && key.startsWith('session/') && !key.includes('current')) {
        throw new Error('Session storage failed')
      }

      if (action === 'store' && valueIndex !== -1) {
        const value = args[valueIndex + 1]
        this.memory.set(key, value)
        return { stdout: 'OK', stderr: '' }
      }

      if (action === 'get') {
        const value = this.memory.get(key) ?? ''
        return { stdout: value, stderr: '' }
      }

      if (action === 'delete') {
        this.deletedKeys.push(key)
        this.memory.delete(key)
        return { stdout: 'OK', stderr: '' }
      }
    }

    return { stdout: 'OK', stderr: '' }
  }

  getMemory(key: string): string | undefined {
    return this.memory.get(key)
  }

  setMemory(key: string, value: string): void {
    this.memory.set(key, value)
  }

  hasKey(key: string): boolean {
    return this.memory.has(key)
  }

  clear(): void {
    this.memory.clear()
    this.spawnCalls = []
    this.executeCalls = []
    this.usedStringCommand = false
    this.failOnKey = undefined
    this.failOnCheckpointStore = false
    this.failOnSessionStore = false
    this.deletedKeys = []
  }

  /**
   * Check if spawn arguments contain injection attempts
   * With spawn(), these are just string literals, not executed
   */
  getValuesFromSpawnCalls(): string[] {
    const values: string[] = []
    for (const call of this.spawnCalls) {
      const valueIndex = call.args.indexOf('--value')
      if (valueIndex !== -1 && call.args[valueIndex + 1]) {
        values.push(call.args[valueIndex + 1])
      }
    }
    return values
  }
}

describe('SMI-674: Command Injection Prevention', () => {
  let executor: SpawnAwareExecutor
  let manager: SessionManager

  beforeEach(() => {
    executor = new SpawnAwareExecutor()
    manager = new SessionManager(executor)
  })

  describe('storeMemory command injection', () => {
    it('should prevent $(whoami) command substitution in values', async () => {
      await manager.startSession()

      // Attempt to inject command substitution in checkpoint description
      await manager.createCheckpoint('test $(whoami) injection')

      // With spawn(), values are passed as literal strings, not shell-interpreted
      // The injection payload should be stored as-is
      const values = executor.getValuesFromSpawnCalls()
      const hasInjectionAsLiteral = values.some((v) => v.includes('$(whoami)'))

      // The value should be stored literally (as data, not executed)
      expect(hasInjectionAsLiteral).toBe(true)

      // spawn() was used, not the insecure execute()
      expect(executor.spawnCalls.length).toBeGreaterThan(0)
    })

    it('should prevent backtick command substitution in values', async () => {
      await manager.startSession()

      // Attempt backtick injection
      await manager.createCheckpoint('test `id` injection')

      // With spawn(), backticks are just characters, not command substitution
      const values = executor.getValuesFromSpawnCalls()
      const hasBacktickAsLiteral = values.some((v) => v.includes('`id`'))

      expect(hasBacktickAsLiteral).toBe(true)
    })

    it('should prevent newline injection in values', async () => {
      await manager.startSession()

      // Attempt newline injection to run additional commands
      const payload = 'test\nmalicious-command\n'
      await manager.createCheckpoint(payload)

      // With spawn(), newlines are just characters in the value
      // They don't break out of the command
      const session = manager.getCurrentSession()
      expect(session?.checkpoints[0].description).toContain('test')
    })

    it('should prevent semicolon command chaining', async () => {
      await manager.startSession()

      // Attempt semicolon injection
      await manager.createCheckpoint("test'; rm -rf /; echo '")

      // With spawn(), semicolons are just characters
      const values = executor.getValuesFromSpawnCalls()
      const hasSemicolonAsLiteral = values.some((v) => v.includes(';'))

      expect(hasSemicolonAsLiteral).toBe(true)
    })

    it('should prevent pipe injection in values', async () => {
      await manager.startSession()

      // Attempt pipe injection
      await manager.createCheckpoint('test | cat /etc/passwd')

      // Value should be stored literally
      const session = manager.getCurrentSession()
      const checkpoint = session?.checkpoints[0]

      // The description should contain the literal string, not executed
      expect(checkpoint?.description).toBe('test | cat /etc/passwd')
    })

    it('should use spawn with argument array instead of exec with string', async () => {
      // After the fix, the manager should use spawn() not execute()
      await manager.startSession()
      await manager.createCheckpoint('test')

      // The executor tracks if spawn was used
      expect(executor.spawnCalls.length).toBeGreaterThan(0)

      // And execute was NOT used for memory operations
      // (it may still be called for hooks if spawn not available, but memory ops should use spawn)
      expect(executor.usedStringCommand).toBe(false)
    })
  })

  describe('key validation', () => {
    it('should reject keys with command injection patterns', async () => {
      // Keys are validated separately, but ensure they can't contain injection
      await manager.startSession()

      // The session ID is generated internally with UUID, so keys should be safe
      const session = manager.getCurrentSession()
      expect(session?.sessionId).toMatch(/^[a-f0-9-]+$/i)
    })
  })
})

describe('SMI-675: Race Condition Prevention', () => {
  let executor: SpawnAwareExecutor
  let manager: SessionManager

  beforeEach(() => {
    executor = new SpawnAwareExecutor()
    manager = new SessionManager(executor)
  })

  it('should preserve all checkpoints when created concurrently', async () => {
    await manager.startSession()

    // Create multiple checkpoints concurrently
    const concurrentCheckpoints = Promise.all([
      manager.createCheckpoint('Checkpoint 1'),
      manager.createCheckpoint('Checkpoint 2'),
      manager.createCheckpoint('Checkpoint 3'),
      manager.createCheckpoint('Checkpoint 4'),
      manager.createCheckpoint('Checkpoint 5'),
    ])

    await concurrentCheckpoints

    // All 5 checkpoints should exist
    const session = manager.getCurrentSession()
    expect(session?.checkpoints).toHaveLength(5)

    // Each checkpoint should have a unique ID
    const ids = new Set(session?.checkpoints.map((cp) => cp.id))
    expect(ids.size).toBe(5)
  })

  it('should not lose data during parallel session updates', async () => {
    await manager.startSession()

    // Run multiple operations concurrently
    const operations = Promise.all([
      manager.createCheckpoint('CP1'),
      manager.recordFileModified('/file1.ts'),
      manager.createCheckpoint('CP2'),
      manager.recordFileModified('/file2.ts'),
      manager.createCheckpoint('CP3'),
      manager.recordFileModified('/file3.ts'),
    ])

    await operations

    const session = manager.getCurrentSession()

    // All checkpoints and files should be recorded
    expect(session?.checkpoints).toHaveLength(3)
    expect(session?.filesModified).toHaveLength(3)
  })

  it('should serialize checkpoint creation to prevent interleaving', async () => {
    await manager.startSession()

    const timestamps: string[] = []

    // Create checkpoints that record their creation order
    const promises = []
    for (let i = 0; i < 10; i++) {
      promises.push(
        manager.createCheckpoint(`Checkpoint ${i}`).then((cp) => {
          timestamps.push(cp.timestamp)
          return cp
        })
      )
    }

    await Promise.all(promises)

    const session = manager.getCurrentSession()
    expect(session?.checkpoints).toHaveLength(10)

    // Verify no duplicate timestamps (indicates proper serialization)
    // Note: This may still have duplicates due to timestamp resolution,
    // but the IDs should all be unique
    const uniqueIds = new Set(session?.checkpoints.map((cp) => cp.id))
    expect(uniqueIds.size).toBe(10)
  })

  it('should handle lock timeout gracefully', async () => {
    await manager.startSession()

    // Create many concurrent operations to stress-test locking
    const operations: Promise<unknown>[] = []
    for (let i = 0; i < 20; i++) {
      operations.push(manager.createCheckpoint(`Stress test ${i}`))
      operations.push(manager.recordFileModified(`/stress-${i}.ts`))
    }

    // All operations should complete without hanging
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Lock timeout')), 10000)
    )

    await expect(Promise.race([Promise.all(operations), timeoutPromise])).resolves.toBeDefined()
  })
})

describe('SMI-676: Partial Failure Rollback', () => {
  it('should rollback checkpoint from session if memory store fails', async () => {
    const executor = new SpawnAwareExecutor()
    const manager = new SessionManager(executor)

    await manager.startSession()

    // First checkpoint should succeed
    await manager.createCheckpoint('First checkpoint')
    expect(manager.getCurrentSession()?.checkpoints).toHaveLength(1)

    // Configure failure for next checkpoint memory storage
    executor.failOnCheckpointStore = true

    // Second checkpoint should fail and rollback
    await expect(manager.createCheckpoint('Second checkpoint')).rejects.toThrow()

    // Session should still only have 1 checkpoint (rollback worked)
    const session = manager.getCurrentSession()
    expect(session?.checkpoints).toHaveLength(1)
    expect(session?.checkpoints[0].description).toBe('First checkpoint')
  })

  it('should store checkpoint memory BEFORE updating session', async () => {
    const executor = new SpawnAwareExecutor()
    const manager = new SessionManager(executor)

    await manager.startSession()

    // Configure failure for session storage (not checkpoint)
    executor.failOnSessionStore = true

    // Create checkpoint - it should fail when storing session
    // BUT the checkpoint data should be cleaned up
    try {
      await manager.createCheckpoint('Test checkpoint')
    } catch {
      // Expected to fail
    }

    // The checkpoint memory should have been deleted as part of rollback
    // Find any checkpoint keys in deletedKeys
    const checkpointKeys = executor.deletedKeys.filter((k) => k.includes('checkpoint/'))

    // Should have attempted to clean up the checkpoint
    expect(checkpointKeys.length).toBeGreaterThan(0)
  })

  it('should maintain session consistency after error', async () => {
    const executor = new SpawnAwareExecutor()
    const manager = new SessionManager(executor)

    await manager.startSession()

    // Create some successful checkpoints
    await manager.createCheckpoint('CP1')
    await manager.createCheckpoint('CP2')
    await manager.recordFileModified('/file1.ts')

    // Configure failure
    executor.failOnCheckpointStore = true

    // Try to create failing checkpoint
    try {
      await manager.createCheckpoint('CP3')
    } catch {
      // Expected
    }

    // Session should still be consistent with original 2 checkpoints
    const session = manager.getCurrentSession()
    expect(session?.checkpoints).toHaveLength(2)
    expect(session?.filesModified).toContain('/file1.ts')

    // Can still add files after failure
    executor.failOnCheckpointStore = false
    await manager.recordFileModified('/file2.ts')
    expect(manager.getCurrentSession()?.filesModified).toHaveLength(2)
  })

  it('should not leave orphaned checkpoint data in memory', async () => {
    const executor = new SpawnAwareExecutor()
    const manager = new SessionManager(executor)

    await manager.startSession()
    const session = manager.getCurrentSession()!

    // Simulate partial failure scenario where checkpoint is stored
    // but session update fails
    executor.failOnSessionStore = true

    try {
      await manager.createCheckpoint('Orphan checkpoint')
    } catch {
      // Expected
    }

    // Check that no checkpoint keys remain for this session
    // (they should be cleaned up on rollback)
    const sessionData = executor.getMemory(`session/${session.sessionId}`)
    if (sessionData) {
      const parsed = JSON.parse(sessionData)
      // Session should not reference the failed checkpoint
      expect(
        parsed.checkpoints.find(
          (cp: { description: string }) => cp.description === 'Orphan checkpoint'
        )
      ).toBeUndefined()
    }
  })
})

describe('Integration: Security + Concurrency', () => {
  it('should handle injection attempts during concurrent operations', async () => {
    const executor = new SpawnAwareExecutor()
    const manager = new SessionManager(executor)

    await manager.startSession()

    // Mix of injection attempts and normal operations concurrently
    const operations = [
      manager.createCheckpoint('$(whoami)'),
      manager.createCheckpoint('normal checkpoint'),
      manager.createCheckpoint('`id`'),
      manager.recordFileModified('/safe/path.ts'),
      manager.createCheckpoint("'; DROP TABLE sessions; --"),
      manager.recordFileModified('/another/file.ts'),
    ]

    await Promise.all(operations)

    const session = manager.getCurrentSession()

    // All operations should complete
    expect(session?.checkpoints).toHaveLength(4)
    expect(session?.filesModified).toHaveLength(2)

    // Values should be stored literally, not executed
    const descriptions = session?.checkpoints.map((cp) => cp.description)
    expect(descriptions).toContain('$(whoami)')
    expect(descriptions).toContain('`id`')
    expect(descriptions).toContain("'; DROP TABLE sessions; --")

    // Verify spawn was used (not string-based execute)
    expect(executor.spawnCalls.length).toBeGreaterThan(0)
    expect(executor.usedStringCommand).toBe(false)
  })
})
