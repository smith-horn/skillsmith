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
 *    same match as the write's step 3. It returns `{ error }`, naming the
 *    path that failed, when the root can't be resolved, its staging can't be
 *    listed or a staging entry can't be `lstat`ed, and the probe reports
 *    `probe-failed`: a check that could not run never reads as "not named".
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
import { errnoOf } from './update-target.probe.types.js'
import type { ProbeError, RecoveryPendingChecker } from './update-target.probe.types.js'

/**
 * The scan of `skillsDir`'s staging, resolved the way `bindSkillsRoot` binds
 * the root. `asGiven` maps a path the scan names back under `skillsDir` as the
 * caller gave it (resolved lexically, `path.resolve`, never through links):
 * a failure must never name where a symlinked root points
 * (`update-target.probe.ts`'s fileoverview), and the scan's paths are under
 * the resolved root.
 */
async function scanRoot(
  skillsDir: string
): Promise<{ scan: RecordScan; asGiven: (p: string) => string }> {
  const given = path.resolve(skillsDir)
  const root = await fs.promises.realpath(given)
  const scan = await scanStagingRecords(root, path.join(root, STAGING_DIR_NAME))
  const asGiven = (p: string): string => {
    const rel = path.relative(root, p)
    const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
    return outside ? given : path.join(given, rel)
  }
  return { scan, asGiven }
}

/**
 * Row 3: does a verified record of this root name `dir`? `{ error }`, naming
 * the path that failed, when that can't be decided: the root can't be
 * resolved, its staging can't be listed, a staging entry can't be `lstat`ed,
 * or `dir`'s realpath fails other than as missing.
 */
export const defaultRecoveryPendingChecker: RecoveryPendingChecker = async ({ skillsDir, dir }) => {
  let scanned: Awaited<ReturnType<typeof scanRoot>>
  try {
    scanned = await scanRoot(skillsDir)
  } catch (err) {
    return { error: { path: path.resolve(skillsDir), errno: errnoOf(err) } }
  }
  const { scan, asGiven } = scanned
  if (!scan.ok) return { error: { path: asGiven(scan.path), errno: scan.errno } }
  let realDir = dir
  try {
    realDir = await fs.promises.realpath(dir)
  } catch (err) {
    // A missing folder (a crash between the renames) is matched by its path.
    const code = errnoOf(err)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return { error: { path: dir, errno: code } }
  }
  return recordsNaming(scan.pending, { realDir, comparedPath: dir }).length > 0
}

/**
 * Row 0b: the opIds of `skillsDir`'s unreadable records (empty when none, or
 * when the root doesn't exist). `ok: false` when the root can't be resolved,
 * its staging can't be listed or a staging entry can't be `lstat`ed: the
 * caller reports `probe-failed`, never "nothing to block".
 */
export async function unreadableStagingRecords(
  skillsDir: string
): Promise<{ ok: true; opIds: string[] } | { ok: false; error: ProbeError }> {
  let scanned: Awaited<ReturnType<typeof scanRoot>>
  try {
    scanned = await scanRoot(skillsDir)
  } catch (err) {
    const errno = errnoOf(err)
    // A root that doesn't exist has no staging and no records.
    if (errno === 'ENOENT') return { ok: true, opIds: [] }
    return { ok: false, error: { path: path.resolve(skillsDir), errno } }
  }
  const { scan, asGiven } = scanned
  if (!scan.ok) return { ok: false, error: { path: asGiven(scan.path), errno: scan.errno } }
  return { ok: true, opIds: scan.unreadable.map((r) => r.opId) }
}
