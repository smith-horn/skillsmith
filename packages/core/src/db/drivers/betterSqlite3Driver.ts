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
    const corruptionReason = probeForCorruption(Database, path)
    if (corruptionReason !== null) {
      throw corruptDatabaseError(path, corruptionReason)
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
 * It is also what this repo already decided. ADR-155: *"Recovery never runs
 * automatically."* Skillsmith refuses and defers to an explicit command rather
 * than acting on the user's data unasked.
 *
 * The message therefore has to be actionable, because a correct refusal the
 * user cannot act on is its own defect. It names the path, the verdict, and the
 * exact manual move — **including the WAL sidecars**, because
 * `schema-sql.ts` sets `journal_mode = WAL`, so the database on disk is three
 * files and moving one leaves the others orphaned against a rebuilt file.
 */
function corruptDatabaseError(path: string, reason: string): Error {
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
  return new Error(
    `[Skillsmith] The local database at ${path} is corrupt and cannot be read: ${reason}\n` +
      `\n` +
      `Skillsmith does not repair it automatically — it holds no data that cannot be ` +
      `rebuilt from the registry, and repairing a database another process may have ` +
      `open risks losing that process's writes.\n` +
      `\n` +
      `To recover: stop every Skillsmith process, including any running MCP server, ` +
      `then run these in sequence and re-run Skillsmith. This is a WAL database, so ` +
      `move whichever of the three files are present:\n` +
      `  mv ${q(path)} ${q(dest)}\n` +
      `  mv ${q(`${path}-wal`)} ${q(`${dest}-wal`)}   # if present\n` +
      `  mv ${q(`${path}-shm`)} ${q(`${dest}-shm`)}   # if present\n` +
      `\n` +
      `Skillsmith rebuilds the database on the next sync. Keep the moved files until ` +
      `you are satisfied nothing is missing.`
  )
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
 * Corruption classified by SQLite's own **result code**, not by message text.
 *
 * SMI-6931. The shared `isCorruptionError` matches bare substrings — `malformed`,
 * `file is encrypted`, `not a database` — against a message. A cross-family
 * review found no standard SQLite transient I/O, permission, busy or locking
 * message that collides with those, so the practical risk was smaller than
 * feared; but the approach still discards the structured code, accepts
 * incidental text from a wrapper or a *file path*, and under a refusal design
 * any collision becomes confident advice to move the user's data.
 *
 * So this driver classifies locally and narrowly. The shared helper is left
 * alone because the WASM driver depends on it and changing it would alter that
 * driver's behaviour without review.
 *
 * The prefix test covers SQLite's extended codes (`SQLITE_CORRUPT_VTAB` and
 * friends) without enumerating them.
 */
function isNativeCorruptionCode(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB')
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
 * @returns A human-readable reason, or `null` when the database reads cleanly.
 */
function probeForCorruption(DatabaseCtor: typeof BetterSqlite3, path: string): string | null {
  let probe: BetterSqlite3.Database
  try {
    probe = new DatabaseCtor(path, { readonly: true, timeout: 5000 })
  } catch (error) {
    // A corrupt header is rejected at open, so that case is a verdict. Anything
    // else — SQLITE_CANTOPEN, a permission error, a locking failure — is an
    // operational problem, and this function must not reinterpret it as
    // corruption. It propagates as itself.
    //
    // SQLITE_READONLY_RECOVERY / SQLITE_READONLY_ROLLBACK deserve their own
    // note, because they are the one shape where "the probe cannot open it"
    // might not mean "the caller cannot open it": they signal that a read-only
    // connection cannot perform a recovery the file needs, which a READ-WRITE
    // open — the one this function runs ahead of — can. If that were reachable,
    // probing read-only would turn a recoverable database into a refusal to
    // open, a regression this change would have introduced.
    //
    // They get no special branch, because the asymmetry was looked for and not
    // found: a read-only open recovered every crash-damaged database it was
    // given — hot rollback journal, and WAL both with and without its `-shm` —
    // and the asymmetry requires writable storage, since otherwise the
    // read-write open fails too. SMI-6931 holds the fixtures and the one arm
    // recorded VACUOUS rather than passing.
    //
    // So an open failure the probe cannot classify fails loudly. If a state is
    // ever found where a read-write open would have recovered what the probe
    // could not, this is the comment it falsifies, and the fix is to return null
    // here and let the real open attempt the recovery.
    if (isNativeCorruptionCode(error)) {
      return error instanceof Error ? error.message : String(error)
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

    return verdict.toLowerCase() === 'ok' ? null : verdict
  } catch (error) {
    // A corruption-class CODE is corruption. Everything else — including the
    // probe fault above, which carries no SQLite code — propagates, so a broken
    // probe is never reported to the user as a broken database.
    if (isNativeCorruptionCode(error)) {
      return error instanceof Error ? error.message : String(error)
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
