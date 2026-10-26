/**
 * @fileoverview `skillsmith doctor locks`: list Skillsmith's lock files and
 * release a stuck one (A1 plan §3.9; test T-M2).
 * @module @skillsmith/cli/commands/doctor
 * @see SMI-7143 (A1 step 0, part 2)
 *
 * A crashed older Skillsmith leaves a bare-PID manifest lock that nothing
 * auto-reclaims, so every later manifest write waits 30 s and fails. This
 * lists the state root's locks with what can be known about each owner, and
 * `--release <path>` removes one under core's `releaseLock` rules: alone, it
 * frees only a claim from this host whose pid is dead; anything else needs
 * `--unsafe-unverified-owner`; a claim it can't read is never released.
 *
 * The state root is `~/.skillsmith` or `--state-root`, resolved with
 * `realpath`, so the paths listed are the real files. `--release` accepts only
 * one of those, matched by the real path of its folder; with the unsafe flag
 * it releases only the claim it inspected, and refuses a lock it could not read
 * or compare.
 *
 * The listing also covers every skills root doctor discovers (the nine client
 * roots, the workspace roots from the current directory, every root the
 * manifest names, and each `--root`; SMI-6531 step 6a-i): each root's
 * `.skillsmith-writes.lock` and its `.reclaim`, with the same fields. Releasing
 * one of those is a later step; `--release` still accepts only the state
 * root's.
 * Exit status: 0 when listed or released; 1 when a release is refused, when the
 * arguments are invalid (an unlisted path, the unsafe flag without --release, a
 * state root that is not a directory), or on an unexpected filesystem error.
 */

import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Command } from 'commander'
import chalk from 'chalk'
import { withTelemetry } from '@skillsmith/core/telemetry'
import {
  discoverRoots,
  inspectLock,
  releaseLock,
  rootLockEntries,
  stateRootLockPaths,
  unverifiedOwnerReason,
  type DiscoverOptions,
  type LockInspection,
} from '@skillsmith/core'
import { collectRoot, doctorRecoveryAction } from './doctor.recovery.js'

export interface DoctorLocksOptions {
  stateRoot?: string
  release?: string
  unsafeUnverifiedOwner?: boolean
  /** `--root <dir>`, repeatable: an extra skills root whose write lock is listed. */
  root?: string[]
  /** @internal Test seam: overrides for root discovery (the nine paths, the home directory, `cwd`). */
  discovery?: Partial<DiscoverOptions>
}

/** `path` with symlinks resolved, or `path` itself when nothing is there. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return path // nothing to list there
    throw err
  }
}

/** The state root doctor reads, with symlinks resolved: `--state-root`, or `~/.skillsmith`. */
export function resolveStateRoot(opt: string | undefined): string {
  return realOrSelf(opt !== undefined ? resolve(opt) : join(homedir(), '.skillsmith'))
}

function describeAge(ageNs: bigint): string {
  if (ageNs < 0n) return 'from the future (clock skew)'
  const s = Number(ageNs / 1_000_000n) / 1000
  return `${s.toFixed(1)} s old`
}

/** The lines `doctor locks` prints for one lock file. */
export function describeLock(path: string, insp: LockInspection | null): string[] {
  if (insp === null) return [`${path}: not present`]
  const lines = [`${path}`]
  if (insp.kind === 'cant-read') {
    lines.push(`  can't read: ${insp.note}; owned by uid ${insp.uid}`)
  } else if (insp.kind === 'unparseable') {
    lines.push(`  unparseable: ${insp.note}`)
  } else {
    const kind = insp.kind === 'v1' ? 'v1 claim' : 'bare-PID claim (older Skillsmith)'
    lines.push(`  ${kind}, pid ${insp.pid}`)
    lines.push(
      insp.host === null
        ? '  host: not recorded'
        : `  host: ${insp.host} (${insp.sameHost ? 'this host' : 'another host'})`
    )
    lines.push(
      insp.pidAliveHere === null
        ? '  pid alive on this host: not checked'
        : `  pid alive on this host: ${insp.pidAliveHere ? 'yes' : 'no'}`
    )
  }
  lines.push(`  ${describeAge(insp.ageNs)}`)
  if (insp.kind !== 'cant-read') {
    const why = unverifiedOwnerReason(insp)
    lines.push(
      why === null
        ? `  release: \`skillsmith doctor locks --release ${path}\``
        : `  release needs --unsafe-unverified-owner: ${why}`
    )
  }
  return lines
}

/** The skills-root write locks: each discovered root's lock and reclaim lock that exists. */
async function printRootLocks(options: DoctorLocksOptions): Promise<void> {
  const found = await discoverRoots({
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
    ...(options.root === undefined || options.root.length === 0 ? {} : { roots: options.root }),
    ...options.discovery,
  })
  const entries = rootLockEntries(found.roots.map((r) => r.root))
  const holding = new Set(entries.filter((e) => e.inspection !== null).map((e) => e.root))
  for (const root of found.roots.map((r) => r.root)) {
    if (!holding.has(root)) continue
    console.log(chalk.bold(`Locks in skills root ${root}`))
    for (const e of entries.filter((x) => x.root === root)) {
      for (const line of describeLock(e.path, e.inspection)) console.log(line)
    }
  }
  console.log(
    `Scanned ${found.roots.length} skills root${found.roots.length === 1 ? '' : 's'}; ` +
      `${holding.size} hold${holding.size === 1 ? 's' : ''} a write lock file.`
  )
  for (const s of found.skipped.filter((x) => x.source === '--root')) {
    console.error(
      chalk.red(`--root ${s.path} could not be used (${s.errno}); nothing was created there.`)
    )
    process.exitCode = 1
  }
}

export async function runDoctorLocks(options: DoctorLocksOptions): Promise<void> {
  const stateRoot = resolveStateRoot(options.stateRoot)
  const paths = stateRootLockPaths(stateRoot)
  let rootExists = true
  try {
    if (!statSync(stateRoot).isDirectory()) {
      console.error(chalk.red(`${stateRoot} is not a directory; give the state root folder.`))
      process.exitCode = 1
      return
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    rootExists = false
  }

  if (options.release === undefined) {
    if (options.unsafeUnverifiedOwner) {
      console.error(chalk.red('--unsafe-unverified-owner applies only with --release <path>.'))
      process.exitCode = 1
      return
    }
    if (!rootExists) {
      console.log(
        `${stateRoot} does not exist, so it holds no locks. Check --state-root if you expected one.`
      )
    } else {
      console.log(chalk.bold(`Locks under ${stateRoot}`))
      for (const p of paths) for (const line of describeLock(p, inspectLock(p))) console.log(line)
    }
    await printRootLocks(options)
    return
  }

  // The lock file itself is never resolved (doctor refuses a symlinked lock);
  // its folder is, so a symlinked folder can't name a file elsewhere.
  const asGiven = resolve(options.release)
  const target = join(realOrSelf(dirname(asGiven)), basename(asGiven))
  if (!paths.includes(target)) {
    console.error(
      chalk.red(`${target} is not a lock doctor lists. It releases only:\n  ${paths.join('\n  ')}`)
    )
    process.exitCode = 1
    return
  }
  let expected: { ino: bigint; bytes: Buffer } | undefined
  if (options.unsafeUnverifiedOwner) {
    // Plan §3.9: the claim and why its owner can't be verified, before acting.
    // The release is bound to this inspection by `expected`; an inspection
    // with nothing to bind to (no lock, or no bytes read) refuses here, since
    // releaseLock's own fresh look could find a different, live lock.
    const insp = inspectLock(target)
    if (insp === null) {
      console.error(chalk.red(`Not released: nothing is at ${target}`))
      process.exitCode = 1
      return
    }
    if (insp.bytes === null) {
      for (const line of describeLock(target, insp)) console.log(line)
      const whose =
        insp.kind === 'cant-read'
          ? ` It belongs to uid ${insp.uid}: run this as that user or an administrator.`
          : ''
      console.error(
        chalk.red(
          `Not released: ${target} could not be read and compared (${insp.note}); ` +
            `nothing was removed.${whose}`
        )
      )
      process.exitCode = 1
      return
    }
    const why = unverifiedOwnerReason(insp)
    if (why !== null) {
      // Every line but the last, which would repeat the reason printed next.
      for (const line of describeLock(target, insp).slice(0, -1)) console.log(line)
      console.log(chalk.yellow(`Its owner can't be verified: ${why}. Releasing it anyway.`))
    }
    expected = { ino: insp.ino, bytes: insp.bytes }
  }
  const result = releaseLock(target, {
    unsafeUnverifiedOwner: options.unsafeUnverifiedOwner === true,
    ...(expected !== undefined ? { expected } : {}),
  })
  if (result.outcome === 'refused') {
    console.error(chalk.red(`Not released: ${result.message}`))
    process.exitCode = 1
    return
  }
  console.log(chalk.green(`Released ${target}.`))
}

export const doctorLocksAction = withTelemetry(runDoctorLocks, {
  source: 'cli',
  extractSkillId: () => 'doctor-locks',
  extractFramework: () => 'cli',
})

/** Create the `doctor` command (`doctor locks`, `doctor recovery`). */
export function createDoctorCommand(): Command {
  const doctor = new Command('doctor').description(
    "Inspect and repair Skillsmith's own state (locks, unfinished updates)"
  )
  doctor
    .command('recovery')
    .description('List what a crashed update left in each skills root (read-only)')
    .option('--root <dir>', 'Also scan this skills root (repeatable)', collectRoot, [] as string[])
    .option('--state-root <dir>', 'State root to read instead of the discovered ones')
    .option('--json', 'Print the listing as JSON')
    .action(doctorRecoveryAction)
  doctor
    .command('locks')
    .description("List Skillsmith's lock files, or release a stuck one")
    .option('--state-root <dir>', 'State root to inspect (default: ~/.skillsmith)')
    .option(
      '--root <dir>',
      "Also list this skills root's write lock (repeatable)",
      collectRoot,
      [] as string[]
    )
    .option('--release <path>', 'Release this lock, if its owner is known to be gone')
    .option(
      '--unsafe-unverified-owner',
      "With --release: also release a lock whose owner can't be verified gone"
    )
    .action(doctorLocksAction)
  return doctor
}
