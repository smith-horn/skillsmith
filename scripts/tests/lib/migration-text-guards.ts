/**
 * Shared primitives for suites that assert on Postgres migration TEXT (SMI-6690).
 *
 * WHY THIS MODULE EXISTS. `private-registry-audit-trigger.static.test.ts` worked out, over several
 * adversarial review rounds, what a migration-text guard has to handle: git-crypt lock state as a
 * three-way outcome, enumeration of ALL migrations rather than one pinned filename, identifier
 * matching that tolerates the spellings Postgres treats as equivalent, and tamper verbs beyond
 * `CREATE`. A second suite then re-implemented the same guard by hand and omitted one of those
 * four in each of three consecutive review rounds — the lock gate, then the all-migrations scan,
 * then identifier tolerance and the non-`CREATE` verbs. The third omission was measured as an
 * end-to-end bypass: a later migration redefining the guarded function with its tenant predicate
 * removed, spelled `"public"."fn"`, passed every assertion.
 *
 * So the primitives live here once and both suites import them. A third suite asserting on
 * migration text should import them too rather than re-deriving them.
 *
 * WHAT IS DELIBERATELY NOT HERE: anything shaped by one function's own signature or body. The
 * audit-trigger suite's `DEF_RE` captures a header and a dollar-quoted body via backreference and
 * pins each to a SHA; that is specific to a zero-argument function and stays in that file.
 *
 * @module scripts/tests/lib/migration-text-guards
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const GIT_CRYPT_MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54])
export const EXPECT_LOCKED_ENV_VAR = 'SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED'
export const MIGRATIONS_DIR = 'supabase/migrations'

/**
 * Reads a migration, returning `null` when it is git-crypt ciphertext AND that was declared
 * expected, and THROWING when it is ciphertext and was not (SMI-5984).
 *
 * The three-way outcome is the point. `supabase/migrations/` is git-crypt-scoped, so a locked
 * checkout yields ciphertext rather than SQL: `post-merge-verify.yml` runs locked by design. A
 * caller that treated locked-and-undeclared as "just skip" would absorb a real unlock failure
 * into a green run, which is the failure class these suites exist to detect.
 */
export function readMigrationText(name: string, dir: string = MIGRATIONS_DIR): string | null {
  const raw = readFileSync(join(dir, name))
  if (raw.subarray(0, GIT_CRYPT_MAGIC.length).equals(GIT_CRYPT_MAGIC)) {
    if (process.env[EXPECT_LOCKED_ENV_VAR] !== '1') {
      throw new Error(
        `${name} is git-crypt-locked but ${EXPECT_LOCKED_ENV_VAR} is not set — treat as an unlock ` +
          'failure, not a lock-state edge case (SMI-5984).'
      )
    }
    return null
  }
  return raw.toString('utf8')
}

/** Every `.sql` migration, filename-sorted. */
export function allMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/**
 * Every migration whose numeric prefix is strictly greater than `pinnedFile`'s.
 *
 * Numeric, not lexicographic: a plain string comparison is right only while every filename has
 * the same prefix width, and silently wrong the moment one does not.
 *
 * KNOWN RESIDUAL GAP, shared with the audit-trigger suite and accepted rather than solved: this
 * orders by the filename's declared version, not by APPLY order. A migration added later but
 * numbered earlier — `supabase db push` will apply a new `20260914…` after an already-applied
 * `20260915…` — sorts as "not later" and escapes the scan. Closing it needs the applied ledger
 * (`supabase_migrations.schema_migrations`), which is a live-database read these text-only suites
 * deliberately do not make.
 */
export function laterMigrationFiles(pinnedFile: string, dir: string = MIGRATIONS_DIR): string[] {
  const pinned = Number(pinnedFile.match(/^(\d+)/)?.[1] ?? NaN)
  if (Number.isNaN(pinned)) {
    throw new Error(`laterMigrationFiles: ${pinnedFile} has no numeric version prefix`)
  }
  return allMigrationFiles(dir).filter((f) => {
    const m = f.match(/^(\d+)/)
    return m !== null && Number(m[1]) > pinned
  })
}

/**
 * Regex source matching a `public`-qualified identifier the way Postgres resolves it: optional
 * schema qualification, optional double quotes on either part, and arbitrary whitespace around
 * the dot. `public.fn`, `"public"."fn"`, `"fn"`, and `public . fn` all name the same object, and a
 * guard that matches only the bare spelling is defeated by typing one of the others.
 */
export function qualifiedIdent(name: string): string {
  return String.raw`(?:"?public"?\s*\.\s*)?"?${name}"?`
}

/** `CREATE [OR REPLACE] FUNCTION <name>(` — any argument list, any case, any spelling. */
export function createFunctionRe(name: string): RegExp {
  return new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+${qualifiedIdent(name)}\s*\(`,
    'i'
  )
}

/** `DROP FUNCTION [IF EXISTS] <name>(` — removing the function is tampering too. */
export function dropFunctionRe(name: string): RegExp {
  return new RegExp(
    String.raw`DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?${qualifiedIdent(name)}\s*\(`,
    'i'
  )
}

/**
 * `ALTER FUNCTION <name>(` — the verb that needs no `CREATE`.
 *
 * `ALTER FUNCTION … RESET ALL` strips a pinned `search_path` from a `SECURITY DEFINER` function,
 * and `… SECURITY INVOKER` discards its privilege model. Both leave the function's own definition
 * text untouched, so a guard anchored on `CREATE` never sees them.
 */
export function alterFunctionRe(name: string): RegExp {
  return new RegExp(String.raw`ALTER\s+FUNCTION\s+${qualifiedIdent(name)}\s*\(`, 'i')
}
