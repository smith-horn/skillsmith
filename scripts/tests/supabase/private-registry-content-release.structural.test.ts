/**
 * SMI-6690 / SMI-6685 — the PG-FREE half of the SMI-6651
 * `release_private_registry_skill_content()` suite.
 *
 * WHICH HALF RUNS WHERE. `private-registry-content-release.pg.test.ts` is entirely wrapped in one
 * `describe.skipIf(noLiveTestPg)` (SMI-6651, ADR-162 §1), because nearly everything in it is a
 * PRIVILEGE or TRANSACTIONAL property only a real Postgres catalog can prove. This file needs no
 * database — it only reads migration text — so it has NO `skipIf` and runs unconditionally,
 * matching the precedent of `../private-registry-audit-trigger.static.test.ts`. Before SMI-6690
 * these assertions lived inside that `skipIf` and were skipped for a reason that never applied to
 * them, which is how PR #2862 reported 40/40 checks green while they never executed.
 *
 * THIS IS A TRIPWIRE, NOT A SECURITY PROOF. It forces a human to look at any change to the step-4
 * re-read. It cannot prove the predicates are EFFECTIVE — that property is transactional, and the
 * behavioural proof for it is tracked in SMI-6685 (it needs the live test Postgres that SMI-5946
 * provisions). Do not read a green run here as proof that a tenant cannot read another tenant's
 * content.
 *
 * WHY AN EXACT-TEXT PIN RATHER THAN `toContain` PER PREDICATE (SMI-6685). A substring check is a
 * lexical stand-in for a semantic property, and two review rounds found it blind in two different
 * ways. Measured: `AND prs.deprecated = false OR TRUE` leaves every predicate substring intact
 * while `AND` binding tighter than `OR` turns the whole WHERE clause into an unconditional match —
 * every `toContain` passed and every `.not.toContain` passed, against a migration whose tenant
 * guard was disabled. A data-conditional disjunct (`OR prs.review_note = '...'`) and a
 * session-GUC-gated one are invisible to substring checks too, and both were proven exploitable.
 * Pinning the WHOLE statement catches all of them by construction, and — because it needs no
 * comment stripping, no anchor search and no slicing — it also deletes the three defects the
 * previous helper carried (no anchor-uniqueness guard; block comments that do not nest the way
 * Postgres nests them; no dollar-quote awareness) rather than documenting them in a header.
 *
 * Exact-text pinning is the right shape here specifically because this migration is already
 * applied to staging and production. Its text should never change again; if it does, a loud
 * failure is the correct outcome, not a tolerance.
 *
 * @module scripts/tests/supabase/private-registry-content-release.structural
 */

import { describe, it, expect } from 'vitest'
import { migrationSql } from './private-registry-content-release.test-helpers.ts'
import { brokenMigrationSql } from './private-registry-content-release.test-reverts.ts'

/** The step-4 content re-read, verbatim as shipped in
 *  `20260915000000_private_registry_content_release_rpc.sql`. Transcribed from the file's own
 *  bytes, not retyped from the rendered SQL — the indentation is load-bearing. */
const STEP4_REREAD =
  'SELECT prs.content INTO v_content\n' +
  '    FROM public.private_registry_skills prs\n' +
  '   WHERE prs.id = v_row.id\n' +
  '     AND prs.team_id = v_row.team_id\n' +
  "     AND prs.approval_status = 'approved'\n" +
  '     AND prs.deprecated = false;'

/** Occurrences of the shipped step-4 statement in a migration text. Deliberately a whole-string
 *  count: no extraction, no comment handling, nothing that can disagree with Postgres. */
function countStep4(sql: string): number {
  return sql.split(STEP4_REREAD).length - 1
}

describe('SMI-6651/SMI-6690 — release_private_registry_skill_content() step-4 re-read (PG-free)', () => {
  it('the shipped migration contains the step-4 re-read exactly once, byte-for-byte', () => {
    const count = countStep4(migrationSql())
    // Exactly once, not merely at-least-once: a second copy would mean the statement this pin
    // describes is no longer the only one, and a reader could no longer tell which one runs.
    expect(count).toBe(1)
  })

  it.each([
    ['i', 'team_id re-pin deleted'],
    ['m', 'team_id re-pin commented out'],
    ['n', 'approval_status commented out'],
    ['o', 'deprecated commented out'],
  ] as const)('a step-4 mutation is detected: %s (%s)', (variant) => {
    // Commenting a predicate out rather than deleting it is the specific bypass that defeated the
    // raw substring check: `-- AND prs.team_id = ...` still contains `AND prs.team_id = ...`.
    // A whole-statement pin is immune — any edit at all changes the text.
    expect(countStep4(brokenMigrationSql(variant))).toBe(0)
  })

  it('a change confined to step 2 leaves the step-4 pin quiet (the pin is scoped, not a file checksum)', () => {
    // Variant d drops the deprecated predicate from step 2's lookup and does not touch step 4.
    // Without this case the pin above would be indistinguishable from "the migration file changed
    // at all", which would make it fire on unrelated edits and get disabled.
    expect(countStep4(brokenMigrationSql('d'))).toBe(1)
  })
})
