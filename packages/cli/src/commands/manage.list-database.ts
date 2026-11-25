/**
 * SMI-7260: `skillsmith list` reports a database it could not open, on its own.
 *
 * `list` reads the database only to attach update status to installed skills,
 * so an open failure used to surface only as a per-skill "Unknown" note. With
 * no skills installed there was nothing to attach it to: a corrupt database
 * printed "No skills installed" and exited 0. The WASM driver's unstable-read
 * message sends the user to `skillsmith list` to check the database for
 * damage, so `list` must say so even with nothing installed.
 *
 * Extracted from manage.action.ts to keep it under the 500-line standard.
 */
import { existsSync } from 'node:fs'
import chalk from 'chalk'
import { getCliLogger } from '../cli-logger.js'
import { openCliDatabase } from '../utils/open-database.js'
import { sanitizeError } from '../utils/sanitize.js'

const logger = getCliLogger()

/**
 * Open `dbPath` read-only, as `list`'s update-status lookup does, and return
 * the error if that fails. An absent file is not damage (ADR-175 § 5: nothing
 * installed, nothing stale), so it returns `undefined` without opening.
 */
export async function listDatabaseFailure(dbPath: string): Promise<unknown> {
  if (!existsSync(dbPath)) return undefined
  try {
    const db = await openCliDatabase(dbPath, { readonly: true })
    db.close()
    return undefined
  } catch (error) {
    return error
  }
}

/**
 * Print the open failure once, with the error's own remedy (a corruption
 * refusal names the files and the commands), and exit non-zero.
 */
export function reportListDatabaseFailure(error: unknown): void {
  logger.error(`${chalk.red('The local database could not be opened:')} ${sanitizeError(error)}`)
  process.exit(1)
}
