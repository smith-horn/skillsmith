/**
 * @fileoverview Type vocabulary for the `skill_inventory_audit` MCP tool
 *               (SMI-4590 Wave 4 PR 4).
 * @module @skillsmith/mcp-server/tools/skill-inventory-audit.types
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §1.
 *
 * The `SkillInventoryAuditResponse` shape is the canonical wire format
 * returned to MCP callers. The shared `RunInventoryAuditResult` from
 * `audit/run-inventory-audit.ts` is structurally identical — keep these
 * two surfaces in lock-step so the tool body is a thin pass-through.
 */

import type {
  ExactCollisionFlag,
  GenericTokenFlag,
  InventoryEntry,
  SemanticCollisionFlag,
} from '../audit/collision-detector.types.js'
import type { RecommendedEdit } from '../audit/edit-suggester.types.js'
import type { RenameSuggestion } from '../audit/rename-engine.types.js'

/**
 * Input for the `skill_inventory_audit` MCP tool. All fields optional;
 * the Zod schema (in `skill-inventory-audit.ts`) refines `homeDir` to
 * reject paths outside `os.homedir()` / `os.tmpdir()`.
 */
export interface SkillInventoryAuditInput {
  /** Gate the semantic-overlap pass. Defaults to `false`. */
  deep?: boolean
  /**
   * Override for `os.homedir()`. Refined to live under the real homedir
   * or `os.tmpdir()` (test fixtures only) — bare arbitrary paths are
   * rejected with `namespace.audit.invalid_home_dir`. Prevents an
   * attacker-controlled input from steering the scanner at arbitrary
   * filesystem locations.
   */
  homeDir?: string
  /** Optional project CLAUDE.md to scan in addition to the user one. */
  projectDir?: string
  /**
   * Filter collisions whose entries match
   * `~/.skillsmith/audit-exclusions.json`. Defaults to `true`. The
   * Enterprise scheduled-scan runner (Wave 4 PR 6) passes `false` so the
   * governance pass sees un-filtered findings for policy enforcement.
   */
  applyExclusions?: boolean
}

/** Wire response shape for the MCP tool. */
export interface SkillInventoryAuditResponse {
  auditId: string
  inventory: InventoryEntry[]
  exactCollisions: ExactCollisionFlag[]
  /**
   * Wave 1's `genericFlags` (typed `GenericTokenFlag[]`). Plan §99–108
   * referenced this field as `TriggerQualityEntry[]`; the canonical
   * Wave 1 type name is `GenericTokenFlag`. Field name preserved to
   * match plan wire shape.
   */
  genericFlags: GenericTokenFlag[]
  semanticCollisions: SemanticCollisionFlag[]
  renameSuggestions: RenameSuggestion[]
  recommendedEdits: RecommendedEdit[]
  /** Absolute path to `~/.skillsmith/audits/<auditId>/report.md`. */
  reportPath: string
  summary: {
    totalEntries: number
    totalFlags: number
    errorCount: number
    warningCount: number
    durationMs: number
  }
}
