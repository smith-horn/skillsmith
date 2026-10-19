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
 * it releases only the claim it printed. The skills-root write lock and
 * skills-root discovery join with A1 steps 2 and 6.
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
  inspectLock,
  releaseLock,
  stateRootLockPaths,
  unverifiedOwnerReason,
  type LockInspection,
} from '@skillsmith/core'

export interface DoctorLocksOptions {
  stateRoot?: string
  release?: string
  unsafeUnverifiedOwner?: boolean
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
      return
    }
    console.log(chalk.bold(`Locks under ${stateRoot}`))
    for (const p of paths) for (const line of describeLock(p, inspectLock(p))) console.log(line)
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
    // Whatever this inspection saw, `expected` binds the release to it, so the
    // flag never removes a lock that appeared or changed after it.
    const insp = inspectLock(target)
    if (insp === null) {
      console.error(chalk.red(`Not released: nothing is at ${target}`))
      process.exitCode = 1
      return
    }
    if (insp.bytes !== null) {
      const why = insp.kind !== 'cant-read' ? unverifiedOwnerReason(insp) : null
      if (why !== null) {
        // Every line but the last, which would repeat the reason printed next.
        for (const line of describeLock(target, insp).slice(0, -1)) console.log(line)
        console.log(chalk.yellow(`Its owner can't be verified: ${why}. Releasing it anyway.`))
      }
      expected = { ino: insp.ino, bytes: insp.bytes }
    }
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

/** Create the `doctor` command (`doctor locks`). */
export function createDoctorCommand(): Command {
  const doctor = new Command('doctor').description(
    "Inspect and repair Skillsmith's own state (locks)"
  )
  doctor
    .command('locks')
    .description("List Skillsmith's lock files, or release a stuck one")
    .option('--state-root <dir>', 'State root to inspect (default: ~/.skillsmith)')
    .option('--release <path>', 'Release this lock, if its owner is known to be gone')
    .option(
      '--unsafe-unverified-owner',
      "With --release: also release a lock whose owner can't be verified gone"
    )
    .action(doctorLocksAction)
  return doctor
}
