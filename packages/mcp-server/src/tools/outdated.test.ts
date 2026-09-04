/**
 * @fileoverview Unit tests for skill_outdated MCP tool
 * @see SMI-3138: Wave 5 — Dependency intelligence outdated tool
 * @see SMI-6343 Wave 2 — real content-hash comparison + live registry arm
 */

import { createHash } from 'crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SkillVersionRepository, SkillDependencyRepository } from '@skillsmith/core'
import { createTestDatabase, closeDatabase } from '@skillsmith/core/testkit'
import { executeOutdated } from './outdated.js'
import type { ToolContext } from '../context.js'
import type { Database } from '@skillsmith/core'
import type { SkillManifest, SkillManifestEntry } from './install.types.js'

// ============================================================================
// Mocks
// ============================================================================

vi.mock('./install.helpers.js', () => ({
  loadManifest: vi.fn(),
  lookupSkillFromRegistry: vi.fn(),
}))

// SMI-6343: hashContent is no longer mocked — the original defect (SyncEngine
// writing a metadata-proxy hash while outdated.ts hashed real content) was
// invisible to this suite precisely because it faked hashContent() and fed
// recordVersion() synthetic matching strings. Assert against real SHA-256
// hashes computed the same way the SUT computes them.
function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
    },
  }
})

import { loadManifest, lookupSkillFromRegistry } from './install.helpers.js'
import { promises as fs } from 'fs'

const mockedLoadManifest = vi.mocked(loadManifest)
const mockedReadFile = vi.mocked(fs.readFile)
const mockedLookupSkillFromRegistry = vi.mocked(lookupSkillFromRegistry)

// ============================================================================
// Helpers
// ============================================================================

/**
 * SMI-6343: `apiClient.isOffline()` defaults to `true` so every pre-existing
 * test (written before the live registry arm existed) keeps exercising the
 * historical-arm-only path unchanged. Tests exercising the live arm pass
 * `{ online: true }` explicitly.
 */
function makeContext(db: Database, opts: { online?: boolean } = {}): ToolContext {
  return {
    db,
    skillDependencyRepository: new SkillDependencyRepository(db),
    apiClient: {
      isOffline: () => !opts.online,
    },
  } as unknown as ToolContext
}

function emptyManifest(): SkillManifest {
  return { version: '1', installedSkills: {} }
}

function manifestWithSkills(
  skills: Array<{ id: string; name: string; installPath: string }>
): SkillManifest {
  const installedSkills: SkillManifest['installedSkills'] = {}
  for (const s of skills) {
    installedSkills[s.name] = {
      id: s.id,
      name: s.name,
      version: '1.0.0',
      source: 'registry',
      installPath: s.installPath,
      installedAt: '2026-01-01T00:00:00Z',
      lastUpdated: '2026-01-01T00:00:00Z',
    }
  }
  return { version: '1', installedSkills }
}

// ============================================================================
// Tests
// ============================================================================

describe('executeOutdated', () => {
  let db: Database
  let versionRepo: SkillVersionRepository

  beforeEach(async () => {
    db = await createTestDatabase()
    versionRepo = new SkillVersionRepository(db)
    vi.clearAllMocks()
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('returns empty result when manifest has no installed skills', async () => {
    mockedLoadManifest.mockResolvedValue(emptyManifest())

    const result = await executeOutdated({ include_deps: true }, makeContext(db))

    expect(result.skills).toHaveLength(0)
    expect(result.summary.total_installed).toBe(0)
    expect(result.summary.outdated).toBe(0)
    expect(result.summary.up_to_date).toBe(0)
    expect(result.summary.unknown).toBe(0)
    expect(result.summary.missing_deps).toBe(0)
  })

  it('reports all skills as current when hashes match', async () => {
    const skillId = 'community/test-skill'
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([
        { id: skillId, name: 'test-skill', installPath: '/tmp/skills/test-skill' },
      ])
    )

    mockedReadFile.mockResolvedValue('latest-content')

    // Insert a version record with the same real hash the SUT will compute
    // for 'latest-content'.
    await versionRepo.recordVersion(skillId, sha256('latest-content'), '1.2.0')

    const result = await executeOutdated({ include_deps: true }, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].status).toBe('current')
    expect(result.skills[0].installed_hash).toBe(sha256('latest-content').slice(0, 8))
    expect(result.skills[0].latest_hash).toBe(sha256('latest-content').slice(0, 8))
    expect(result.skills[0].semver).toBe('1.2.0')
    expect(result.summary.up_to_date).toBe(1)
    expect(result.summary.outdated).toBe(0)
  })

  it('reports skill as outdated when hashes differ', async () => {
    const skillId = 'community/outdated-skill'
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([
        { id: skillId, name: 'outdated-skill', installPath: '/tmp/skills/outdated-skill' },
      ])
    )

    // Local content is old.
    mockedReadFile.mockResolvedValue('old-content')

    // Registry has a different (real) hash.
    await versionRepo.recordVersion(skillId, sha256('latest-content'), '2.0.0')

    const result = await executeOutdated({ include_deps: true }, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].status).toBe('outdated')
    expect(result.skills[0].installed_hash).toBe(sha256('old-content').slice(0, 8))
    expect(result.skills[0].latest_hash).toBe(sha256('latest-content').slice(0, 8))
    expect(result.skills[0].semver).toBe('2.0.0')
    expect(result.summary.outdated).toBe(1)
    expect(result.summary.up_to_date).toBe(0)
  })

  it('reports unknown when no version history exists, and never echoes installed_hash as latest_hash', async () => {
    const skillId = 'community/new-skill'
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([{ id: skillId, name: 'new-skill', installPath: '/tmp/skills/new-skill' }])
    )
    mockedReadFile.mockResolvedValue('latest-content')

    // No version records in DB for this skill, and offline (default) means
    // the live arm never runs either — nothing to compare against at all.

    const result = await executeOutdated({ include_deps: true }, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].status).toBe('unknown')
    // SMI-6343: the echo-bug fix — an unchecked skill must never render its
    // own installed_hash as latest_hash (which used to read visually as "in
    // sync" for a row that was never actually checked).
    expect(result.skills[0].installed_hash).toBe(sha256('latest-content').slice(0, 8))
    expect(result.skills[0].latest_hash).toBe('--------')
    expect(result.summary.unknown).toBe(1)
  })

  it('includes dependency status when include_deps is true', async () => {
    const skillId = 'community/dep-skill'
    const depSkillId = 'community/required-skill'
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([
        { id: skillId, name: 'dep-skill', installPath: '/tmp/skills/dep-skill' },
        { id: depSkillId, name: 'required-skill', installPath: '/tmp/skills/required-skill' },
      ])
    )
    mockedReadFile.mockResolvedValue('latest-content')

    await versionRepo.recordVersion(skillId, sha256('latest-content'), '1.0.0')
    await versionRepo.recordVersion(depSkillId, sha256('latest-content'), '1.0.0')

    // Add a dependency: dep-skill depends on required-skill (which IS installed)
    const depRepo = new SkillDependencyRepository(db)
    depRepo.setDependencies(
      skillId,
      [
        {
          skill_id: skillId,
          dep_type: 'skill_hard',
          dep_target: depSkillId,
          dep_version: '*',
          dep_source: 'declared',
          confidence: 1.0,
          metadata: null,
        },
      ],
      'declared'
    )

    const result = await executeOutdated({ include_deps: true }, makeContext(db))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const depSkill = result.skills.find((s: any) => s.id === skillId)
    expect(depSkill?.dependencies).toBeDefined()
    expect(depSkill!.dependencies!.total).toBe(1)
    expect(depSkill!.dependencies!.satisfied).toHaveLength(1)
    expect(depSkill!.dependencies!.missing).toHaveLength(0)
    expect(result.summary.missing_deps).toBe(0)
  })

  it('omits dependency status when include_deps is false', async () => {
    const skillId = 'community/no-dep-check'
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([
        { id: skillId, name: 'no-dep-check', installPath: '/tmp/skills/no-dep-check' },
      ])
    )
    mockedReadFile.mockResolvedValue('latest-content')

    await versionRepo.recordVersion(skillId, sha256('latest-content'), '1.0.0')

    const result = await executeOutdated({ include_deps: false }, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].dependencies).toBeUndefined()
  })

  it('counts missing deps in summary when a skill dep is not installed', async () => {
    const skillId = 'community/lonely-skill'
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([
        { id: skillId, name: 'lonely-skill', installPath: '/tmp/skills/lonely-skill' },
      ])
    )
    mockedReadFile.mockResolvedValue('latest-content')

    await versionRepo.recordVersion(skillId, sha256('latest-content'), '1.0.0')

    // Add a dependency on a skill that is NOT installed
    const depRepo = new SkillDependencyRepository(db)
    depRepo.setDependencies(
      skillId,
      [
        {
          skill_id: skillId,
          dep_type: 'skill_hard',
          dep_target: 'community/missing-skill',
          dep_version: '*',
          dep_source: 'declared',
          confidence: 1.0,
          metadata: null,
        },
      ],
      'declared'
    )

    const result = await executeOutdated({ include_deps: true }, makeContext(db))

    const skill = result.skills[0]
    expect(skill.dependencies!.missing).toHaveLength(1)
    expect(skill.dependencies!.missing[0]).toContain('missing-skill')
    expect(result.summary.missing_deps).toBe(1)
  })

  // ===========================================================================
  // SMI-3177: Corrupt manifest entries (missing installPath)
  // ===========================================================================

  it('handles manifest entry with missing installPath gracefully', async () => {
    // Simulate corrupt manifest entry (runtime JSON, not type-checked)
    const corruptManifest: SkillManifest = {
      version: '1',
      installedSkills: {
        'test-skill': {
          id: 'test/test-skill',
          name: 'test-skill',
          version: '1.0.0',
          source: 'registry',
          installedAt: '2026-01-01T00:00:00Z',
          lastUpdated: '2026-01-01T00:00:00Z',
        } as SkillManifestEntry, // Cast to bypass TS required field
      },
    }
    mockedLoadManifest.mockResolvedValue(corruptManifest)

    const result = await executeOutdated({ include_deps: true }, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].status).toBe('unknown')
    expect(result.skills[0].installed_hash).toBe('--------')
    expect(result.skills[0].id).toBe('test/test-skill')
    expect(result.skills[0].dependencies).toEqual({ total: 0, satisfied: [], missing: [] })
    expect(result.summary.unknown).toBe(1)
    expect(result.summary.total_installed).toBe(1)
  })

  it('processes valid entries alongside corrupt entries', async () => {
    const manifest: SkillManifest = {
      version: '1',
      installedSkills: {
        'good-skill': {
          id: 'community/good-skill',
          name: 'good-skill',
          version: '1.0.0',
          source: 'registry',
          installPath: '/tmp/skills/good-skill',
          installedAt: '2026-01-01T00:00:00Z',
          lastUpdated: '2026-01-01T00:00:00Z',
        },
        'bad-skill': {
          id: 'test/bad-skill',
          name: 'bad-skill',
          version: '1.0.0',
          source: 'registry',
          installedAt: '2026-01-01T00:00:00Z',
          lastUpdated: '2026-01-01T00:00:00Z',
        } as SkillManifestEntry,
      },
    }
    mockedLoadManifest.mockResolvedValue(manifest)
    mockedReadFile.mockResolvedValue('latest-content')

    await versionRepo.recordVersion('community/good-skill', sha256('latest-content'), '1.0.0')

    const result = await executeOutdated({ include_deps: true }, makeContext(db))

    expect(result.skills).toHaveLength(2)
    expect(result.summary.total_installed).toBe(2)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const good = result.skills.find((s: any) => s.id === 'community/good-skill')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = result.skills.find((s: any) => s.id === 'test/bad-skill')

    expect(good?.status).toBe('current')
    expect(bad?.status).toBe('unknown')
    expect(bad?.installed_hash).toBe('--------')
  })

  it('handles corrupt entry with include_deps false', async () => {
    const corruptManifest: SkillManifest = {
      version: '1',
      installedSkills: {
        broken: {
          id: 'test/broken',
          name: 'broken',
          version: '1.0.0',
          source: 'registry',
          installedAt: '2026-01-01T00:00:00Z',
          lastUpdated: '2026-01-01T00:00:00Z',
        } as SkillManifestEntry,
      },
    }
    mockedLoadManifest.mockResolvedValue(corruptManifest)

    const result = await executeOutdated({ include_deps: false }, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].status).toBe('unknown')
    expect(result.skills[0].dependencies).toBeUndefined()
  })

  // SMI-5407: source-recovery hint surfaces in outdated results when source is missing
  it('includes hint when manifest entry has no source URL', async () => {
    const noSourceManifest: SkillManifest = {
      version: '1',
      installedSkills: {
        'orphan-skill': {
          id: 'test/orphan-skill',
          name: 'orphan-skill',
          version: '1.0.0',
          source: '', // no source — should trigger SMI-5407 hint
          installPath: '/tmp/no-source',
          installedAt: '2026-01-01T00:00:00Z',
          lastUpdated: '2026-01-01T00:00:00Z',
        },
      },
    }
    mockedLoadManifest.mockResolvedValue(noSourceManifest)
    mockedReadFile.mockResolvedValue('orphan-content')

    const result = await executeOutdated({ include_deps: false }, makeContext(db))

    const skill = result.skills[0]
    expect(skill).toBeDefined()
    expect(typeof skill?.hint).toBe('string')
    expect(skill?.hint).toContain('audit sources')
    expect(skill?.hint).toContain('skill_recover_source')
  })

  it('does not include hint when manifest entry has a source URL', async () => {
    const withSourceManifest: SkillManifest = {
      version: '1',
      installedSkills: {
        'tracked-skill': {
          id: 'test/tracked-skill',
          name: 'tracked-skill',
          version: '1.0.0',
          source: 'https://github.com/test/tracked-skill', // has source
          installPath: '/tmp/has-source',
          installedAt: '2026-01-01T00:00:00Z',
          lastUpdated: '2026-01-01T00:00:00Z',
        },
      },
    }
    mockedLoadManifest.mockResolvedValue(withSourceManifest)
    mockedReadFile.mockResolvedValue('tracked-content')

    const result = await executeOutdated({ include_deps: false }, makeContext(db))

    const skill = result.skills[0]
    expect(skill).toBeDefined()
    expect(skill?.hint).toBeUndefined()
  })

  // ===========================================================================
  // SMI-6343 Wave 2: live registry arm + degradation contract (H1)
  // ===========================================================================

  describe('live registry arm', () => {
    it('skips the live arm entirely when offline, falling back to the historical arm', async () => {
      const skillId = 'community/offline-skill'
      mockedLoadManifest.mockResolvedValue(
        manifestWithSkills([
          { id: skillId, name: 'offline-skill', installPath: '/tmp/skills/offline-skill' },
        ])
      )
      mockedReadFile.mockResolvedValue('latest-content')
      await versionRepo.recordVersion(skillId, sha256('latest-content'), '1.0.0')

      // makeContext(db) defaults to offline.
      const result = await executeOutdated({ include_deps: false }, makeContext(db))

      expect(mockedLookupSkillFromRegistry).not.toHaveBeenCalled()
      expect(result.skills[0].status).toBe('current')
    })

    it('compares against the live registry hash when online, taking precedence over stale history', async () => {
      const skillId = 'community/live-current'
      mockedLoadManifest.mockResolvedValue(
        manifestWithSkills([
          { id: skillId, name: 'live-current', installPath: '/tmp/skills/live-current' },
        ])
      )
      mockedReadFile.mockResolvedValue('latest-content')
      // Stale historical row would say "outdated" if consulted alone.
      await versionRepo.recordVersion(skillId, sha256('stale-history'), '1.0.0')
      mockedLookupSkillFromRegistry.mockResolvedValue({
        repoUrl: 'https://github.com/community/live-current',
        name: 'live-current',
        trustTier: 'community',
        contentHash: sha256('latest-content'),
      })

      const result = await executeOutdated(
        { include_deps: false },
        makeContext(db, { online: true })
      )

      expect(mockedLookupSkillFromRegistry).toHaveBeenCalledTimes(1)
      expect(result.skills[0].status).toBe('current')
      expect(result.skills[0].latest_hash).toBe(sha256('latest-content').slice(0, 8))
    })

    it('reports outdated when the live registry hash differs from installed', async () => {
      const skillId = 'community/live-outdated'
      mockedLoadManifest.mockResolvedValue(
        manifestWithSkills([
          { id: skillId, name: 'live-outdated', installPath: '/tmp/skills/live-outdated' },
        ])
      )
      mockedReadFile.mockResolvedValue('old-content')
      mockedLookupSkillFromRegistry.mockResolvedValue({
        repoUrl: 'https://github.com/community/live-outdated',
        name: 'live-outdated',
        trustTier: 'community',
        contentHash: sha256('new-content'),
      })

      const result = await executeOutdated(
        { include_deps: false },
        makeContext(db, { online: true })
      )

      expect(result.skills[0].status).toBe('outdated')
      expect(result.skills[0].latest_hash).toBe(sha256('new-content').slice(0, 8))
    })

    it('degrades a single skill to unknown on a per-skill network error, while the batch continues', async () => {
      mockedLoadManifest.mockResolvedValue(
        manifestWithSkills([
          { id: 'community/flaky', name: 'flaky', installPath: '/tmp/skills/flaky' },
          { id: 'community/healthy', name: 'healthy', installPath: '/tmp/skills/healthy' },
        ])
      )
      mockedReadFile.mockResolvedValue('latest-content')
      mockedLookupSkillFromRegistry
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce({
          repoUrl: 'https://github.com/community/healthy',
          name: 'healthy',
          trustTier: 'community',
          contentHash: sha256('latest-content'),
        })

      const result = await executeOutdated(
        { include_deps: false },
        makeContext(db, { online: true })
      )

      expect(mockedLookupSkillFromRegistry).toHaveBeenCalledTimes(2)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const flaky = result.skills.find((s: any) => s.id === 'community/flaky')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const healthy = result.skills.find((s: any) => s.id === 'community/healthy')
      expect(flaky?.status).toBe('unknown')
      expect(healthy?.status).toBe('current')
    })

    it('stops the live arm for the rest of the run after a quota-exceeded signal', async () => {
      mockedLoadManifest.mockResolvedValue(
        manifestWithSkills([
          { id: 'community/quota-1', name: 'quota-1', installPath: '/tmp/skills/quota-1' },
          { id: 'community/quota-2', name: 'quota-2', installPath: '/tmp/skills/quota-2' },
          { id: 'community/quota-3', name: 'quota-3', installPath: '/tmp/skills/quota-3' },
        ])
      )
      mockedReadFile.mockResolvedValue('latest-content')
      // First call signals quota exhaustion (mirrors lookupSkillFromRegistry's
      // real contract: it swallows the error internally and invokes
      // onQuotaExceeded before falling back to a local-DB-shaped result).
      mockedLookupSkillFromRegistry.mockImplementationOnce(async (_id, _ctx, opts) => {
        opts?.onQuotaExceeded?.()
        return null
      })

      const result = await executeOutdated(
        { include_deps: false },
        makeContext(db, { online: true })
      )

      // Only the first skill actually reached the live arm — the remaining
      // two must never burn a failed call each.
      expect(mockedLookupSkillFromRegistry).toHaveBeenCalledTimes(1)
      expect(result.skills).toHaveLength(3)
      expect(result.skills.every((s) => s.status === 'unknown')).toBe(true)
    })

    it('never fails the whole call when the live arm is unavailable for every skill', async () => {
      mockedLoadManifest.mockResolvedValue(
        manifestWithSkills([
          { id: 'community/always-fails', name: 'always-fails', installPath: '/tmp/skills/x' },
        ])
      )
      mockedReadFile.mockResolvedValue('latest-content')
      mockedLookupSkillFromRegistry.mockRejectedValue(new Error('DNS failure'))

      await expect(
        executeOutdated({ include_deps: false }, makeContext(db, { online: true }))
      ).resolves.toBeDefined()
    })
  })
})
