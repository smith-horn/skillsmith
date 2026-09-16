/**
 * SMI-6114 / SMI-6680: migration-directory reading and ordering shared by the
 * private-registry-audit-trigger tripwire suite. Split out of the single ~1000-line test file
 * (SMI-6680 governance retro F1) so every non-test file here stays under the repo's 500-line gate.
 *
 * `dir` is threaded through every function here (default `MIGRATIONS_DIR`, the real directory) so
 * `private-registry-audit-trigger.detectors.test.ts` can point the whole detector pipeline at a
 * `mkdtempSync()` fixture directory instead -- the fix for SMI-6680 F1: every detector in
 * `private-registry-audit-trigger.detectors.ts` iterates `laterMigrationFiles()`, and what that
 * returns against the real directory changes every time a migration lands after the pinned one, so
 * a test pointed only at the real directory cannot give any detector a fixed, deterministic input
 * to react to. A fixture directory can. Follows the same pattern as `private-registry-rls.test.ts`'s
 * `loadPrivateRegistryMigration(dir = MIGRATIONS_DIR)`.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const MIGRATIONS_DIR = 'supabase/migrations'
export const MIGRATION_FILE = '20260913000000_private_registry_audit_trigger.sql'
export const PINNED_VERSION = Number(MIGRATION_FILE.match(/^(\d+)/)![1])
// Not git-crypt-scoped (only supabase/functions/ and supabase/migrations/ are), so this is always
// plaintext and needs no GIT_CRYPT_MAGIC handling of its own.
export const ROLLBACK_FILE =
  'supabase/rollbacks/20260913000000_private_registry_audit_trigger_down.sql'
export const GIT_CRYPT_MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54])
export const EXPECT_LOCKED_ENV_VAR = 'SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED'
export const FUNCTION_NAME = 'audit_private_registry_skills_change'

/** The 15 columns read from prod's information_schema on 2026-09-13. */
export const PROD_COLUMNS = [
  'id',
  'team_id',
  'skill_id',
  'version',
  'description',
  'content',
  'content_hash',
  'deprecated',
  'published_by',
  'published_at',
  'approval_status',
  'approval_mode',
  'approved_by',
  'approved_at',
  'review_note',
]

/**
 * Reads one migration file from `dir`, returning `null` (not throwing) on a git-crypt-locked file
 * when `SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED=1` -- see the module doc comment on the real suite in
 * `private-registry-audit-trigger.pins.test.ts` for the git-crypt contract (SMI-5984). Fixture
 * directories used by the F1 tripwire suite are always plaintext, so this branch never fires for
 * them.
 */
export function readMigration(name: string, dir: string = MIGRATIONS_DIR): string | null {
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

export function allMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/**
 * Every migration whose numeric-prefix version is strictly after MIGRATION_FILE's own.
 * A filename with no numeric prefix is NOT counted here -- see `unprefixedMigrationFiles()` below,
 * which fails closed on that case instead of this function silently treating it as "not later"
 * (SMI-6680 F6).
 */
export function laterMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return allMigrationFiles(dir).filter((f) => {
    const m = f.match(/^(\d+)/)
    return m !== null && Number(m[1]) > PINNED_VERSION
  })
}

/**
 * Every `.sql` migration filename with no leading numeric prefix. `laterMigrationFiles()` can't
 * order these against `PINNED_VERSION` (its regex match is `null`), so treating that as "not
 * later" would silently exempt an unprefixed file from all five detectors in
 * `private-registry-audit-trigger.detectors.ts` instead of failing closed the way every other
 * unparseable input in this suite does (SMI-6680 F6: `laterMigrationFiles()` previously treated
 * `m === null` as simply "not later" with no signal that the file was invisible, not merely
 * out-of-range). Asserted empty by an `it()` in the static test file; a real hit means the file
 * needs a numeric timestamp prefix before it can be reasoned about at all.
 */
export function unprefixedMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return allMigrationFiles(dir).filter((f) => f.match(/^(\d+)/) === null)
}
