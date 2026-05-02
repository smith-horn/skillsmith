/**
 * @fileoverview Pure pass functions for the collision detector
 *               (SMI-4587 Wave 1 Step 4).
 * @module @skillsmith/mcp-server/audit/collision-detector.helpers
 *
 * Each pass is a pure function over `InventoryEntry[]`. The orchestrator
 * (`collision-detector.ts`) wires them together. Generic + semantic
 * passes land in subsequent PRs; this PR ships the exact pass only.
 */

import type { InventoryEntry } from '../utils/local-inventory.types.js'
import type { ExactCollisionFlag } from './collision-detector.types.js'
import { deriveCollisionId } from './audit-history.js'

/**
 * Normalize an identifier for case-insensitive equality. Mirrors the
 * normalization OverlapDetector applies for exact-match comparisons
 * (`OverlapDetector.ts:180-183`).
 */
export function normalizeIdentifier(id: string): string {
  return id.trim().toLowerCase()
}

/**
 * Group entries by normalized `identifier`. Returns a Map keyed by the
 * normalized form so callers can find sets-of-2-or-more in O(n).
 */
export function groupByIdentifier(
  entries: ReadonlyArray<InventoryEntry>
): Map<string, InventoryEntry[]> {
  const groups = new Map<string, InventoryEntry[]>()
  for (const entry of entries) {
    const key = normalizeIdentifier(entry.identifier)
    if (!key) continue // empty/whitespace identifier — skip silently
    const bucket = groups.get(key)
    if (bucket) {
      bucket.push(entry)
    } else {
      groups.set(key, [entry])
    }
  }
  return groups
}

/**
 * Detect exact-name collisions across the inventory.
 *
 * A collision is two or more entries that share the same normalized
 * `identifier` (case-insensitive, trimmed). Severity is always `error`.
 *
 * Pure O(n) — single Map pass over the input. Each returned flag carries
 * a `collisionId` derived via `deriveCollisionId(auditId, entries)` so
 * Wave 2's ledger can look it up by id.
 */
export function detectExactCollisions(
  inventory: ReadonlyArray<InventoryEntry>,
  auditId: string
): ExactCollisionFlag[] {
  const groups = groupByIdentifier(inventory)
  const flags: ExactCollisionFlag[] = []

  for (const [, bucket] of groups) {
    if (bucket.length < 2) continue
    const reason = describeCollision(bucket)
    flags.push({
      kind: 'exact',
      collisionId: deriveCollisionId(auditId, bucket),
      identifier: bucket[0]?.identifier ?? '',
      entries: bucket,
      severity: 'error',
      reason,
    })
  }

  // Stable ordering for downstream consumers (report writer relies on this).
  flags.sort((a, b) => a.identifier.localeCompare(b.identifier))
  return flags
}

/**
 * Build the human-readable `reason` string for an exact collision. The
 * message lists the colliding kinds + count so the audit report can
 * render it without re-walking the entries array.
 */
function describeCollision(entries: ReadonlyArray<InventoryEntry>): string {
  const kinds = new Set(entries.map((e) => e.kind))
  if (kinds.size === 1) {
    const k = entries[0]?.kind ?? 'entry'
    return `${entries.length} ${k}s share the same identifier "${entries[0]?.identifier ?? ''}"`
  }
  const kindList = [...kinds].sort().join(' / ')
  return `${entries.length} entries (${kindList}) share the same identifier "${entries[0]?.identifier ?? ''}"`
}
