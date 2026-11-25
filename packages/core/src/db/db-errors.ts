/**
 * Structured database-open failures (ADR-175, SMI-6946).
 *
 * **Why these exist.** SMI-6931 made the native driver detect corruption and
 * throw. It threw a plain `Error`, so the only discriminator a caller had was
 * the message text — and two consumers read that text wrongly: one discarded
 * every open failure as "database not available yet" and reported *no updates*
 * for every installed skill, and another fed the refusal to a substring matcher
 * that renamed the user's database aside on a match.
 *
 * The driver had already rejected substring matching for its own internal
 * classification, on the grounds that a message "discards the structured code."
 * It then published its own verdict as prose. These classes close that gap.
 *
 * **Match on `code`. Never on the message, and never with `instanceof`.**
 * Node's own guidance is that `error.message` may change in any version while
 * `error.code` is the stable identifier. `instanceof` is unsafe here for a
 * different reason: `@skillsmith/core` is consumed by both the CLI and a
 * long-lived MCP server and can be present as duplicate package copies, across
 * which a prototype check fails. This is undici's documented reason for the
 * same rule. Use the exported predicates.
 *
 * **The codes are ours, not SQLite's.** Deliberately not `SQLITE_CORRUPT`:
 * reusing it would make a deliberate policy refusal indistinguishable from an
 * unhandled driver error. The originating SQLite code travels separately on
 * `sqliteCode`.
 */

/** Stable discriminator for "this database is corrupt and was not opened". */
export const DB_CORRUPT_CODE = 'SKILLSMITH_DB_CORRUPT' as const

/**
 * What a user can usefully try, as a *kind* rather than a command string.
 *
 * The kind is stable; the rendered commands and their wording are not. It is a
 * **recommended** framework and not a guarantee — see `CorruptDatabaseError`.
 *
 * - `reindex` — SQLite reported `SQLITE_CORRUPT_INDEX`, the one code it names a
 *   repair for, and names conditionally: `REINDEX` *might* resolve it
 *   "assuming no other problems exist."
 * - `replace` — move the database set aside and let a sync rebuild it.
 */
export type RemedyKind = 'reindex' | 'replace'

/**
 * A database that exists on disk, was inspected, and was found corrupt.
 *
 * Nothing was renamed, rebuilt or modified: the refusal is non-mutating by
 * design (ADR-175 § 1).
 *
 * **What the accompanying remedy claims.** It is a *recommended* sequence, not
 * a guaranteed fix. Whether following it restores service depends on conditions
 * this error cannot verify — principally whether every process holding the file
 * has actually stopped. Nothing here should be read as a promise that the
 * database comes back.
 */
export class CorruptDatabaseError extends Error {
  /** Stable, matched by consumers. Literal type, deliberately not widened. */
  readonly code: typeof DB_CORRUPT_CODE = DB_CORRUPT_CODE

  /** The database that was refused. */
  readonly path: string

  /** SQLite's own words — a result message, or a `quick_check` verdict row. */
  readonly verdict: string

  /**
   * Which recommended recovery framework applies.
   *
   * **NOT driver-independent, unlike `code` (SMI-6991).** `'reindex'` requires
   * the extended code `SQLITE_CORRUPT_INDEX`, and only the native driver can
   * supply one: `sqlJsCorruptionCode` resolves exactly two messages, neither of
   * them the index case, and the WASM `quick_check` path carries no code at
   * all. Measured: `'reindex'` is reachable ONLY from native's **thrown** path.
   * Native's own `quick_check` path also returns a verdict with no code, so a
   * database whose index damage `quick_check` finds gets `'replace'` on native
   * too. The divergence is per-path, not simply native-versus-WASM — an earlier
   * version of this note generalised one fixture into a claim about drivers.
   *
   * That matters because the two remedies differ in what they cost the user:
   * `'reindex'` is a non-destructive repair attempt, `'replace'` moves the
   * database aside and loses anything a sync cannot rebuild. An npx install,
   * where WASM is the default driver, therefore gets the worse advice.
   *
   * Branch on `code` for "is this corruption"; treat `remedyKind` as a hint
   * whose precision depends on the driver until SMI-6991 closes the gap.
   */
  readonly remedyKind: RemedyKind

  /**
   * The originating SQLite extended code, when there was one.
   *
   * Carried explicitly rather than only on `cause` for two reasons: a non-`ok`
   * `quick_check` verdict is **returned, not thrown**, so no `cause` exists for
   * it at all; and `cause` is routinely lost to wrapping, logging, serialization
   * and IPC. A consumer should not have to understand a driver-specific cause
   * shape to learn which code fired.
   */
  readonly sqliteCode?: string

  constructor(args: {
    message: string
    path: string
    verdict: string
    remedyKind: RemedyKind
    sqliteCode?: string
    cause?: unknown
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause })
    this.name = 'CorruptDatabaseError'
    this.path = args.path
    this.verdict = args.verdict
    this.remedyKind = args.remedyKind
    this.sqliteCode = args.sqliteCode
  }
}

/**
 * The supported consumer contract: is this a corruption refusal?
 *
 * Structural on purpose. It reads `code` and nothing else, so it holds across
 * duplicate package copies and across a serialized/rehydrated error that lost
 * its prototype.
 */
export function isCorruptDatabaseError(error: unknown): error is CorruptDatabaseError {
  return (error as { code?: unknown } | null | undefined)?.code === DB_CORRUPT_CODE
}

/**
 * Stable discriminator for "the WASM driver opened this database read-only and
 * refused a write" (SMI-7260).
 */
export const DB_WASM_READ_ONLY_CODE = 'SKILLSMITH_DB_WASM_READ_ONLY' as const

/**
 * A write refused because the database was opened by the sql.js (WASM) driver,
 * which never writes a file-backed database (SMI-7260).
 *
 * **Why the WASM driver cannot write.** sql.js loads the whole file into
 * memory and can only save by writing a new file and renaming it over the old
 * one. It takes no file locks, so it can never know whether a native
 * (better-sqlite3) process holds the database in WAL mode. When one does, the
 * rename silently loses that process's work, and a later native open folds a
 * WAL written for the old file into the new one, corrupting it. Writing needs
 * the native driver. Nothing was modified when this is thrown. Match on `code`
 * via `isDatabaseReadOnlyDriverError`, as above.
 */
export class DatabaseReadOnlyDriverError extends Error {
  readonly code: typeof DB_WASM_READ_ONLY_CODE = DB_WASM_READ_ONLY_CODE

  /** The database that was not written. */
  readonly path: string

  constructor(args: { message: string; path: string; cause?: unknown }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause })
    this.name = 'DatabaseReadOnlyDriverError'
    this.path = args.path
  }
}

/** Structural predicate for `DatabaseReadOnlyDriverError`; reads `code` only. */
export function isDatabaseReadOnlyDriverError(
  error: unknown
): error is DatabaseReadOnlyDriverError {
  return (error as { code?: unknown } | null | undefined)?.code === DB_WASM_READ_ONLY_CODE
}

/**
 * Stable discriminator for "the database file changed while the WASM driver
 * was reading it, so no verdict was reached" (SMI-7260).
 */
export const DB_READ_UNSTABLE_CODE = 'SKILLSMITH_DB_READ_UNSTABLE' as const

/**
 * The WASM driver's image of the database failed its integrity check, and the
 * file kept changing on every re-read, so the driver cannot tell a damaged file
 * from one another process was writing while it read (SMI-7260).
 *
 * **Deliberately not a corruption refusal.** A sql.js open that races a native
 * checkpoint can read a torn image of an intact file. Calling that corrupt
 * would advise moving the database aside, destroying a healthy file. A
 * corruption verdict (`CorruptDatabaseError`) is given only when two
 * consecutive reads are byte-identical and both fail; anything else is this
 * error, which says to try again. Nothing was modified.
 */
export class DatabaseReadUnstableError extends Error {
  readonly code: typeof DB_READ_UNSTABLE_CODE = DB_READ_UNSTABLE_CODE

  /** The database that could not be read consistently. */
  readonly path: string

  /** How many times the file was read before giving up. */
  readonly attempts: number

  constructor(args: { message: string; path: string; attempts: number; cause?: unknown }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause })
    this.name = 'DatabaseReadUnstableError'
    this.path = args.path
    this.attempts = args.attempts
  }
}

/** Structural predicate for `DatabaseReadUnstableError`; reads `code` only. */
export function isDatabaseReadUnstableError(error: unknown): error is DatabaseReadUnstableError {
  return (error as { code?: unknown } | null | undefined)?.code === DB_READ_UNSTABLE_CODE
}
