/**
 * The parked index's file name and the parked area's directory name, in a
 * module with no filesystem import (with the name a park gives what it moves), so doctor's classifier-side attribution
 * (SMI-6531 6b-ii) can name the index a park appends to, and its install
 * classifier (8-i-a-2) the area a park moves into. `parked-index.ts`
 * re-exports the index name and stays its public home;
 * `park-tree.destination.ts` and `prune.list.parked.ts` re-export the area's.
 *
 * @module @skillsmith/core/install/parked-index.name
 */

/** The index file's name under the state root (UD26). */
export const PARKED_INDEX_FILE = 'parked-index.jsonl'

/** The parked area's directory under a parent: `<parent>/.skillsmith-parked/<opId>/` (ADR-166 D-3). */
export const PARKED_DIR_NAME = '.skillsmith-parked'

/** `name` is what a park names the entry it moved from `<parent>/<base>`: `<base>-<8 hex>`. */
export function isParkedNameOf(name: string, base: string): boolean {
  return (
    name.length === base.length + 9 &&
    name.startsWith(`${base}-`) &&
    /^[0-9a-f]{8}$/.test(name.slice(base.length + 1))
  )
}
