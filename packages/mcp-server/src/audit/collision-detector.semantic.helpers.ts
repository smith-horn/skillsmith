/**
 * @fileoverview Semantic-overlap pass for SMI-4587 Wave 1 Step 6.
 * @module @skillsmith/mcp-server/audit/collision-detector.semantic.helpers
 *
 * Wraps the existing {@link OverlapDetector} from `@skillsmith/core` and
 * adapts inventory entries to the `TriggerPhraseSkill` shape it expects.
 *
 * Latency invariant: this module is **only imported and exercised** when
 * the resolved audit-mode is `power_user` or `governance`. In
 * `preventative` mode the orchestrator skips this path entirely and
 * therefore never instantiates `EmbeddingService` (the load-bearing
 * 5 ms p95 invariant for the cheap mode).
 *
 * Intentional design: the orchestrator constructs `OverlapDetector` once
 * per audit run and disposes it via `close()` after this helper returns.
 * That keeps ONNX model lifetime bounded and avoids two concurrent model
 * instances on memory-constrained machines (per plan §430).
 */

import type { OverlapDetector, TriggerPhraseSkill } from '@skillsmith/core'

import type { InventoryEntry } from '../utils/local-inventory.types.js'
import { deriveCollisionId } from './audit-history.js'
import type {
  AuditId,
  ExactCollisionFlag,
  SemanticCollisionFlag,
} from './collision-detector.types.js'

/**
 * Adapt an {@link InventoryEntry} to the `TriggerPhraseSkill` shape that
 * `OverlapDetector` expects. Uses `source_path` as the stable id so we
 * can map detector results back to the originating inventory entries
 * via a Map keyed off `source_path`.
 *
 * Empty `triggerSurface[]` -> the entry is filtered out upstream because
 * `OverlapDetector.detectOverlap` would produce a 0-overlap result anyway
 * and the iteration cost (O(n^2)) isn't free.
 */
export function inventoryToTriggerPhraseSkill(entry: InventoryEntry): TriggerPhraseSkill {
  return {
    id: entry.source_path,
    name: entry.identifier,
    triggerPhrases: entry.triggerSurface,
  }
}

/**
 * Build a Set of "exactly-collided" path-pair keys so the semantic pass
 * can skip pairs already flagged by Step 4. Key format is the sorted
 * pair of source_paths joined by `\x00` (NUL — never appears in paths).
 */
function buildExactPairSet(exactCollisions: ReadonlyArray<ExactCollisionFlag>): Set<string> {
  const pairs = new Set<string>()
  for (const flag of exactCollisions) {
    const paths = flag.entries.map((e) => e.source_path).sort()
    // For 3-way+ exact collisions, all sub-pairs are skipped.
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        pairs.add(`${paths[i]}\x00${paths[j]}`)
      }
    }
  }
  return pairs
}

/**
 * Run the semantic-overlap pass over the inventory.
 *
 * Steps:
 *   1. Build an O(1) lookup from `source_path` -> `InventoryEntry`.
 *   2. Adapt entries with non-empty `triggerSurface[]` to
 *      `TriggerPhraseSkill[]`.
 *   3. Call `OverlapDetector.findAllOverlaps` once.
 *   4. Map each non-zero overlap result back to a `SemanticCollisionFlag`,
 *      skipping pairs already flagged by the exact pass.
 *
 * Disposal of the `OverlapDetector` is the **caller's** responsibility
 * — the orchestrator does it after this function returns so it can
 * also be skipped on the cheap path without double-construction.
 */
export async function detectSemanticCollisions(
  inventory: ReadonlyArray<InventoryEntry>,
  exactCollisions: ReadonlyArray<ExactCollisionFlag>,
  auditId: AuditId,
  detector: OverlapDetector
): Promise<SemanticCollisionFlag[]> {
  // Build path -> entry lookup so result mapping is O(1) per overlap.
  const byPath = new Map<string, InventoryEntry>()
  for (const entry of inventory) {
    byPath.set(entry.source_path, entry)
  }

  // Filter to entries with at least one trigger phrase. Empty surfaces
  // can't overlap with anything semantically.
  const candidates = inventory
    .filter((e) => e.triggerSurface.length > 0)
    .map(inventoryToTriggerPhraseSkill)

  if (candidates.length < 2) {
    return []
  }

  const exactPairs = buildExactPairSet(exactCollisions)
  const overlaps = await detector.findAllOverlaps(candidates)

  const flags: SemanticCollisionFlag[] = []
  for (const overlap of overlaps) {
    if (overlap.overlappingPhrases.length === 0) continue

    const sortedPair = [overlap.skillId1, overlap.skillId2].sort()
    const pairKey = `${sortedPair[0]}\x00${sortedPair[1]}`
    if (exactPairs.has(pairKey)) continue

    const entryA = byPath.get(overlap.skillId1)
    const entryB = byPath.get(overlap.skillId2)
    if (!entryA || !entryB) continue

    flags.push({
      kind: 'semantic',
      collisionId: deriveCollisionId(auditId, [entryA, entryB]),
      entryA,
      entryB,
      cosineScore: overlap.overlapScore,
      overlappingPhrases: overlap.overlappingPhrases,
      severity: 'warning',
      reason: buildReason(entryA, entryB, overlap.overlapScore),
    })
  }

  // Stable ordering by entry-pair identifier for deterministic reports.
  flags.sort((a, b) => {
    const aKey = `${a.entryA.identifier}|${a.entryB.identifier}`
    const bKey = `${b.entryA.identifier}|${b.entryB.identifier}`
    return aKey.localeCompare(bKey)
  })

  return flags
}

function buildReason(a: InventoryEntry, b: InventoryEntry, score: number): string {
  const pct = Math.round(score * 100)
  return `"${a.identifier}" and "${b.identifier}" share semantically similar trigger phrases (${pct}% overlap)`
}
