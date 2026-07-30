/**
 * @fileoverview Unit tests for getManifestInstalledSkillIds
 * @see SMI-5895 Wave 2 Step 2
 */

import { describe, it, expect } from 'vitest'
import { getManifestInstalledSkillIds } from './manifest-skill-ids.helpers.js'
import type { SkillManifest, SkillManifestEntry } from './install.types.js'

function entry(id: string, name: string, installPath = `/tmp/skills/${name}`): SkillManifestEntry {
  return {
    id,
    name,
    version: '1.0.0',
    source: 'registry',
    installPath,
    installedAt: '2026-01-01T00:00:00Z',
    lastUpdated: '2026-01-01T00:00:00Z',
  }
}

describe('getManifestInstalledSkillIds', () => {
  it('returns an empty array for an empty manifest', () => {
    const manifest: SkillManifest = { version: '1', installedSkills: {} }
    expect(getManifestInstalledSkillIds(manifest)).toEqual([])
  })

  it('returns an empty array when installedSkills is absent (hand-edited/truncated manifest)', () => {
    // loadManifest() does no schema validation -- it returns raw JSON.parse
    // output, so this shape genuinely reaches the helper.
    const manifest = { version: '1' } as unknown as SkillManifest
    expect(getManifestInstalledSkillIds(manifest)).toEqual([])
  })

  it('returns the id of every installed entry', () => {
    const manifest: SkillManifest = {
      version: '1',
      installedSkills: {
        astro: entry('community/astro', 'astro'),
        'ci-doctor': entry('community/ci-doctor', 'ci-doctor'),
      },
    }
    const ids = getManifestInstalledSkillIds(manifest).sort()
    expect(ids).toEqual(['community/astro', 'community/ci-doctor'])
  })

  it('filters out entries with a missing id (corrupt manifest row, SMI-3177)', () => {
    const manifest: SkillManifest = {
      version: '1',
      installedSkills: {
        astro: entry('community/astro', 'astro'),
        broken: { ...entry('', 'broken') },
      },
    }
    expect(getManifestInstalledSkillIds(manifest)).toEqual(['community/astro'])
  })

  it('filters out entries with a whitespace-only id', () => {
    const manifest: SkillManifest = {
      version: '1',
      installedSkills: {
        broken: entry('   ', 'broken'),
      },
    }
    expect(getManifestInstalledSkillIds(manifest)).toEqual([])
  })

  it('de-duplicates ids shared by two client-scoped entries for the same skill (SMI-5894 multi-client keys)', () => {
    // SMI-5894 Wave 1 Step 3: a skill installed under two clients produces
    // two manifest entries -- 'astro' (canonical) and 'astro::cursor' -- that
    // both carry the same registry id. A per-id loop (skill_updates,
    // skill_outdated's dependency-satisfaction check) must see it once.
    const manifest: SkillManifest = {
      version: '1',
      installedSkills: {
        astro: entry('community/astro', 'astro', '/home/.claude/skills/astro'),
        'astro::cursor': entry('community/astro', 'astro', '/home/.cursor/skills/astro'),
      },
    }
    expect(getManifestInstalledSkillIds(manifest)).toEqual(['community/astro'])
  })

  it('does not de-duplicate genuinely distinct ids', () => {
    const manifest: SkillManifest = {
      version: '1',
      installedSkills: {
        astro: entry('community/astro', 'astro', '/home/.claude/skills/astro'),
        'astro::cursor': entry('other/astro-fork', 'astro', '/home/.cursor/skills/astro'),
      },
    }
    const ids = getManifestInstalledSkillIds(manifest).sort()
    expect(ids).toEqual(['community/astro', 'other/astro-fork'])
  })
})
