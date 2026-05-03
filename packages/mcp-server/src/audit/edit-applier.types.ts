/**
 * @fileoverview Type vocabulary for the edit-applier (SMI-4589 Wave 3 Step 5).
 * @module @skillsmith/mcp-server/audit/edit-applier.types
 *
 * Mirrors `ApplyRenameResult` (Wave 2 PR #2) so heterogeneous suggestion
 * lists (rename + edit) can be displayed uniformly by Wave 4's MCP tool
 * surface. The error union is purpose-narrow — prose-edit failures don't
 * include any rename-engine codes.
 *
 * Plan: docs/internal/implementation/smi-4589-edit-suggester.md §5.
 */

import type { CollisionId } from './collision-detector.types.js'
import type { EditTemplatePattern } from './edit-suggester.types.js'

/**
 * Discriminated errors surfaced by `applyRecommendedEdit`. Callers
 * `switch` on `kind` rather than parsing the message string.
 */
export type EditApplyError =
  | {
      /** Edit's source template is not in the apply registry allowlist. */
      kind: 'edit.template_not_in_apply_registry'
      pattern: EditTemplatePattern
      message: string
    }
  | {
      /**
       * The file content at `lineRange` no longer matches the recorded
       * `before` snippet — file changed under us between detector run
       * and apply call. The agent should re-run detection and surface
       * the fresh suggestion.
       */
      kind: 'edit.stale_before'
      filePath: string
      message: string
    }
  | {
      kind: 'edit.backup_failed'
      reason: string
      message: string
    }
  | {
      kind: 'edit.fs_error'
      reason: string
      message: string
    }

/**
 * Result of applying a `RecommendedEdit`. `success === false` populates
 * `error`; `success === true` populates `backupPath`, `ledgerEntryId`,
 * and the inline revert summary text.
 */
export interface EditApplyResult {
  success: boolean
  collisionId: CollisionId
  /** Pattern that produced the edit (for log-grep + telemetry). */
  pattern: EditTemplatePattern
  /** Absolute path to the mutated file. */
  filePath: string
  /**
   * Backup directory created by `createProseBackup`. Empty string on
   * failure. Backup is retained until the 30-day GC sweep.
   */
  backupPath: string
  /** ULID of the appended ledger entry (`ovr_…`). Empty string on failure. */
  ledgerEntryId: string
  /**
   * Inline revert summary (decision #10). Literal text on success:
   *
   *   `"Edited <file> lines <range>. To undo: sklx audit revert <auditId>"`
   *
   * Empty string on failure.
   */
  summary: string
  /** Discriminated error on failure; `undefined` on success. */
  error?: EditApplyError
}
