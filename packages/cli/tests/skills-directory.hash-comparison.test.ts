/**
 * @fileoverview Unit tests for computeHasUpdates() — SMI-6343 Wave 2 (C2)
 *
 * Direct unit tests for the extracted pure comparison helper used by
 * `getSkillsFromDirectory()` (the function `sklx list --outdated` actually
 * reads, via `getInstalledSkills()`/`getInstalledSkillsForClient()` ->
 * `manage.action.ts`). Kept as pure-function tests (no fs/db harness)
 * because the exact defect this wave fixes — a hand-rolled comparison that
 * read a nonexistent `contentHash` field off the *parsed SKILL.md* object
 * instead of the manifest entry, and so always fell back to comparing a
 * fresh on-disk hash against skill_versions' pre-fix metadata-proxy hash —
 * lives entirely inside this one function's decision logic.
 */

import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { computeHasUpdates } from '../src/utils/skills-directory.js'
import type { SkillManifestEntry, SkillVersionRow } from '@skillsmith/core'

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function makeManifestEntry(overrides: Partial<SkillManifestEntry> = {}): SkillManifestEntry {
  return {
    id: 'community/test-skill',
    name: 'test-skill',
    version: '1.0.0',
    source: 'registry',
    installPath: '/tmp/skills/test-skill',
    installedAt: '2026-01-01T00:00:00Z',
    lastUpdated: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeVersionRow(overrides: Partial<SkillVersionRow> = {}): SkillVersionRow {
  return {
    id: 1,
    skill_id: 'community/test-skill',
    content_hash: sha256('registry-content'),
    recorded_at: 1000,
    semver: '1.0.0',
    metadata: null,
    ...overrides,
  }
}

describe('computeHasUpdates (SMI-6343 Wave 2, C2)', () => {
  it('returns false when there is no latest registry version at all', () => {
    expect(computeHasUpdates(makeManifestEntry(), 'on-disk content', null)).toBe(false)
  })

  it('returns false when the manifest-recorded contentHash matches the latest registry hash', () => {
    const registryHash = sha256('registry-content')
    const entry = makeManifestEntry({ contentHash: registryHash })
    expect(
      computeHasUpdates(
        entry,
        'irrelevant on-disk content',
        makeVersionRow({ content_hash: registryHash })
      )
    ).toBe(false)
  })

  it('returns true when the manifest-recorded contentHash differs from the latest registry hash', () => {
    const entry = makeManifestEntry({ contentHash: sha256('installed-content') })
    expect(
      computeHasUpdates(
        entry,
        'irrelevant on-disk content',
        makeVersionRow({ content_hash: sha256('newer-registry-content') })
      )
    ).toBe(true)
  })

  it('falls back to originalContentHash when contentHash is absent', () => {
    const entry = makeManifestEntry({
      originalContentHash: sha256('install-time-content'),
    })
    expect(
      computeHasUpdates(
        entry,
        'irrelevant on-disk content',
        makeVersionRow({ content_hash: sha256('install-time-content') })
      )
    ).toBe(false)
  })

  it('prefers contentHash over originalContentHash when both are present', () => {
    const entry = makeManifestEntry({
      contentHash: sha256('latest-installed-content'),
      originalContentHash: sha256('stale-install-time-content'),
    })
    // Registry now matches the ORIGINAL install-time hash, not the latest
    // update — proves contentHash (not originalContentHash) wins.
    expect(
      computeHasUpdates(
        entry,
        'irrelevant on-disk content',
        makeVersionRow({ content_hash: sha256('stale-install-time-content') })
      )
    ).toBe(true)
  })

  it('falls back to a fresh on-disk SHA-256 when the manifest entry has no recorded hash at all', () => {
    const entry = makeManifestEntry()
    const onDiskContent = 'exact on-disk SKILL.md content'
    expect(
      computeHasUpdates(
        entry,
        onDiskContent,
        makeVersionRow({ content_hash: sha256(onDiskContent) })
      )
    ).toBe(false)
    expect(
      computeHasUpdates(
        entry,
        onDiskContent,
        makeVersionRow({ content_hash: sha256('different-registry-content') })
      )
    ).toBe(true)
  })

  it('falls through a BLANK (whitespace-only) contentHash to originalContentHash (adversarial-review regression)', () => {
    // The bug this guards: a raw `entry.contentHash ?? entry.originalContentHash`
    // chain only falls through on null/undefined — a blank-but-present
    // contentHash would incorrectly "win" with a value the comparator
    // itself treats as absent, discarding a legitimate originalContentHash.
    const entry = makeManifestEntry({
      contentHash: '   ',
      originalContentHash: sha256('install-time-content'),
    })
    expect(
      computeHasUpdates(
        entry,
        'irrelevant on-disk content',
        makeVersionRow({ content_hash: sha256('install-time-content') })
      )
    ).toBe(false)
    expect(
      computeHasUpdates(
        entry,
        'irrelevant on-disk content',
        makeVersionRow({ content_hash: sha256('different-registry-content') })
      )
    ).toBe(true)
  })

  it('falls through a BLANK contentHash all the way to a fresh on-disk hash when originalContentHash is also blank/absent', () => {
    const entry = makeManifestEntry({ contentHash: '   ' })
    const onDiskContent = 'exact on-disk SKILL.md content'
    expect(
      computeHasUpdates(
        entry,
        onDiskContent,
        makeVersionRow({ content_hash: sha256(onDiskContent) })
      )
    ).toBe(false)
    expect(
      computeHasUpdates(
        entry,
        onDiskContent,
        makeVersionRow({ content_hash: sha256('different-registry-content') })
      )
    ).toBe(true)
  })

  it('falls back to a fresh on-disk SHA-256 when there is no manifest entry at all (untracked skill)', () => {
    const onDiskContent = 'untracked skill content'
    expect(
      computeHasUpdates(
        undefined,
        onDiskContent,
        makeVersionRow({ content_hash: sha256(onDiskContent) })
      )
    ).toBe(false)
    expect(
      computeHasUpdates(
        undefined,
        onDiskContent,
        makeVersionRow({ content_hash: sha256('something-else') })
      )
    ).toBe(true)
  })
})
