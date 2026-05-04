/**
 * @fileoverview Type vocabulary for the `apply_namespace_rename` MCP tool
 *               (SMI-4590 Wave 4 PR 4).
 * @module @skillsmith/mcp-server/tools/apply-namespace-rename.types
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §2.
 */

import type { CollisionId } from '../audit/collision-detector.types.js'
import type { ApplyRenameResult } from '../audit/rename-engine.types.js'

/**
 * Input for the `apply_namespace_rename` MCP tool.
 *
 * `action: 'apply'`  — apply the suggested rename (Wave 2 `applyRename`).
 * `action: 'custom'` — apply with `customName` (must be non-empty).
 * `action: 'skip'`   — record a no-op decision; no file mutation.
 *
 * `auditId` + `collisionId` are FKs into
 * `~/.skillsmith/audits/<auditId>/suggestions.json` (this PR — see
 * `audit/audit-suggestions.ts`).
 */
export interface ApplyNamespaceRenameInput {
  /** ULID from a prior `skill_inventory_audit` response. */
  auditId: string
  /** `collisionId` from a `RenameSuggestion` in that response. */
  collisionId: string
  action: 'apply' | 'custom' | 'skip'
  /** Required when `action === 'custom'`. */
  customName?: string
}

/**
 * Wire response shape. `success: true` carries the Wave 2
 * `ApplyRenameResult`; `success: false` carries a typed `errorCode` +
 * human-readable `error` message.
 */
export interface ApplyNamespaceRenameResponse {
  success: boolean
  /** Echoes the input `collisionId` (or `''` when input was unparseable). */
  collisionId: CollisionId | ''
  /** Wave 2 result. Populated when `action !== 'skip'` AND apply succeeded. */
  result?: ApplyRenameResult
  /** Typed error code on failure or input error. */
  errorCode?:
    | 'namespace.audit.invalid_input'
    | 'namespace.audit.history_not_found'
    | 'namespace.audit.collision_not_found'
    | 'namespace.rename.subcall_failed'
  /** Human-readable error message. */
  error?: string
}
