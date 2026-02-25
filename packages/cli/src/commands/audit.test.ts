/**
 * @fileoverview Unit tests for `skillsmith audit` CLI command
 * @see SMI-skill-version-tracking Wave 3
 *
 * Uses SKILLSMITH_SKIP_LICENSE_CHECK=true to bypass tier gate in tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdvisoryRepository } from '@skillsmith/core'
import { createTestDatabase, closeDatabase } from '../../../core/tests/helpers/database.js'
import type { Database as DatabaseType } from '../../../core/src/db/database-interface.js'
import type { SkillAdvisory } from '@skillsmith/core'

// ============================================================================
// Helpers
// ============================================================================

function makeAdvisory(overrides: Partial<SkillAdvisory> = {}): SkillAdvisory {
  return {
    id: 'SSA-2026-001',
    skillId: 'community/commit-helper',
    severity: 'critical',
    title: 'Prompt Injection in commit-helper',
    description: 'A test advisory for CLI tests.',
    publishedAt: '2026-01-15T00:00:00Z',
    ...overrides,
  }
}

// ============================================================================
// Tests — isolate the core logic by testing AdvisoryRepository output
// that the audit command displays, without spawning an actual Commander
// process (which would require SKILLSMITH_SKIP_LICENSE_CHECK in env).
// The command action itself is thin formatting logic over the repo.
// ============================================================================

describe('audit command — AdvisoryRepository integration', () => {
  let db: DatabaseType
  let repo: AdvisoryRepository

  beforeEach(() => {
    process.env['SKILLSMITH_SKIP_LICENSE_CHECK'] = 'true'
    db = createTestDatabase()
    repo = new AdvisoryRepository(db)
  })

  afterEach(() => {
    delete process.env['SKILLSMITH_SKIP_LICENSE_CHECK']
    closeDatabase(db)
  })

  it('returns empty array when DB has no advisories (early-access scenario)', () => {
    const advisories = repo.getActiveAdvisories()
    expect(advisories).toHaveLength(0)
  })

  it('returns advisory data for display when advisories exist', () => {
    repo.upsertAdvisory(
      makeAdvisory({ id: 'SSA-2026-001', severity: 'critical', skillId: 'community/commit-helper' })
    )
    repo.upsertAdvisory(
      makeAdvisory({ id: 'SSA-2026-002', severity: 'high', skillId: 'community/jest-helper' })
    )

    const advisories = repo.getActiveAdvisories()
    expect(advisories).toHaveLength(2)

    const critical = advisories.filter((a: SkillAdvisory) => a.severity === 'critical')
    const high = advisories.filter((a: SkillAdvisory) => a.severity === 'high')
    expect(critical).toHaveLength(1)
    expect(high).toHaveLength(1)
    expect(critical[0]!.skillId).toBe('community/commit-helper')
    expect(high[0]!.skillId).toBe('community/jest-helper')
  })

  it('reflects npm audit style data: title and id are present per advisory', () => {
    repo.upsertAdvisory(
      makeAdvisory({
        id: 'SSA-2026-003',
        title: 'Prompt Injection in commit-helper',
        severity: 'critical',
      })
    )

    const advisories = repo.getActiveAdvisories()
    expect(advisories[0]!.title).toBe('Prompt Injection in commit-helper')
    expect(advisories[0]!.id).toBe('SSA-2026-003')
  })

  it('fixAvailable is determined by presence of patchedVersions', () => {
    repo.upsertAdvisory(makeAdvisory({ id: 'SSA-2026-004', patchedVersions: '[">=2.0.0"]' }))
    repo.upsertAdvisory(makeAdvisory({ id: 'SSA-2026-005', skillId: 'community/other-skill' }))

    const withPatch = repo.getAdvisoriesForSkill('community/commit-helper')[0]!
    const withoutPatch = repo.getAdvisoriesForSkill('community/other-skill')[0]!

    expect(withPatch.patchedVersions).toBeTruthy()
    expect(withoutPatch.patchedVersions).toBeUndefined()
  })
})

// ============================================================================
// Tests — requireTier bypass with SKILLSMITH_SKIP_LICENSE_CHECK
// ============================================================================

describe('audit command — requireTier bypass', () => {
  it('does not throw when SKILLSMITH_SKIP_LICENSE_CHECK=true', async () => {
    process.env['SKILLSMITH_SKIP_LICENSE_CHECK'] = 'true'

    // requireTier should return without throwing
    const { requireTier } = await import('../utils/require-tier.js')
    await expect(requireTier('team')).resolves.toBeUndefined()

    delete process.env['SKILLSMITH_SKIP_LICENSE_CHECK']
  })

  it('throws when no license key and tier is required', async () => {
    delete process.env['SKILLSMITH_SKIP_LICENSE_CHECK']
    delete process.env['SKILLSMITH_LICENSE_KEY']

    const { requireTier } = await import('../utils/require-tier.js')

    // With no license key, community tier — should reject team requirement
    // getLicenseStatus returns community tier when no key is present
    await expect(requireTier('team')).rejects.toThrow(/team tier/)
  })
})
