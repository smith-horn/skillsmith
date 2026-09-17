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
 * ciphertext, not SQL, and `post-merge-verify.yml` runs locked by design. An UNEXPECTED lock
 * throws rather than skipping, so a real unlock failure cannot hide inside the skip.
 *
 * ONE LANE THIS GATE DOES NOT RESCUE, stated because deleting the claim was worse than correcting
 * it (SMI-6690 round 4). `ci.yml`'s `Test (root)` also runs locked on fork and dependabot PRs —
 * its unlock step is gated on `GIT_CRYPT_KEY != ''`, and those PRs get no secret — but it never
 * sets `SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED`, which is set in exactly one workflow repo-wide
 * (`post-merge-verify.yml`). So in that lane the gate does not skip; it throws.
 *
 * The LANE is pre-existing. An earlier version of this paragraph said the throw was too, which
 * was wrong (SMI-6690 retro, finding 4): before SMI-6690 nothing read migration text at module
 * scope, so that lane skipped cleanly via `describe.skipIf(noLiveTestPg)`, and the eager `const`
 * this suite introduced turned a clean skip into an import-time failure that took `.pg.test.ts`
 * down with it — a file that reads no migration text of its own. `migrationTextLocked` is now a
 * function, so the throw is scoped to the suites that actually assert on that text and
 * `.pg.test.ts` skips cleanly again. The lane still needs a decision on `ci.yml` — declare the
 * lock there, or exclude migration-text suites under `gitCryptLocked()` — tracked as SMI-6703.
 * Do not silently delete this paragraph to make the file read cleaner.
 *
 * THIS IS A TRIPWIRE, NOT A SECURITY PROOF. It forces a human to look at any change to the step-4
 * re-read. The full list of what it cannot prove — an enumeration, not a summary, because two
 * earlier versions of this list were wrong by omission:
 *
 *   1. Whether the predicates are EFFECTIVE. That property is transactional; the behavioural
 *      proof needs the live test Postgres SMI-5946 provisions, and is tracked in SMI-6685.
 *   2. A SECOND read of a skill body under a DIFFERENT table alias or into a different target
 *      variable. The exclusivity test below counts two token sequences, case- and
 *      whitespace-insensitively; it does not parse SQL, so an aliased read evades it.
 *   3. A NEW reader added by a later migration — a second `SECURITY DEFINER` function selecting
 *      `content`, or a plain `GRANT SELECT` on the table or its `content` column, either of which
 *      re-opens the whole vulnerability with no change to this function at all. Nothing here or
 *      in the audit-trigger suite scans for that; tracked as SMI-6702.
 *   4. A redefinition in a schema other than `public` that `search_path` happens to reach. Not
 *      scanned, and judged low-risk rather than closed: PostgREST resolves `/rpc/<name>` against
 *      its exposed schema, so reaching a shadow copy needs a second, non-migration change.
 *   5. Ordering by APPLY time rather than by filename version, and the same-prefix narrowing —
 *      both documented on `laterMigrationFiles` in `../lib/migration-text-guards.ts`.
 *
 * WHY AN EXACT-TEXT PIN RATHER THAN `toContain` PER PREDICATE (SMI-6685). A substring check is a
 * lexical stand-in for a semantic property, and two review rounds found it blind in two different
 * ways. Measured: `AND prs.deprecated = false OR TRUE` leaves every predicate substring intact
 * while `AND` binding tighter than `OR` turns the whole WHERE clause into an unconditional match —
 * every `toContain` passed and every `.not.toContain` passed, against a migration whose tenant
 * guard was disabled. Pinning the whole statement catches every mutation OF THAT STATEMENT by
 * construction, and — needing no comment stripping, no anchor search and no slicing — it also
 * deleted three defects the previous helper carried (no anchor-uniqueness guard; block comments
 * that do not nest the way Postgres nests them; no dollar-quote awareness).
 *
 * WHY EXACT TEXT IS SAFE TO PIN. Not because the text cannot change — it can, and a purely
 * cosmetic reindentation of these six lines fails this suite. It is safe because applied
 * migrations are never edited in this repo: corrections ship as a follow-up migration, and
 * `20260915000001_private_registry_release_rpc_comment_fix.sql` is the precedent. The text is
 * frozen by CONVENTION, not by nature, and a loud failure on any change is the forcing function.
 *
 * WHY THE TAMPER SCAN IS IMPORTED RATHER THAN WRITTEN HERE. A hand-rolled version passed all
 * eight tests against a later migration that redefined the RPC with the tenant, approval and
 * deprecation predicates removed; it also matched only `CREATE`, so `ALTER FUNCTION … RESET ALL`
 * — which strips the pinned `search_path` off a `SECURITY DEFINER` function, the exact hazard this
 * migration's own smoke block guards — was invisible.
 *
 * So use `matchesCreateFunction`/`matchesDropFunction`/`matchesAlterFunction` from
 * `../lib/sql-statement-guards.ts`, one statement at a time, and do not re-derive them here. Four
 * consecutive rounds of bypasses, and the measurements behind each, are recorded on SMI-6690.
 *
 * @module scripts/tests/supabase/private-registry-content-release.structural
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NEW_MIGRATION,
  migrationSql,
  migrationTextLocked,
} from './private-registry-content-release.test-helpers.ts'
import { brokenMigrationSql } from './private-registry-content-release.test-reverts.ts'
import { laterMigrationFiles, readMigrationText } from '../lib/migration-text-guards.ts'
import {
  matchesAlterFunction,
  matchesCreateFunction,
  matchesDropFunction,
  splitStatements,
  stripComments,
} from '../lib/sql-statement-guards.ts'

const FUNCTION_NAME = 'release_private_registry_skill_content'

/** The step-4 content re-read, verbatim as shipped in `NEW_MIGRATION`. Transcribed from the
 *  file's own bytes, not retyped from the rendered SQL — the indentation is load-bearing. */
const STEP4_REREAD =
  'SELECT prs.content INTO v_content\n' +
  '    FROM public.private_registry_skills prs\n' +
  '   WHERE prs.id = v_row.id\n' +
  '     AND prs.team_id = v_row.team_id\n' +
  "     AND prs.approval_status = 'approved'\n" +
  '     AND prs.deprecated = false;'

/** Reads a skill body into a variable. Case- and whitespace-insensitive because Postgres is both,
 *  and a literal `String.split` count is neither — one extra space or a lowercase keyword defeated
 *  the previous literal counters (SMI-6690 round 3, finding F3). */
const READS_CONTENT_RE = /select\s+prs\s*\.\s*content\b/gi
const WRITES_V_CONTENT_RE = /\binto\s+v_content\b/gi

/**
 * Later migrations that redefine, drop or alter the RPC.
 *
 * NO ALLOWLIST, deliberately (SMI-6690 round 4). An earlier version had a
 * `REVIEWED_LATER_MIGRATIONS` array and a comment claiming it "exempts a file from the VIOLATION
 * scan only, never from the pin." That was false: the pin reads `migrationSql()`, which is
 * `NEW_MIGRATION` and nothing else, so a later migration's text never reaches it. Allowlisting a
 * filename silenced EVERY assertion about that file — an off-switch with no residual assertion.
 * The comment also claimed to match the audit-trigger precedent, which in fact has no allowlist
 * skip on its tamper scan at all; only its three softer scans honour one. So the file adopted
 * exactly the shape its own comment said the precedent rejects, and then claimed the precedent's
 * protection. If a reviewed redefinition ever needs to land, add a residual assertion against the
 * LATEST definition first — do not reintroduce a bare skip.
 *
 * Comments are stripped and text is split into statements before matching (SMI-6690) — this
 * repo's migration convention includes commented-out rollback blocks naming the function
 * (`20260915000000` has one), and testing whole-file text let a differently-shaped statement
 * elsewhere in the file produce a false positive or negative.
 */
function tamperViolations(dir?: string): { scanned: string[]; offenders: string[] } {
  // `dir` exists so a test can plant a known tampering migration and require this to name it —
  // a clean scan over the real tree is only evidence if the scan is known to be able to fail
  // (SMI-6690). Both helpers default the directory, so `undefined` reads the real one.
  const scanned = laterMigrationFiles(NEW_MIGRATION, dir)
  const offenders: string[] = []
  for (const file of scanned) {
    const raw = readMigrationText(file, dir)
    // The suite gate proved NEW_MIGRATION is plaintext, so a ciphertext sibling means an
    // inconsistent tree rather than a normal locked checkout. readMigrationText() has already
    // thrown if the lock was undeclared; a null here is a declared lock, which cannot happen
    // alongside a readable NEW_MIGRATION.
    if (raw === null) {
      offenders.push(`${file}: git-crypt ciphertext while ${NEW_MIGRATION} is plaintext`)
      continue
    }
    const statements = splitStatements(stripComments(raw))
    if (statements.some((s) => matchesCreateFunction(s, FUNCTION_NAME))) {
      offenders.push(`${file}: CREATE FUNCTION`)
    }
    if (statements.some((s) => matchesDropFunction(s, FUNCTION_NAME))) {
      offenders.push(`${file}: DROP FUNCTION`)
    }
    if (statements.some((s) => matchesAlterFunction(s, FUNCTION_NAME))) {
      offenders.push(`${file}: ALTER FUNCTION`)
    }
  }
  return { scanned, offenders }
}

describe.skipIf(migrationTextLocked())(
  'SMI-6651/SMI-6690 — release_private_registry_skill_content() step-4 re-read (PG-free)',
  () => {
    it('the shipped migration contains the step-4 re-read exactly once, byte-for-byte', () => {
      const sql = migrationSql()
      const anchor = sql.indexOf('SELECT prs.content INTO v_content')
      const end = anchor === -1 ? -1 : sql.indexOf(';', anchor)
      // A bare count gives "expected 0 to be 1", from which a reader cannot tell a removed
      // predicate from a reindent — and this file's whole purpose is to make a human look. Each
      // arm is named, because an unterminated statement silently produced an EMPTY diagnostic in
      // the first version of this message (round-3 finding F6).
      const nearest =
        anchor === -1
          ? '(anchor not found at all)'
          : end === -1
            ? '(anchor found, but the statement is unterminated — no semicolon follows)'
            : sql.slice(anchor, end + 1)
      expect(
        sql.split(STEP4_REREAD).length - 1,
        `step-4 re-read not found verbatim. Nearest actual text:\n${nearest}`
      ).toBe(1)
    })

    it('nothing else in the migration reads a skill body', () => {
      // Presence-of-good must be paired with absence-of-other, or the pin above is one-sided: it
      // counts the good statement and cannot see an unguarded re-read APPENDED beside it. Two
      // token sequences, because they catch different shapes.
      const sql = migrationSql()
      expect(
        sql.match(READS_CONTENT_RE)?.length ?? 0,
        'a second read of prs.content was added'
      ).toBe(1)
      expect(
        sql.match(WRITES_V_CONTENT_RE)?.length ?? 0,
        'a second write into v_content was added'
      ).toBe(1)
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
      expect(brokenMigrationSql(variant).split(STEP4_REREAD).length - 1).toBe(0)
    })

    it('a change confined to step 2 leaves the step-4 pin quiet (the pin is scoped, not a file checksum)', () => {
      // Variant d drops the deprecated predicate from step 2's lookup and does not touch step 4.
      // Without this case the pin above would be indistinguishable from "the migration file
      // changed at all", which would make it fire on unrelated edits and get disabled.
      expect(brokenMigrationSql('d').split(STEP4_REREAD).length - 1).toBe(1)
    })

    it('no later migration redefines, drops or alters the RPC', () => {
      // The pin reads ONE file, so a later migration replacing the function leaves it
      // byte-identical. Amending a shipped function via a follow-up migration is this repo's
      // established pattern, so this is the likely vector rather than a hypothetical one — and
      // `ALTER FUNCTION` needs no redefinition at all to strip the pinned search_path off a
      // SECURITY DEFINER function.
      const { scanned, offenders } = tamperViolations()
      expect(offenders).toEqual([])
      // A clean scan over an EMPTY set proves nothing, and this assertion passed identically over
      // 1 file and over 0 when it was first written (SMI-6690 retro, finding 5). Zero is reachable
      // only if the pinned migration becomes the newest one, or if laterMigrationFiles() regressed
      // its prefix parsing. Either way, say so rather than reporting a green.
      expect(scanned.length, 'the tamper scan had no later migrations to scan').toBeGreaterThan(0)
    })

    it('positive control: the scan names a planted tampering migration', () => {
      // `scanned.length > 0` above proves only that filenames were ENUMERATED. This proves the
      // scan can fail, which is what makes the clean result above meaningful: it drives the whole
      // path — enumeration, the git-crypt read, comment stripping, statement splitting and the
      // matchers — and requires each tamper verb to be reported (SMI-6690 retro, finding 5).
      const planted: Array<[string, string]> = [
        [
          'CREATE FUNCTION',
          `CREATE OR REPLACE FUNCTION public.${FUNCTION_NAME}(a text)\n` +
            ` RETURNS void AS $$ SELECT 1 $$ LANGUAGE sql;`,
        ],
        // The quoted `;` spelling is the delimiter forgery a `[^;]`-bounded regex missed.
        ['DROP FUNCTION', `DROP FUNCTION IF EXISTS "a;b", public.${FUNCTION_NAME};`],
        ['ALTER FUNCTION', `ALTER FUNCTION public.${FUNCTION_NAME} RESET ALL;`],
      ]
      for (const [verb, sql] of planted) {
        const dir = mkdtempSync(join(tmpdir(), 'smi6690-tamper-'))
        writeFileSync(join(dir, NEW_MIGRATION), '-- pinned migration, plaintext\n')
        writeFileSync(join(dir, '29999999999999_planted_tamper.sql'), sql)
        const { scanned, offenders } = tamperViolations(dir)
        expect(scanned, verb).toEqual(['29999999999999_planted_tamper.sql'])
        expect(offenders.join(' | '), verb).toContain(verb)
      }
    })
  }
)
