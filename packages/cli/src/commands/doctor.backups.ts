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
 * `--prune` (SMI-6531 6c-ii-b) is a dry run over the same listing: it plans what
 * `--apply` (6c-iii) would delete, and deletes, renames, creates, writes and locks
 * nothing. `--apply` is not registered.
 *
 * The space warning goes to stderr. Exit status: 0 when listed or planned (even
 * when `--apply` would refuse); 1 when a `--root` could not be used, a `--path`
 * names no tree prune lists, a selector is given without `--prune` or is invalid
 * (an empty or blank value, `--keep 0`, a bad number), or on an unexpected filesystem error.
 * @module @skillsmith/cli/commands/doctor.backups
 */

import fs from 'node:fs'
import path from 'node:path'
import chalk from 'chalk'
import { withTelemetry } from '@skillsmith/core/telemetry'
import {
  assignLocks,
  listBackups,
  planPrune,
  type PruneRequest,
  type DiscoverOptions,
  type Discovery,
  type ListBackupsOptions,
  type ParkedUsageOptions,
} from '@skillsmith/core'
import { listingJson } from './doctor.backups.json.js'
import { renderListing } from './doctor.backups.render.js'
import { planJson } from './doctor.backups.plan.json.js'
import { renderPlan } from './doctor.backups.render.plan.js'

export interface DoctorBackupsOptions {
  /** `--root <dir>`, repeatable: an extra skills root to scan. */
  root?: string[]
  stateRoot?: string
  json?: boolean
  client?: string
  /** `--prune`: plan what `--apply` (6c-iii) would delete. Read-only. */
  prune?: boolean
  /** `--older-than <days>`, as the command line gives it. */
  olderThan?: string
  /** `--keep <n>`, as given. Undefined when not given (no commander default, M-KEEP1). */
  keep?: string
  skill?: string
  op?: string
  /** `--path <tree>`, repeatable. */
  path?: string[]
  includeKept?: boolean
  /** `--allow-changed <path>`, repeatable. */
  allowChanged?: string[]
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

/** A directory's native real path; a path that cannot be resolved stays as given. */
function nativeReal(p: string): string {
  const abs = path.resolve(p)
  try {
    return fs.realpathSync.native(abs)
  } catch {
    return abs
  }
}

/**
 * A tree's path: its parent's native real path plus its own name. The tree may
 * itself be a symlink (a copy root can be), and resolving that link would name
 * a different tree; the listing names a copy by its real parent and its leaf.
 */
function treePath(p: string): string {
  const abs = path.resolve(p)
  return path.join(nativeReal(path.dirname(abs)), path.basename(abs))
}

const SELECTORS = [
  'olderThan',
  'keep',
  'skill',
  'op',
  'path',
  'includeKept',
  'allowChanged',
] as const
const FLAG: Record<(typeof SELECTORS)[number], string> = {
  olderThan: '--older-than',
  keep: '--keep',
  skill: '--skill',
  op: '--op',
  path: '--path',
  includeKept: '--include-kept',
  allowChanged: '--allow-changed',
}

/** The options that only mean something with `--prune`, as given. */
function strayFlags(o: DoctorBackupsOptions): string[] {
  return SELECTORS.filter((k) => {
    const v = o[k]
    return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== false
  }).map((k) => FLAG[k])
}

/**
 * The first flag given an empty or whitespace-only value, or null. `path.resolve('')`
 * is the current directory, so an empty `--path` or `--root` would silently select
 * whatever tree the shell stands in; a blank name selects nothing by name. Refused
 * for every mode, listing included.
 */
function blankFlag(o: DoctorBackupsOptions): string | null {
  const given: [string, readonly (string | undefined)[]][] = [
    ['--root', o.root ?? []],
    ['--path', o.path ?? []],
    ['--allow-changed', o.allowChanged ?? []],
    ['--skill', [o.skill]],
    ['--op', [o.op]],
    ['--client', [o.client]],
  ]
  for (const [flag, values] of given) {
    if (values.some((v) => v !== undefined && v.trim() === '')) return flag
  }
  return null
}

/** The request, or the message that says why a value is not usable. */
function requestOf(o: DoctorBackupsOptions, now: number): PruneRequest | string {
  const req: PruneRequest = {
    now,
    includeKept: o.includeKept === true,
    allowChanged: (o.allowChanged ?? []).map(treePath),
  }
  if (o.olderThan !== undefined) {
    const days = /^\d+(\.\d+)?$/.test(o.olderThan) ? Number(o.olderThan) : NaN
    if (!Number.isFinite(days)) return `--older-than needs a number of days, got "${o.olderThan}"`
    req.olderThanDays = days
  }
  if (o.keep !== undefined) {
    if (!/^\d+$/.test(o.keep)) return `--keep needs a whole number, got "${o.keep}"`
    req.keep = Number(o.keep)
    if (req.keep < 1) {
      return '--keep needs at least 1; the newest backup of each folder is always kept.'
    }
  }
  if (o.client !== undefined) req.client = o.client
  if (o.root !== undefined && o.root.length > 0) req.roots = o.root.map(nativeReal)
  if (o.skill !== undefined) req.skill = o.skill
  if (o.op !== undefined) req.op = o.op
  if (o.path !== undefined && o.path.length > 0) req.paths = o.path.map(treePath)
  return req
}

/** `--prune`: list, assign locks, plan; print the plan. Reads only. */
async function runPrune(options: DoctorBackupsOptions): Promise<void> {
  const now = options.now ?? Date.now()
  const req = requestOf(options, now)
  if (typeof req === 'string') {
    console.error(chalk.red(req))
    process.exitCode = 1
    return
  }
  const listing = await listBackups(listOptions({ ...options, now }))
  const plan = planPrune(listing, req, await assignLocks(listing))
  // The warning goes first: a render or JSON failure (a closed stdout is one) must not lose it.
  if (listing.warning.message !== null) console.error(listing.warning.message)
  try {
    if (options.json === true) console.log(JSON.stringify(planJson(plan), null, 2))
    else for (const line of renderPlan(plan)) console.log(line)
  } finally {
    for (const s of listing.discovery.skipped.filter((x) => x.source === '--root')) {
      console.error(
        chalk.red(`--root ${s.path} could not be used (${s.errno}); nothing was created there.`)
      )
      process.exitCode = 1
    }
    for (const u of plan.unmatchedPaths) {
      console.error(chalk.red(`--path ${u.path} matched nothing: ${u.why}.`))
      process.exitCode = 1
    }
    // A notice only: --allow-changed widens nothing it does not name, and the exit status is unchanged.
    const inPlan = new Set([
      ...plan.groups.flatMap((g) => g.items.map((i) => i.copyPath)),
      ...plan.excluded.map((x) => x.copyPath),
    ])
    for (const a of req.allowChanged) {
      if (!inPlan.has(a)) {
        console.error(
          `--allow-changed ${a} names no tree this plan selects or keeps, so it allows nothing.`
        )
      }
    }
  }
}

export async function runDoctorBackups(options: DoctorBackupsOptions): Promise<void> {
  const blank = blankFlag(options)
  if (blank !== null) {
    console.error(chalk.red(`${blank} needs a non-empty value.`))
    process.exitCode = 1
    return
  }
  const stray = strayFlags(options)
  if (options.prune !== true && stray.length > 0) {
    console.error(
      chalk.red(`${stray.join(', ')} only works with --prune (a dry run that deletes nothing).`)
    )
    process.exitCode = 1
    return
  }
  if (options.prune === true) {
    try {
      await runPrune(options)
    } catch (err) {
      console.error(chalk.red(`doctor backups --prune could not plan: ${(err as Error).message}`))
      process.exitCode = 1
    }
    return
  }
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
