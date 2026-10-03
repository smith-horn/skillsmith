/**
 * Update-status classification for installed skills (ADR-175 § 5, SMI-6946).
 *
 * Extracted from `skills-directory.ts` to stay under the 500-line standard once
 * the tri-state and its cause classification were added — the same reason
 * `skills-directory.hash-comparison.ts` exists. Both are re-exported from
 * `skills-directory.ts`, so call sites import from there unchanged.
 */
import { existsSync } from 'node:fs'
import { isCorruptDatabaseError } from '@skillsmith/core'

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
 * `false`: a database that does not exist yet, one that is corrupt, one we lack
 * permission to read, one locked by another process, and one whose schema is
 * wrong. Only the first licenses "no updates available" — nothing is installed
 * that could be out of date. The other four leave the answer unknowable, and
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
    return `the local database at ${error.path} is corrupt`
  }

  const code = (error as { code?: unknown } | null | undefined)?.code
  const sqliteCode = typeof code === 'string' ? code : ''

  // A database that has not been created yet is the ONE benign case: there is
  // nothing installed whose currency we could be wrong about. If the file does
  // exist and still would not open, that is not benign.
  if (sqliteCode === 'SQLITE_CANTOPEN' || code === 'ENOENT') {
    return existsSync(dbPath) ? `the local database at ${dbPath} could not be opened` : undefined
  }

  if (sqliteCode.startsWith('SQLITE_BUSY')) {
    return `the local database at ${dbPath} is locked by another process`
  }
  if (sqliteCode.startsWith('SQLITE_READONLY') || sqliteCode.startsWith('SQLITE_PERM')) {
    return `the local database at ${dbPath} could not be read`
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `the local database at ${dbPath} is not readable`
  }

  return `the local database at ${dbPath} could not be queried`
}
