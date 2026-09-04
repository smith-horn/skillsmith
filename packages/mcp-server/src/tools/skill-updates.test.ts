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

function manifestWithSkills(
  entries: Array<{ key: string; id: string; contentHash?: string; originalContentHash?: string }>
): SkillManifest {
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
      ...(e.contentHash !== undefined ? { contentHash: e.contentHash } : {}),
      ...(e.originalContentHash !== undefined
        ? { originalContentHash: e.originalContentHash }
        : {}),
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
    // SMI-6343 (C1): the manifest's recorded installed hash ('oldoldold1',
    // what was actually installed) differs from the latest registry hash
    // ('newnewnew2') -> update available. Version history itself no longer
    // drives this — only the manifest-vs-latest-registry comparison does.
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([
        { key: 'astro', id: 'community/astro', contentHash: 'oldoldold1' },
      ])
    )

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

  it('honors an explicit skillIds filter, still consulting the manifest for the real installed hash (SMI-6343 C1)', async () => {
    // SMI-6343 (C1): the manifest is now always loaded — even for an
    // explicit skillIds override — because it is the only source of the
    // real recorded installed hash the comparison needs. This replaces the
    // pre-fix design, where `skillIds` bypassed the manifest entirely and
    // the comparison used skill_versions' (meaningless) oldest-vs-latest
    // hashes instead.
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([{ key: 'explicit', id: 'explicit/skill', contentHash: 'hashhash01' }])
    )

    await versionRepo.recordVersion('explicit/skill', 'hashhash01', '1.0.0')

    const result = await executeSkillUpdates({ skillIds: ['explicit/skill'] }, makeContext(db))

    expect(mockedLoadManifest).toHaveBeenCalled()
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].skillId).toBe('explicit/skill')
    expect(result.skills[0].updateAvailable).toBe(false)
  })

  it('falls through a BLANK (whitespace-only) contentHash to originalContentHash (adversarial-review regression)', async () => {
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([
        {
          key: 'blank-content-hash',
          id: 'community/blank-content-hash',
          contentHash: '   ',
          originalContentHash: 'real-original-hash',
        },
      ])
    )
    await versionRepo.recordVersion('community/blank-content-hash', 'newer-registry-hash', '2.0.0')

    const result = await executeSkillUpdates({}, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].installedHash).toBe('real-original-hash'.slice(0, 8))
    expect(result.skills[0].updateAvailable).toBe(true)
  })

  it('reports updateAvailable: false for an explicit skillId the manifest has no entry for (unknown, not a false positive)', async () => {
    mockedLoadManifest.mockResolvedValue(emptyManifest())

    await versionRepo.recordVersion('unmanifested/skill', 'somehash01', '1.0.0')

    const result = await executeSkillUpdates(
      { skillIds: ['unmanifested/skill'] },
      makeContext(db)
    )

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].installedHash).toBe('--------')
    expect(result.skills[0].updateAvailable).toBe(false)
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

  it('reports unknown (not a guess) when two clients of the same skill carry conflicting installed hashes (adversarial-review regression)', async () => {
    // The bug this guards: "first non-empty hash wins" made the verdict
    // depend on manifest object-iteration order — one client's install is
    // current, the other is genuinely outdated, and picking either
    // silently misreports the other. Per ADR-144 §3, a real conflict must
    // resolve to no-hash-available (comparator -> 'unknown'), never a
    // guess.
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([
        { key: 'astro', id: 'community/astro', contentHash: 'client-a-hash' },
        { key: 'astro::cursor', id: 'community/astro', contentHash: 'client-b-hash' },
      ])
    )
    await versionRepo.recordVersion('community/astro', 'client-a-hash', '1.0.0')

    const result = await executeSkillUpdates({}, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].updateAvailable).toBe(false)
    expect(result.skills[0].installedHash).toBe('--------')
  })

  it('resolves normally when two clients of the same skill carry the SAME installed hash', async () => {
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([
        { key: 'astro', id: 'community/astro', contentHash: 'agreed-hash' },
        { key: 'astro::cursor', id: 'community/astro', contentHash: 'agreed-hash' },
      ])
    )
    await versionRepo.recordVersion('community/astro', 'newer-registry-hash', '2.0.0')

    const result = await executeSkillUpdates({}, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].updateAvailable).toBe(true)
    expect(result.skills[0].installedHash).toBe('agreed-hash'.slice(0, 8))
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

  it('reports updateAvailable: false when the manifest-recorded hash matches the latest registry hash', async () => {
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([{ key: 'stable', id: 'community/stable', contentHash: 'samehash01' }])
    )
    await versionRepo.recordVersion('community/stable', 'samehash01', '1.0.0')

    const result = await executeSkillUpdates({}, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].updateAvailable).toBe(false)
    expect(result.updatesAvailable).toBe(0)
  })

  // SMI-6343 (C1) regression guard: the migration purging skill_versions
  // (v18) exists specifically to prevent a mixed old/new hash-space table
  // from making `oldest !== latest` true for EVERY skill with pre-existing
  // history. Prove the NEW comparison (manifest-vs-latest, not
  // oldest-vs-latest) doesn't reintroduce that universal false positive by
  // itself: a skill with several pre-existing (post-migration, real-hash)
  // version rows whose manifest-recorded hash matches the current latest
  // registry hash must report updateAvailable: false.
  it('does not report updateAvailable purely because a skill has pre-existing version history (SMI-6343 universal-false-positive guard)', async () => {
    mockedLoadManifest.mockResolvedValue(
      manifestWithSkills([
        { key: 'history-rich', id: 'community/history-rich', contentHash: 'currenthash1' },
      ])
    )

    // Several real-hash version rows recorded over time, ending at the
    // exact hash the manifest says is installed.
    insertVersionAt(db, 'community/history-rich', 'ancienthash0', '1.0.0', 1000)
    insertVersionAt(db, 'community/history-rich', 'olderhash01', '1.1.0', 2000)
    insertVersionAt(db, 'community/history-rich', 'currenthash1', '1.2.0', 3000)

    const result = await executeSkillUpdates({}, makeContext(db))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].skillId).toBe('community/history-rich')
    expect(result.skills[0].updateAvailable).toBe(false)
    expect(result.updatesAvailable).toBe(0)
  })
})
