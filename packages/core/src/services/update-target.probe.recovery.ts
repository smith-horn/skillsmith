/**
 * @fileoverview The `.skillsmith-staging/` record check for the update
 * eligibility gate (SMI-6532, A2 §4.2, §4.3 rows 0b and 3), on A1's record
 * scan (SMI-6531 step 5, `skill-swap.records.ts`).
 * @module @skillsmith/core/services/update-target.probe.recovery
 * @see docs/internal/implementation/update-safety-and-source-resolution.md §3.3 step 3, §4.2
 *
 * The probe and the write use the same scan, so a dry run blocks exactly the
 * skills the write would refuse (owner decision 2026-10-24, replacing the
 * placeholder this file held until A1's `record.json` existed):
 *
 *  - `defaultRecoveryPendingChecker` (row 3): true when a verified record of
 *    this root names the target's `realpath` or the target path itself, the
 *    same match as the write's step 3. It throws, so the probe reports
 *    `probe-failed`, when the root can't be resolved or its staging can't be
 *    listed: a check that could not run never reads as "not named".
 *  - `unreadableStagingRecords` (row 0b, for whoever builds the run's
 *    `plan`): the opIds of the root's unreadable records, which block every
 *    skill in it and are what `doctor recovery --park <opId>` takes. A
 *    staging that can't be listed is not 0b: like the write (`staging-unsafe`)
 *    and row 3's checker, it is a `probe-failed` error.
 *
 * `RecoveryPendingChecker` is imported from `update-target.probe.types.ts`,
 * NOT from `update-target.probe.ts`: this module and `probe.ts` never import
 * from each other (see `update-target.probe.types.ts`'s fileoverview).
 */

import fs from 'node:fs'
import path from 'node:path'

import { recordsNaming, scanStagingRecords } from './skill-swap.records.js'
import type { RecordScan } from './skill-swap.records.js'
import { STAGING_DIR_NAME } from './skill-write-lock.types.js'
import type { ProbeError, RecoveryPendingChecker } from './update-target.probe.types.js'

/** The scan of `skillsDir`'s staging, resolved the way `bindSkillsRoot` binds the root. */
async function scanRoot(skillsDir: string): Promise<RecordScan> {
  const root = await fs.promises.realpath(path.resolve(skillsDir))
  return scanStagingRecords(root, path.join(root, STAGING_DIR_NAME))
}

/** Row 3: does a verified record of this root name `dir`? Throws when that can't be decided. */
export const defaultRecoveryPendingChecker: RecoveryPendingChecker = async ({ skillsDir, dir }) => {
  const scan = await scanRoot(skillsDir)
  if (!scan.ok) {
    throw Object.assign(new Error(listingFailure(skillsDir, scan)), { code: scan.errno })
  }
  let realDir = dir
  try {
    realDir = await fs.promises.realpath(dir)
  } catch (err) {
    // A missing folder (a crash between the renames) is matched by its path.
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
  }
  return recordsNaming(scan.pending, { realDir, comparedPath: dir }).length > 0
}

const listingFailure = (skillsDir: string, scan: { path: string; errno: string }): string =>
  `the update records in ${path.join(skillsDir, STAGING_DIR_NAME)} could not be listed ` +
  `(${scan.path}: ${scan.errno})`

/**
 * Row 0b: the opIds of `skillsDir`'s unreadable records (empty when none, or
 * when the root doesn't exist). `ok: false` when the root can't be resolved
 * or its staging can't be listed: the caller reports `probe-failed`, never
 * "nothing to block".
 */
export async function unreadableStagingRecords(
  skillsDir: string
): Promise<{ ok: true; opIds: string[] } | { ok: false; error: ProbeError }> {
  let scan: Awaited<ReturnType<typeof scanRoot>>
  try {
    scan = await scanRoot(skillsDir)
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException | null)?.code
    // A root that doesn't exist has no staging and no records.
    if (errno === 'ENOENT') return { ok: true, opIds: [] }
    return { ok: false, error: { path: skillsDir, errno: errno ?? 'UNKNOWN' } }
  }
  if (!scan.ok) return { ok: false, error: { path: scan.path, errno: scan.errno } }
  return { ok: true, opIds: scan.unreadable.map((r) => r.opId) }
}
