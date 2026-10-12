/**
 * Corruption classification for the sql.js driver (ADR-175 § 2, SMI-6961).
 *
 * A sibling module rather than functions inside `sqljsDriver.ts` for two
 * reasons: that file is at the 500-line standard, and these predicates are
 * worth testing directly against a case table rather than only through a
 * driver open.
 */

import { corruptDatabaseError } from '../corrupt-refusal.js'

/** The narrowest shape `quickCheckVerdict` needs, so it is testable with a stub. */
export interface QuickCheckable {
  prepare(sql: string): {
    step(): boolean
    get(): unknown[]
    free(): void
  }
}

/**
 * SQLite's integrity verdict on an open database, or `undefined` when healthy.
 *
 * **Why this exists separately from the error path.** `quick_check` **REPORTS**
 * rather than throws: it returns `ok` or a description of the damage as a
 * string, so no amount of `try`/`catch` around an open can observe it. The
 * native driver has the same split (ADR-175 § 2), which is also why a verdict
 * from here carries no `sqliteCode` — there is no thrown error to read one off.
 *
 * **Why the driver needs it at all.** This driver's existing probe is
 * `SELECT name FROM sqlite_master LIMIT 1`, which reads only the schema page.
 * Measured: a database with a valid header and `0xff` written over every page
 * from 4096 onward — the exact condition SMI-6931 was filed for — **passes**
 * that probe and opens cleanly, while `quick_check(1)` returns
 * `*** in database main *** Tree 2 page 2: btreeInitPage() returns error code 11`.
 * Without this, the two drivers refuse different files, which § 1 forbids.
 *
 * Compared case-insensitively against `ok` because that is SQLite's own
 * success token; anything else is a verdict, including a shape this code did
 * not anticipate. An unreadable or absent row is treated as a verdict too
 * rather than as health — the safe direction, since the alternative is
 * publishing a handle whose integrity was never established.
 */
export function quickCheckVerdict(db: QuickCheckable): string | undefined {
  const stmt = db.prepare('PRAGMA quick_check(1)')
  try {
    if (!stmt.step()) return 'quick_check returned no result'
    const first = stmt.get()[0]
    if (typeof first !== 'string') return 'quick_check returned a non-string result'
    return first.trim().toLowerCase() === 'ok' ? undefined : first
  } finally {
    stmt.free()
  }
}

/**
 * Refuse an open handle whose integrity `quick_check` reports as damaged.
 *
 * Closes the handle before throwing: it is never published to the caller, so
 * nothing else will free its WASM heap.
 *
 * The refusal carries no `sqliteCode`. A reported verdict has no thrown error
 * to read one from, which is the same shape the native driver's `quick_check`
 * path has — and the reason ADR-175 § 7 puts `sqliteCode` on the error as an
 * optional field rather than deriving it from `cause`.
 */
export function refuseIfCorrupt(db: QuickCheckable & { close(): void }, path: string): void {
  const verdict = quickCheckVerdict(db)
  if (verdict === undefined) return
  try {
    db.close()
  } catch {
    // already unusable; nothing left to free
  }
  throw corruptDatabaseError(path, verdict)
}

/**
 * The SQLite result code behind a sql.js error, derived from its message.
 *
 * **Why a message match here is not the substring matching ADR-175 retired.**
 * sql.js errors carry **no** `code` property at all — measured, `code` is
 * `undefined` on every one — so `sqliteCodeOf` and `classifyProbeFailure`
 * cannot classify them: every sql.js failure falls to `operational`. The
 * message is the only verdict this driver's engine exposes.
 *
 * What was retired was matching a substring against *arbitrary* text, where an
 * incidental word in a wrapper message or a file path could produce a false
 * positive. This compares the **whole message** against SQLite's own
 * `sqlite3_errmsg` output, which is a fixed enumeration and is the engine's
 * verdict surface — the equivalent of a code, not a description of one. A path
 * containing the word "malformed" cannot match, because the comparison is not a
 * substring test.
 *
 * Both strings measured against real fixtures built by sql.js itself, so they
 * are what this engine actually emits rather than what SQLite documents:
 *
 * - a file of non-database bytes      -> `file is not a database`
 * - a database truncated mid-file     -> `database disk image is malformed`
 *
 * A message outside the enumeration returns `undefined`, which the caller
 * treats as *not corruption* and rethrows untouched. That direction is
 * deliberate: an unrecognised failure must not be reported as corruption, since
 * the refusal tells the user to move their database aside.
 */
export function sqlJsCorruptionCode(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'file is not a database') return 'SQLITE_NOTADB'
  if (message === 'database disk image is malformed') return 'SQLITE_CORRUPT'
  return undefined
}
