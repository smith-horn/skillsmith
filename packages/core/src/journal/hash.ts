/**
 * @fileoverview sha256 helpers shared by the journal writer + reader.
 * @module @skillsmith/core/journal/hash
 */

import { createHash } from 'node:crypto'

/** SHA-256 hex digest of arbitrary string/Buffer content. */
export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Genesis constant the first journal record's `prev_hash` chains from.
 * Computed (not a literal hex string) so the source documents its own
 * derivation rather than presenting an opaque magic value.
 */
export const JOURNAL_GENESIS_HASH = sha256Hex('skillsmith-journal-genesis-v1')
