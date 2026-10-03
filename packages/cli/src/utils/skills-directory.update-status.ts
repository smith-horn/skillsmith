/**
 * Update-status classification for installed skills (ADR-175 § 5, SMI-6946).
 *
 * Extracted from `skills-directory.ts` to stay under the 500-line standard once
 * the tri-state and its cause classification were added — the same reason
 * `skills-directory.hash-comparison.ts` exists. Both are re-exported from
 * `skills-directory.ts`, so call sites import from there unchanged.
 */
import { existsSync } from 'node:fs'
import { isCorruptDatabaseError, isCorruptionCode } from '@skillsmith/core'
import { sanitizePath } from './sanitize.js'

/** The one clause that names a corrupt database, so both callers agree. */
function corruptClause(path: string): string {
  return `the local database at ${sanitizePath(path)} is corrupt`
}

/**
 * Whether a newer version exists — or whether that could not be determined.
 *
 * This replaced a `boolean`, and the third state is the whole point: when the
 * database cannot be read, "no update available" is a claim we have no basis
 * for. The renderer printed that boolean's `false` as **"Up to date"**, so a
 * corrupt database made every installed skill report itself current, silently,
 * with exit code 0.
 *
 * A boolean cannot express this, which is why it is gone rather than kept
 * alongside — a surviving boolean is a second source of truth a reader can pick
 * up without noticing the distinction.
 *
 * - `available` — a newer version exists.
 * - `current` — checked, and nothing newer.
 * - `unknown` — could not be checked.
 */
export type UpdateStatus = 'available' | 'current' | 'unknown'

/**
 * Why the version lookup is unavailable — or `undefined` when its absence is
 * itself informative.
 *
 * The bare `catch {}` this replaces collapsed **five** distinct causes into one
 * `false`. Four of them reach THIS function, which classifies an OPEN failure:
 * a database that does not exist yet, one that is corrupt, one we lack
 * permission to read, and one locked by another process. A wrong schema is the
 * fifth cause and does NOT arrive here — a read-only open skips
 * `initializeSchema`, so it surfaces at query time and is classified by
 * `describeQueryFailure` instead. Only the absent case licenses "no updates
 * available" — nothing is installed that could be out of date. The other four leave the answer unknowable, and
 * reporting them as "up to date" is a positive false statement, which is the
 * defect SMI-6946 exists to remove.
 *
 * So `undefined` means *knowably nothing to report*, and a string means *could
 * not determine*. Note the direction: an unrecognised failure maps to
 * **unknown**, not to "fine". Better to say "could not check" about a cause we
 * failed to name than to assert currency we cannot support.
 */
export function classifyOpenFailure(error: unknown, dbPath: string): string | undefined {
  // The corruption refusal, matched on its stable code — never on the message
  // and never with `instanceof`, which is unreliable across duplicate copies of
  // @skillsmith/core between the CLI and the MCP server (ADR-175 § 7).
  if (isCorruptDatabaseError(error)) {
    return corruptClause(error.path)
  }

  const code = (error as { code?: unknown } | null | undefined)?.code
  const sqliteCode = typeof code === 'string' ? code : ''

  // A database that has not been created yet is the ONE benign case: there is
  // nothing installed whose currency we could be wrong about. If the file does
  // exist and still would not open, that is not benign.
  if (sqliteCode === 'SQLITE_CANTOPEN' || code === 'ENOENT') {
    return existsSync(dbPath)
      ? `the local database at ${sanitizePath(dbPath)} could not be opened`
      : undefined
  }

  if (sqliteCode.startsWith('SQLITE_BUSY')) {
    return `the local database at ${sanitizePath(dbPath)} is locked by another process`
  }
  if (sqliteCode.startsWith('SQLITE_READONLY') || sqliteCode.startsWith('SQLITE_PERM')) {
    return `the local database at ${sanitizePath(dbPath)} could not be read`
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `the local database at ${sanitizePath(dbPath)} is not readable`
  }

  return `the local database at ${sanitizePath(dbPath)} could not be queried`
}

/**
 * Why a per-skill version lookup failed, after the open already succeeded.
 *
 * Separate from `classifyOpenFailure` because the inputs differ: by this point
 * the database opened, so `CorruptDatabaseError` — constructed only by the
 * driver's pre-open probe — cannot appear. What CAN appear is a raw SQLite
 * error whose code says the file is corrupt, which is the case
 * `openCliDatabase` documents as "a corrupt page only read once the schema
 * queries run."
 *
 * Classified on the code via the shared `isCorruptionCode`, so this agrees with
 * the driver's own classification instead of re-deriving it. There is no
 * benign case here: the open succeeded, so a failing query is always
 * unknowable rather than informative.
 */
/**
 * Resolve one skill's update status, given a version lookup that may fail.
 *
 * Lives here rather than inline in `getSkillsFromDirectory` because it is
 * status logic and because that file is at its length limit — the fourth
 * extraction from it for that reason.
 *
 * `lookup` performs the comparison and returns whether a newer version exists.
 * It is passed as a callback so this function owns the *classification* without
 * owning the repository, the manifest, or the hash comparator.
 *
 * The failure arm is the load-bearing part: before ADR-175 a failed lookup fell
 * back to `false`, which rendered as "Up to date" — the same false statement
 * the open-failure path produced, one layer further in.
 */
export async function resolveUpdateStatus(
  lookup: (() => Promise<boolean>) | null,
  openFailureReason: string | undefined,
  dbPath: string | undefined
): Promise<{ updateStatus: UpdateStatus; updateStatusReason: string | undefined }> {
  // No lookup available: the status is whatever the OPEN established. A reason
  // means unknowable; no reason means there was nothing to check against, which
  // is `current` — the absent-database case.
  if (!lookup) {
    return {
      updateStatus: openFailureReason ? 'unknown' : 'current',
      updateStatusReason: openFailureReason,
    }
  }

  try {
    return {
      updateStatus: (await lookup()) ? 'available' : 'current',
      updateStatusReason: undefined,
    }
  } catch (error) {
    return {
      updateStatus: 'unknown',
      updateStatusReason: describeQueryFailure(error, dbPath),
    }
  }
}

export function describeQueryFailure(error: unknown, dbPath: string | undefined): string {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (typeof code === 'string' && isCorruptionCode(code)) {
    // `dbPath` is in practice always set when a query has run — a repository
    // exists only if the open succeeded, which requires a path — but the
    // caller's narrowing does not reach this far, and a fallback clause is
    // honest where a non-null assertion would merely look confident.
    return dbPath ? corruptClause(dbPath) : 'the local database is corrupt'
  }
  return `the version lookup for this skill failed`
}
