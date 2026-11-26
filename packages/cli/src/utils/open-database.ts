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
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createDatabaseAsync, initializeSchema, type DatabaseType } from '@skillsmith/core'

/** Whether `dir` is Skillsmith's own state directory, `~/.skillsmith`. */
function isSkillsmithStateDir(dir: string): boolean {
  return dir === join(homedir(), '.skillsmith')
}

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
 * @returns A connected database. Caller owns `db.close()`.
 */
export async function openCliDatabase(
  path: string,
  options?: { readonly?: boolean }
): Promise<DatabaseType> {
  // SMI-5139: read-only consumers open read-only and skip schema init (DDL is
  // impossible on a read-only handle).
  // The open itself may throw (native better-sqlite3 read-only-opens of an
  // absent file throw) — that is the caller's signal to degrade gracefully.
  if (options?.readonly) {
    return createDatabaseAsync(path, { readonly: true })
  }

  // SMI-7260: the native driver (now shipped with the CLI) refuses to create a
  // database in a directory that does not exist — "Cannot open database
  // because the directory does not exist" — where the WASM driver opened it in
  // memory. On a first run `~/.skillsmith` may not exist yet, so create it,
  // owner only (0o700, since it holds the user's skill index; `recursive`
  // leaves an existing directory's mode alone). ONLY Skillsmith's own state
  // directory: a missing directory in a path the user named with `-d` (a
  // typo, say) is not created, and the driver refuses the open as it always
  // did. Computed per call, so a stubbed HOME is honoured.
  if (path !== ':memory:' && isSkillsmithStateDir(dirname(resolve(path)))) {
    mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 })
  }

  let db: DatabaseType | undefined
  try {
    db = await createDatabaseAsync(path)
    // SMI-7260: on the WASM driver an existing database opens read-only:
    // `initializeSchema` is a no-op when its schema is current, so read
    // commands work and writes fail with DatabaseReadOnlyDriverError; when the
    // schema is older it throws that error itself, since this command could
    // not record anything. A missing database is built in memory and sealed.
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
    //   TWO shapes, and this comment deliberately gives no count per shape.
    //   The enumeration lives in `database-consumer-inventory.test.ts`, where
    //   it is checked rather than narrated. This paragraph has been wrong three
    //   times — "aborts every command", then "most commands have no try", then
    //   a third shape with no members — and each wrong version was a claim a
    //   comment cannot keep true (SMI-6991).
    //
    //   (a) The command's own `catch` sanitizes and calls `process.exit(1)`.
    //       The open may sit outside its immediate function's `try` and still
    //       land here, because the enclosing `*ActionImpl` wraps the whole body
    //       — which is why "outside any try" was the wrong way to describe it.
    //   (b) The command handles the refusal and keeps going, deliberately.
    //       `skillsmith update` records a per-skill failure and continues, so
    //       on a corrupt database every skill fails and it exits 1 (step 6);
    //       `skillsmith list` classifies the refusal into
    //       `updateStatus: 'unknown'` and exits 0, reporting what it cannot
    //       determine rather than a count it cannot verify.
    //
    //   The entry point's handler (`utils/fatal.ts`) is a BACKSTOP for a
    //   rejection that escapes both, not a shape any command currently uses.
    //   Keep it: it is what stops an unhandled rejection printing raw.
    //
    //   Neither shape proceeds against an empty database, which is what § 1
    //   actually requires. Neither is an "abort" in the sense of stopping at
    //   the open.
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
