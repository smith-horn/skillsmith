/**
 * Tests for the SMI-5162 migration ordering guard helper.
 *
 * Covers `findOutOfOrderMigrations` in audit-standards-helpers.mjs.
 *
 * Background: a migration whose version prefix (the part before the first
 * underscore) sorts lexicographically BELOW the maximum pre-existing migration
 * version will be silently skipped by `supabase db push` — exactly the
 * SMI-5159 /account/telemetry incident. This pure helper is the logic layer;
 * Check 50 in audit-standards.mjs provides the git I/O layer.
 */
import { describe, expect, it } from 'vitest'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  findOutOfOrderMigrations: (
    addedBasenames: string[],
    baseBasenames: string[]
  ) => {
    maxBaseVersion: string | null
    violations: Array<{ file: string; version: string; maxBaseVersion: string }>
  }
}

const { findOutOfOrderMigrations } = helpers

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findOutOfOrderMigrations (SMI-5162)', () => {
  it('out-of-order timestamp fails: added version below base tip → 1 violation', () => {
    const { maxBaseVersion, violations } = findOutOfOrderMigrations(
      ['20260519000005_skill_invoke_rpcs.sql'],
      ['20260521000001_team_member_visibility.sql']
    )
    expect(maxBaseVersion).toBe('20260521000001')
    expect(violations).toHaveLength(1)
    expect(violations[0].file).toBe('20260519000005_skill_invoke_rpcs.sql')
    expect(violations[0].version).toBe('20260519000005')
    expect(violations[0].maxBaseVersion).toBe('20260521000001')
  })

  it('ordered timestamp passes: added version above base tip → 0 violations', () => {
    const { maxBaseVersion, violations } = findOutOfOrderMigrations(
      ['20260522000001_new_feature.sql'],
      ['20260521000001_team_member_visibility.sql']
    )
    expect(maxBaseVersion).toBe('20260521000001')
    expect(violations).toHaveLength(0)
  })

  it('equal version is allowed (no false-fail): added version equals base tip → 0 violations', () => {
    // Duplicate-version detection is SMI-5163's scope; this guard uses strict <.
    const { maxBaseVersion, violations } = findOutOfOrderMigrations(
      ['20260521000001_duplicate_name.sql'],
      ['20260521000001_team_member_visibility.sql']
    )
    expect(maxBaseVersion).toBe('20260521000001')
    expect(violations).toHaveLength(0)
  })

  it('cross-scheme is safe: timestamp add above legacy base tip → 0 violations', () => {
    // Legacy prefixes start with '0', timestamps with '2' — lexicographic order is correct.
    const { maxBaseVersion, violations } = findOutOfOrderMigrations(
      ['20260101000001_new_ts_migration.sql'],
      ['084_legacy_migration.sql']
    )
    expect(maxBaseVersion).toBe('084')
    expect(violations).toHaveLength(0)
  })

  it('legacy add below timestamp tip fails: adding legacy NNN below 14-digit tip → 1 violation', () => {
    const { maxBaseVersion, violations } = findOutOfOrderMigrations(
      ['085_new_legacy.sql'],
      ['20260521000001_team_member_visibility.sql']
    )
    expect(maxBaseVersion).toBe('20260521000001')
    expect(violations).toHaveLength(1)
    expect(violations[0].version).toBe('085')
  })

  it('empty base no-ops: first-ever migration → 0 violations, maxBaseVersion null', () => {
    const { maxBaseVersion, violations } = findOutOfOrderMigrations(['001_initial_schema.sql'], [])
    expect(maxBaseVersion).toBeNull()
    expect(violations).toHaveLength(0)
  })

  it('mixed added set: one in-order + one out-of-order → exactly 1 violation, the right file', () => {
    const { maxBaseVersion, violations } = findOutOfOrderMigrations(
      ['20260519000005_old_invoke_rpcs.sql', '20260522000001_correct_order.sql'],
      ['20260521000001_team_member_visibility.sql']
    )
    expect(maxBaseVersion).toBe('20260521000001')
    expect(violations).toHaveLength(1)
    expect(violations[0].file).toBe('20260519000005_old_invoke_rpcs.sql')
  })

  it('malformed basename (no underscore) is ignored: not a violation', () => {
    const { violations } = findOutOfOrderMigrations(
      ['no-underscore.sql'],
      ['20260521000001_team_member_visibility.sql']
    )
    expect(violations).toHaveLength(0)
  })

  it('rename destination basename treated as added: if below tip → 1 violation', () => {
    // The --diff-filter=AR wiring in Check 50 passes the destination basename
    // to this helper. Assert that a below-tip destination correctly fails.
    const { violations } = findOutOfOrderMigrations(
      ['20260518000001_renamed_destination.sql'],
      ['20260521000001_team_member_visibility.sql']
    )
    expect(violations).toHaveLength(1)
    expect(violations[0].file).toBe('20260518000001_renamed_destination.sql')
  })
})
