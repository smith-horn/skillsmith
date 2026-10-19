/**
 * SMI-6531 (A1 step 1), T-L10: the MCP install path's fetch and registry-lookup
 * wrappers call `assertSkillWriteLockNotHeld` on entry, so neither can run under
 * the skills-root lock (plan §3.2).
 *
 * Each wrapper runs inside `withFileLock(..., { rank: '1' })` (must throw
 * `held-while-planning` before any network call) and outside any lock (the
 * control: it must not throw a LockOrderError).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LockOrderError, withFileLock } from '@skillsmith/core'
import { lookupSkillFromRegistry, fetchFromGitHub } from '../../src/tools/install.helpers.js'
import type { ToolContext } from '../../src/context.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-planning-guard-'))
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

function contextWithApi(getSkill: ReturnType<typeof vi.fn>): ToolContext {
  return {
    apiClient: { isOffline: () => false, getSkill },
    skillRepository: { findById: vi.fn() },
  } as unknown as ToolContext
}

describe('T-L10: lookupSkillFromRegistry refuses to run under lock 1', () => {
  const apiSkill = {
    data: { name: 's', repo_url: 'https://github.com/o/r', trust_tier: 'community' },
  }

  it('throws held-while-planning and never calls the API', async () => {
    const getSkill = vi.fn().mockResolvedValue(apiSkill)
    const error = await thrownUnderLockOne(() =>
      lookupSkillFromRegistry('o/s', contextWithApi(getSkill))
    )
    expectHeldWhilePlanning(error, 'lookupSkillFromRegistry')
    expect(getSkill).not.toHaveBeenCalled()
  })

  it('reaches the API outside any lock', async () => {
    const getSkill = vi.fn().mockResolvedValue(apiSkill)
    await expect(lookupSkillFromRegistry('o/s', contextWithApi(getSkill))).resolves.not.toBeNull()
    expect(getSkill).toHaveBeenCalledWith('o/s')
  })
})

describe('T-L10: fetchFromGitHub refuses to run under lock 1', () => {
  function mockFetchOk(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return { ok: true, status: 200, text: async () => '# readme\n' } as unknown as Response
    })
  }

  it('throws held-while-planning and never calls fetch', async () => {
    const fetchSpy = mockFetchOk()
    const error = await thrownUnderLockOne(() => fetchFromGitHub('o', 'r', 'SKILL.md'))
    expectHeldWhilePlanning(error, 'fetchFromGitHub')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('calls fetch outside any lock', async () => {
    const fetchSpy = mockFetchOk()
    await expect(fetchFromGitHub('o', 'r', 'SKILL.md')).resolves.toBe('# readme\n')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
