/**
 * SMI-6531 (A1 step 6c-ii-b): the path of lock 1′, the lock a parked area, or
 * a state-root backup tree whose skills root is gone, is pruned under (PLAN
 * lock table row 1′, UD62, UD63).
 *
 * `<stateRoot>/locks/parked-<key>.lock`, `<key>` being the first 16 hex
 * characters of sha256 over the UTF-8 bytes of the native realpath of the
 * area (or of `<stateRoot>/backups/update/<client>/<rootKey>/` for UD62).
 * `withFileLock` is passed the target without `.lock` and derives the lock
 * file (`file-lock.ts`), so this returns the lock FILE, the path a reader
 * orders by (UD60). Pure: no fs. 6c-iii adds the `withFileLock` wrapper here.
 *
 * @module @skillsmith/core/config/file-lock.parked
 */
import { createHash } from 'node:crypto'
import path from 'node:path'

/** Hex characters of the digest kept in the lock's name (PLAN:915). */
const PARKED_LOCK_KEY_HEX = 16

/** The lock 1′ file for `areaReal`, a native realpath. */
export function parkedLockPath(stateRoot: string, areaReal: string): string {
  const key = createHash('sha256')
    .update(areaReal, 'utf8')
    .digest('hex')
    .slice(0, PARKED_LOCK_KEY_HEX)
  return path.join(stateRoot, 'locks', `parked-${key}.lock`)
}
