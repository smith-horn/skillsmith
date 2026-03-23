/**
 * SMI-2754: SessionManager Memory Operation Tests
 * SMI-3600: V3 dynamic import tests removed (dead code after claude-flow → ruflo rename)
 * SMI-3601: CLI calls migrated from claude-flow to ruflo
 *
 * Tests for storeMemoryEntry, retrieveMemoryEntry, deleteMemoryEntry,
 * runPreTaskHook, and runPostTaskHook — spawn-based CLI path only.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../src/session/SessionManager.helpers.js', () => {
  return {
    validateMemoryKey: (key: string) => /^[a-zA-Z0-9/_-]+$/.test(key) && key.length <= 256,
    MEMORY_KEYS: { CURRENT: 'session/current' },
  }
})

import {
  storeMemoryEntry,
  retrieveMemoryEntry,
  deleteMemoryEntry,
  runPreTaskHook,
  runPostTaskHook,
} from '../../src/session/SessionManager.memory.js'
import type { CommandExecutor } from '../../src/session/SessionManager.types.js'

// ============================================================================
// Helpers
// ============================================================================

function makeSpawnExecutor(overrides: Partial<{ stdout: string }> = {}): CommandExecutor {
  return {
    execute: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    spawn: vi.fn().mockResolvedValue({ stdout: overrides.stdout ?? '', stderr: '' }),
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

// ============================================================================
// storeMemoryEntry
// ============================================================================

describe('storeMemoryEntry', () => {
  it('returns { success: false, error: "Invalid memory key" } for an invalid key', async () => {
    const executor = makeSpawnExecutor()
    const result = await storeMemoryEntry('bad key!', 'value', executor)
    expect(result).toEqual({ success: false, error: 'Invalid memory key' })
    expect(executor.spawn).not.toHaveBeenCalled()
  })

  it('uses spawn with ruflo CLI args', async () => {
    const executor = makeSpawnExecutor()
    const result = await storeMemoryEntry('session/key', 'val', executor)

    expect(result).toEqual({ success: true })
    expect(executor.spawn).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['ruflo', 'memory', 'store', '--key', 'session/key'])
    )
  })

  it('returns error when spawn fails', async () => {
    const executor: CommandExecutor = {
      execute: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      spawn: vi.fn().mockRejectedValue(new Error('spawn failed')),
    }
    const result = await storeMemoryEntry('session/key', 'val', executor)
    expect(result).toEqual({ success: false, error: 'spawn failed' })
  })
})

// ============================================================================
// retrieveMemoryEntry
// ============================================================================

describe('retrieveMemoryEntry', () => {
  it('returns { success: false, error: "Invalid memory key" } for an invalid key', async () => {
    const executor = makeSpawnExecutor()
    const result = await retrieveMemoryEntry('bad key!', executor)
    expect(result).toEqual({ success: false, error: 'Invalid memory key' })
  })

  it('returns data from spawn stdout', async () => {
    const executor = makeSpawnExecutor({ stdout: 'value-from-spawn\n' })
    const result = await retrieveMemoryEntry('session/key', executor)

    expect(result).toEqual({ success: true, data: 'value-from-spawn' })
    expect(executor.spawn).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['ruflo', 'memory', 'get', '--key', 'session/key'])
    )
  })

  it('returns error when spawn fails', async () => {
    const executor: CommandExecutor = {
      execute: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      spawn: vi.fn().mockRejectedValue(new Error('get failed')),
    }
    const result = await retrieveMemoryEntry('session/key', executor)
    expect(result).toEqual({ success: false, error: 'get failed' })
  })
})

// ============================================================================
// deleteMemoryEntry
// ============================================================================

describe('deleteMemoryEntry', () => {
  it('returns { success: false, error: "Invalid memory key" } for an invalid key', async () => {
    const executor = makeSpawnExecutor()
    const result = await deleteMemoryEntry('bad key!', executor)
    expect(result).toEqual({ success: false, error: 'Invalid memory key' })
  })

  it('uses spawn with ruflo CLI args', async () => {
    const executor = makeSpawnExecutor()
    const result = await deleteMemoryEntry('session/to-delete', executor)

    expect(result).toEqual({ success: true })
    expect(executor.spawn).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['ruflo', 'memory', 'delete', '--key', 'session/to-delete'])
    )
  })

  it('returns success even when spawn throws (delete is best-effort)', async () => {
    const executor: CommandExecutor = {
      execute: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      spawn: vi.fn().mockRejectedValue(new Error('delete error')),
    }
    const result = await deleteMemoryEntry('session/key', executor)
    expect(result).toEqual({ success: true })
  })
})

// ============================================================================
// runPreTaskHook
// ============================================================================

describe('runPreTaskHook', () => {
  it('uses spawn with ruflo hooks pre-task args', async () => {
    const executor = makeSpawnExecutor()
    await runPreTaskHook('test description', executor)

    expect(executor.spawn).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['ruflo', 'hooks', 'pre-task', '--description', 'test description'])
    )
  })

  it('swallows errors and does not throw', async () => {
    const executor: CommandExecutor = {
      execute: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      spawn: vi.fn().mockRejectedValue(new Error('hook failed')),
    }
    // Should not throw
    await expect(runPreTaskHook('test', executor)).resolves.toBeUndefined()
  })
})

// ============================================================================
// runPostTaskHook
// ============================================================================

describe('runPostTaskHook', () => {
  it('uses spawn with ruflo hooks post-task args', async () => {
    const executor = makeSpawnExecutor()
    await runPostTaskHook('task-456', executor)

    expect(executor.spawn).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['ruflo', 'hooks', 'post-task', '--task-id', 'task-456'])
    )
  })

  it('swallows errors and does not throw', async () => {
    const executor: CommandExecutor = {
      execute: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      spawn: vi.fn().mockRejectedValue(new Error('hook failed')),
    }
    await expect(runPostTaskHook('task-789', executor)).resolves.toBeUndefined()
  })
})
