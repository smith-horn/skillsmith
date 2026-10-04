/**
 * The corruption refusal, shared by every driver (ADR-175 § 1, SMI-6961).
 *
 * Extracted verbatim from `drivers/betterSqlite3Driver.ts` so the WASM driver
 * can throw the **same** refusal rather than a second one built to look like
 * it. ADR-175 § 1 binds both drivers, and two independently-maintained builders
 * is how they drift apart — the defect SMI-6961 exists to close is precisely
 * the two drivers disagreeing about what a corrupt database means.
 *
 * Extraction rather than duplication is also forced by the 500-line standard:
 * `sqljsDriver.ts` is already 474 lines, so inlining this would break the
 * pre-commit gate.
 *
 * Internal to `@skillsmith/core` — deliberately not re-exported from the
 * package root. Consumers branch on `isCorruptDatabaseError` and the error's
 * `code`, never on how the refusal was constructed.
 */

import { randomBytes } from 'node:crypto'
import { CorruptDatabaseError } from './db-errors.js'
import { remedyKindFor } from './probe-classification.js'

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
export function sqliteCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code.length > 0 ? code : undefined
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
export function corruptDatabaseError(
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
  //
  // Rendered by BOTH branches. It used to live only in the `replace` branch
  // while the `reindex` branch said "move the files aside as below" — and
  // nothing was below it, because the two were mutually exclusive arms of one
  // ternary. A reader who reached the fallback got no command at all. One
  // binding, so the branches cannot drift apart again (SMI-6961 review F2).
  const moveAside =
    `This is a WAL database, so move whichever of the three files are present:\n` +
    `  mv ${q(path)} ${q(dest)}\n` +
    `  mv ${q(`${path}-wal`)} ${q(`${dest}-wal`)}   # if present\n` +
    `  mv ${q(`${path}-shm`)} ${q(`${dest}-shm`)}   # if present\n`

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
        `does not, move the files aside and let a sync rebuild what it can:\n` +
        moveAside
      : `Recommended: stop every Skillsmith process, including any running MCP server, ` +
        `then move the database set aside and re-run Skillsmith. ` +
        moveAside +
        `\n` +
        `Keep the moved files until you are satisfied nothing is missing.\n`

  return new CorruptDatabaseError({
    path,
    verdict: reason,
    remedyKind,
    sqliteCode,
    cause,
    message:
      `[Skillsmith] The local database at ${path} is corrupt and cannot be read: ${reason}\n` +
      `\n` +
      `Skillsmith does not repair it automatically, because repairing a database ` +
      `another process may have open risks losing that process's writes.\n` +
      `\n` +
      // This paragraph replaces a FALSE one claiming the database "holds no data
      // that cannot be rebuilt from the registry" (SMI-6961 review F1). It is
      // not true, and it was the sentence telling the user there was nothing to
      // lose. `import-local` tags its rows `source='local'` precisely so that
      // registry sync — `--force` included — will not overwrite them, so sync
      // cannot recreate them; quarantine review decisions have no registry
      // source either. Losing those is fail-safe in direction (a skill reverts
      // to `pending`) but it is still loss. This is why every instruction below
      // says `mv` and never `rm`.
      `A sync rebuilds the registry mirror. It does NOT rebuild locally-created ` +
      `rows: skills added with "skillsmith import-local" are deliberately excluded ` +
      `from sync, and quarantine review decisions have no registry source. That is ` +
      `why the steps below move the files aside rather than deleting them.\n` +
      `\n` +
      recommended,
  })
}
