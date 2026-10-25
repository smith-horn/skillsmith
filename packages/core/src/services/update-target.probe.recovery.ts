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
 *  - `stagingRecordsUnreadable` (row 0b, for whoever builds the run's
 *    `plan`): true when any record in the root's staging is unreadable, or
 *    the staging can't be read at all.
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
import type { RecoveryPendingChecker } from './update-target.probe.types.js'

/** The scan of `skillsDir`'s staging, resolved the way `bindSkillsRoot` binds the root. */
async function scanRoot(skillsDir: string): Promise<RecordScan> {
  const root = await fs.promises.realpath(path.resolve(skillsDir))
  return scanStagingRecords(root, path.join(root, STAGING_DIR_NAME))
}

/** Row 3: does a verified record of this root name `dir`? Throws when that can't be decided. */
export const defaultRecoveryPendingChecker: RecoveryPendingChecker = async ({ skillsDir, dir }) => {
  const scan = await scanRoot(skillsDir)
  if (!scan.ok) {
    throw Object.assign(new Error(`the update records in ${scan.path} could not be listed`), {
      code: scan.errno,
    })
  }
  let realDir = dir
  try {
    realDir = await fs.promises.realpath(dir)
  } catch {
    // A missing folder (a crash between the renames) is matched by its path.
  }
  return recordsNaming(scan.pending, { realDir, comparedPath: dir }).length > 0
}

/**
 * Row 0b: true when `skillsDir`'s staging holds an unreadable record, or
 * can't be read. Fails closed: an error resolving the root or listing its
 * staging is true, never "nothing to block".
 */
export async function stagingRecordsUnreadable(skillsDir: string): Promise<boolean> {
  try {
    const scan = await scanRoot(skillsDir)
    return !scan.ok || scan.unreadable.length > 0
  } catch (err) {
    // A root that doesn't exist has no staging and no records.
    return (err as NodeJS.ErrnoException | null)?.code !== 'ENOENT'
  }
}
