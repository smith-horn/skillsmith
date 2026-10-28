/**
 * The parked index's file name, in a module with no filesystem import, so
 * doctor's classifier-side attribution (SMI-6531 6b-ii) can name the index a
 * park appends to. `parked-index.ts` re-exports it and stays its public home.
 *
 * @module @skillsmith/core/install/parked-index.name
 */

/** The index file's name under the state root (UD26). */
export const PARKED_INDEX_FILE = 'parked-index.jsonl'
