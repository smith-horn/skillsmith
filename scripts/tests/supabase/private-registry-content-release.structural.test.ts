/**
 * SMI-6690 / SMI-6685 — the PG-FREE half of the SMI-6651
 * `release_private_registry_skill_content()` suite.
 *
 * WHICH HALF RUNS WHERE. `private-registry-content-release.pg.test.ts` is entirely wrapped in one
 * `describe.skipIf(noLiveTestPg)` (SMI-6651, ADR-162 §1), because nearly everything in it is a
 * PRIVILEGE or TRANSACTIONAL property only a real Postgres catalog can prove. This file needs no
 * database — it only reads migration text — so it carries NO Postgres gate. Before SMI-6690 these
 * assertions lived inside that `skipIf` and were skipped for a reason that never applied to them,
 * which is how PR #2862 reported 40/40 checks green while they never executed.
 *
 * It does carry ONE gate, and it is not the Postgres one: `migrationTextLocked` (SMI-5984).
 * `supabase/migrations/` is git-crypt-scoped, so on a locked checkout the file this suite reads is
 * ciphertext, not SQL. `post-merge-verify.yml` runs locked by design, and `Test (root)` runs
 * locked on fork/dependabot PRs where the unlock step is gated on a secret — without the gate this
 * suite fails there with a message that reads as migration drift rather than as a lock state. An
 * UNEXPECTED lock throws rather than skipping, so a real unlock failure cannot hide inside the
 * skip. This is the same contract every sibling migration-text suite honors, including
 * `../private-registry-audit-trigger.static.test.ts`, the precedent this file follows.
 *
 * THIS IS A TRIPWIRE, NOT A SECURITY PROOF. It forces a human to look at any change to the step-4
 * re-read. What it cannot prove, stated precisely rather than as one sweeping caveat, because two
 * of these three are TEXT-scope gaps that no amount of live Postgres would close (SMI-6690
 * governance round 2):
 *
 *   1. Whether the predicates are EFFECTIVE. That property is transactional; the behavioural
 *      proof needs the live test Postgres SMI-5946 provisions, and is tracked in SMI-6685.
 *   2. A SECOND read of a skill body added beside the pinned one. The pin counts occurrences of
 *      the good statement; it cannot see an addition. Measured bypass, which passed the pin and
 *      all four mutation cases: leave the pinned statement byte-identical and append
 *      `IF v_content IS NULL THEN SELECT prs.content INTO v_content ... WHERE prs.id = v_row.id;`
 *      — an unguarded re-read for exactly the rows the tenant guard rejected, and the realistic
 *      shape someone adds after a null-body bug report. Closed below by the exclusivity test,
 *      but only for the two spellings it counts: a read using a different table alias or a
 *      different target variable still evades it.
 *   3. A LATER migration replacing the function. `migrationSql()` reads ONE hardcoded filename,
 *      so a `...000002` doing `CREATE OR REPLACE FUNCTION` without the tenant predicate leaves
 *      `...000000` byte-identical. Closed below by the later-migration scan.
 *
 * WHY AN EXACT-TEXT PIN RATHER THAN `toContain` PER PREDICATE (SMI-6685). A substring check is a
 * lexical stand-in for a semantic property, and two review rounds found it blind in two different
 * ways. Measured: `AND prs.deprecated = false OR TRUE` leaves every predicate substring intact
 * while `AND` binding tighter than `OR` turns the whole WHERE clause into an unconditional match —
 * every `toContain` passed and every `.not.toContain` passed, against a migration whose tenant
 * guard was disabled. Pinning the whole statement catches every mutation OF THAT STATEMENT by
 * construction, and — needing no comment stripping, no anchor search and no slicing — it also
 * deleted three defects the previous helper carried (no anchor-uniqueness guard; block comments
 * that do not nest the way Postgres nests them; no dollar-quote awareness) rather than documenting
 * them in a header.
 *
 * WHY EXACT TEXT IS SAFE TO PIN. Not because the text cannot change — it can, and a purely
 * cosmetic reindentation of these six lines fails this suite. It is safe because applied
 * migrations are never edited in this repo: corrections ship as a follow-up migration, and
 * `20260915000001_private_registry_release_rpc_comment_fix.sql` is the precedent (it corrects this
 * function's catalog comments and contains no `CREATE OR REPLACE FUNCTION`). So the text is frozen
 * by CONVENTION, not by nature, and a loud failure on any change to it is the intended forcing
 * function rather than a tolerance being violated.
 *
 * @module scripts/tests/supabase/private-registry-content-release.structural
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  MIGRATIONS_DIR,
  NEW_MIGRATION,
  migrationSql,
  migrationTextLocked,
} from './private-registry-content-release.test-helpers.ts'
import { brokenMigrationSql } from './private-registry-content-release.test-reverts.ts'

/** The step-4 content re-read, verbatim as shipped in `NEW_MIGRATION`. Transcribed from the
 *  file's own bytes, not retyped from the rendered SQL — the indentation is load-bearing. */
const STEP4_REREAD =
  'SELECT prs.content INTO v_content\n' +
  '    FROM public.private_registry_skills prs\n' +
  '   WHERE prs.id = v_row.id\n' +
  '     AND prs.team_id = v_row.team_id\n' +
  "     AND prs.approval_status = 'approved'\n" +
  '     AND prs.deprecated = false;'

const GIT_CRYPT_MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54])

const REDEFINES_RPC =
  /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?release_private_registry_skill_content/i

/** Migrations ordered after `NEW_MIGRATION` that a human has read and confirmed keep the step-4
 *  tenant guard intact. Add a FILENAME here after reading its diff — never weaken `REDEFINES_RPC`
 *  to make this suite pass. Same by-name allowlist discipline as
 *  `../private-registry-audit-trigger.static.test.ts`'s `REVIEWED_LATER_MIGRATIONS`.
 *
 *  `20260915000001` is deliberately absent: it corrects catalog comments only and contains no
 *  `CREATE OR REPLACE FUNCTION`, so it never matches in the first place. A file belongs here only
 *  if it DOES redefine the function. */
const REVIEWED_LATER_MIGRATIONS: readonly string[] = []

/** Occurrences of a literal in a migration text. Deliberately a whole-string count: no
 *  extraction, no comment handling, nothing that can disagree with Postgres. */
function count(sql: string, literal: string): number {
  return sql.split(literal).length - 1
}

/** Migrations after the pinned one that redefine the RPC and have not been reviewed by name. */
function unreviewedLaterRedefinitions(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && f > NEW_MIGRATION)
    .filter((f) => !REVIEWED_LATER_MIGRATIONS.includes(f))
    .filter((f) => {
      const raw = readFileSync(join(MIGRATIONS_DIR, f))
      if (raw.subarray(0, GIT_CRYPT_MAGIC.length).equals(GIT_CRYPT_MAGIC)) {
        // The suite gate proved NEW_MIGRATION is plaintext, so a ciphertext sibling is an
        // inconsistent tree, not a normal locked checkout. Fail loudly: a locked later migration
        // could redefine the RPC unseen, which is the whole gap this test exists to close.
        throw new Error(
          `${f} is git-crypt ciphertext while ${NEW_MIGRATION} is plaintext — inconsistent tree ` +
            'state; a locked later migration could redefine the RPC unseen (SMI-6690).'
        )
      }
      return REDEFINES_RPC.test(raw.toString('utf8'))
    })
}

describe.skipIf(migrationTextLocked)(
  'SMI-6651/SMI-6690 — release_private_registry_skill_content() step-4 re-read (PG-free)',
  () => {
    it('the shipped migration contains the step-4 re-read exactly once, byte-for-byte', () => {
      const sql = migrationSql()
      const anchor = sql.indexOf('SELECT prs.content INTO v_content')
      // The bare count gives "expected 0 to be 1", from which a reader cannot tell a removed
      // predicate from a reindent — and this file's whole purpose is to make a human look.
      // Print the nearest actual text so the failure is readable without a diff hunt.
      const nearest =
        anchor === -1
          ? '(anchor not found at all)'
          : sql.slice(anchor, sql.indexOf(';', anchor) + 1)
      expect(
        count(sql, STEP4_REREAD),
        `step-4 re-read not found verbatim. Nearest actual text:\n${nearest}`
      ).toBe(1)
    })

    it('nothing else in the migration reads a skill body', () => {
      // Presence-of-good must be paired with absence-of-other, or the pin above is one-sided: it
      // counts the good statement and cannot see an unguarded re-read APPENDED beside it. Two
      // spellings, because they catch different shapes — a second `SELECT prs.content` under any
      // target variable, and a second sink into `v_content` under any table alias.
      const sql = migrationSql()
      expect(count(sql, 'SELECT prs.content'), 'a second read of prs.content was added').toBe(1)
      expect(count(sql, 'INTO v_content'), 'a second write into v_content was added').toBe(1)
    })

    it.each([
      ['i', 'team_id re-pin deleted'],
      ['m', 'team_id re-pin commented out'],
      ['n', 'approval_status commented out'],
      ['o', 'deprecated commented out'],
    ] as const)('a step-4 mutation is detected: %s (%s)', (variant) => {
      // Commenting a predicate out rather than deleting it is the specific bypass that defeated
      // the raw substring check: `-- AND prs.team_id = ...` still contains `AND prs.team_id = ...`.
      // A whole-statement pin is immune — any edit at all changes the text.
      expect(count(brokenMigrationSql(variant), STEP4_REREAD)).toBe(0)
    })

    it('a change confined to step 2 leaves the step-4 pin quiet (the pin is scoped, not a file checksum)', () => {
      // Variant d drops the deprecated predicate from step 2's lookup and does not touch step 4.
      // Without this case the pin above would be indistinguishable from "the migration file
      // changed at all", which would make it fire on unrelated edits and get disabled.
      expect(count(brokenMigrationSql('d'), STEP4_REREAD)).toBe(1)
    })

    it('no later migration redefines the RPC (the pin above reads one file only)', () => {
      // Without this, a `...000002` doing CREATE OR REPLACE FUNCTION without the tenant predicate
      // leaves NEW_MIGRATION byte-identical and every other test here green. Amending a shipped
      // function via a follow-up migration is this repo's established pattern, so this is the
      // likely vector rather than a hypothetical one.
      expect(unreviewedLaterRedefinitions()).toEqual([])
    })
  }
)
