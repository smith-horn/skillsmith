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
 * TWO MECHANISMS IN UNION, NEITHER GATING THE OTHER (SMI-6690 round 9). `mentionsIdentifier`
 * (`../lib/sql-name-tripwire.ts`) reads no grammar, so it catches a DROP inside `DO $$ ... $$`, a
 * non-ASCII or keyword list head, comment fusion and a three-part name. The three matchers in
 * `../lib/sql-verb-matchers.ts` read the statement, so they catch a plain
 * `DROP FUNCTION public.<fn>;` even when the tripwire has lost the name. A hit from EITHER is an
 * offender. An earlier version gated the matchers behind the tripwire, and one stray `"` inside an
 * unrelated `DO` block then silenced row one of this guard's own case table.
 *
 * WHAT NO TEXT-BASED GUARD CAN DO, measured on PG 17.11 — accepted by the engine, and the function
 * actually dropped. This is fail-closed over TEXT, not over EFFECTS, in two distinct ways.
 *
 * The name can be ABSENT from the migration's text, and then nothing here can see it:
 *
 *   - runtime assembly — `EXECUTE 'DROP FUNCTION public.rele' || 'ase_...'`;
 *   - the name as a PARAMETER — `EXECUTE format('DROP FUNCTION public.%I(uuid,uuid)', n)`, the very
 *     construct that motivated abandoning grammar-parsing, and equally out of reach for the
 *     tripwire;
 *   - catalog-driven drops — a loop over `pg_proc` that never spells the name;
 *   - collateral removal that names nothing — `DROP SCHEMA public CASCADE;`.
 *
 * And a name that IS present and contiguous can still be missed. Three were, each by one exotic
 * character — `İ` (U+0130) desynchronising an index space, a byte-based dollar tag like `$٣$`, a
 * comment on the far side of `UESCAPE` — and each is fixed (SMI-6690 round 10). They are recorded
 * because they show the KIND of thing that defeats a text scan, not because the list is closed.
 *
 * So a clean scan here means "no spelling the tokenizer models was found," never "the name is not
 * in this file." Only a live-catalog assertion closes the gap:
 * `private-registry-content-release.pg.test.ts` once SMI-5946 provisions Postgres in CI, tracked
 * for this function in SMI-6685. Do not describe this file as proof that no unreviewed change can
 * happen.
 *
 * @module scripts/tests/supabase/private-registry-content-release.structural
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NEW_MIGRATION,
  migrationSql,
  migrationTextLocked,
} from './private-registry-content-release.test-helpers.ts'
import { brokenMigrationSql } from './private-registry-content-release.test-reverts.ts'
import { laterMigrationFiles, readMigrationText } from '../lib/migration-text-guards.ts'
import { splitStatements, stripComments } from '../lib/sql-statement-guards.ts'
import {
  matchesAlterFunction,
  matchesCreateFunction,
  matchesDropFunction,
} from '../lib/sql-verb-matchers.ts'
import { mentionsIdentifier } from '../lib/sql-name-tripwire.ts'

// Directories `mkdtempSync` creates below for the positive control (SMI-6690 finding F7): tracked
// here and removed in `afterEach` rather than left on disk -- one per planted case, unbounded
// over time otherwise. (An earlier version of this line said "7 per CI run"; measured, it is 3 --
// one `mkdtempSync` call site inside a three-element loop. SMI-6712's class, in a code comment.)
const tempDirs: string[] = []

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
 * THE OFFENDER DECISION IS A UNION of `mentionsIdentifier` (`../lib/sql-name-tripwire.ts`) and the
 * three verb matchers (`../lib/sql-verb-matchers.ts`), NEITHER gating the other — see this
 * module's header. The tripwire is fail-closed over executable text and fires on the bare name
 * appearing anywhere in it, including inside a `DO $$ ... $$` block no grammar-based matcher can
 * read; the matchers read one statement at a time and catch a plain top-level DROP the tripwire
 * can lose. Both run unconditionally (comments stripped, split via `splitStatements` —
 * this repo's migration convention includes commented-out rollback blocks naming the function,
 * `20260915000000` has one, and whole-file text let a differently-shaped statement elsewhere in
 * the file produce a false positive or negative), to NAME which verb was seen. Their own silence
 * never suppresses a firing tripwire: a mention with no recognised verb still reports, worded to
 * say so — the correct behaviour for, e.g., a `COMMENT ON FUNCTION` naming the function, which is
 * exactly what `20260915000001_private_registry_release_rpc_comment_fix.sql` does, a genuine
 * tripwire hit the owner reviewed and accepted rather than something this scan should silence.
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
    // UNION, NOT A GATE (SMI-6690 round 9). Both mechanisms run unconditionally and a hit from
    // EITHER is an offender, because each covers a blind spot of the other:
    //   - the tripwire reads no grammar, so it sees a DROP inside `DO $$ ... $$`, a non-ASCII or
    //     keyword list head, comment fusion and a three-part name -- none of which the matchers do;
    //   - the matchers read the statement, so they still see a plain `DROP FUNCTION public.<fn>;`
    //     when the tripwire has lost the name.
    // Gating the matchers behind the tripwire regressed exactly that: one stray `"` inside an
    // unrelated `DO` block makes the tripwire's re-tokenisation swallow the rest of the file, and a
    // plain top-level DROP -- row one of this guard's own case table -- went silent. Round 7 caught
    // it; round 8 did not. Neither mechanism may suppress the other.
    const statements = splitStatements(stripComments(raw))
    const verbs: string[] = []
    if (statements.some((s) => matchesCreateFunction(s, FUNCTION_NAME)))
      verbs.push('CREATE FUNCTION')
    if (statements.some((s) => matchesDropFunction(s, FUNCTION_NAME))) verbs.push('DROP FUNCTION')
    if (statements.some((s) => matchesAlterFunction(s, FUNCTION_NAME))) verbs.push('ALTER FUNCTION')
    if (verbs.length > 0) {
      for (const verb of verbs) offenders.push(`${file}: ${verb}`)
    } else if (mentionsIdentifier(raw, FUNCTION_NAME)) {
      offenders.push(
        `${file}: ${FUNCTION_NAME} appears in executable SQL without a recognised CREATE/DROP/` +
          'ALTER FUNCTION verb -- review manually'
      )
    }
  }
  return { scanned, offenders }
}

describe.skipIf(migrationTextLocked())(
  'SMI-6651/SMI-6690 — release_private_registry_skill_content() step-4 re-read (PG-free)',
  () => {
    afterEach(() => {
      for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    })

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

      // ONE KNOWN, REVIEWED HIT — asserted rather than allowlisted (SMI-6690 round 5+).
      //
      // The fail-closed tripwire fires on the function name appearing in executable SQL at all, so
      // it fires on `20260915000001_..._comment_fix.sql`, which carries
      // `COMMENT ON FUNCTION public.<fn>(...) IS '...'`. That is a real reviewed catalog-comment
      // correction, and it is the same file this module's header cites as the precedent for
      // shipping corrections as follow-up migrations — so this hit recurs by convention, not by
      // accident.
      //
      // Pinning the exact offender string is the RESIDUAL ASSERTION this scan's own doc requires
      // instead of a bare skip: the file stays scanned, and the message names every verb found, so
      // adding a CREATE/DROP/ALTER to it changes the string and fails here. An allowlist entry
      // would instead silence every assertion about the file (the round-4 finding). Red-tested by
      // planting a DROP into a copy of this migration: the assertion fails.
      expect(offenders).toEqual([
        `20260915000001_private_registry_release_rpc_comment_fix.sql: ${FUNCTION_NAME} appears in ` +
          'executable SQL without a recognised CREATE/DROP/ALTER FUNCTION verb -- review manually',
      ])

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
        tempDirs.push(dir)
        writeFileSync(join(dir, NEW_MIGRATION), '-- pinned migration, plaintext\n')
        writeFileSync(join(dir, '29999999999999_planted_tamper.sql'), sql)
        const { scanned, offenders } = tamperViolations(dir)
        expect(scanned, verb).toEqual(['29999999999999_planted_tamper.sql'])
        // EXACT equality, not `toContain` (SMI-6690 post-merge retro). The tripwire's no-verb
        // fallback message reads "...without a recognised CREATE/DROP/ALTER FUNCTION verb...",
        // which CONTAINS the literal `ALTER FUNCTION`. So a substring assertion on the ALTER row
        // was satisfied by that fallback, and stubbing `matchesAlterFunction` to false left the
        // whole suite green — measured. `CREATE FUNCTION` and `DROP FUNCTION` are not substrings
        // of it, so only one of the three rows was decorative, and it was not the one the
        // author's own red-test mutated.
        expect(offenders, verb).toEqual([`29999999999999_planted_tamper.sql: ${verb}`])
      }
    })
  }
)
