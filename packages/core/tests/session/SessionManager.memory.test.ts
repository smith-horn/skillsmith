/**
 * SMI-2754: SessionManager Memory Operation Tests
 *
 * Tests for storeMemoryEntry, retrieveMemoryEntry, deleteMemoryEntry,
 * runPreTaskHook, and runPostTaskHook.
 *
 * Since USE_V3_API is evaluated at module load time, we mock the helpers
 * module to control getClaudeFlowMemory / getClaudeFlowMcp / USE_V3_API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// We mock the helpers module to control USE_V3_API and module loading
// ============================================================================

vi.mock('../../src/session/SessionManager.helpers.js', () => {
  return {
    validateMemoryKey: (key: string) => /^[a-zA-Z0-9/_-]+$/.test(key) && key.length <= 256,
    MEMORY_KEYS: { CURRENT: 'session/current' },
    MEMORY_NAMESPACE: 'skillsmith-sessions',
    USE_V3_API: false, // Start with spawn path; override per test
    getClaudeFlowMemory: vi.fn(),
    getClaudeFlowMcp: vi.fn(),
  }
})

import {
  storeMemoryEntry,
  retrieveMemoryEntry,
  deleteMemoryEntry,
  runPreTaskHook,
  runPostTaskHook,
} from '../../src/session/SessionManager.memory.js'
import * as helpers from '../../src/session/SessionManager.helpers.js'
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

function enableV3(enabled: boolean) {
  // Override the USE_V3_API value in the mocked module
  // @ts-expect-error - overriding readonly for testing
  helpers.USE_V3_API = enabled
}

beforeEach(() => {
  enableV3(false)
  vi.mocked(helpers.getClaudeFlowMemory).mockReset()
  vi.mocked(helpers.getClaudeFlowMcp).mockReset()
})

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

  it('uses V3 storeEntry when USE_V3_API is true and module is available', async () => {
    enableV3(true)
    const storeEntry = vi.fn().mockResolvedValue({ success: true })
    vi.mocked(helpers.getClaudeFlowMemory).mockResolvedValue({ storeEntry })

    const executor = makeSpawnExecutor()
    const result = await storeMemoryEntry('session/test', 'my-value', executor)

    expect(result).toEqual({ success: true })
    expect(storeEntry).toHaveBeenCalledWith({
      key: 'session/test',
      value: 'my-value',
      namespace: 'skillsmith-sessions',
    })
    expect(executor.spawn).not.toHaveBeenCalled()
  })

  it('falls back to spawn when V3 storeEntry returns success:false', async () => {
    enableV3(true)
    const storeEntry = vi.fn().mockResolvedValue({ success: false, error: 'V3 error' })
    vi.mocked(helpers.getClaudeFlowMemory).mockResolvedValue({ storeEntry })

    const executor = makeSpawnExecutor()
    const result = await storeMemoryEntry('session/fallback', 'value', executor)

    expect(result).toEqual({ success: true })
    expect(executor.spawn).toHaveBeenCalled()
  })

  it('uses spawn directly when USE_V3_API is false', async () => {
    enableV3(false)
    const executor = makeSpawnExecutor()
    const result = await storeMemoryEntry('session/key', 'val', executor)

    expect(result).toEqual({ success: true })
    expect(executor.spawn).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['claude-flow', 'memory', 'store', '--key', 'session/key'])
    )
    expect(helpers.getClaudeFlowMemory).not.toHaveBeenCalled()
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

  it('returns data from V3 getEntry when found', async () => {
    enableV3(true)
    const getEntry = vi.fn().mockResolvedValue({
      success: true,
      found: true,
      entry: { content: 'stored-value' },
    })
    vi.mocked(helpers.getClaudeFlowMemory).mockResolvedValue({ getEntry })

    const executor = makeSpawnExecutor()
    const result = await retrieveMemoryEntry('session/found', executor)

    expect(result).toEqual({ success: true, data: 'stored-value' })
    expect(executor.spawn).not.toHaveBeenCalled()
  })

  it('returns not-found error from V3 when key does not exist', async () => {
    enableV3(true)
    const getEntry = vi.fn().mockResolvedValue({
      success: true,
      found: false,
    })
    vi.mocked(helpers.getClaudeFlowMemory).mockResolvedValue({ getEntry })

    const executor = makeSpawnExecutor()
    const result = await retrieveMemoryEntry('session/missing', executor)

    expect(result).toEqual({ success: false, error: 'Key not found' })
    expect(executor.spawn).not.toHaveBeenCalled()
  })

  it('falls back to spawn when V3 getEntry throws an exception', async () => {
    enableV3(true)
    vi.mocked(helpers.getClaudeFlowMemory).mockRejectedValue(new Error('module load error'))

    const executor = makeSpawnExecutor({ stdout: 'spawned-data' })
    const result = await retrieveMemoryEntry('session/key', executor)

    expect(result).toEqual({ success: true, data: 'spawned-data' })
    expect(executor.spawn).toHaveBeenCalled()
  })

  it('uses spawn directly when USE_V3_API is false', async () => {
    enableV3(false)
    const executor = makeSpawnExecutor({ stdout: 'value-from-spawn\n' })
    const result = await retrieveMemoryEntry('session/key', executor)

    expect(result).toEqual({ success: true, data: 'value-from-spawn' })
    expect(helpers.getClaudeFlowMemory).not.toHaveBeenCalled()
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

  it('returns success when V3 callMCPTool succeeds', async () => {
    enableV3(true)
    const callMCPTool = vi.fn().mockResolvedValue({ success: true, deleted: true })
    vi.mocked(helpers.getClaudeFlowMcp).mockResolvedValue({ callMCPTool })

    const executor = makeSpawnExecutor()
    const result = await deleteMemoryEntry('session/to-delete', executor)

    expect(result).toEqual({ success: true })
    expect(callMCPTool).toHaveBeenCalledWith('memory/delete', { key: 'session/to-delete' })
  })

  it('falls back to spawn (and returns success) when V3 callMCPTool fails', async () => {
    enableV3(true)
    const callMCPTool = vi.fn().mockResolvedValue({ success: false })
    vi.mocked(helpers.getClaudeFlowMcp).mockResolvedValue({ callMCPTool })

    const executor = makeSpawnExecutor()
    const result = await deleteMemoryEntry('session/key', executor)

    expect(result).toEqual({ success: true })
    expect(executor.spawn).toHaveBeenCalled()
  })
})

// ============================================================================
// runPreTaskHook
// ============================================================================

describe('runPreTaskHook', () => {
  it('calls V3 MCP pre-task hook when USE_V3_API is true', async () => {
    enableV3(true)
    const callMCPTool = vi.fn().mockResolvedValue({})
    vi.mocked(helpers.getClaudeFlowMcp).mockResolvedValue({ callMCPTool })

    const executor = makeSpawnExecutor()
    await runPreTaskHook('test description', executor)

    expect(callMCPTool).toHaveBeenCalledWith(
      'hooks/pre-task',
      expect.objectContaining({
        description: 'test description',
      })
    )
    expect(executor.spawn).not.toHaveBeenCalled()
  })

  it('uses spawn when USE_V3_API is false', async () => {
    enableV3(false)
    const executor = makeSpawnExecutor()
    await runPreTaskHook('test description', executor)

    expect(executor.spawn).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['pre-task', '--description', 'test description'])
    )
  })

  it('swallows errors and does not throw', async () => {
    enableV3(false)
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
  it('calls V3 MCP post-task hook when USE_V3_API is true', async () => {
    enableV3(true)
    const callMCPTool = vi.fn().mockResolvedValue({})
    vi.mocked(helpers.getClaudeFlowMcp).mockResolvedValue({ callMCPTool })

    const executor = makeSpawnExecutor()
    await runPostTaskHook('task-123', executor)

    expect(callMCPTool).toHaveBeenCalledWith('hooks/post-task', { taskId: 'task-123' })
    expect(executor.spawn).not.toHaveBeenCalled()
  })

  it('uses spawn when USE_V3_API is false', async () => {
    enableV3(false)
    const executor = makeSpawnExecutor()
    await runPostTaskHook('task-456', executor)

    expect(executor.spawn).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['post-task', '--task-id', 'task-456'])
    )
  })
})
