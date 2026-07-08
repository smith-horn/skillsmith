/**
 * SMI-5582: Tier-1 Self-Heal Unit Tests
 *
 * Tests for `maybeInstallMissingTier1Skills()` and its supporting status-file
 * helpers in `src/onboarding/tier1-self-heal.ts`. `installSkill` is mocked so
 * no real network/GitHub calls happen; `setPendingWelcome` is mocked so we can
 * assert on what it was called with without exercising the full welcome
 * middleware (covered by its own suite at `src/middleware/first-run-welcome.test.ts`).
 *
 * Follows the same real-filesystem save/restore-in-`finally` idiom as
 * `first-run.test.ts` uses for `FIRST_RUN_MARKER`, applied here to
 * `TIER1_STATUS_FILE` (both live under the real `~/.skillsmith` directory —
 * see `SKILLSMITH_DIR` in `first-run.ts`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { dirname } from 'path'

vi.mock('../../src/tools/install.js', () => ({
  installSkill: vi.fn(),
}))

vi.mock('../../src/middleware/first-run-welcome.js', () => ({
  setPendingWelcome: vi.fn(),
}))

import { installSkill } from '../../src/tools/install.js'
import type { InstallResult } from '../../src/tools/install.js'
import { setPendingWelcome } from '../../src/middleware/first-run-welcome.js'
import { TIER1_SKILLS } from '../../src/onboarding/first-run.js'
import {
  maybeInstallMissingTier1Skills,
  readTier1Status,
  writeTier1Status,
  TIER1_STATUS_FILE,
  isTier1AutoInstallDisabled,
  type Tier1Status,
} from '../../src/onboarding/tier1-self-heal.js'
import type { ToolContext } from '../../src/context.js'

const installSkillMock = vi.mocked(installSkill)
const setPendingWelcomeMock = vi.mocked(setPendingWelcome)

// installSkill is fully mocked, so the context is never actually read.
const toolContext = {} as ToolContext

const SKILL_NAMES = TIER1_SKILLS.map((s) => s.name)

function attributionOf(name: string): string {
  const skill = TIER1_SKILLS.find((s) => s.name === name)
  if (!skill) throw new Error(`Unknown Tier-1 skill: ${name}`)
  return skill.id.split('/')[0]
}

function successResult(name: string): InstallResult {
  return { success: true, skillId: name, installPath: `/fake/path/${name}` }
}

function failureResult(name: string, error = 'install failed'): InstallResult {
  return { success: false, skillId: name, installPath: '', error }
}

/** `errorCode` is erased from the public `InstallResult` type but set at
 * runtime by the core service; `countsAsInstalled()` reads it defensively. */
type MockInstallResult = InstallResult & { errorCode?: string }

function alreadyInstalledResult(name: string): MockInstallResult {
  return {
    success: false,
    skillId: name,
    installPath: '',
    error: 'Already installed',
    errorCode: 'ALREADY_INSTALLED',
  }
}

describe('Tier-1 Self-Heal (SMI-5582)', () => {
  let statusFileExistedBefore: boolean
  let originalStatusContent: string | undefined
  let originalDisableEnv: string | undefined

  beforeEach(() => {
    statusFileExistedBefore = existsSync(TIER1_STATUS_FILE)
    originalStatusContent = statusFileExistedBefore
      ? readFileSync(TIER1_STATUS_FILE, 'utf-8')
      : undefined
    originalDisableEnv = process.env.SKILLSMITH_TIER1_AUTOINSTALL_DISABLE
    delete process.env.SKILLSMITH_TIER1_AUTOINSTALL_DISABLE

    installSkillMock.mockReset()
    setPendingWelcomeMock.mockReset()
  })

  afterEach(() => {
    if (statusFileExistedBefore && originalStatusContent !== undefined) {
      writeFileSync(TIER1_STATUS_FILE, originalStatusContent)
    } else if (!statusFileExistedBefore && existsSync(TIER1_STATUS_FILE)) {
      rmSync(TIER1_STATUS_FILE)
    }

    if (originalDisableEnv === undefined) {
      delete process.env.SKILLSMITH_TIER1_AUTOINSTALL_DISABLE
    } else {
      process.env.SKILLSMITH_TIER1_AUTOINSTALL_DISABLE = originalDisableEnv
    }
  })

  /** Seed (or remove) TIER1_STATUS_FILE as a test precondition. */
  function seedStatusFile(status: Tier1Status | undefined): void {
    if (status === undefined) {
      if (existsSync(TIER1_STATUS_FILE)) rmSync(TIER1_STATUS_FILE)
      return
    }
    mkdirSync(dirname(TIER1_STATUS_FILE), { recursive: true })
    writeFileSync(TIER1_STATUS_FILE, JSON.stringify(status, null, 2))
  }

  describe('TIER1_SKILLS fixture sanity', () => {
    it('has exactly 3 skills (assumed by every scenario below)', () => {
      expect(TIER1_SKILLS).toHaveLength(3)
      expect(SKILL_NAMES.sort()).toEqual(['code-review', 'commit', 'skill-writer'].sort())
    })
  })

  describe('readTier1Status()', () => {
    it('returns an empty never-attempted status when the file does not exist', () => {
      seedStatusFile(undefined)
      expect(readTier1Status()).toEqual({ installed: [] })
    })

    it('returns an empty never-attempted status when the file is unparseable', () => {
      mkdirSync(dirname(TIER1_STATUS_FILE), { recursive: true })
      writeFileSync(TIER1_STATUS_FILE, '{ not valid json')
      expect(readTier1Status()).toEqual({ installed: [] })
    })
  })

  describe('isTier1AutoInstallDisabled()', () => {
    it('is false by default', () => {
      expect(isTier1AutoInstallDisabled()).toBe(false)
    })

    it('is true when SKILLSMITH_TIER1_AUTOINSTALL_DISABLE=1', () => {
      process.env.SKILLSMITH_TIER1_AUTOINSTALL_DISABLE = '1'
      expect(isTier1AutoInstallDisabled()).toBe(true)
    })
  })

  describe('maybeInstallMissingTier1Skills()', () => {
    it('all-success: installs all 3 missing skills and records them', async () => {
      seedStatusFile(undefined)
      installSkillMock
        .mockResolvedValueOnce(successResult('skill-writer'))
        .mockResolvedValueOnce(successResult('commit'))
        .mockResolvedValueOnce(successResult('code-review'))

      const before = Date.now()
      await maybeInstallMissingTier1Skills(toolContext)
      const after = Date.now()

      expect(installSkillMock).toHaveBeenCalledTimes(3)

      const persisted = readTier1Status()
      expect(persisted.installed.sort()).toEqual([...SKILL_NAMES].sort())
      expect(persisted.lastAttempt).toBeDefined()
      const lastAttempt = persisted.lastAttempt ?? ''
      const ts = Date.parse(lastAttempt)
      expect(ts).toBeGreaterThanOrEqual(before)
      expect(ts).toBeLessThanOrEqual(after)

      expect(setPendingWelcomeMock).toHaveBeenCalledTimes(1)
      const [message, failures] = setPendingWelcomeMock.mock.calls[0]
      expect(failures).toEqual([])
      for (const skill of TIER1_SKILLS) {
        expect(message).toContain(`- ${skill.name} (by ${attributionOf(skill.name)})`)
      }
    })

    it('all-success + bundledSkills: welcome message lists bundled skills unattributed', async () => {
      seedStatusFile({ installed: [] })
      installSkillMock
        .mockResolvedValueOnce(successResult('skill-writer'))
        .mockResolvedValueOnce(successResult('commit'))
        .mockResolvedValueOnce(successResult('code-review'))

      await maybeInstallMissingTier1Skills(toolContext, {
        bundledSkills: ['skillsmith', 'varlock'],
      })

      expect(setPendingWelcomeMock).toHaveBeenCalledTimes(1)
      const [message] = setPendingWelcomeMock.mock.calls[0]
      expect(message).toContain('- skillsmith')
      expect(message).toContain('- varlock')
      expect(message).not.toMatch(/skillsmith \(by/)
      expect(message).not.toMatch(/varlock \(by/)
      for (const skill of TIER1_SKILLS) {
        expect(message).toContain(`- ${skill.name} (by ${attributionOf(skill.name)})`)
      }
    })

    it('all-success without bundledSkills: message lists only registry skills', async () => {
      seedStatusFile(undefined)
      installSkillMock
        .mockResolvedValueOnce(successResult('skill-writer'))
        .mockResolvedValueOnce(successResult('commit'))
        .mockResolvedValueOnce(successResult('code-review'))

      await maybeInstallMissingTier1Skills(toolContext)

      const [message] = setPendingWelcomeMock.mock.calls[0]
      expect(message).not.toContain('- skillsmith')
      expect(message).not.toContain('- varlock')
    })

    it('partial failure: 1 of 3 rejects, the other 2 succeed', async () => {
      seedStatusFile(undefined)
      installSkillMock
        .mockResolvedValueOnce(successResult('skill-writer'))
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce(successResult('code-review'))

      await maybeInstallMissingTier1Skills(toolContext)

      const persisted = readTier1Status()
      expect(persisted.installed.sort()).toEqual(['code-review', 'skill-writer'])
      expect(persisted.installed).not.toContain('commit')

      expect(setPendingWelcomeMock).toHaveBeenCalledTimes(1)
      const [message, failures] = setPendingWelcomeMock.mock.calls[0]
      expect(failures).toEqual(['commit'])
      expect(message).toContain('- skill-writer (by getsentry)')
      expect(message).toContain('- code-review (by getsentry)')
      expect(message).not.toContain('- commit')
    })

    it('partial failure: 1 of 3 resolves success:false, the other 2 succeed', async () => {
      seedStatusFile(undefined)
      installSkillMock
        .mockResolvedValueOnce(successResult('skill-writer'))
        .mockResolvedValueOnce(failureResult('commit', 'registry lookup failed'))
        .mockResolvedValueOnce(successResult('code-review'))

      await maybeInstallMissingTier1Skills(toolContext)

      const persisted = readTier1Status()
      expect(persisted.installed.sort()).toEqual(['code-review', 'skill-writer'])

      const [, failures] = setPendingWelcomeMock.mock.calls[0]
      expect(failures).toEqual(['commit'])
    })

    it('all-failure: installed stays empty, lastAttempt still bumps (throttle applies), all 3 in failures', async () => {
      seedStatusFile(undefined)
      installSkillMock
        .mockResolvedValueOnce(failureResult('skill-writer'))
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(failureResult('code-review'))

      const before = Date.now()
      await maybeInstallMissingTier1Skills(toolContext)
      const after = Date.now()

      const persisted = readTier1Status()
      expect(persisted.installed).toEqual([])
      expect(persisted.lastAttempt).toBeDefined()
      const ts = Date.parse(persisted.lastAttempt ?? '')
      expect(ts).toBeGreaterThanOrEqual(before)
      expect(ts).toBeLessThanOrEqual(after)

      expect(setPendingWelcomeMock).toHaveBeenCalledTimes(1)
      const [, failures] = setPendingWelcomeMock.mock.calls[0]
      expect(failures.sort()).toEqual([...SKILL_NAMES].sort())
    })

    it('ALREADY_INSTALLED counts as installed and is not a failure', async () => {
      seedStatusFile(undefined)
      installSkillMock
        .mockResolvedValueOnce(successResult('skill-writer'))
        .mockResolvedValueOnce(alreadyInstalledResult('commit'))
        .mockResolvedValueOnce(successResult('code-review'))

      await maybeInstallMissingTier1Skills(toolContext)

      const persisted = readTier1Status()
      expect(persisted.installed.sort()).toEqual([...SKILL_NAMES].sort())

      const [, failures] = setPendingWelcomeMock.mock.calls[0]
      expect(failures).toEqual([])
    })

    it('throttle skip: within 24h of lastAttempt, installSkill is never called and the file is untouched', async () => {
      const seeded: Tier1Status = {
        installed: ['skill-writer', 'commit'],
        lastAttempt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      }
      seedStatusFile(seeded)

      await maybeInstallMissingTier1Skills(toolContext)

      expect(installSkillMock).not.toHaveBeenCalled()
      expect(setPendingWelcomeMock).not.toHaveBeenCalled()
      expect(readTier1Status()).toEqual(seeded)
    })

    it('throttle expired: lastAttempt >24h ago retries the missing skill(s)', async () => {
      const seeded: Tier1Status = {
        installed: ['skill-writer', 'commit'],
        lastAttempt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      }
      seedStatusFile(seeded)
      installSkillMock.mockResolvedValueOnce(successResult('code-review'))

      await maybeInstallMissingTier1Skills(toolContext)

      expect(installSkillMock).toHaveBeenCalledTimes(1)
      expect(installSkillMock).toHaveBeenCalledWith(
        expect.objectContaining({ skillId: 'getsentry/code-review' }),
        toolContext
      )

      const persisted = readTier1Status()
      expect(persisted.installed.sort()).toEqual([...SKILL_NAMES].sort())
    })

    it('never-attempted (no lastAttempt field, true first run): retries missing skill(s) immediately', async () => {
      seedStatusFile({ installed: ['skill-writer'] })
      installSkillMock
        .mockResolvedValueOnce(successResult('commit'))
        .mockResolvedValueOnce(successResult('code-review'))

      await maybeInstallMissingTier1Skills(toolContext)

      expect(installSkillMock).toHaveBeenCalledTimes(2)
      const persisted = readTier1Status()
      expect(persisted.installed.sort()).toEqual([...SKILL_NAMES].sort())
    })

    it('nothing missing: no-op, no message, no installSkill calls', async () => {
      seedStatusFile({ installed: [...SKILL_NAMES] })

      await maybeInstallMissingTier1Skills(toolContext)

      expect(installSkillMock).not.toHaveBeenCalled()
      expect(setPendingWelcomeMock).not.toHaveBeenCalled()
    })

    it('opt-out env var: returns immediately with zero side effects', async () => {
      seedStatusFile(undefined)
      process.env.SKILLSMITH_TIER1_AUTOINSTALL_DISABLE = '1'

      await maybeInstallMissingTier1Skills(toolContext)

      expect(installSkillMock).not.toHaveBeenCalled()
      expect(setPendingWelcomeMock).not.toHaveBeenCalled()
      expect(existsSync(TIER1_STATUS_FILE)).toBe(false)
    })

    it('opt-out env var: skips even when skills are missing and never attempted', async () => {
      seedStatusFile({ installed: ['skill-writer'] })
      process.env.SKILLSMITH_TIER1_AUTOINSTALL_DISABLE = '1'

      await maybeInstallMissingTier1Skills(toolContext)

      expect(installSkillMock).not.toHaveBeenCalled()
      const persisted = readTier1Status()
      expect(persisted.installed).toEqual(['skill-writer'])
    })

    it('never throws: a synchronous throw is caught per-skill', async () => {
      seedStatusFile(undefined)
      installSkillMock
        .mockImplementationOnce(() => {
          throw new Error('sync boom')
        })
        .mockResolvedValueOnce(successResult('commit'))
        .mockResolvedValueOnce(successResult('code-review'))

      await expect(maybeInstallMissingTier1Skills(toolContext)).resolves.toBeUndefined()

      const persisted = readTier1Status()
      expect(persisted.installed.sort()).toEqual(['code-review', 'commit'])
      const [, failures] = setPendingWelcomeMock.mock.calls[0]
      expect(failures).toEqual(['skill-writer'])
    })

    it('never throws: a non-Error rejection (string/undefined) is caught per-skill', async () => {
      seedStatusFile(undefined)
      installSkillMock
        .mockRejectedValueOnce('a plain string rejection')
        .mockRejectedValueOnce(undefined)
        .mockRejectedValueOnce({ some: 'object' })

      await expect(maybeInstallMissingTier1Skills(toolContext)).resolves.toBeUndefined()

      const persisted = readTier1Status()
      expect(persisted.installed).toEqual([])
      const [, failures] = setPendingWelcomeMock.mock.calls[0]
      expect(failures.sort()).toEqual([...SKILL_NAMES].sort())
    })
  })

  describe('writeTier1Status() / readTier1Status() round-trip', () => {
    it('persists and reads back installed + lastAttempt', () => {
      seedStatusFile(undefined)
      const status: Tier1Status = {
        installed: ['skill-writer'],
        lastAttempt: new Date().toISOString(),
      }
      writeTier1Status(status)
      expect(readTier1Status()).toEqual(status)
    })
  })
})
