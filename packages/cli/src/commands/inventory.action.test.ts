/**
 * @fileoverview Tests for `skillsmith inventory` subcommands.
 * @module @skillsmith/cli/commands/inventory.action.test
 * @see SMI-5392 Wave 3 — CLI inventory push/status/forget-device (umbrella SMI-5382)
 *
 * Covers:
 *   push: renders applied / consent-off / disabled-locally output correctly
 *   push: maps each of the 4 typed errors to console.error + process.exit(1)
 *   status: prints device ID, last-push, opt-out flag, and harness presence
 *   forget-device: calls core forgetDevice and prints confirmation with prior ID
 *
 * instanceof strategy:
 *   @skillsmith/core is mocked with inline class definitions for the four error
 *   types. Because vi.mock factories are hoisted, both the source module and the
 *   test file receive the SAME class reference — so `err instanceof InventoryAuthError`
 *   inside inventoryPushActionImpl matches the errors thrown in tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// @skillsmith/core/telemetry — passthrough so withTelemetry has no side effects
// ---------------------------------------------------------------------------

vi.mock('@skillsmith/core/telemetry', () => ({
  withTelemetry: <TArgs extends readonly unknown[], TReturn>(
    fn: (...args: TArgs) => Promise<TReturn> | TReturn
  ) => fn,
}))

// ---------------------------------------------------------------------------
// @skillsmith/core — mock functions; inline class definitions for error types
// so instanceof checks work (same reference in source + test).
// ---------------------------------------------------------------------------

vi.mock('@skillsmith/core', () => {
  class InventoryAuthError extends Error {
    constructor(msg = 'Not authenticated. Run `skillsmith login` and try again.') {
      super(msg)
      this.name = 'InventoryAuthError'
    }
  }
  class InventoryConflictError extends Error {
    constructor(msg = 'device_conflict') {
      super(msg)
      this.name = 'InventoryConflictError'
    }
  }
  class InventoryValidationError extends Error {
    constructor(msg = 'invalid payload') {
      super(msg)
      this.name = 'InventoryValidationError'
    }
  }
  class InventoryUploadError extends Error {
    constructor(msg: string) {
      super(msg)
      this.name = 'InventoryUploadError'
    }
  }

  return {
    pushInventory: vi.fn(),
    getDeviceId: vi.fn(),
    forgetDevice: vi.fn(),
    getLastInventoryPushAt: vi.fn(),
    isInventorySyncDisabledLocally: vi.fn(),
    InventoryAuthError,
    InventoryConflictError,
    InventoryValidationError,
    InventoryUploadError,
  }
})

// ---------------------------------------------------------------------------
// @skillsmith/core/install — sync function, mock to return a fixed presence set
// ---------------------------------------------------------------------------

vi.mock('@skillsmith/core/install', () => ({
  enumerateHarnessPresence: vi.fn(() => [
    { harness: 'claude-code', present: true, path: '/mock/.claude/skills' },
    { harness: 'cursor', present: false, path: '/mock/.cursor/skills' },
  ]),
}))

// ---------------------------------------------------------------------------
// CLI utilities
// ---------------------------------------------------------------------------

vi.mock('../utils/skills-directory.js', () => ({
  getInstalledSkillsPerHarness: vi.fn(() => Promise.resolve([])),
}))

vi.mock('../version.js', () => ({ VERSION: '0.0.0-test' }))

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

import {
  runPush,
  runStatus,
  runForgetDevice,
  inventoryPushActionImpl,
  inventoryStatusActionImpl,
  inventoryForgetDeviceActionImpl,
} from './inventory.action.js'

import {
  pushInventory,
  getDeviceId,
  forgetDevice,
  getLastInventoryPushAt,
  isInventorySyncDisabledLocally,
  InventoryAuthError,
  InventoryConflictError,
  InventoryValidationError,
  InventoryUploadError,
} from '@skillsmith/core'

import { enumerateHarnessPresence } from '@skillsmith/core/install'
import { getInstalledSkillsPerHarness } from '../utils/skills-directory.js'

const pushInventoryMock = vi.mocked(pushInventory)
const getDeviceIdMock = vi.mocked(getDeviceId)
const forgetDeviceMock = vi.mocked(forgetDevice)
const getLastInventoryPushAtMock = vi.mocked(getLastInventoryPushAt)
const isInventorySyncDisabledLocallyMock = vi.mocked(isInventorySyncDisabledLocally)
const enumerateHarnessPresenceMock = vi.mocked(enumerateHarnessPresence)
const getInstalledSkillsPerHarnessMock = vi.mocked(getInstalledSkillsPerHarness)

// ---------------------------------------------------------------------------
// Console capture helper
// ---------------------------------------------------------------------------

function captureConsole() {
  const log: string[] = []
  const err: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args) => log.push(args.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...args) => err.push(args.join(' ')))
  return {
    log,
    err,
    all: () => [...log, ...err],
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()

  // Defaults so tests that don't care about these still get sensible values.
  getDeviceIdMock.mockReturnValue('test-device-uuid-1234')
  getLastInventoryPushAtMock.mockReturnValue(undefined)
  isInventorySyncDisabledLocallyMock.mockReturnValue(false)
  getInstalledSkillsPerHarnessMock.mockResolvedValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// push — happy-path rendering
// ---------------------------------------------------------------------------

describe('inventory push — happy paths', () => {
  it('prints dim note when sync is locally disabled (disabled_locally)', async () => {
    pushInventoryMock.mockResolvedValue({
      ok: true,
      applied: false,
      reason: 'disabled_locally',
    })
    const cap = captureConsole()
    await runPush()
    const output = cap.all().join('\n')
    expect(output).toContain('SKILLSMITH_INVENTORY_DISABLE')
    expect(output).toContain('nothing sent')
  })

  it('prints yellow consent-off message when server returns consent_disabled', async () => {
    pushInventoryMock.mockResolvedValue({
      ok: true,
      applied: false,
      reason: 'consent_disabled',
    })
    const cap = captureConsole()
    await runPush()
    const output = cap.all().join('\n')
    expect(output).toContain('sync is OFF')
    expect(output).toContain('nothing stored')
  })

  it('prints green success line with device_id and counts when applied=true', async () => {
    pushInventoryMock.mockResolvedValue({
      ok: true,
      applied: true,
      device_id: 'abc-device-123',
      skills_present: 7,
      skills_absent: 2,
    })
    const cap = captureConsole()
    await runPush()
    const output = cap.all().join('\n')
    expect(output).toContain('abc-device-123')
    expect(output).toContain('7 present')
    expect(output).toContain('2 marked absent')
  })

  it('prints defensive raw result for unexpected ok/reason combo', async () => {
    pushInventoryMock.mockResolvedValue({ ok: false, applied: false, reason: 'unknown_reason' })
    const cap = captureConsole()
    await runPush()
    const output = cap.all().join('\n')
    expect(output).toContain('unknown_reason')
  })
})

// ---------------------------------------------------------------------------
// push — typed error mapping → process.exit(1)
// ---------------------------------------------------------------------------

describe('inventory push — typed error mapping', () => {
  function mockExit() {
    return vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`)
    })
  }

  it('maps InventoryAuthError → "Not logged in" message + exit(1)', async () => {
    const exitSpy = mockExit()
    pushInventoryMock.mockRejectedValue(new InventoryAuthError())
    const cap = captureConsole()
    await expect(inventoryPushActionImpl()).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(cap.err.join(' ')).toContain('Not logged in')
  })

  it('maps InventoryConflictError → "forget-device" hint + exit(1)', async () => {
    const exitSpy = mockExit()
    pushInventoryMock.mockRejectedValue(new InventoryConflictError())
    const cap = captureConsole()
    await expect(inventoryPushActionImpl()).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(cap.err.join(' ')).toContain('forget-device')
  })

  it('maps InventoryValidationError → server message + exit(1)', async () => {
    const exitSpy = mockExit()
    pushInventoryMock.mockRejectedValue(new InventoryValidationError('skill_id_too_long'))
    const cap = captureConsole()
    await expect(inventoryPushActionImpl()).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(cap.err.join(' ')).toContain('skill_id_too_long')
  })

  it('maps InventoryUploadError → "Inventory upload failed." prefix + exit(1)', async () => {
    const exitSpy = mockExit()
    pushInventoryMock.mockRejectedValue(new InventoryUploadError('HTTP 503'))
    const cap = captureConsole()
    await expect(inventoryPushActionImpl()).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(cap.err.join(' ')).toContain('Inventory upload failed.')
    expect(cap.err.join(' ')).toContain('HTTP 503')
  })
})

// ---------------------------------------------------------------------------
// status — read-only local view
// ---------------------------------------------------------------------------

describe('inventory status', () => {
  it('shows device ID when registered', async () => {
    getDeviceIdMock.mockReturnValue('my-stable-device-uuid')
    const cap = captureConsole()
    await runStatus()
    expect(cap.log.join('\n')).toContain('my-stable-device-uuid')
  })

  it('shows placeholder when device not yet registered', async () => {
    getDeviceIdMock.mockReturnValue(undefined)
    const cap = captureConsole()
    await runStatus()
    expect(cap.log.join('\n')).toContain('not yet registered')
  })

  it('shows "never" when no push has occurred', async () => {
    getLastInventoryPushAtMock.mockReturnValue(undefined)
    const cap = captureConsole()
    await runStatus()
    expect(cap.log.join('\n')).toContain('never')
  })

  it('shows last push timestamp when present', async () => {
    getLastInventoryPushAtMock.mockReturnValue('2026-01-15T10:00:00.000Z')
    const cap = captureConsole()
    await runStatus()
    expect(cap.log.join('\n')).toContain('2026-01-15T10:00:00.000Z')
  })

  it('shows opt-out warning when SKILLSMITH_INVENTORY_DISABLE is set', async () => {
    isInventorySyncDisabledLocallyMock.mockReturnValue(true)
    const cap = captureConsole()
    await runStatus()
    expect(cap.log.join('\n')).toContain('SKILLSMITH_INVENTORY_DISABLE')
  })

  it('lists harness presence from enumerateHarnessPresence', async () => {
    enumerateHarnessPresenceMock.mockReturnValue([
      { harness: 'claude-code', present: true, path: '/mock/.claude/skills' },
      { harness: 'cursor', present: false, path: '/mock/.cursor/skills' },
    ])
    const cap = captureConsole()
    await runStatus()
    const out = cap.log.join('\n')
    expect(out).toContain('claude-code')
    expect(out).toContain('cursor')
  })

  it('shows skill count for present harnesses', async () => {
    enumerateHarnessPresenceMock.mockReturnValue([
      { harness: 'claude-code', present: true, path: '/mock/.claude/skills' },
    ])
    getInstalledSkillsPerHarnessMock.mockResolvedValue([
      {
        harness: 'claude-code',
        skillId: 'foo/bar',
        version: '1.0.0',
        contentHash: null,
        author: null,
        license: null,
        repository: null,
        path: '/mock/foo-bar',
      },
      {
        harness: 'claude-code',
        skillId: 'baz/qux',
        version: null,
        contentHash: null,
        author: null,
        license: null,
        repository: null,
        path: '/mock/baz-qux',
      },
    ])
    const cap = captureConsole()
    await runStatus()
    expect(cap.log.join('\n')).toContain('2 skills')
  })

  it('lists skill IDs under each harness when --verbose is passed', async () => {
    enumerateHarnessPresenceMock.mockReturnValue([
      { harness: 'claude-code', present: true, path: '/mock/.claude/skills' },
    ])
    getInstalledSkillsPerHarnessMock.mockResolvedValue([
      {
        harness: 'claude-code',
        skillId: 'author/my-skill',
        version: '1.0.0',
        contentHash: null,
        author: null,
        license: null,
        repository: null,
        path: '/mock/my-skill',
      },
    ])
    const cap = captureConsole()
    await runStatus({ verbose: true })
    expect(cap.log.join('\n')).toContain('author/my-skill')
  })

  it('does not list skill IDs when --verbose is not passed', async () => {
    enumerateHarnessPresenceMock.mockReturnValue([
      { harness: 'claude-code', present: true, path: '/mock/.claude/skills' },
    ])
    getInstalledSkillsPerHarnessMock.mockResolvedValue([
      {
        harness: 'claude-code',
        skillId: 'author/hidden-skill',
        version: null,
        contentHash: null,
        author: null,
        license: null,
        repository: null,
        path: '/mock/hidden',
      },
    ])
    const cap = captureConsole()
    await runStatus({ verbose: false })
    expect(cap.log.join('\n')).not.toContain('author/hidden-skill')
  })

  it('passes through errors from getInstalledSkillsPerHarness to inventoryStatusActionImpl', async () => {
    getInstalledSkillsPerHarnessMock.mockRejectedValue(new Error('disk error'))
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`)
    })
    captureConsole()
    await expect(inventoryStatusActionImpl({})).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

// ---------------------------------------------------------------------------
// forget-device
// ---------------------------------------------------------------------------

describe('inventory forget-device', () => {
  it('calls core forgetDevice', async () => {
    getDeviceIdMock.mockReturnValue('old-device-uuid')
    captureConsole()
    await runForgetDevice()
    expect(forgetDeviceMock).toHaveBeenCalledTimes(1)
  })

  it('confirms the previous device ID in output', async () => {
    getDeviceIdMock.mockReturnValue('previous-device-abc')
    const cap = captureConsole()
    await runForgetDevice()
    expect(cap.log.join('\n')).toContain('previous-device-abc')
  })

  it('shows "(none)" when there was no device ID to forget', async () => {
    getDeviceIdMock.mockReturnValue(undefined)
    const cap = captureConsole()
    await runForgetDevice()
    expect(cap.log.join('\n')).toContain('(none)')
  })

  it('mentions fresh device on next push', async () => {
    getDeviceIdMock.mockReturnValue('any-device')
    const cap = captureConsole()
    await runForgetDevice()
    expect(cap.log.join('\n')).toContain('fresh device')
  })

  it('passes through errors to inventoryForgetDeviceActionImpl + exit(1)', async () => {
    forgetDeviceMock.mockImplementation(() => {
      throw new Error('config write error')
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`)
    })
    captureConsole()
    await expect(inventoryForgetDeviceActionImpl()).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
