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

  /** Which recommended recovery framework applies. */
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
