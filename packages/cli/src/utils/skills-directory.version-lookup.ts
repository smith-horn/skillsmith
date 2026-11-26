/**
 * Opening the database for `getSkillsFromDirectory`'s update-status lookup.
 *
 * Extracted from skills-directory.ts (the 500-line standard). SMI-7260: the
 * raw open error is now returned alongside its per-skill classification, so a
 * caller such as `skillsmith list` can report the failure itself, from this
 * one open, rather than opening the database a second time to find out.
 */
import { existsSync } from 'node:fs'
import { SkillVersionRepository, type Database } from '@skillsmith/core'
import { openCliDatabase } from './open-database.js'
import { classifyOpenFailure } from './skills-directory.update-status.js'

export interface VersionLookup {
  versionRepo: SkillVersionRepository | null
  dbConn: Database | null
  /**
   * Set when the lookup is unavailable for a reason that leaves update state
   * UNKNOWABLE, rather than knowably "nothing installed".
   */
  unknownReason?: string | undefined
  /** The error the open threw, when it threw (SMI-7260). */
  openError?: unknown
}

/**
 * Open `dbPath` read-only for the version lookup, or report why it could not.
 *
 * ADR-175 § 5: absence is decided BEFORE the open, because the two drivers
 * disagree about what an absent path does. Native throws SQLITE_CANTOPEN;
 * WASM **succeeds** with an empty in-memory database, so the absence would
 * resurface as a per-skill query failure and render `unknown` — wrong, since
 * an absent database is this contract's one benign case. Reachable on any
 * machine without a native build, which is the normal npx install.
 *
 * Not the precheck ADR § 2 forbids: that bars `existsSync` from classifying a
 * failure CODE, which it cannot do. This asks a different question.
 */
export async function openVersionLookup(dbPath?: string): Promise<VersionLookup> {
  if (!dbPath || !existsSync(dbPath)) return { versionRepo: null, dbConn: null }
  let dbConn: Database | null = null
  try {
    // SMI-5139: this is a pure-read version lookup — open read-only, so no
    // driver writes to dbPath (the native driver would otherwise open it
    // read-write; the WASM driver never writes a database file, SMI-7260).
    dbConn = await openCliDatabase(dbPath, { readonly: true })
    return { versionRepo: new SkillVersionRepository(dbConn), dbConn }
  } catch (error) {
    try {
      dbConn?.close()
    } catch {
      // already unusable — nothing more to free
    }
    return {
      versionRepo: null,
      dbConn: null,
      unknownReason: classifyOpenFailure(error, dbPath),
      openError: error,
    }
  }
}
