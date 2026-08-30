/**
 * @fileoverview Unit tests for `skillsmith audit` CLI command
 * @see SMI-skill-version-tracking Wave 3
 *
 * Uses SKILLSMITH_SKIP_LICENSE_CHECK=true to bypass tier gate in tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AdvisoryRepository } from '@skillsmith/core'
import { createTestDatabase, closeDatabase } from '@skillsmith/core/testkit'
import type { Database as DatabaseType } from '@skillsmith/core'
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

  beforeEach(async () => {
    process.env['SKILLSMITH_SKIP_LICENSE_CHECK'] = 'true'
    db = await createTestDatabase()
    repo = new AdvisoryRepository(db)
  })

  afterEach(() => {
    delete process.env['SKILLSMITH_SKIP_LICENSE_CHECK']
    closeDatabase(db)
  })

  it('returns empty array when DB has no advisories', () => {
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
    delete process.env['SKILLSMITH_API_KEY']

    // SMI-6271: requireTier() now also checks for a stored `skillsmith
    // login` device session (loadCredentials(), homedir-based) before
    // falling back to community — sandbox HOME so this test's outcome
    // never depends on whether this specific container happens to have a
    // real session stored in ~/.skillsmith/config.json.
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const tmpHome = mkdtempSync(join(tmpdir(), 'sklx-audit-test-home-'))
    const originalHome = process.env['HOME']
    process.env['HOME'] = tmpHome

    try {
      const { requireTier } = await import('../utils/require-tier.js')

      // With no license key, API key, or stored session, community tier —
      // should reject the team requirement.
      await expect(requireTier('team')).rejects.toThrow(/team tier/)
    } finally {
      if (originalHome !== undefined) {
        process.env['HOME'] = originalHome
      } else {
        delete process.env['HOME']
      }
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})

// ============================================================================
// SMI-6271 (Wave 1 of SMI-6266): `audit advisories`' requireTier('team') now
// live-resolves SKILLSMITH_API_KEY via /license-status instead of only ever
// reporting community for it. Deliberately end-to-end (real requireTier(),
// no @skillsmith/core module mock — just the env var + a fetch stub) so this
// proves the FULL wiring through the actual command's tier gate, not just
// the resolver in isolation (covered exhaustively by
// packages/cli/src/utils/require-tier.test.ts).
// ============================================================================

describe('audit advisories — SMI-6271 live tier resolution via SKILLSMITH_API_KEY', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    delete process.env['SKILLSMITH_API_KEY']
    delete process.env['SKILLSMITH_LICENSE_KEY']
    delete process.env['SKILLSMITH_SKIP_LICENSE_CHECK']
    global.fetch = originalFetch
  })

  it('resolves live Enterprise tier for a configured API key, no longer reporting community', async () => {
    process.env['SKILLSMITH_API_KEY'] = 'sk_live_enterprise_test'
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { authenticated: true, tier: 'enterprise' } }), {
        status: 200,
      })
    )

    const { requireTier } = await import('../utils/require-tier.js')
    await expect(requireTier('team')).resolves.toBeUndefined()
    expect(global.fetch).toHaveBeenCalledOnce()
  })

  it('still blocks a below-tier API key (live-resolved individual, gate requires team)', async () => {
    process.env['SKILLSMITH_API_KEY'] = 'sk_live_individual_test'
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { authenticated: true, tier: 'individual' } }), {
        status: 200,
      })
    )

    const { requireTier } = await import('../utils/require-tier.js')
    await expect(requireTier('team')).rejects.toThrow(/team tier/)
  })
})
