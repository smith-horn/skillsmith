/**
 * @fileoverview Three-pass collision detector for the consumer namespace
 *               audit. Wave 1 PR1+PR2 ship the exact + generic passes;
 *               PR #3 wires the semantic pass (gated by audit_mode) +
 *               unmanaged-skill bootstrap + audit-mode resolver dispatch.
 * @module @skillsmith/mcp-server/audit/collision-detector
 * @see SMI-4587
 *
 * The detector is detection-only — file mutation lives in Wave 2's
 * rename engine. Each pass is independently invocable for testing.
 *
 * Audit-mode dispatch (plan §6b):
 *   - 'off'                        -> short-circuit, empty result, no telemetry
 *   - 'preventative'               -> exact + generic only (no embedding service)
 *   - 'power_user' / 'governance'  -> + semantic-overlap pass via OverlapDetector
 *
 * Latency invariant (plan §426): in `preventative` mode the
 * `OverlapDetector` is **not instantiated** and `EmbeddingService` is
 * **not touched**. Tests assert zero invocations.
 */

import { OverlapDetector } from '@skillsmith/core'
import { resolveAuditMode, type AuditMode } from '@skillsmith/core/config/audit-mode'
import type { Tier as AuditModeTier } from '@skillsmith/core/config/audit-mode'

import type { InventoryEntry, ScanWarning } from '../utils/local-inventory.types.js'
import type { InventoryAuditResult } from './collision-detector.types.js'
import { detectExactCollisions, detectGenericTokenFlags } from './collision-detector.helpers.js'
import { newAuditId } from './audit-history.js'
import { bootstrapUnmanagedSkills, type BootstrapFn } from './bootstrap-unmanaged.js'
import { detectSemanticCollisions } from './collision-detector.semantic.helpers.js'

export interface DetectCollisionsOptions {
  /**
   * Pre-allocated audit id. Useful when the caller wants the id to flow
   * into telemetry / report-writer alongside the detector result.
   * Defaults to a fresh ULID.
   */
  auditId?: string
  /**
   * Subscription tier of the caller. Drives the default audit mode via
   * {@link resolveAuditMode}. When omitted, defaults to `'community'`
   * (the cheapest fail-safe).
   */
  tier?: AuditModeTier
  /**
   * Explicit audit-mode override (read by the caller from
   * `~/.skillsmith/config.json` `audit_mode` or `SKILLSMITH_AUDIT_MODE`).
   * When set + valid, this beats the tier default.
   */
  auditModeOverride?: AuditMode | null
  /**
   * Bootstrap callback for unmanaged SKILL.md entries (Step 6a). Defaults
   * to a no-op until PR #4 wires the real `indexLocalSkill` core helper.
   */
  bootstrapFn?: BootstrapFn
}

/**
 * Run the configured collision-detection passes over an inventory
 * snapshot.
 *
 * Returns an `InventoryAuditResult` whose `summary.passDurations` records
 * the wall-clock cost of each pass. The semantic pass duration is `0`
 * when the resolved audit-mode short-circuits past it (preventative /
 * off).
 */
export async function detectCollisions(
  inventory: ReadonlyArray<InventoryEntry>,
  opts: DetectCollisionsOptions = {}
): Promise<InventoryAuditResult> {
  const startedAt = process.hrtime.bigint()
  const auditId = (opts.auditId ?? newAuditId()) as InventoryAuditResult['auditId']

  // Step 6b: resolve the audit mode before any pass runs.
  const auditMode = resolveAuditMode({
    tier: opts.tier ?? 'community',
    override: opts.auditModeOverride ?? null,
  })

  // Step 6b: 'off' short-circuits — empty result, zero passes, no
  // telemetry. The orchestrator returns immediately so callers can
  // safely no-op.
  if (auditMode === 'off') {
    return emptyResult(auditId, inventory)
  }

  // Bootstrap warnings flow into the audit result via the report writer
  // in PR #4 (Step 8). Until then we collect them locally so the surface
  // is stable; tests assert on the collected list via a helper.
  const bootstrapWarnings: ScanWarning[] = []

  // Step 6a: bootstrap unmanaged skills before the exact pass so any
  // newly-discovered manifest data shows up as `meta.author` on
  // subsequent re-scans (handled by the caller — this PR only plumbs).
  const bootstrap = await bootstrapUnmanagedSkills(inventory, {
    bootstrapFn: opts.bootstrapFn,
  })
  bootstrapWarnings.push(...bootstrap.warnings)

  // Step 4: exact-name pass.
  const exactStart = process.hrtime.bigint()
  const exactCollisions = detectExactCollisions(inventory, auditId)
  const exactDuration = nsToMs(process.hrtime.bigint() - exactStart)

  // Step 5: generic-token pass.
  const genericStart = process.hrtime.bigint()
  const genericFlags = detectGenericTokenFlags(inventory, auditId)
  const genericDuration = nsToMs(process.hrtime.bigint() - genericStart)

  // Step 6: semantic-overlap pass — only when the resolved mode opts in.
  // Latency invariant: instantiate `OverlapDetector` only when needed
  // so `EmbeddingService` is never touched in `preventative` mode.
  let semanticCollisions: InventoryAuditResult['semanticCollisions'] = []
  let semanticDuration = 0
  if (needsSemanticPass(auditMode)) {
    const detector = new OverlapDetector()
    try {
      const semanticStart = process.hrtime.bigint()
      semanticCollisions = await detectSemanticCollisions(
        inventory,
        exactCollisions,
        auditId,
        detector
      )
      semanticDuration = nsToMs(process.hrtime.bigint() - semanticStart)
    } finally {
      detector.close()
    }
  }

  const totalDuration = nsToMs(process.hrtime.bigint() - startedAt)
  const errorCount = exactCollisions.length
  const warningCount = genericFlags.length + semanticCollisions.length

  // bootstrapWarnings is collected for PR #4's report writer; emitted
  // through `getLastBootstrapWarnings()` to avoid widening the public
  // result shape ahead of Step 8.
  lastBootstrapWarnings = bootstrapWarnings

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
        semantic: semanticDuration,
      },
    },
  }
}

/**
 * Module-private cache of the most recent bootstrap warnings. Tests
 * (and PR #4's report writer) read this immediately after invoking
 * `detectCollisions`. Module-scoped is acceptable because the detector
 * is invoked sequentially per process — there is no concurrency on this
 * surface in Wave 1.
 */
let lastBootstrapWarnings: ScanWarning[] = []

/**
 * Internal hook used by tests + PR #4 report writer. Returns the
 * bootstrap warnings produced by the most recent `detectCollisions`
 * call. Returns an empty array when the most recent call short-circuited
 * (`auditMode === 'off'`) or no unmanaged skills failed to bootstrap.
 */
export function getLastBootstrapWarnings(): ReadonlyArray<ScanWarning> {
  return lastBootstrapWarnings
}

function needsSemanticPass(mode: AuditMode): boolean {
  return mode === 'power_user' || mode === 'governance'
}

function emptyResult(
  auditId: InventoryAuditResult['auditId'],
  inventory: ReadonlyArray<InventoryEntry>
): InventoryAuditResult {
  // 'off' short-circuit also clears any prior bootstrap warnings so
  // the test-visible state matches the documented "no work" semantics.
  lastBootstrapWarnings = []
  return {
    auditId,
    inventory: [...inventory],
    exactCollisions: [],
    genericFlags: [],
    semanticCollisions: [],
    summary: {
      totalEntries: 0,
      totalFlags: 0,
      errorCount: 0,
      warningCount: 0,
      durationMs: 0,
      passDurations: { exact: 0, generic: 0, semantic: 0 },
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
export { bootstrapUnmanagedSkills, isUnmanagedSkill } from './bootstrap-unmanaged.js'
export type { BootstrapFn } from './bootstrap-unmanaged.js'
