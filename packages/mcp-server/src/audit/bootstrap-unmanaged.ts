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
 * Wave 1 PR #4 (Step 8 / NEW-E-2) wires the real `indexLocalSkill` core
 * helper as the default `bootstrapFn` — replacing PR #3's no-op stub. The
 * MCP-side `parseFrontmatter` is injected so behaviour matches the
 * existing `LocalIndexer` path bit-for-bit.
 *
 * "Unmanaged" = `kind: 'skill'` AND `meta.author` is undefined (i.e.,
 * the skill is not registered in `~/.skillsmith/manifest.json`).
 */

import { indexLocalSkill } from '@skillsmith/core'

import type { InventoryEntry, ScanWarning } from '../utils/local-inventory.types.js'
import { WARNING_CODES } from '../utils/local-inventory.helpers.js'
import { parseFrontmatter } from '../indexer/FrontmatterParser.js'

/**
 * Per-entry bootstrap callback. Implementations register the skill with
 * `index_local` (or the future `indexLocalSkill` core helper) and return
 * void on success. Throwing converts to a typed warning, never a hard
 * fail.
 */
export type BootstrapFn = (entry: InventoryEntry) => Promise<void>

export interface BootstrapUnmanagedOptions {
  /**
   * Bootstrap callback. Defaults to {@link defaultIndexLocalSkillBootstrap}
   * (PR #4 / NEW-E-2 wiring) which delegates to the real `indexLocalSkill`
   * core helper. Tests can substitute a vi.fn() to assert call counts and
   * exercise the failure-warning path.
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
  const bootstrapFn = opts.bootstrapFn ?? defaultIndexLocalSkillBootstrap
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
 * Default bootstrap implementation (SMI-4587 Wave 1 PR #4 / NEW-E-2).
 *
 * Delegates to `indexLocalSkill` from `@skillsmith/core/skills/index-local`
 * with the MCP-side `parseFrontmatter` injected so we keep parity with the
 * existing `LocalIndexer` path. Synchronous filesystem reads inside the
 * core helper are wrapped in `Promise.resolve()` so the audit pipeline can
 * await uniformly.
 *
 * Errors propagate upward — `bootstrapUnmanagedSkills` converts them into
 * typed `ScanWarning` entries with code
 * `namespace.inventory.bootstrap_failed`.
 */
async function defaultIndexLocalSkillBootstrap(entry: InventoryEntry): Promise<void> {
  await Promise.resolve(
    indexLocalSkill(entry.source_path, {
      parseFrontmatter,
    })
  )
}
