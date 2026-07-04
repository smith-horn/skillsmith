/**
 * @fileoverview Shared `runInventoryAudit` composition helper (SMI-4590 Wave 4 PR 4).
 * @module @skillsmith/mcp-server/audit/run-inventory-audit
 *
 * Composes Wave 1 (scan + detect + history) + Wave 2 (rename suggestions)
 * + Wave 3 (recommended edits) + Wave 4 PR 3 (exclusions filter) +
 * Wave 2B (SMI-5535 rot detection) into a single entry-point used by both
 * the `skill_inventory_audit` MCP tool (this PR) and the
 * `sklx audit collisions` CLI command (PR 5).
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
 *   5. `detectRot`            (Wave 2B, SMI-5535) — dead-ref scan over the
 *      same inventory/auditId as the collision pass (version-drift is a
 *      documented no-op scaffold — see `rot-detector.ts`'s header).
 *   6. Apply `~/.skillsmith/audit-exclusions.json` filter (Wave 4 PR 3)
 *      when `applyExclusions !== false`. Rot findings pass through the
 *      SAME filter as generic/semantic flags — an excluded entry
 *      suppresses its rot finding too.
 *   7. `writeAuditHistory`    (Wave 1)           — persist `result.json`.
 *   8. `writeAuditSuggestions` (this PR)          — persist `suggestions.json`
 *      (so PR 4's apply-tools can look up rename + edit by collisionId).
 *   9. Build + return the response shape.
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
import type { RenameSuggestion } from './rename-engine.types.js'
import { detectRot } from './rot-detector.js'
import type { RotFinding } from './rot-detector.types.js'
import {
  buildRenameSuggestions,
  dedupeAgentPackCollisions,
} from './run-inventory-audit.detectors.js'

// Re-exported for backward compatibility: `run-inventory-audit.dedup.test.ts`
// (and any other consumer) imports `dedupeAgentPackCollisions` directly from
// this module's path — the SMI-5535 Wave 2B split moved the implementation
// to `./run-inventory-audit.detectors.js` but the public import path here
// is preserved.
export { dedupeAgentPackCollisions }

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
  /** Rot findings (SMI-5535 Wave 2B) — dead-ref / version-drift signals. */
  rotFindings: RotFinding[]
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
  const rawDetectorResult = await detectCollisions(scan.entries, detectorOpts)

  // Step 2b (SMI-5456 Wave 1 Step 5, plan §6): dedupe + self-exempt the
  // dual-path Skillsmith Agent pack. `scanLocalInventory` now scans BOTH
  // `.claude/skills` and `.agents/skills` (Step 1b in local-inventory.ts) —
  // the installer's mandatory dual-path write means a byte-identical copy of
  // the `skillsmith-agent` pack legitimately exists at both paths, which
  // would otherwise surface as a spurious exact-name collision every single
  // audit run. Applied unconditionally (not gated by `applyExclusions`) —
  // this is dedup of a known-intentional duplicate, not a user-configured
  // exclusion — and BEFORE exclusions/rename-suggestion building so a
  // self-exempted collision never produces a rename suggestion either.
  const detectorResult = dedupeAgentPackCollisions(rawDetectorResult)

  // Step 2c (SMI-5535 Wave 2B): rot-detection pass over the SAME inventory
  // snapshot + auditId the collision detector used above. Detection-only —
  // see `rot-detector.ts`'s header for the dead-ref / version-drift
  // signal contract.
  const rotFindings = await detectRot(detectorResult.inventory, {
    auditId: detectorResult.auditId,
  })

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
  let filteredRot = rotFindings
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
    // A user exclusion should be able to suppress a rot finding the same
    // way it suppresses a generic/semantic flag — mirror those filters.
    filteredRot = rotFindings.filter((f) => !isExcludedInventoryEntry(f.entry, exclusions))
  }

  // Step 6: persist `result.json` + `report.md`. The history writer
  // creates the per-audit directory; the report writer reuses it.
  const history = await writeAuditHistory(filtered)
  await writeAuditReport(filtered, {
    auditDir: history.reportPath.replace(/\/report\.md$/, ''),
    renameSuggestions: filteredRenames,
    recommendedEdits: filteredEdits,
    rotFindings: filteredRot,
  })

  // Step 7: persist `suggestions.json` (this PR — for the apply-tools).
  await writeAuditSuggestions(filtered.auditId, filteredRenames, filteredEdits)

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000

  // Rot findings are 'warning' severity today (dead-ref is the only
  // implemented signal); fold them into totalFlags/warningCount the same
  // way genericFlags/semanticCollisions are counted. `'info'`-severity
  // findings (reserved, unused in v1) are deliberately excluded from the
  // warning tally.
  //
  // MEDIUM-2 fix (SMI-5535 Wave 2B): `writeAuditReport` above was called
  // with `rotFindings: filteredRot` already, but its summary header used
  // to read only `filtered.summary` (collision-only) — so a report with a
  // populated "Rot / dead references" section still printed the
  // collision-only "Total flags"/"Warnings" totals, silently disagreeing
  // with the augmented totals returned below. `renderSummaryHeader`
  // (audit-report-writer.ts) now derives the SAME rot-warning fold
  // directly from the `rotFindings` array it already received, so the
  // report header and this JSON `summary` can never drift apart — no
  // separate count needs threading through this call.
  const rotWarningCount = filteredRot.filter((f) => f.severity === 'warning').length

  // Step 8: build the response.
  return {
    auditId: filtered.auditId,
    inventory: filtered.inventory,
    exactCollisions: filtered.exactCollisions,
    genericFlags: filtered.genericFlags,
    semanticCollisions: filtered.semanticCollisions,
    renameSuggestions: filteredRenames,
    recommendedEdits: filteredEdits,
    rotFindings: filteredRot,
    reportPath: history.reportPath,
    summary: {
      totalEntries: filtered.summary.totalEntries,
      totalFlags: filtered.summary.totalFlags + rotWarningCount,
      errorCount: filtered.summary.errorCount,
      warningCount: filtered.summary.warningCount + rotWarningCount,
      durationMs,
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
