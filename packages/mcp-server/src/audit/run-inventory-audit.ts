/**
 * @fileoverview Shared `runInventoryAudit` composition helper (SMI-4590 Wave 4 PR 4).
 * @module @skillsmith/mcp-server/audit/run-inventory-audit
 *
 * Composes Wave 1 (scan + detect + history) + Wave 2 (rename suggestions)
 * + Wave 3 (recommended edits) + Wave 4 PR 3 (exclusions filter) into a
 * single entry-point used by both the `skill_inventory_audit` MCP tool
 * (this PR) and the `sklx audit collisions` CLI command (PR 5).
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §1.
 *
 * Pipeline:
 *   1. `scanLocalInventory` (Wave 1)             — scan the inventory.
 *   2. `detectCollisions`     (Wave 1)           — three-pass detector.
 *   3. Build `RenameSuggestion[]` (Wave 2 types) — one per exact collision,
 *      using `generateSuggestionChain` to pick a non-colliding name and
 *      mtime-descending tiebreak to pick which entry to rename.
 *   4. `runEditSuggester`     (Wave 3)           — recommended prose edits.
 *   5. Apply `~/.skillsmith/audit-exclusions.json` filter (Wave 4 PR 3)
 *      when `applyExclusions !== false`.
 *   6. `writeAuditHistory`    (Wave 1)           — persist `result.json`.
 *   7. `writeAuditSuggestions` (this PR)          — persist `suggestions.json`
 *      (so PR 4's apply-tools can look up rename + edit by collisionId).
 *   8. Build + return the response shape.
 *
 * Tier defaults to `'community'` (cheapest fail-safe). Callers (the MCP
 * tool, the CLI) pass through their resolved tier; the session-start
 * audit hook (PR 6) passes the user's resolved tier from license info.
 */

import * as os from 'node:os'

import {
  type ExcludableEntry,
  type ExclusionsConfig,
  loadExclusions,
  isExcluded as isExcludedCore,
} from '@skillsmith/core/audit'
import type { Tier } from '@skillsmith/core/config/audit-mode'

import { scanLocalInventory } from '../utils/local-inventory.js'
import type { InventoryEntry } from '../utils/local-inventory.types.js'
import { detectCollisions } from './collision-detector.js'
import type {
  ExactCollisionFlag,
  GenericTokenFlag,
  InventoryAuditResult,
  SemanticCollisionFlag,
} from './collision-detector.types.js'
import { writeAuditHistory } from './audit-history.js'
import { writeAuditReport } from './audit-report-writer.js'
import { writeAuditSuggestions } from './audit-suggestions.js'
import { runEditSuggester } from './edit-suggester.js'
import type { RecommendedEdit } from './edit-suggester.types.js'
import { generateSuggestionChain } from './suggestion-chain.js'
import type { RenameAction, RenameSuggestion } from './rename-engine.types.js'

/**
 * Input for {@link runInventoryAudit}. All fields optional — the MCP tool
 * input schema rejects unknowns and home-dir traversal at the boundary.
 */
export interface RunInventoryAuditOptions {
  /** Gate the semantic-overlap pass (Wave 1). Defaults to `false`. */
  deep?: boolean
  /** Override `os.homedir()`. Caller (MCP tool) Zod-validates the path. */
  homeDir?: string
  /** Optional project CLAUDE.md to scan in addition to the user one. */
  projectDir?: string
  /**
   * Filter collision flags whose entries match
   * `~/.skillsmith/audit-exclusions.json`. Defaults to `true`. Enterprise
   * scheduled-scan runner (PR 6) passes `false` so the governance pass
   * sees un-filtered findings for policy enforcement.
   */
  applyExclusions?: boolean
  /**
   * Subscription tier of the caller — gates the semantic pass per the
   * audit-mode resolver. Defaults to `'community'` (preventative mode →
   * exact + generic only). The MCP tool resolves the caller tier from
   * license info before invoking; the CLI command passes through the same.
   */
  tier?: Tier
}

/** Response shape returned to MCP / CLI callers. */
export interface RunInventoryAuditResult {
  auditId: string
  inventory: InventoryEntry[]
  exactCollisions: ExactCollisionFlag[]
  /**
   * Wave 1's `genericFlags` (typed `GenericTokenFlag[]`). Plan §99–108
   * referenced this field as `TriggerQualityEntry[]`; the canonical Wave 1
   * type is `GenericTokenFlag`. Field name preserved per spec.
   */
  genericFlags: GenericTokenFlag[]
  semanticCollisions: SemanticCollisionFlag[]
  renameSuggestions: RenameSuggestion[]
  recommendedEdits: RecommendedEdit[]
  /** Absolute path to the rendered `report.md` for this audit. */
  reportPath: string
  summary: {
    totalEntries: number
    totalFlags: number
    errorCount: number
    warningCount: number
    durationMs: number
  }
}

/**
 * Run the full inventory audit pipeline. Single entrypoint shared by the
 * MCP `skill_inventory_audit` tool and the CLI `sklx audit collisions`
 * command.
 *
 * Stateless — every call generates a fresh `auditId` (via the detector's
 * default ULID generator) and writes the corresponding history +
 * suggestions files to `~/.skillsmith/audits/<auditId>/`.
 */
export async function runInventoryAudit(
  opts: RunInventoryAuditOptions = {}
): Promise<RunInventoryAuditResult> {
  const startedAt = process.hrtime.bigint()

  // Step 1: scan the local inventory.
  const homeDir = opts.homeDir ?? os.homedir()
  const scan = await scanLocalInventory({
    homeDir,
    ...(opts.projectDir !== undefined ? { projectDir: opts.projectDir } : {}),
  })

  // Step 2: run the three-pass detector. Tier resolves the audit-mode
  // (preventative → exact + generic; power_user / governance → +semantic).
  // `deep: true` opts into the semantic pass via the `auditModeOverride`
  // path so callers don't need to know about tier semantics.
  const tier = opts.tier ?? 'community'
  const detectorOpts: Parameters<typeof detectCollisions>[1] = { tier }
  if (opts.deep) {
    detectorOpts.auditModeOverride = 'power_user'
  }
  const detectorResult = await detectCollisions(scan.entries, detectorOpts)

  // Step 3: build rename suggestions for each exact collision.
  const renameSuggestions = buildRenameSuggestions(detectorResult, scan.entries)

  // Step 4: run the edit suggester (Wave 3 — semantic-collision path).
  // Returns an empty array when `semanticCollisions.length === 0`.
  const recommendedEdits = await runEditSuggester(detectorResult)

  // Step 5: apply exclusions filter when requested. Defaults to `true`;
  // Enterprise scheduled-scan (PR 6) passes `false`.
  const applyExclusions = opts.applyExclusions !== false
  let filtered = detectorResult
  let filteredRenames = renameSuggestions
  let filteredEdits = recommendedEdits
  if (applyExclusions) {
    const exclusions = await loadExclusions()
    filtered = applyExclusionsFilter(detectorResult, exclusions)
    filteredRenames = renameSuggestions.filter((s) =>
      filtered.exactCollisions.some((f) => f.collisionId === s.collisionId)
    )
    const keptCollisionIds = new Set([
      ...filtered.exactCollisions.map((f) => f.collisionId),
      ...filtered.genericFlags.map((f) => f.collisionId),
      ...filtered.semanticCollisions.map((f) => f.collisionId),
    ])
    filteredEdits = recommendedEdits.filter((e) => keptCollisionIds.has(e.collisionId))
  }

  // Step 6: persist `result.json` + `report.md`. The history writer
  // creates the per-audit directory; the report writer reuses it.
  const history = await writeAuditHistory(filtered)
  await writeAuditReport(filtered, {
    auditDir: history.reportPath.replace(/\/report\.md$/, ''),
    renameSuggestions: filteredRenames,
    recommendedEdits: filteredEdits,
  })

  // Step 7: persist `suggestions.json` (this PR — for the apply-tools).
  await writeAuditSuggestions(filtered.auditId, filteredRenames, filteredEdits)

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000

  // Step 8: build the response.
  return {
    auditId: filtered.auditId,
    inventory: filtered.inventory,
    exactCollisions: filtered.exactCollisions,
    genericFlags: filtered.genericFlags,
    semanticCollisions: filtered.semanticCollisions,
    renameSuggestions: filteredRenames,
    recommendedEdits: filteredEdits,
    reportPath: history.reportPath,
    summary: {
      totalEntries: filtered.summary.totalEntries,
      totalFlags: filtered.summary.totalFlags,
      errorCount: filtered.summary.errorCount,
      warningCount: filtered.summary.warningCount,
      durationMs,
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `RenameSuggestion[]` from each `ExactCollisionFlag`. We pick the
 * **most-recently-installed** entry (mtime descending) as the rename
 * target — matches plan §259 default-entry tiebreak. Falls back to the
 * first entry when mtime is missing.
 *
 * Author / packDomain are left null for v1 — chain falls through to the
 * `local-` prefix path (`local-foo`, `local-foo-<shortHash>`). Wave 4 PR 5
 * extends this with manifest lookups for richer prefixes.
 */
function buildRenameSuggestions(
  result: InventoryAuditResult,
  fullInventory: ReadonlyArray<InventoryEntry>
): RenameSuggestion[] {
  const suggestions: RenameSuggestion[] = []
  for (const flag of result.exactCollisions) {
    if (flag.entries.length === 0) continue

    // mtime-descending tiebreak; missing mtime sinks to the bottom.
    const sorted = [...flag.entries].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    const target = sorted[0]!
    const action = inventoryKindToRenameAction(target)
    if (action === null) continue // claude_md_rule entries can't be renamed.

    const chain = generateSuggestionChain({
      token: stripLeadingSlash(target.identifier),
      author: target.meta?.author ?? null,
      packDomain: null,
      tagFallback: target.meta?.tags?.[0] ?? null,
      authorPath: target.source_path,
      existingInventory: fullInventory,
    })
    const lowercaseInventory = new Set(fullInventory.map((e) => e.identifier.toLowerCase()))
    const firstFree = chain.candidates.find((c) => !lowercaseInventory.has(c.toLowerCase()))
    const suggested = firstFree ?? chain.candidates[0] ?? target.identifier

    suggestions.push({
      collisionId: flag.collisionId,
      entry: target,
      currentName: target.identifier,
      suggested,
      applyAction: action,
      reason: flag.reason,
    })
  }
  return suggestions
}

function stripLeadingSlash(identifier: string): string {
  return identifier.startsWith('/') ? identifier.slice(1) : identifier
}

/** Map an `InventoryEntry.kind` to a `RenameAction`, or `null` for unrenamable kinds. */
function inventoryKindToRenameAction(entry: InventoryEntry): RenameAction | null {
  switch (entry.kind) {
    case 'command':
      return 'rename_command_file'
    case 'agent':
      return 'rename_agent_file'
    case 'skill':
      return 'rename_skill_dir_and_frontmatter'
    case 'claude_md_rule':
      return null
    default:
      return null
  }
}

/**
 * Drop a collision flag iff ANY involved entry matches an exclusion. The
 * intent of an exclusion is "I deliberately keep this entry around" —
 * once the user marks one side acceptable, the rename suggestion against
 * that pair is moot.
 *
 * Inventory itself is NOT filtered — exclusions suppress findings, not
 * inventory entries. The audit report still lists every entry under
 * "Inventory" so the user has full context for their exclusion choices.
 */
function applyExclusionsFilter(
  result: InventoryAuditResult,
  config: ExclusionsConfig
): InventoryAuditResult {
  if (config.exclusions.length === 0) return result

  const exactCollisions = result.exactCollisions.filter(
    (flag) => !flag.entries.some((entry) => isExcludedInventoryEntry(entry, config))
  )
  const genericFlags = result.genericFlags.filter(
    (flag) => !isExcludedInventoryEntry(flag.entry, config)
  )
  const semanticCollisions = result.semanticCollisions.filter(
    (flag) =>
      !isExcludedInventoryEntry(flag.entryA, config) &&
      !isExcludedInventoryEntry(flag.entryB, config)
  )

  const errorCount = exactCollisions.length
  const warningCount = genericFlags.length + semanticCollisions.length
  return {
    ...result,
    exactCollisions,
    genericFlags,
    semanticCollisions,
    summary: {
      ...result.summary,
      totalFlags: errorCount + warningCount,
      errorCount,
      warningCount,
    },
  }
}

/** Translate a Wave 1 `InventoryEntry` to the core `ExcludableEntry` shape. */
function isExcludedInventoryEntry(entry: InventoryEntry, config: ExclusionsConfig): boolean {
  if (entry.kind === 'command') {
    const candidate: ExcludableEntry = {
      kind: 'command',
      commandIdentifier: entry.identifier.startsWith('/')
        ? entry.identifier
        : `/${entry.identifier}`,
    }
    return isExcludedCore(candidate, config)
  }
  if (entry.kind === 'skill') {
    const author = entry.meta?.author
    // Skill exclusions are keyed by `<author>/<identifier>`. Without an
    // author, fall back to bare identifier so a manually-edited
    // exclusions file can still target unmanaged skills.
    const skillId = author ? `${author}/${entry.identifier}` : entry.identifier
    const candidate: ExcludableEntry = { kind: 'skill', skillId }
    return isExcludedCore(candidate, config)
  }
  // agents + claude_md_rule have no v1 exclusion shape — never excluded.
  return false
}
