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
import {
  createDatabaseAsync,
  initializeSchema,
  isCorruptionError,
  backupCorruptDbFile,
  type DatabaseType,
} from '@skillsmith/core'
import { existsSync } from 'node:fs'

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
    // SMI-4484: backstop for corruption that surfaces during schema init (e.g.
    // a corrupt page only read once the schema queries run). The sql.js driver
    // self-heals on open, but a corrupt file opened by the native driver can
    // still fail here. Back up the bad file and retry once on a fresh DB.
    if (!isCorruptionError(err) || path === ':memory:' || !existsSync(path)) {
      throw err
    }
    // Close the handle opened before initializeSchema failed so it is not
    // leaked before we rebuild.
    if (db) {
      try {
        db.close()
      } catch {
        // handle already unusable — nothing more to free
      }
    }
    const backupPath = backupCorruptDbFile(path)
    console.warn(
      `[Skillsmith] The local database at ${path} was corrupt and could not be opened. ` +
        `It has been backed up to ${backupPath} and will be rebuilt on the next sync.`
    )
    const fresh = await createDatabaseAsync(path)
    initializeSchema(fresh)
    return fresh
  }
}
