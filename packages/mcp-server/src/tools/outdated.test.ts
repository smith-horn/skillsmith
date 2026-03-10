/**
 * @fileoverview Unit tests for skill_outdated MCP tool
 * @see SMI-3138: Wave 5 — Dependency intelligence outdated tool
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SkillVersionRepository, SkillDependencyRepository } from '@skillsmith/core'
import { createTestDatabase, closeDatabase } from '../../../core/tests/helpers/database.js'
import { executeOutdated } from './outdated.js'
import type { ToolContext } from '../context.js'
import type { Database } from '@skillsmith/core'
import type { SkillManifest, SkillManifestEntry } from './install.types.js'

// ============================================================================
// Mocks
// ============================================================================

vi.mock('./install.helpers.js', () => ({
  loadManifest: vi.fn(),
}))

vi.mock('./install.conflict-helpers.js', () => ({
  hashContent: vi.fn((content: string) => {
    // Simple deterministic mock hash
    if (content === 'latest-content') return 'aabbccdd11223344'
    if (content === 'old-content') return '11223344aabbccdd'
    return '0000000000000000'
  }),
}))

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

import { loadManifest } from './install.helpers.js'
import { promises as fs } from 'fs'

const mockedLoadManifest = vi.mocked(loadManifest)
const mockedReadFile = vi.mocked(fs.readFile)

// ============================================================================
// Helpers
// ============================================================================

function makeContext(db: Database): ToolContext {
  return {
    db,
    skillDependencyRepository: new SkillDependencyRepository(db),
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

  beforeEach(() => {
    db = createTestDatabase()
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

    // Insert a version record with the same hash as hashContent('latest-content')
    await versionRepo.recordVersion(skillId, 'aabbccdd11223344', '1.2.0')

    const result = await executeOutdated({ include_deps: true }, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].status).toBe('current')
    expect(result.skills[0].installed_hash).toBe('aabbccdd')
    expect(result.skills[0].latest_hash).toBe('aabbccdd')
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

    // Local content is old → hashContent returns '11223344aabbccdd'
    mockedReadFile.mockResolvedValue('old-content')

    // Registry has a different hash
    await versionRepo.recordVersion(skillId, 'aabbccdd11223344', '2.0.0')

    const result = await executeOutdated({ include_deps: true }, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].status).toBe('outdated')
    expect(result.skills[0].installed_hash).toBe('11223344')
    expect(result.skills[0].latest_hash).toBe('aabbccdd')
    expect(result.skills[0].semver).toBe('2.0.0')
    expect(result.summary.outdated).toBe(1)
    expect(result.summary.up_to_date).toBe(0)
  })

  it('reports unknown when no version history exists', async () => {
    const skillId = 'community/new-skill'
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([{ id: skillId, name: 'new-skill', installPath: '/tmp/skills/new-skill' }])
    )
    mockedReadFile.mockResolvedValue('latest-content')

    // No version records in DB for this skill

    const result = await executeOutdated({ include_deps: true }, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].status).toBe('unknown')
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

    await versionRepo.recordVersion(skillId, 'aabbccdd11223344', '1.0.0')
    await versionRepo.recordVersion(depSkillId, 'aabbccdd11223344', '1.0.0')

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

    const depSkill = result.skills.find((s) => s.id === skillId)
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

    await versionRepo.recordVersion(skillId, 'aabbccdd11223344', '1.0.0')

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

    await versionRepo.recordVersion(skillId, 'aabbccdd11223344', '1.0.0')

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

    await versionRepo.recordVersion('community/good-skill', 'aabbccdd11223344', '1.0.0')

    const result = await executeOutdated({ include_deps: true }, makeContext(db))

    expect(result.skills).toHaveLength(2)
    expect(result.summary.total_installed).toBe(2)

    const good = result.skills.find((s) => s.id === 'community/good-skill')
    const bad = result.skills.find((s) => s.id === 'test/bad-skill')

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
})
