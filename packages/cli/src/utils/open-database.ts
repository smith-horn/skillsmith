/**
 * @fileoverview Shared CLI database opener — the single schema-safe entry point.
 * @see SMI-4486, SMI-4917
 *
 * `@skillsmith/core` re-exports the BARE `createDatabaseAsync` factory
 * (`db/createDatabase.js`) — it opens a connection but creates NO tables. Every
 * CLI command that touches a table (`skills`, `cache`, `sync_history`, …) MUST
 * call `initializeSchema` first, or it crashes on a fresh DB with errors like
 * `no such table: cache`.
 *
 * Before this helper, each command repeated `createDatabaseAsync` +
 * `initializeSchema` by hand; any command that forgot the second line shipped a
 * first-time-install crash (Bug 1 of SMI-4917 — `search` did exactly this).
 * `openCliDatabase` makes the footgun structurally impossible: it is the one
 * unmissable way a CLI command opens a database.
 */
import { createDatabaseAsync, initializeSchema, type DatabaseType } from '@skillsmith/core'

/**
 * Open a CLI database with the full schema initialized and all migrations
 * applied. Use this everywhere a CLI command needs a database — never call the
 * bare `createDatabaseAsync` directly.
 *
 * @param path - Filesystem path to the SQLite database (e.g. `DEFAULT_DB_PATH`).
 * @param options.readonly - SMI-5139: open read-only for pure-read consumers
 *   (e.g. version lookups). A read-only handle CANNOT run schema DDL, so
 *   `initializeSchema` is skipped — the caller must tolerate an absent schema
 *   (queries on a missing table throw, which read consumers already catch).
 *   This also prevents the WASM `SqlJsDatabaseAdapter` from persisting (writing)
 *   on `close()`, which would throw `EROFS` on an unwritable/absent db path.
 * @returns A connected database. Caller owns `db.close()`.
 */
export async function openCliDatabase(
  path: string,
  options?: { readonly?: boolean }
): Promise<DatabaseType> {
  // SMI-5139: read-only consumers open read-only and skip schema init (DDL is
  // impossible on a read-only handle; sql.js close() then skips persist()).
  // The open itself may throw (native better-sqlite3 read-only-opens of an
  // absent file throw) — that is the caller's signal to degrade gracefully.
  if (options?.readonly) {
    return createDatabaseAsync(path, { readonly: true })
  }

  let db: DatabaseType | undefined
  try {
    db = await createDatabaseAsync(path)
    initializeSchema(db)
    return db
  } catch (err) {
    // Close the handle opened before `initializeSchema` failed, on EVERY
    // failure path. The previous version closed it only on the branch that
    // went on to rebuild, so a non-corruption failure leaked it.
    if (db) {
      try {
        db.close()
      } catch {
        // handle already unusable — nothing more to free
      }
    }
    // Rethrow untouched. This wrapper used to catch a corruption refusal here,
    // feed it to a substring matcher, rename the MAIN FILE ONLY — orphaning the
    // `-wal` against a rebuilt database — and return, so the command proceeded
    // against an empty database (SMI-4484, forbidden by ADR-175 § 1).
    //
    // Repair is not this layer's decision to make. The driver has already
    // established that the file is damaged and its refusal carries the remedy;
    // renaming a database other processes may hold open is what ADR-175
    // documents as unsafe, because SQLite coordinates through file paths rather
    // than inodes.
    //
    // **This refusal is uniform — no caller gets a repaired database — but it
    // does NOT abort every command.** An earlier version of this comment said
    // it did, which was false: what a caller does with the refusal is the
    // caller's own business, and one of them swallows it.
    //
    //   There are THREE shapes, and this comment deliberately does not say how
    //   many commands are in each — an earlier version said "aborts every
    //   command", then "most commands have no try", and both were wrong. The
    //   enumeration lives in `database-consumer-inventory.test.ts`, where it is
    //   checked; a count here would only rot (SMI-6991).
    //
    //   (a) The open sits outside any `try`. The refusal reaches the entry
    //       point's handler, which prints one sanitized line and exits 1.
    //   (b) The open sits inside a `try` whose catch sanitizes and calls
    //       `process.exit(1)` itself, so the entry-point handler never fires.
    //       Same user-visible outcome, different mechanism.
    //   (c) The command handles the refusal and keeps going. TWO do this, and
    //       both are deliberate: `skillsmith update` records a per-skill
    //       failure and continues, so on a corrupt database every skill fails
    //       and the command exits 1 (step 6); `skillsmith list` classifies the
    //       refusal into `updateStatus: 'unknown'` and exits 0, reporting what
    //       it cannot determine rather than a count it cannot verify.
    //
    //   None of the three proceeds against an empty database, which is what
    //   § 1 actually requires, but it is not an abort.
    //
    // The cost of refusing at all was weighed against degrading `search`,
    // `info` and `remove`, each of which could have served from the remote API
    // or the filesystem without a database. The owner chose uniform refusal on
    // 2026-10-04: one code path is far harder to regress than fourteen plus
    // three exceptions, and § 1 binds without carve-outs. It is a decision, not
    // an oversight — do not "fix" it by adding a per-command fallback without
    // revisiting that call.
    throw err
  }
}
