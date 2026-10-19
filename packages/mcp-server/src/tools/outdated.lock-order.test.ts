/**
 * SMI-6531 (A1 step 1): a `LockOrderError` raised by the live registry lookup
 * must propagate out of `executeOutdated`. The catch around the lookup used to
 * turn it into `liveArmFailed` (status `unknown`); every other error keeps that
 * degradation.
 */
import { basename, join } from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { LockOrderError, SkillDependencyRepository } from '@skillsmith/core'
import { getCanonicalInstallPath } from '@skillsmith/core/install'
import { createTestDatabase, closeDatabase } from '@skillsmith/core/testkit'
import { executeOutdated } from './outdated.js'
import type { ToolContext } from '../context.js'
import type { Database } from '@skillsmith/core'
import type { SkillManifest } from './install.types.js'

vi.mock('./install.helpers.js', () => {
  const loadManifest = vi.fn()
  return {
    loadManifest,
    loadManifestWithWarning: vi.fn(async (...args: unknown[]) => ({
      manifest: await loadManifest(...args),
      warning: null,
    })),
    lookupSkillFromRegistry: vi.fn(),
  }
})

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, promises: { ...actual.promises, readFile: vi.fn() } }
})

import { loadManifest, lookupSkillFromRegistry } from './install.helpers.js'
import { promises as fs } from 'fs'

const mockedLoadManifest = vi.mocked(loadManifest)
const mockedReadFile = vi.mocked(fs.readFile)
const mockedLookup = vi.mocked(lookupSkillFromRegistry)

function manifestWithOneSkill(): SkillManifest {
  const name = 'lock-order-skill'
  return {
    version: '1',
    installedSkills: {
      [name]: {
        id: 'community/lock-order-skill',
        name,
        version: '1.0.0',
        source: 'registry',
        installPath: join(getCanonicalInstallPath(), basename('/tmp/skills/' + name)),
        installedAt: '2026-01-01T00:00:00Z',
        lastUpdated: '2026-01-01T00:00:00Z',
      },
    },
  }
}

describe('executeOutdated: lock-order refusal from the live lookup', () => {
  let db: Database

  beforeEach(async () => {
    db = await createTestDatabase()
    vi.clearAllMocks()
    mockedLoadManifest.mockResolvedValue(manifestWithOneSkill())
    mockedReadFile.mockResolvedValue('latest-content')
  })

  afterEach(() => {
    closeDatabase(db)
  })

  const context = (): ToolContext =>
    ({
      db,
      skillDependencyRepository: new SkillDependencyRepository(db),
      apiClient: { isOffline: () => false },
    }) as unknown as ToolContext

  it('propagates a LockOrderError instead of degrading to unknown', async () => {
    mockedLookup.mockRejectedValue(new LockOrderError('held-while-planning', 'x'))
    await expect(executeOutdated({ include_deps: false }, context())).rejects.toBeInstanceOf(
      LockOrderError
    )
  })

  it('control: an ordinary error still degrades the skill to unknown (liveArmFailed)', async () => {
    mockedLookup.mockRejectedValue(new Error('DNS failure'))
    const result = await executeOutdated({ include_deps: false }, context())
    expect(result.skills[0].status).toBe('unknown')
    expect(result.skills[0].latest_hash).toBe('--------')
  })
})
