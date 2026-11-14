/**
 * @fileoverview `skillsmith doctor backups`: list the set-aside folders and
 * kept backups Skillsmith holds, and warn when they take a lot of space
 * (A1 plan §3.9; SMI-6531 step 6c-ii-a; UD22, UD66).
 *
 * Read-only. It lists and measures; it deletes, renames, creates, writes and
 * locks nothing, and never creates a skills root or a state root. It scans the
 * update backup store (`<state root>/backups/update/`), every `.skillsmith-parked`
 * area under each skills root, and areas only the parked index names, and
 * reports the older MCP backup store (`~/.claude/skills/.backups`) in its own
 * section as not managed by prune. `--root` adds a skills root to scan AND
 * narrows the listing to what belongs to the roots given (what it hid is
 * counted, never silent); `--client` narrows the rows to one client.
 *
 * The space warning goes to stderr. Exit status: 0 when listed; 1 when a
 * `--root` could not be used, or on an unexpected filesystem error.
 * @module @skillsmith/cli/commands/doctor.backups
 */

import chalk from 'chalk'
import { withTelemetry } from '@skillsmith/core/telemetry'
import {
  listBackups,
  type DiscoverOptions,
  type Discovery,
  type ListBackupsOptions,
  type ParkedUsageOptions,
} from '@skillsmith/core'
import { listingJson } from './doctor.backups.json.js'
import { renderListing } from './doctor.backups.render.js'

export interface DoctorBackupsOptions {
  /** `--root <dir>`, repeatable: an extra skills root to scan. */
  root?: string[]
  stateRoot?: string
  json?: boolean
  client?: string
  /** A discovery already made (a doctor action passes the one it acted on). */
  discovered?: Discovery
  /** @internal Test seam: overrides for root discovery (the nine paths, the home directory, `cwd`). */
  discovery?: Partial<DiscoverOptions>
  /** @internal Test seam: the warning's `statfs` and thresholds. */
  parkedUsage?: ParkedUsageOptions
  /** @internal Test seam: the clock. */
  now?: number
  /** @internal Test seam: replaces the size walk. */
  measure?: ListBackupsOptions['measure']
}

const listOptions = (o: DoctorBackupsOptions): ListBackupsOptions => ({
  ...(o.stateRoot === undefined ? {} : { stateRoot: o.stateRoot }),
  ...(o.root === undefined || o.root.length === 0 ? {} : { roots: o.root }),
  ...(o.client === undefined ? {} : { client: o.client }),
  ...(o.discovered === undefined ? {} : { discovered: o.discovered }),
  ...(o.discovery === undefined ? {} : { discovery: o.discovery }),
  ...(o.parkedUsage === undefined ? {} : { usage: o.parkedUsage }),
  ...(o.now === undefined ? {} : { now: o.now }),
  ...(o.measure === undefined ? {} : { measure: o.measure }),
})

export async function runDoctorBackups(options: DoctorBackupsOptions): Promise<void> {
  let listing: Awaited<ReturnType<typeof listBackups>>
  try {
    listing = await listBackups(listOptions(options))
  } catch (err) {
    console.error(chalk.red(`doctor backups could not list: ${(err as Error).message}`))
    process.exitCode = 1
    return
  }
  // The warning goes first: a render or JSON failure (a closed stdout is one) must not lose it.
  if (listing.warning.message !== null) console.error(listing.warning.message)
  try {
    if (options.json === true) console.log(JSON.stringify(listingJson(listing), null, 2))
    else for (const line of renderListing(listing)) console.log(line)
  } finally {
    for (const s of listing.discovery.skipped.filter((x) => x.source === '--root')) {
      console.error(
        chalk.red(`--root ${s.path} could not be used (${s.errno}); nothing was created there.`)
      )
      process.exitCode = 1
    }
  }
}

/**
 * UD66: after a doctor action that set a folder aside, prints the space
 * warning (to stderr) when the set-aside folders are over their threshold or
 * some could not be measured. Never throws: the action it follows has already
 * finished, so a failure here is one stderr line and changes no exit status.
 */
export async function printParkedUsageWarning(options: DoctorBackupsOptions): Promise<void> {
  try {
    const listing = await listBackups(listOptions(options))
    if (listing.warning.message !== null) console.error(listing.warning.message)
  } catch (err) {
    console.error(
      `Could not check how much space Skillsmith's set-aside folders take: ${(err as Error).message}`
    )
  }
}

export const doctorBackupsAction = withTelemetry(runDoctorBackups, {
  source: 'cli',
  extractSkillId: () => 'doctor-backups',
  extractFramework: () => 'cli',
})
