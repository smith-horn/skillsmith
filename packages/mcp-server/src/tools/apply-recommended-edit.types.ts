/**
 * @fileoverview Type vocabulary for the `apply_recommended_edit` MCP tool
 *               (SMI-4590 Wave 4 PR 4).
 * @module @skillsmith/mcp-server/tools/apply-recommended-edit.types
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §3.
 *
 * Tool registration is gated on `APPLY_TEMPLATE_REGISTRY.size > 0`
 * (Wave 3 `edit-applier.ts`). When the registry is empty, the tool is
 * NOT exposed in the dispatcher's `AUDIT_TOOL_NAMES` set — defense-in-
 * depth against a rollback that empties the registry.
 */

import type { CollisionId } from '../audit/collision-detector.types.js'
import type { EditApplyResult } from '../audit/edit-applier.types.js'

/**
 * Input for the `apply_recommended_edit` MCP tool.
 *
 * `pattern` is NOT a tool input — it's derived from the persisted
 * `RecommendedEdit.pattern`. The registry guard sits inside Wave 3's
 * `applyRecommendedEdit` (template not in `APPLY_TEMPLATE_REGISTRY` →
 * typed error `edit.template_not_in_apply_registry`).
 */
export interface ApplyRecommendedEditInput {
  /** ULID from a prior `skill_inventory_audit` response. */
  auditId: string
  /**
   * `collisionId` from a `RecommendedEdit` in that response. Wave 3
   * keys edits by their source `SemanticCollisionFlag.collisionId`, not a
   * separate `editId`.
   */
  collisionId: string
}

/**
 * Wire response shape. `success: true` carries the Wave 3
 * `EditApplyResult` (file path, backup path, ledger entry, summary);
 * `success: false` carries a typed `errorCode` + human-readable message.
 */
export interface ApplyRecommendedEditResponse {
  success: boolean
  /** Echoes the input `collisionId` (or `''` when input was unparseable). */
  collisionId: CollisionId | ''
  /** Wave 3 result. Populated when apply succeeded. */
  result?: EditApplyResult
  /** Typed error code on failure or input error. */
  errorCode?:
    | 'namespace.audit.invalid_input'
    | 'namespace.audit.history_not_found'
    | 'namespace.audit.collision_not_found'
    | 'edit.template_not_in_apply_registry'
    | 'edit.subcall_failed'
  /** Human-readable error message. */
  error?: string
}
