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
 * `action: 'revert'` — undo a previously applied rename for the same
 *   `(auditId, collisionId)` pair (SMI-5671). Reuses the same
 *   `(auditId, collisionId)` lookup as apply/custom — `suggestions.json` is
 *   a static snapshot from audit time, so it still resolves after the
 *   forward rename has already happened. `collisionId` disambiguates when
 *   a single audit run resolved 2+ collisions under one `auditId` (Change 0).
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
  action: 'apply' | 'custom' | 'skip' | 'revert'
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
  // SMI-5213: confirmation-gate preview fields. Present (with
  // `applied: false`) when the tool was called without `confirmed: true`
  // on a non-skip action — nothing on disk changed.
  /** True when this is a non-mutating preview of the rename. */
  preview?: boolean
  /** Mutation strategy that *would* run on confirm. */
  action?: string
  /** Absolute path of the file that *would* be renamed. */
  target?: string
  /** Current identifier (pre-rename). */
  before?: string
  /** Proposed identifier (post-rename: suggested or custom name). */
  after?: string
  /** Always `false` on a preview; absent on a real apply. */
  applied?: boolean
  /**
   * SMI-5671: which way this preview describes — `'apply'` for `apply`/
   * `custom`, `'revert'` for `revert`. Part of the confirmation-gate
   * preview-field group (present when `preview: true`) so a generic
   * renderer doesn't have to infer direction from `before`/`after`
   * field-name convention alone.
   */
  direction?: 'apply' | 'revert'
  /**
   * SMI-5671: present on the non-preview (post-`confirmed: true`) success
   * response; `true` when the engine's apply/revert call was a no-op —
   * computed from `result.fromPath === result.toPath && result.backupPath
   * === ''`. For `revert` this means no matching ledger entry was found
   * for `(auditId, collisionId)` (already reverted, or never applied);
   * for `apply`/`custom` it mirrors the pre-existing idempotent-re-apply
   * case. Surfaces the engine's existing idempotency signal explicitly so
   * callers don't have to infer it from `result` themselves.
   */
  noOp?: boolean
}
