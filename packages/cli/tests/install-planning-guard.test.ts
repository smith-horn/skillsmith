/**
 * SMI-6531 (A1 step 1), T-L10: the prompt and registry-lookup wrappers the CLI
 * install and update paths use call `assertSkillWriteLockNotHeld` on entry, so
 * none of them can run under the skills-root lock (plan §3.2).
 *
 * Each wrapper runs inside `withFileLock(..., { rank: '1' })` (must throw
 * `held-while-planning` before any prompt or lookup) and outside any lock (the
 * control: it must not throw a LockOrderError).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  confirmFn: vi.fn(),
  apiGetSkill: vi.fn(),
}))

vi.mock('@inquirer/prompts', () => ({
  confirm: (...args: unknown[]) => mocks.confirmFn(...args),
}))

vi.mock('@skillsmith/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core')>()
  return {
    ...actual,
    loadStoredAccessToken: vi.fn().mockResolvedValue(null),
    createApiClient: vi.fn(() => ({ isOffline: () => false, getSkill: mocks.apiGetSkill })),
  }
})

import { LockOrderError, withFileLock, type DatabaseType } from '@skillsmith/core'
import { installWithConfirmation } from '../src/commands/install.confirm.js'
import {
  createApiBackedRegistryLookup,
  createDbRegistryLookup,
} from '../src/commands/install.action.js'

let dir: string
const skillRepo = { findById: vi.fn(() => null) } as never
const db = {} as unknown as DatabaseType

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-planning-guard-'))
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function thrownUnderLockOne(fn: () => unknown): Promise<unknown> {
  let thrown: unknown
  await withFileLock(
    path.join(dir, 'skills-writes'),
    'test lock 1',
    async () => {
      try {
        await fn()
      } catch (error) {
        thrown = error
      }
    },
    { rank: '1' }
  )
  return thrown
}

function expectHeldWhilePlanning(error: unknown, label: string): void {
  expect(error).toBeInstanceOf(LockOrderError)
  expect((error as LockOrderError).kind).toBe('held-while-planning')
  expect((error as LockOrderError).message).toContain(label)
}

describe('T-L10: the confirmation prompt (askToProceed) refuses to run under lock 1', () => {
  const needsConfirmation = {
    success: false,
    skillId: 'a/b',
    installPath: '/x',
    errorCode: 'CONFIRMATION_REQUIRED',
    trustTier: 'unverified',
    confirmationReason: 'Not reviewed.',
  }
  const install = vi.fn(async () => needsConfirmation as never)
  let stdinTty: PropertyDescriptor | undefined
  let stdoutTty: PropertyDescriptor | undefined

  beforeEach(() => {
    stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    mocks.confirmFn.mockResolvedValue(false)
  })

  afterEach(() => {
    for (const [stream, desc] of [
      [process.stdin, stdinTty],
      [process.stdout, stdoutTty],
    ] as const) {
      if (desc) Object.defineProperty(stream, 'isTTY', desc)
      else delete (stream as { isTTY?: boolean }).isTTY
    }
  })

  it('throws held-while-planning and never shows the prompt', async () => {
    const error = await thrownUnderLockOne(() => installWithConfirmation(install, {} as never))
    expectHeldWhilePlanning(error, 'askToProceed')
    expect(mocks.confirmFn).not.toHaveBeenCalled()
  })

  it('shows the prompt outside any lock', async () => {
    const result = await installWithConfirmation(install, {} as never)
    expect(mocks.confirmFn).toHaveBeenCalledTimes(1)
    expect(result.declined).toBe(true)
  })
})

describe('T-L10: the registry-lookup wrappers refuse to run under lock 1', () => {
  it('createApiBackedRegistryLookup().lookup throws held-while-planning and never calls the API', async () => {
    const lookup = await createApiBackedRegistryLookup(skillRepo, db)
    const error = await thrownUnderLockOne(() => lookup.lookup('a/b'))
    expectHeldWhilePlanning(error, 'createApiBackedRegistryLookup')
    expect(mocks.apiGetSkill).not.toHaveBeenCalled()
  })

  it('createApiBackedRegistryLookup().lookup reaches the API outside any lock', async () => {
    mocks.apiGetSkill.mockResolvedValueOnce({
      data: { repo_url: 'https://github.com/a/b', name: 'b', trust_tier: 'community' },
    })
    const lookup = await createApiBackedRegistryLookup(skillRepo, db)
    await expect(lookup.lookup('a/b')).resolves.not.toBeNull()
    expect(mocks.apiGetSkill).toHaveBeenCalledWith('a/b')
  })

  it('createDbRegistryLookup().lookup throws held-while-planning and never reads the repo', async () => {
    const findById = vi.fn(() => null)
    const lookup = createDbRegistryLookup({ findById } as never, db)
    const error = await thrownUnderLockOne(() => lookup.lookup('a/b'))
    expectHeldWhilePlanning(error, 'createDbRegistryLookup')
    expect(findById).not.toHaveBeenCalled()
  })

  it('createDbRegistryLookup().lookup reads the repo outside any lock', async () => {
    const findById = vi.fn(() => null)
    const lookup = createDbRegistryLookup({ findById } as never, db)
    await expect(lookup.lookup('a/b')).resolves.toBeNull()
    expect(findById).toHaveBeenCalledWith('a/b')
  })
})
