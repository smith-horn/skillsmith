/**
 * SMI-2180: better-sqlite3 Driver Implementation
 *
 * Wraps the better-sqlite3 library to implement the Database abstraction interface.
 * This driver is used when native modules are available (Docker, Linux, CI).
 *
 * better-sqlite3 is synchronous and provides excellent performance for local SQLite.
 *
 * @see https://github.com/WiseLibs/better-sqlite3
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import type { Database, Statement, RunResult, DatabaseOptions } from '../database-interface.js'
import { CorruptDatabaseError } from '../db-errors.js'
import { classifyProbeFailure, remedyKindFor } from '../probe-classification.js'

// ESM-compatible require for native modules
const require = createRequire(import.meta.url)

/**
 * Wraps a better-sqlite3 Statement to implement our Statement interface
 */
class BetterSqlite3Statement<T = unknown> implements Statement<T> {
  constructor(private readonly stmt: BetterSqlite3.Statement) {}

  run(...params: unknown[]): RunResult {
    const result = this.stmt.run(...params)
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    }
  }

  get(...params: unknown[]): T | undefined {
    return this.stmt.get(...params) as T | undefined
  }

  all(...params: unknown[]): T[] {
    return this.stmt.all(...params) as T[]
  }

  iterate(...params: unknown[]): IterableIterator<T> {
    return this.stmt.iterate(...params) as IterableIterator<T>
  }

  finalize(): void {
    // better-sqlite3 doesn't require explicit finalization
    // Statements are automatically cleaned up when garbage collected
  }

  bind(...params: unknown[]): this {
    this.stmt.bind(...params)
    return this
  }
}

/**
 * Wraps a better-sqlite3 Database to implement our Database interface
 */
export class BetterSqlite3Database implements Database {
  constructor(private readonly db: BetterSqlite3.Database) {}

  exec(sql: string): void {
    this.db.exec(sql)
  }

  prepare<T = unknown>(sql: string): Statement<T> {
    const stmt = this.db.prepare(sql)
    return new BetterSqlite3Statement<T>(stmt)
  }

  transaction<T, Args extends unknown[] = []>(fn: (...args: Args) => T): (...args: Args) => T {
    // better-sqlite3 transaction returns a wrapped function
    return this.db.transaction(fn) as (...args: Args) => T
  }

  pragma(pragma: string): unknown {
    return this.db.pragma(pragma)
  }

  close(): void {
    this.db.close()
  }

  get open(): boolean {
    return this.db.open
  }

  get name(): string {
    return this.db.name
  }

  get memory(): boolean {
    return this.db.memory
  }

  get readonly(): boolean {
    return this.db.readonly
  }

  /**
   * Get the underlying better-sqlite3 database instance
   * Use with caution - this bypasses the abstraction layer
   */
  get native(): BetterSqlite3.Database {
    return this.db
  }
}

/**
 * Create a database connection using better-sqlite3
 *
 * @param path - Path to database file, or ':memory:' for in-memory database
 * @param options - Database connection options
 * @returns A Database instance wrapping better-sqlite3
 * @throws Error if better-sqlite3 native module is not available
 */
export function createBetterSqlite3Database(
  path: string = ':memory:',
  options?: DatabaseOptions
): BetterSqlite3Database {
  // Dynamic import to avoid loading native module at module evaluation time
  // This is synchronous because better-sqlite3 is synchronous

  const Database = require('better-sqlite3') as typeof BetterSqlite3

  // Build options object, only including defined values
  // better-sqlite3 doesn't accept undefined for boolean options
  const dbOptions: Record<string, unknown> = {
    timeout: options?.timeout ?? 5000,
  }

  if (options?.readonly !== undefined) {
    dbOptions.readonly = options.readonly
  }
  if (options?.fileMustExist !== undefined) {
    dbOptions.fileMustExist = options.fileMustExist
  }
  if (options?.verbose) {
    dbOptions.verbose = console.log
  }

  // Captured BEFORE opening, because `new Database()` creates the file — a
  // check made afterwards can never distinguish a pre-existing database from
  // one this call just brought into being.
  const fileExistedBeforeOpen = path !== ':memory:' && existsSync(path)

  // SMI-6931: probe through a SEPARATE READ-ONLY connection, before the real
  // one is opened at all. A read-write open mutates on close — SQLite
  // checkpoints committed WAL content into the main file and unlinks the
  // journal sidecars — so probing through the caller's connection cannot
  // deliver a non-mutating refusal, however carefully the rest is written.
  // Measured: after a read-only open and close of a WAL database, the main file
  // and the `-wal` — the durable, data-bearing files — are byte-identical, and
  // the `-shm` remains present and usable. The `-shm` is deliberately NOT
  // claimed byte-identical: a WAL reader participates in coordination through
  // it, so it is mutable shared state. It carries no durable data, measured by
  // deleting it outright and finding every committed row still readable.
  //
  // Refusing here also means a corrupt file is never opened read-write, so
  // there is no handle to leak and no constructor path left unclassified.
  if (fileExistedBeforeOpen) {
    const corruption = probeForCorruption(Database, path)
    if (corruption !== null) {
      throw corruptDatabaseError(path, corruption.verdict, corruption.sqliteCode, corruption.cause)
    }
  }

  // Only reached for a file the probe read cleanly, or one that does not exist
  // yet. A failure here is therefore not corruption and propagates untouched.
  return new BetterSqlite3Database(new Database(path, dbOptions))
}

/**
 * The refusal a corrupt database produces.
 *
 * **Why this refuses instead of repairing (SMI-6931).** An earlier draft backed
 * the file aside and rebuilt, mirroring the WASM driver. A cross-family review
 * rejected it, and correctly: this database is shared between processes — a CLI
 * invocation and a long-lived MCP server can both hold it — and SQLite
 * coordinates processes through the **file paths**, not the inodes. Renaming it
 * out from under a live handle leaves that process writing into the renamed
 * backup while new connections use the replacement, so the two diverge
 * silently. Losing writes is worse than refusing to start, and this database is
 * a rebuildable mirror of the remote registry, so refusing costs little.
 *
 * **ADR-175** records this decision and the evidence for it. An earlier version
 * of this comment cited *ADR-155: "Recovery never runs automatically"* as
 * settled policy for database drivers; that was a misattribution — ADR-155
 * governs skill-folder recovery and mentions no database at all. The quote is
 * real and its scope is another subsystem. The argument that actually holds is
 * the one above, which SQLite states itself: renaming an open database "results
 * in behavior that is undefined and probably undesirable", and the two files
 * then share a journal by name, so one database's recovery can read the other's
 * content.
 *
 * The message therefore has to be actionable, because a correct refusal the
 * user cannot act on is its own defect. It names the path, the verdict, and the
 * exact manual move — **including the WAL sidecars**, because
 * `schema-sql.ts` sets `journal_mode = WAL`, so the database on disk is three
 * files and moving one leaves the others orphaned against a rebuilt file.
 */
function corruptDatabaseError(
  path: string,
  reason: string,
  sqliteCode?: string,
  cause?: unknown
): CorruptDatabaseError {
  // A collision-resistant destination. `.corrupt` alone can already exist and
  // `mv` would replace it silently, losing an earlier diagnosis to a later one.
  // A millisecond timestamp alone is not enough either: two processes can refuse
  // within the same millisecond, so the suffix carries randomness as well.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = `${path}.corrupt-${stamp}-${randomBytes(3).toString('hex')}`

  // Paths are shell-quoted. These lines are instructions a user will paste, and
  // a path containing a space — or anything worse — must not change what the
  // command does.
  const q = shellQuote
  const remedyKind = remedyKindFor(sqliteCode)

  // The guidance is a RECOMMENDED framework, not a guaranteed fix (ADR-175 § 6).
  // Whether it restores service depends on conditions this error cannot verify
  // — above all whether every process holding the file has actually stopped —
  // so nothing below promises the database comes back.
  const recommended =
    remedyKind === 'reindex'
      ? // SQLite names REINDEX for this code and names it conditionally: it
        // "might" resolve the problem "assuming no other problems exist". The
        // probe runs quick_check(1), which stops at the first reported problem,
        // so it cannot establish the index is the only damage. Hence the
        // sequence ends in a re-check rather than in a fix.
        `Recommended: SQLite reports this as index corruption, which a reindex may be ` +
        `able to resolve — though only if nothing else is damaged, which this check ` +
        `cannot confirm. Stop every Skillsmith process, including any running MCP ` +
        `server, then:\n` +
        `  cp ${q(path)} ${q(dest)}   # keep a copy first\n` +
        `  sqlite3 ${q(path)} 'REINDEX;'\n` +
        `  sqlite3 ${q(path)} 'PRAGMA quick_check;'\n` +
        `\n` +
        `Treat the database as healthy only if that last command prints "ok". If it ` +
        `does not, move the files aside as below and let a sync rebuild them.\n`
      : `Recommended: stop every Skillsmith process, including any running MCP server, ` +
        `then move the database set aside and re-run Skillsmith. This is a WAL ` +
        `database, so move whichever of the three files are present:\n` +
        `  mv ${q(path)} ${q(dest)}\n` +
        `  mv ${q(`${path}-wal`)} ${q(`${dest}-wal`)}   # if present\n` +
        `  mv ${q(`${path}-shm`)} ${q(`${dest}-shm`)}   # if present\n` +
        `\n` +
        `Skillsmith rebuilds the database on the next sync. Keep the moved files until ` +
        `you are satisfied nothing is missing.\n`

  return new CorruptDatabaseError({
    path,
    verdict: reason,
    remedyKind,
    sqliteCode,
    cause,
    message:
      `[Skillsmith] The local database at ${path} is corrupt and cannot be read: ${reason}\n` +
      `\n` +
      `Skillsmith does not repair it automatically — it holds no data that cannot be ` +
      `rebuilt from the registry, and repairing a database another process may have ` +
      `open risks losing that process's writes.\n` +
      `\n` +
      recommended,
  })
}

/** Release a handle whose state is already unknown, without masking the real error. */
function closeQuietly(db: BetterSqlite3.Database): void {
  try {
    db.close()
  } catch {
    // Handle already unusable — nothing left to release.
  }
}

/** Single-quote a path for a shell instruction, escaping any embedded quote. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The SQLite extended result code on an error, when it carries a usable one.
 *
 * Read out so it can travel on the refusal as `sqliteCode` (ADR-175 § 7) and so
 * `remedyKindFor` can distinguish `SQLITE_CORRUPT_INDEX` from the rest. The
 * classification itself lives in `probe-classification.ts`, where it is
 * family-aware and directly testable; this only extracts the value.
 *
 * better-sqlite3 documents `code` as a string naming an extended result code,
 * so a missing or non-string value means the error did not come from the driver
 * — a probe fault, for instance, which carries none by design.
 */
function sqliteCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

/**
 * Decide whether an already-open database is corrupt.
 *
 * SMI-6931. Two things here are not obvious and were both measured rather than
 * assumed, because getting either wrong yields a probe that silently detects
 * nothing while looking correct:
 *
 * **1. A `sqlite_master` read is not sufficient.** The WASM driver probes
 * `SELECT name FROM sqlite_master LIMIT 1` (SMI-4484), which validates only the
 * schema page. On a database whose schema page is intact and whose data pages
 * are damaged — the condition SMI-6931 was actually filed for — that read
 * **succeeds** while `SELECT COUNT(*)` on a real table throws
 * `database disk image is malformed`. Copying the WASM probe here would have
 * detected nothing on the machine that prompted the fix.
 *
 * **2. `quick_check` REPORTS rather than throws.** It returns a row whose value
 * is `ok` for a healthy database, and the damage as a *string* for a corrupt
 * one. Wrapping it in `try`/`catch` alone would be a no-op: the catch never
 * fires and every corrupt database passes. The verdict has to be inspected.
 *
 * `quick_check` over `integrity_check` on measured cost: on a fresh 59.6 MB
 * database, `quick_check(1)` took 114 ms against `integrity_check(1)`'s 190 ms.
 * It skips index-vs-table consistency, which a rebuild-on-corruption path does
 * not need — an inconsistent index is repairable by REINDEX, not grounds for
 * discarding the file. The `(1)` argument stops after the first error, so the
 * corrupt case is cheap; the healthy case is the one that pays, and that cost
 * is why this is worth stating out loud rather than burying.
 *
 * @returns The verdict plus the SQLite code that produced it, or `null` when the
 *   database reads cleanly. The code is absent when the finding came from a
 *   `quick_check` row rather than a thrown error — see the non-`ok` branch.
 */
function probeForCorruption(
  DatabaseCtor: typeof BetterSqlite3,
  path: string
): { verdict: string; sqliteCode?: string; cause?: unknown } | null {
  let probe: BetterSqlite3.Database
  try {
    probe = new DatabaseCtor(path, { readonly: true, timeout: 5000 })
  } catch (error) {
    // A corrupt header is rejected at open, so that case is a verdict. Anything
    // else — SQLITE_CANTOPEN, a permission error, a locking failure — is an
    // operational problem, and this function must not reinterpret it as
    // corruption. It propagates as itself.
    //
    // `classifyProbeFailure` names four classes (ADR-175 § 2). PR-1 acts on
    // `corrupt` and propagates the other three, which is today's behaviour —
    // what changes is that they are now *named* rather than falling into an
    // unexamined catch-all, and the classifier is tested directly against every
    // code including those no fixture can produce.
    //
    // `transient` (SQLITE_BUSY family) and `recovery-required`
    // (SQLITE_READONLY_RECOVERY / _ROLLBACK / _CANTLOCK / _CANTINIT) are the
    // two classes whose eventual handling differs from propagation: a lock
    // should be retried inside one shared deadline, and a pending recovery
    // should be performed by a read-write caller and then re-checked, while a
    // read-only caller gets its own distinct error. **That wiring is PR-2**
    // (ADR-175 § 3 and § 4); until it lands, both propagate as themselves,
    // which is strictly no worse than before this classifier existed.
    //
    // What this must never become is "proceed without a verdict." An earlier
    // draft of the ADR returned "no corruption established" for those classes,
    // which would have let the real connection open with no integrity check at
    // all whenever the probe was contended — turning "refuse corruption" into
    // "refuse corruption only when an uncontended probe completes."
    const failureClass = classifyProbeFailure(error)
    if (failureClass === 'corrupt') {
      return {
        verdict: error instanceof Error ? error.message : String(error),
        sqliteCode: sqliteCodeOf(error),
        cause: error,
      }
    }
    throw error
  }

  try {
    const rows = probe.pragma('quick_check(1)') as unknown
    const first = Array.isArray(rows) ? rows[0] : undefined
    const raw = first && typeof first === 'object' ? Object.values(first)[0] : undefined
    // Normalise BEFORE validating: `"   "` would otherwise pass a length check
    // and become an empty corruption reason.
    const verdict = typeof raw === 'string' ? raw.trim() : ''

    if (verdict.length === 0) {
      // SMI-6931 finding 5: an unrecognised result is a PROBE FAULT, not a
      // corruption verdict. An earlier draft mapped any unexpected shape —
      // a scalar, an empty array, a renamed row key — to "corrupt", reasoning
      // that unknown should be treated as unsafe. That is backwards when the
      // "unsafe" branch refuses to open the user's database and tells them to
      // move it aside: a `pragma()` return-shape change in a dependency would
      // then have bricked every open. Fail-closed is right only where the
      // closed state is the harmless one.
      throw new Error(
        `[Skillsmith] Could not read a quick_check verdict for ${path}. This is a ` +
          `fault in the integrity probe, not evidence that the database is corrupt. ` +
          `Received: ${JSON.stringify(rows)?.slice(0, 200)}`
      )
    }

    // A non-`ok` verdict is a corruption verdict with NO SQLite code attached:
    // `quick_check` returns its finding as a string rather than throwing, so
    // there is nothing to read a code from and no `cause` to chain. This is
    // exactly why `sqliteCode` is optional and why consumers must not rely on
    // `cause` to learn which code fired — on this path neither exists.
    return verdict.toLowerCase() === 'ok' ? null : { verdict }
  } catch (error) {
    // A corruption-class CODE is corruption. Everything else — including the
    // probe fault above, which carries no SQLite code — propagates, so a broken
    // probe is never reported to the user as a broken database.
    if (classifyProbeFailure(error) === 'corrupt') {
      return {
        verdict: error instanceof Error ? error.message : String(error),
        sqliteCode: sqliteCodeOf(error),
        cause: error,
      }
    }
    throw error
  } finally {
    // The probe connection is this function's own and never escapes it.
    closeQuietly(probe)
  }
}

/**
 * Captured reason the native driver last failed to load.
 *
 * SMI-4807: `better-sqlite3` is an optionalDependency whose install/dlopen
 * failures were previously swallowed by a bare `catch {}`. We now retain the
 * error message so the WASM-fallback path can surface it under `SKILLSMITH_DEBUG`.
 */
let betterSqlite3FailureReason: string | undefined

/**
 * Get the reason the native better-sqlite3 module last failed to load.
 *
 * @returns The failure message, or `undefined` if the native module loaded
 *   successfully or has not been checked yet.
 */
export function getBetterSqlite3FailureReason(): string | undefined {
  return betterSqlite3FailureReason
}

/**
 * Check if better-sqlite3 native module is available
 * @returns true if the native module can be loaded
 */
export function isBetterSqlite3Available(): boolean {
  try {
    const Database = require('better-sqlite3') as typeof BetterSqlite3
    // Instantiate in-memory DB to trigger dlopen of the native binary.
    // Catches ABI mismatch (Node upgrade) and platform mismatch (Linux binary on macOS).
    const testDb = new Database(':memory:')
    testDb.close()
    betterSqlite3FailureReason = undefined
    return true
  } catch (err) {
    // SMI-4807: capture the failure reason instead of silently discarding it.
    betterSqlite3FailureReason = err instanceof Error ? err.message : String(err)
    return false
  }
}
