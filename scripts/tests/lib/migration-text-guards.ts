/**
 * Git-crypt lock state and migration-file enumeration, for suites that assert on migration TEXT.
 *
 * WHY THIS MODULE EXISTS. `private-registry-audit-trigger.static.test.ts` worked out, over several
 * review rounds, what a migration-text guard needs: lock state as a three-way outcome, and
 * enumeration of ALL migrations rather than the one under test. A second suite re-implemented the
 * guard by hand and omitted one of those in each of three consecutive rounds. So the primitives
 * live here once; a third suite should import them too.
 *
 * SQL lexing and the by-name tamper matchers live in `./sql-statement-guards.ts` — a separate
 * module because nothing here depends on them and nothing there depends on this: migration
 * enumeration and SQL lexing are independent concerns, kept apart rather than combined into one
 * file (SMI-6690, SMI-6696).
 *
 * @module scripts/tests/lib/migration-text-guards
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Module-private on purpose (SMI-6690 retro, finding 2): a caller that needs the lock contract
// calls `readMigrationText`; a caller that needs these constants is re-implementing it.
const GIT_CRYPT_MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54])
const EXPECT_LOCKED_ENV_VAR = 'SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED'
const MIGRATIONS_DIR = 'supabase/migrations'

/**
 * Reads a migration, returning `null` when it is git-crypt ciphertext AND that was declared
 * expected, and THROWING when it is ciphertext and was not (SMI-5984). The three-way outcome is
 * the point: treating locked-and-undeclared as "just skip" would absorb a real unlock failure
 * into a green run.
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
 * Every migration whose numeric prefix is strictly greater than `pinnedFile`'s — numeric, not
 * lexicographic, since a plain string comparison breaks the moment filenames vary in width.
 *
 * KNOWN RESIDUAL GAPS, accepted rather than solved: orders by declared version, not APPLY order
 * (needs the live applied ledger, which these text-only suites deliberately do not read); a
 * sibling sharing `pinnedFile`'s exact numeric prefix is "not later" here even though a plain
 * `f > pinnedFile` would have scanned it.
 */
export function laterMigrationFiles(pinnedFile: string, dir: string = MIGRATIONS_DIR): string[] {
  const pinned = Number(pinnedFile.match(/^(\d+)/)?.[1] ?? NaN)
  if (Number.isNaN(pinned)) {
    throw new Error(`laterMigrationFiles: ${pinnedFile} has no numeric version prefix`)
  }
  const all = allMigrationFiles(dir)
  // Fail loudly rather than silently dropping an unversioned filename from every tamper scan
  // (SMI-6690 round 4, the same invisible-success class these suites exist to catch).
  const unversioned = all.filter((f) => !/^\d/.test(f))
  if (unversioned.length > 0) {
    throw new Error(
      `laterMigrationFiles: ${unversioned.join(', ')} have no numeric version prefix and cannot ` +
        'be ordered — they would be silently excluded from every tamper scan'
    )
  }
  return all.filter((f) => Number(f.match(/^(\d+)/)![1]) > pinned)
}
