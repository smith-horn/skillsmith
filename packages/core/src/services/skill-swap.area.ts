/**
 * SMI-6531 (A1 steps 4a, 6a-i): where the backup area of one skill folder is,
 * with no filesystem access (A1 plan §3.3 "bound paths", UD22).
 *
 * The area is `<stateRoot>/backups/update/<client>/<rootKey>/<dirName>/` under
 * the native realpath of the state root; `rootKey` is the first 16 hex
 * characters of sha256 over R, the skills root's realpath. Pure so doctor's
 * classifier can re-derive the area a record names without a read of its own
 * (`skill-recovery.classify.ts`); `skill-swap.publish.ts` and
 * `skill-swap.sidecar.ts` re-export both functions.
 *
 * @module @skillsmith/core/services/skill-swap.area
 */
import crypto from 'node:crypto'
import path from 'node:path'

/** First 16 hex characters of sha256 over R, the skills root's realpath (UD22). */
export const rootKeyOf = (root: string): string =>
  crypto.createHash('sha256').update(root).digest('hex').slice(0, 16)

/** `<stateRootReal>/backups/update/<client>/<rootKey>/<dirName>`. */
export function backupAreaPath(
  stateRootReal: string,
  client: string,
  root: string,
  dirName: string
): string {
  return path.join(stateRootReal, 'backups', 'update', client, rootKeyOf(root), dirName)
}
