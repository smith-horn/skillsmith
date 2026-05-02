/**
 * @fileoverview Pure pass functions for the collision detector
 *               (SMI-4587 Wave 1 Steps 4–5).
 * @module @skillsmith/mcp-server/audit/collision-detector.helpers
 *
 * Each pass is a pure function over `InventoryEntry[]`. The orchestrator
 * (`collision-detector.ts`) wires them together. Wave 1 PR1 shipped the
 * exact-name pass; this file now also exposes the generic-token pass
 * (Step 5). Semantic pass lands in a subsequent PR.
 */

import { GENERIC_TRIGGERS } from '@skillsmith/core'

import type { InventoryEntry } from '../utils/local-inventory.types.js'
import type { AuditId, ExactCollisionFlag, GenericTokenFlag } from './collision-detector.types.js'
import { deriveCollisionId } from './audit-history.js'
import { derivePackDomain, detectGenericTriggerWords } from '../tools/skill-pack-audit.helpers.js'

/**
 * Stable pack-name input passed to {@link derivePackDomain} when running
 * the generic-token pass over the user's local inventory. The user's
 * `~/.claude/` install has no single pack name — using a non-suffixed
 * sentinel forces `derivePackDomain` to fall through Strategy 1 (which
 * keys off `-skills` suffixes) and rely on Strategy 2 (mode of per-entry
 * tags). Centralized here so plan + tests share the same constant.
 */
export const LOCAL_INVENTORY_PACK_NAME = 'local-inventory'

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

/**
 * Detect generic-trigger-word flags across the local inventory.
 *
 * Wraps {@link detectGenericTriggerWords} (the existing skill-pack-audit
 * helper) and adapts the per-skill flag shape to this audit's
 * {@link GenericTokenFlag}. Severity is always `warning` here — even
 * skill-name hits, which the pack helper raises as `error`, are demoted
 * to `warning` because the inventory audit is detection-only and the
 * user's existing local install is grandfathered in (rename is opt-in
 * via Wave 2's apply path).
 *
 * `packDomain` is computed once over the entire inventory using
 * {@link derivePackDomain} with a stable sentinel pack name; Strategy 2
 * (mode-of-tags) is the load-bearing branch since the user's inventory
 * has no single pack name. The same `packDomain` is then passed into
 * every per-entry call, so suggestions like `${packDomain}-${token}`
 * are consistent across the report.
 */
export function detectGenericTokenFlags(
  inventory: ReadonlyArray<InventoryEntry>,
  auditId: AuditId
): GenericTokenFlag[] {
  const stoplist = GENERIC_TRIGGERS
  const tagBag = inventory.map((e) => ({ tags: e.meta?.tags }))
  const packDomain = derivePackDomain(LOCAL_INVENTORY_PACK_NAME, tagBag, stoplist)

  const flags: GenericTokenFlag[] = []
  for (const entry of inventory) {
    const wordFlags = detectGenericTriggerWords(
      entry.meta?.description,
      entry.identifier,
      packDomain,
      stoplist
    )
    for (const wf of wordFlags) {
      flags.push({
        kind: 'generic',
        collisionId: deriveCollisionId(auditId, [entry]),
        identifier: entry.identifier,
        entry,
        matchedTokens: [wf.token],
        severity: 'warning',
        reason: wf.reason,
      })
    }
  }

  // Stable ordering for downstream consumers: identifier asc, then token asc.
  flags.sort((a, b) => {
    const byId = a.identifier.localeCompare(b.identifier)
    if (byId !== 0) return byId
    return (a.matchedTokens[0] ?? '').localeCompare(b.matchedTokens[0] ?? '')
  })
  return flags
}
