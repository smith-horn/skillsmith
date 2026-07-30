/**
 * @fileoverview Unit tests for skill_updates MCP tool
 * @see SMI-5895 Wave 2 Step 2 — bound skillIds resolution to the manifest
 * instead of an unfiltered `SELECT DISTINCT skill_id FROM skill_versions`
 * (the reported `updatesAvailable: 2833` registry-wide-scan bug).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SkillVersionRepository } from '@skillsmith/core'
import { createTestDatabase, closeDatabase } from '@skillsmith/core/testkit'
import { executeSkillUpdates } from './skill-updates.js'
import type { ToolContext } from '../context.js'
import type { Database } from '@skillsmith/core'
import type { SkillManifest } from './install.types.js'

// ============================================================================
// Mocks
// ============================================================================

vi.mock('./install.helpers.js', () => ({
  loadManifest: vi.fn(),
}))

import { loadManifest } from './install.helpers.js'

const mockedLoadManifest = vi.mocked(loadManifest)

// ============================================================================
// Helpers
// ============================================================================

function makeContext(db: Database): ToolContext {
  return { db } as unknown as ToolContext
}

function emptyManifest(): SkillManifest {
  return { version: '1', installedSkills: {} }
}

function manifestWithSkills(entries: Array<{ key: string; id: string }>): SkillManifest {
  const installedSkills: SkillManifest['installedSkills'] = {}
  for (const e of entries) {
    installedSkills[e.key] = {
      id: e.id,
      name: e.key,
      version: '1.0.0',
      source: 'registry',
      installPath: `/tmp/skills/${e.key}`,
      installedAt: '2026-01-01T00:00:00Z',
      lastUpdated: '2026-01-01T00:00:00Z',
    }
  }
  return { version: '1', installedSkills }
}

/**
 * Insert a skill_versions row with an explicit `recorded_at`, bypassing
 * `SkillVersionRepository.recordVersion()`'s `unixepoch()` DB default.
 * `getVersionHistory()`'s `ORDER BY recorded_at DESC` has no secondary sort
 * key, so two rows for the same skill inserted via `recordVersion()` in the
 * same wall-clock second have unspecified relative order — this sidesteps
 * that by controlling `recorded_at` directly wherever the oldest-vs-latest
 * distinction matters to the test.
 */
function insertVersionAt(
  db: Database,
  skillId: string,
  contentHash: string,
  semver: string,
  recordedAt: number
): void {
  db.prepare(
    `INSERT OR IGNORE INTO skill_versions (skill_id, content_hash, recorded_at, semver)
     VALUES (?, ?, ?, ?)`
  ).run(skillId, contentHash, recordedAt, semver)
}

// ============================================================================
// Tests
// ============================================================================

describe('executeSkillUpdates', () => {
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

  it('returns no results when the manifest has no installed skills and no skillIds are given', async () => {
    mockedLoadManifest.mockResolvedValue(emptyManifest())

    // A skill_versions row exists for a skill that is NOT in the manifest --
    // this must never surface in the result (this is exactly the SMI-5895
    // bug: an unfiltered SELECT DISTINCT would have picked this up).
    await versionRepo.recordVersion('someone/unrelated-skill', 'aaaa1111', '1.0.0')

    const result = await executeSkillUpdates({}, makeContext(db))

    expect(result.skills).toHaveLength(0)
    expect(result.updatesAvailable).toBe(0)
  })

  it('bounds the default skillIds to the manifest, ignoring registry-wide skill_versions rows', async () => {
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([{ key: 'astro', id: 'community/astro' }])
    )

    // Installed skill: two version records, hash changes -> update available.
    insertVersionAt(db, 'community/astro', 'oldoldold1', '1.0.0', 1000)
    insertVersionAt(db, 'community/astro', 'newnewnew2', '2.0.0', 2000)

    // 2800+ unrelated registry skills tracked in skill_versions, NONE installed.
    for (let i = 0; i < 5; i++) {
      await versionRepo.recordVersion(`registry/noise-${i}`, `hash${i}aaaa`, '1.0.0')
    }

    const result = await executeSkillUpdates({}, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].skillId).toBe('community/astro')
    expect(result.skills[0].updateAvailable).toBe(true)
    expect(result.updatesAvailable).toBe(1)
  })

  it('honors an explicit skillIds filter without consulting the manifest', async () => {
    // Manifest is empty/irrelevant -- explicit skillIds is an override, same
    // as before this fix.
    mockedLoadManifest.mockResolvedValue(emptyManifest())

    await versionRepo.recordVersion('explicit/skill', 'hashhash01', '1.0.0')

    const result = await executeSkillUpdates({ skillIds: ['explicit/skill'] }, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].skillId).toBe('explicit/skill')
    expect(mockedLoadManifest).not.toHaveBeenCalled()
  })

  it('de-duplicates a skill installed under two clients (SMI-5894 name::client keys) to one result', async () => {
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([
        { key: 'astro', id: 'community/astro' },
        { key: 'astro::cursor', id: 'community/astro' },
      ])
    )

    await versionRepo.recordVersion('community/astro', 'aaaa1111', '1.0.0')

    const result = await executeSkillUpdates({}, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].skillId).toBe('community/astro')
  })

  it('skips manifest entries with no id (corrupt row) without throwing', async () => {
    const manifest = manifestWithSkills([{ key: 'good', id: 'community/good' }])
    manifest.installedSkills['broken'] = {
      ...manifest.installedSkills['good'],
      id: '',
      name: 'broken',
    }
    mockedLoadManifest.mockResolvedValue(manifest)

    await versionRepo.recordVersion('community/good', 'aaaa1111', '1.0.0')

    const result = await executeSkillUpdates({}, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].skillId).toBe('community/good')
  })

  it('skips a manifest-scoped id with no version history instead of erroring', async () => {
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([{ key: 'no-history', id: 'community/no-history' }])
    )
    // No recordVersion call for this id -- getVersionHistory returns [].

    const result = await executeSkillUpdates({}, makeContext(db))

    expect(result.skills).toHaveLength(0)
    expect(result.updatesAvailable).toBe(0)
  })

  it('reports updateAvailable: false when the oldest and latest hash match', async () => {
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([{ key: 'stable', id: 'community/stable' }])
    )
    await versionRepo.recordVersion('community/stable', 'samehash01', '1.0.0')

    const result = await executeSkillUpdates({}, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].updateAvailable).toBe(false)
    expect(result.updatesAvailable).toBe(0)
  })
})
