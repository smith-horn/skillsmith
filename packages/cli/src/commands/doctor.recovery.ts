/**
 * @fileoverview `skillsmith doctor recovery`: list what a crashed update left
 * (A1 plan §3.9; SMI-6531 step 6a-i).
 *
 * Read-only. It scans every skills root doctor knows (all nine client roots,
 * the workspace roots from the current directory, every root the manifest names
 * and each `--root`), deduplicated by real path, and for each lists the
 * operation directories under `.skillsmith-staging/` with their state, the
 * publish sub-state of any keep, what each action would do, and any leftover
 * probe. It creates, writes, renames and removes nothing: a root with no
 * staging directory is reported as having none, never given one.
 *
 * The listing names what each action would do and which are offered. Every
 * action is supported (`doctor.recovery.action.ts`): `--apply`, `--undo`,
 * `--park`, `--clean-staging` and `--abandon` (SMI-6531 steps 6a-iii, 6b-i,
 * 6b-ii and 6b-iii; a no-record op dir shows its owner verdict, and the
 * `--clean-staging` line's derived hint says when `--unsafe-unverified-owner`
 * would let it act).
 * Exit status: 0 when listed; 1 when a `--root` could not be used or on an
 * unexpected filesystem error.
 * @module @skillsmith/cli/commands/doctor.recovery
 */

import chalk from 'chalk'
import { withTelemetry } from '@skillsmith/core/telemetry'
import {
  discoverRoots,
  listRecovery,
  type DiscoverOptions,
  type ListOptions,
} from '@skillsmith/core'
import { recoveryJson, renderRecovery } from './doctor.recovery.render.js'

export interface DoctorRecoveryOptions {
  /** `--root <dir>`, repeatable: an extra skills root to scan. */
  root?: string[]
  stateRoot?: string
  json?: boolean
  /** @internal Test seam: overrides for root discovery (the nine paths, the home directory, `cwd`). */
  discovery?: Partial<DiscoverOptions>
  /** @internal Test seam (6b-ii): the listing's owner probe. */
  listOptions?: Pick<ListOptions, 'ownerProbe'>
}

export async function runDoctorRecovery(options: DoctorRecoveryOptions): Promise<void> {
  const found = await discoverRoots({
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
    ...(options.root === undefined || options.root.length === 0 ? {} : { roots: options.root }),
    ...options.discovery,
  })
  // The state roots too (6b-ii): a no-record op dir's keep area and a park intent's
  // state root are judged against them, as `--clean-staging`, `--apply` and `--undo` do.
  const reports = await listRecovery(
    found.roots.map((r) => r.root),
    { ...options.listOptions, stateRoots: found.stateRoots }
  )
  if (options.json === true) {
    console.log(JSON.stringify(recoveryJson(found, reports), null, 2))
  } else {
    for (const line of renderRecovery(found, reports)) console.log(line)
  }
  for (const s of found.skipped.filter((x) => x.source === '--root')) {
    console.error(
      chalk.red(`--root ${s.path} could not be used (${s.errno}); nothing was created there.`)
    )
    process.exitCode = 1
  }
}

export const doctorRecoveryAction = withTelemetry(runDoctorRecovery, {
  source: 'cli',
  extractSkillId: () => 'doctor-recovery',
  extractFramework: () => 'cli',
})

/** Commander's collector for a repeatable `--root <dir>`. */
export const collectRoot = (value: string, previous: string[]): string[] => [...previous, value]
