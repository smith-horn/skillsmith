/**
 * SMI-6690 — the PG-FREE half of the SMI-6651 `release_private_registry_skill_content()` suite.
 *
 * WHICH HALF RUNS WHERE, AND WHY. `private-registry-content-release.pg.test.ts` is entirely
 * wrapped in one `describe.skipIf(noLiveTestPg)` (SMI-6651, ADR-162 §1), because nearly everything
 * in it is a PRIVILEGE or TRANSACTIONAL property only a real Postgres catalog can prove. The
 * assertions in THIS file never touched Postgres — they read migration files via
 * `migrationSql()`/`brokenMigrationSql()` and do pure string work — so being nested inside that
 * file's one `skipIf` skipped them for a reason that never applied. That is how PR #2862 reported
 * 40/40 checks green including `Test (root)` while these three assertions never executed. This
 * file has NO `skipIf` and runs unconditionally, matching the precedent of
 * `../private-registry-audit-trigger.static.test.ts`.
 *
 * WHAT THESE ASSERTIONS DO NOT PROVE: they are a lexical smoke check on the migration text, not a
 * semantic proof that the predicates are effective. The exact gaps are measured and documented on
 * `extractReReadSelect` in `private-registry-content-release.test-sqltext.ts`; read them there
 * before trusting a green run here. SMI-6685 replaces the mechanism.
 *
 * @module scripts/tests/supabase/private-registry-content-release.structural
 */

import { describe, it, expect } from 'vitest'
import { migrationSql } from './private-registry-content-release.test-helpers.ts'
import { brokenMigrationSql } from './private-registry-content-release.test-reverts.ts'
import { extractReReadSelect } from './private-registry-content-release.test-sqltext.ts'

describe('SMI-6651/SMI-6690 — release_private_registry_skill_content() migration text (PG-free)', () => {
  it('Finding 5(a) STRUCTURAL: the step-4 re-read re-applies team/approval/deprecated predicates against v_row', () => {
    // Deliberately STATIC, not a live interleaving proof. A genuine two-session test would have to
    // land a concurrent UPDATE strictly between this function's step-2 and step-4 SELECTs — a
    // window that is unlocked on purpose (ADR-159 §3), microseconds wide, with no
    // externally-observable pause point inside a single atomic RPC call. Instrumenting a sleep
    // into the function body would mean testing a modified copy, not the shipped one. The
    // BEHAVIORAL proof that these three predicates matter is the revert-then-restore suite in
    // `.pg.test.ts` (tests (a), (d/f), (i)).
    const block = extractReReadSelect(migrationSql())
    expect(block).toContain('AND prs.team_id = v_row.team_id')
    expect(block).toContain("AND prs.approval_status = 'approved'")
    expect(block).toContain('AND prs.deprecated = false')
  })

  it.each([
    ['team_id', 'm' as const, 'AND prs.team_id = v_row.team_id'],
    ['approval_status', 'n' as const, "AND prs.approval_status = 'approved'"],
    ['deprecated', 'o' as const, 'AND prs.deprecated = false'],
  ])(
    'Finding 2 fix: commenting out the %s predicate (not deleting it) is correctly seen as ABSENT',
    (_label, variant, predicate) => {
      // A predicate commented out as `-- AND ...` still contains the plain substring `AND ...`, so
      // a `toContain` check against RAW extracted SQL would pass against inert SQL.
      // `extractReReadSelect` strips comments first, so the stripped block must NOT contain it.
      const block = extractReReadSelect(brokenMigrationSql(variant))
      expect(block).not.toContain(predicate)
    }
  )
})
