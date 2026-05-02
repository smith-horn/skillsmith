/**
 * @fileoverview Bootstrap unmanaged skills for SMI-4587 Wave 1 Step 6a.
 * @module @skillsmith/mcp-server/audit/bootstrap-unmanaged
 *
 * Iterates over inventory entries and registers any unmanaged SKILL.md
 * via `index_local`. Failures are converted into typed `warnings[]`
 * entries (`namespace.inventory.bootstrap_failed`) — never thrown — so
 * the audit run can complete even when individual bootstrap calls fail
 * (decision #12 in plan).
 *
 * Wave 1 PR #3 ships this as a thin plumb that delegates to a caller-
 * supplied `bootstrapFn`. PR #4 (Step 8 / NEW-E-2) extracts a real
 * `indexLocalSkill(absPath)` helper into `@skillsmith/core` and wires
 * it as the default `bootstrapFn`. Until then, callers pass a no-op
 * (or a real adapter) explicitly.
 *
 * "Unmanaged" = `kind: 'skill'` AND `meta.author` is undefined (i.e.,
 * the skill is not registered in `~/.skillsmith/manifest.json`).
 */

import type { InventoryEntry, ScanWarning } from '../utils/local-inventory.types.js'
import { WARNING_CODES } from '../utils/local-inventory.helpers.js'

/**
 * Per-entry bootstrap callback. Implementations register the skill with
 * `index_local` (or the future `indexLocalSkill` core helper) and return
 * void on success. Throwing converts to a typed warning, never a hard
 * fail.
 */
export type BootstrapFn = (entry: InventoryEntry) => Promise<void>

export interface BootstrapUnmanagedOptions {
  /**
   * Bootstrap callback. Defaults to a no-op so callers that don't wire
   * `index_local` yet (e.g. Wave 1 PR #3 callers) can still invoke this
   * helper without side effects. PR #4 (Step 8) will replace the default
   * with the real `indexLocalSkill` core helper.
   *
   * TODO(SMI-4587 PR #4): replace the default with the extracted
   * `indexLocalSkill` core helper — see plan Step 8 / NEW-E-2.
   */
  bootstrapFn?: BootstrapFn
  /** Optional logger sink for non-fatal diagnostics (debug-level). */
  logger?: { debug?: (msg: string, meta?: unknown) => void }
}

export interface BootstrapUnmanagedResult {
  /** Number of entries that were considered unmanaged candidates. */
  attempted: number
  /** Subset of `attempted` that completed without throwing. */
  succeeded: number
  /** Warnings produced by failed bootstrap attempts (one per failure). */
  warnings: ScanWarning[]
}

/**
 * Identify unmanaged SKILL.md entries — `kind: 'skill'` with no
 * `meta.author` (i.e., not registered in `~/.skillsmith/manifest.json`).
 * Exported so tests + future callers can re-use the predicate.
 */
export function isUnmanagedSkill(entry: InventoryEntry): boolean {
  return entry.kind === 'skill' && !entry.meta?.author
}

/**
 * Run the bootstrap pass over an inventory snapshot.
 *
 * Contract:
 *   - Never throws. Per-entry failures convert to a `ScanWarning` with
 *     code `namespace.inventory.bootstrap_failed`.
 *   - Always returns; callers can append `result.warnings` onto the
 *     audit-level warnings array.
 *   - Pure aside from the `bootstrapFn` side effect; safe to invoke in
 *     dry-run / unit-test mode by supplying a no-op `bootstrapFn`.
 */
export async function bootstrapUnmanagedSkills(
  inventory: ReadonlyArray<InventoryEntry>,
  opts: BootstrapUnmanagedOptions = {}
): Promise<BootstrapUnmanagedResult> {
  const bootstrapFn = opts.bootstrapFn ?? noopBootstrap
  const warnings: ScanWarning[] = []
  let attempted = 0
  let succeeded = 0

  for (const entry of inventory) {
    if (!isUnmanagedSkill(entry)) continue
    attempted++
    try {
      await bootstrapFn(entry)
      succeeded++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push({
        code: WARNING_CODES.BOOTSTRAP_FAILED,
        message: `bootstrap failed for ${entry.source_path}: ${message}`,
        context: {
          source_path: entry.source_path,
          identifier: entry.identifier,
          error: message,
        },
      })
      opts.logger?.debug?.('bootstrap_failed', {
        source_path: entry.source_path,
        error: message,
      })
    }
  }

  return { attempted, succeeded, warnings }
}

/**
 * Default no-op bootstrap. Replaced in PR #4 (Step 8) by the extracted
 * `indexLocalSkill` core helper.
 */
async function noopBootstrap(_entry: InventoryEntry): Promise<void> {
  // TODO(SMI-4587 PR #4): delegate to indexLocalSkill once extracted.
  return undefined
}
