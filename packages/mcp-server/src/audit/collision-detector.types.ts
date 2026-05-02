/**
 * @fileoverview Type vocabulary for the collision detector (SMI-4587 Wave 1 Step 1).
 * @module @skillsmith/mcp-server/audit/collision-detector.types
 *
 * Re-exports the collision flag shapes from local-inventory.types and adds
 * the InventoryAuditResult container. Public surface for Wave 2/3/4.
 */

import type {
  AuditId,
  CollisionId,
  ExactCollisionFlag,
  InventoryEntry,
} from '../utils/local-inventory.types.js'

export type { AuditId, CollisionId, ExactCollisionFlag, InventoryEntry }

/**
 * Semantic-overlap collision (filled in by Wave 1 PR2 — Step 6 semantic pass).
 * Type is stable now so the result-writer can reference the field.
 */
export interface SemanticCollisionFlag {
  kind: 'semantic'
  collisionId: CollisionId
  entryA: InventoryEntry
  entryB: InventoryEntry
  /** From `OverlapDetector.detectOverlap.overlapScore`. */
  cosineScore: number
  overlappingPhrases: Array<{
    phrase1: string
    phrase2: string
    similarity: number
  }>
  severity: 'warning'
  reason: string
}

/**
 * Generic-token quality flag — Step 5 in the next PR plumbs this in via the
 * existing `TriggerQualityEntry` from `skill-pack-audit.types.ts`. Aliased
 * here to keep imports stable.
 */
export interface GenericTokenFlag {
  kind: 'generic'
  collisionId: CollisionId
  identifier: string
  entry: InventoryEntry
  matchedTokens: string[]
  severity: 'warning'
  reason: string
}

/**
 * Top-level result of `detectCollisions`. Contains the inventory snapshot
 * + flags from each pass + summary metrics.
 *
 * Wave 1 PR1 (this PR) populates `auditId`, `inventory`, and
 * `exactCollisions` only. `genericFlags` and `semanticCollisions` are empty
 * arrays until subsequent PRs land Step 5 + Step 6.
 */
export interface InventoryAuditResult {
  auditId: AuditId
  inventory: InventoryEntry[]
  exactCollisions: ExactCollisionFlag[]
  genericFlags: GenericTokenFlag[]
  semanticCollisions: SemanticCollisionFlag[]
  summary: {
    totalEntries: number
    totalFlags: number
    errorCount: number
    warningCount: number
    durationMs: number
    passDurations: { exact: number; generic: number; semantic: number }
  }
}
