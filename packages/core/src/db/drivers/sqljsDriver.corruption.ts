/**
 * Mapping a sql.js error to a SQLite result code (ADR-175 § 2, SMI-6961).
 *
 * A sibling module rather than a function inside `sqljsDriver.ts` for two
 * reasons: that file is at the 500-line standard, and this predicate is worth
 * testing directly against a case table rather than only through a driver open.
 */

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
