/**
 * @fileoverview Type vocabulary for the `undo_apply` MCP tool
 *               (SMI-5456 Wave 1 Step 3 / SMI-5470).
 * @module @skillsmith/mcp-server/tools/undo-apply.types
 */

/** Input for the `undo_apply` MCP tool. `count` and `suggestion_id` are
 * mutually exclusive — see `undoApplyInputSchema`'s `superRefine`. */
export interface UndoApplyInput {
  /** Undo the N most-recent session applies (default 1). */
  count?: number
  /** Undo one specific changeset by its `collisionId`. */
  suggestion_id?: string
}

/** One successfully-reversed changeset in the response. */
export interface UndoneChangeset {
  tool: string
  suggestionId: string
  targetPath: string
  /** sha256 of `targetPath`'s content after the restore (matches the
   * original apply's recorded `before_hash`). */
  restoredHash: string
}

/**
 * Wire response shape. `undone` lists every changeset that was
 * successfully reversed, even when the overall call is `success: false`
 * (a multi-target `count` request that fails partway still reports what
 * it DID undo, so the caller never double-undoes).
 */
export interface UndoApplyResponse {
  success: boolean
  undone: UndoneChangeset[]
  errorCode?:
    | 'undo.invalid_input'
    | 'undo.no_session_applies'
    | 'undo.backup_missing'
    | 'undo.content_changed'
    | 'undo.scope_violation'
    | 'undo.restore_failed'
  error?: string
}
