/**
 * SMI-6531 (A1 step 6b-ii): the owner probe `--clean-staging`'s owner verdict
 * uses (design § 1.2): this host's name, and `probePidAlive`
 * (`config/owned-lock.claim.ts`), the probe owned-lock's reclaim and `doctor
 * locks` share, unchanged. A pid is gone only on `ESRCH`; `EPERM` and every
 * other answer count as alive, and a pid that is not a positive safe integer
 * is not probed.
 *
 * Kept out of the classifier (`skill-recovery.norecord.ts` judges the claim
 * against an injected `OwnerProbe`), which imports no process or filesystem
 * module; the listing and the re-plan under lock 1 pass this one.
 *
 * @module @skillsmith/core/services/skill-recovery.owner
 */
import os from 'node:os'
import { probePidAlive } from '../config/owned-lock.claim.js'
import type { OwnerProbe } from './skill-recovery.clean.types.js'

/** This host's name and the shared pid probe; `kill` is a test seam (default `process.kill`). */
export function defaultOwnerProbe(kill: typeof process.kill = process.kill): OwnerProbe {
  return { host: os.hostname(), alive: (pid) => probePidAlive(pid, kill) }
}
