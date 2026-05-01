/**
 * @fileoverview Three-pass collision detector for the consumer namespace
 *               audit. Wave 1 PR1+PR2 ship the exact + generic passes;
 *               semantic lands in a subsequent PR.
 * @module @skillsmith/mcp-server/audit/collision-detector
 * @see SMI-4587
 *
 * The detector is detection-only — file mutation lives in Wave 2's
 * rename engine. Each pass is independently invocable for testing.
 */

import type { InventoryEntry } from '../utils/local-inventory.types.js'
import type { InventoryAuditResult } from './collision-detector.types.js'
import { detectExactCollisions, detectGenericTokenFlags } from './collision-detector.helpers.js'
import { newAuditId } from './audit-history.js'

export interface DetectCollisionsOptions {
  /**
   * Pre-allocated audit id. Useful when the caller wants the id to flow
   * into telemetry / report-writer alongside the detector result.
   * Defaults to a fresh ULID.
   */
  auditId?: string
}

/**
 * Run the exact + generic-token collision-detection passes over an
 * inventory snapshot.
 *
 * Semantic-overlap pass returns an empty array in this PR — the surface
 * is stable, so Wave 2/3/4 can consume it now while Step 6 lands in a
 * subsequent PR.
 */
export async function detectCollisions(
  inventory: ReadonlyArray<InventoryEntry>,
  opts: DetectCollisionsOptions = {}
): Promise<InventoryAuditResult> {
  const startedAt = process.hrtime.bigint()
  const auditId = (opts.auditId ?? newAuditId()) as InventoryAuditResult['auditId']

  const exactStart = process.hrtime.bigint()
  const exactCollisions = detectExactCollisions(inventory, auditId)
  const exactDuration = nsToMs(process.hrtime.bigint() - exactStart)

  const genericStart = process.hrtime.bigint()
  const genericFlags = detectGenericTokenFlags(inventory, auditId)
  const genericDuration = nsToMs(process.hrtime.bigint() - genericStart)

  // Step 6 placeholder — empty array until the semantic-pass PR lands.
  const semanticCollisions: InventoryAuditResult['semanticCollisions'] = []

  const totalDuration = nsToMs(process.hrtime.bigint() - startedAt)
  const errorCount = exactCollisions.length
  const warningCount = genericFlags.length + semanticCollisions.length

  return {
    auditId,
    inventory: [...inventory],
    exactCollisions,
    genericFlags,
    semanticCollisions,
    summary: {
      totalEntries: inventory.length,
      totalFlags: errorCount + warningCount,
      errorCount,
      warningCount,
      durationMs: totalDuration,
      passDurations: {
        exact: exactDuration,
        generic: genericDuration,
        semantic: 0,
      },
    },
  }
}

function nsToMs(ns: bigint): number {
  return Number(ns) / 1_000_000
}

// Re-export the public surface so consumers can import everything from
// '@skillsmith/mcp-server/audit/collision-detector'. Wave 2/4 imports
// will route through this file.
export type {
  ExactCollisionFlag,
  GenericTokenFlag,
  InventoryAuditResult,
  SemanticCollisionFlag,
} from './collision-detector.types.js'
export { detectExactCollisions, detectGenericTokenFlags } from './collision-detector.helpers.js'
