// SMI-4917 Bug 3: post-login registry auto-sync.
// PLS-1: device-code success path runs the post-login sync.
// PLS-2: a failed post-login sync is non-fatal — login still exits 0.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockDeviceCodeSuccess } from './login.test-helpers.js'

vi.mock('readline', () => {
  const createInterface = vi.fn()
  return { default: { createInterface }, createInterface }
})

vi.mock('@skillsmith/core', () => ({
  loadCredentials: vi.fn(),
  storeCredentials: vi.fn(),
  getApiKey: vi.fn(),
  getApiBaseUrl: vi.fn().mockReturnValue('https://api.skillsmith.app/functions/v1'),
  storeApiKey: vi.fn(),
  isValidApiKeyFormat: vi.fn(),
}))

vi.mock('@inquirer/prompts', () => ({ password: vi.fn() }))
vi.mock('open', () => ({ default: vi.fn() }))

// postLoginSync (SMI-4917) opens a DB and runs runRegistrySync — both stubbed.
const mockOpenCliDatabase = vi.fn()
const mockRunRegistrySync = vi.fn()
vi.mock('../utils/open-database.js', () => ({
  openCliDatabase: (...args: unknown[]) => mockOpenCliDatabase(...args),
}))
vi.mock('./run-registry-sync.js', () => ({
  runRegistrySync: (...args: unknown[]) => mockRunRegistrySync(...args),
}))
vi.mock('ora', () => {
  const spinner = {
    start: vi.fn(() => spinner),
    succeed: vi.fn(() => spinner),
    warn: vi.fn(() => spinner),
    fail: vi.fn(() => spinner),
    stop: vi.fn(() => spinner),
    text: '',
  }
  return { default: vi.fn(() => spinner) }
})

import { createLoginCommand } from './login.js'
import { loadCredentials, storeCredentials } from '@skillsmith/core'

const mockLoadCredentials = vi.mocked(loadCredentials)
const mockStoreCredentials = vi.mocked(storeCredentials)

async function runCommand(args: string[] = []): Promise<void> {
  const cmd = createLoginCommand()
  await cmd.parseAsync(['node', 'login', ...args])
}

describe('SMI-4917 Bug 3: postLoginSync', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let processExitSpy: ReturnType<typeof vi.spyOn>
  let originalEnv: NodeJS.ProcessEnv
  let originalFetch: typeof fetch

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    originalEnv = { ...process.env }
    originalFetch = global.fetch
    process.env['CI'] = 'true'
    delete process.env['SKILLSMITH_API_KEY']
    mockLoadCredentials.mockResolvedValue(null)
    mockStoreCredentials.mockResolvedValue(undefined)
    mockOpenCliDatabase.mockResolvedValue({ close: vi.fn() })
    mockRunRegistrySync.mockResolvedValue({
      success: true,
      skillsAdded: 0,
      skillsUpdated: 0,
      skillsUnchanged: 0,
      totalProcessed: 0,
      errors: [],
      durationMs: 1,
      dryRun: false,
    })
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        vi.clearAllTimers()
        throw new Error(`process.exit(${code ?? 0})`)
      })
  })

  afterEach(() => {
    vi.useRealTimers()
    process.env = originalEnv
    global.fetch = originalFetch
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    processExitSpy.mockRestore()
  })

  it('PLS-1: device-code success path runs the post-login registry sync', async () => {
    mockDeviceCodeSuccess()
    mockRunRegistrySync.mockResolvedValue({
      success: true,
      skillsAdded: 12,
      skillsUpdated: 0,
      skillsUnchanged: 0,
      totalProcessed: 12,
      errors: [],
      durationMs: 1,
      dryRun: false,
    })

    const run = runCommand()
    run.catch(() => {})
    await vi.runAllTimersAsync()

    await expect(run).rejects.toThrow('process.exit(0)')
    expect(mockRunRegistrySync).toHaveBeenCalledTimes(1)
  })

  it('PLS-2: a failed post-login sync is non-fatal — login still exits 0', async () => {
    mockDeviceCodeSuccess()
    // Sync fails; credentials were already persisted, so login must still succeed.
    mockRunRegistrySync.mockRejectedValue(new Error('registry unreachable'))

    const run = runCommand()
    run.catch(() => {})
    await vi.runAllTimersAsync()

    await expect(run).rejects.toThrow('process.exit(0)')
    expect(mockStoreCredentials).toHaveBeenCalled()
  })
})
