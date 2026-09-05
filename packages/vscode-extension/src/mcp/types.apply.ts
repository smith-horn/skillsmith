/**
 * MCP Client Type Definitions — apply family
 *
 * Split out of `types.ts` (SMI-6343 Wave 4, 500-line file gate): the
 * response types for the four "apply"-family MCP tools
 * (`apply_namespace_rename`, `undo_apply`, `apply_manifest_reconcile`,
 * `apply_recommended_edit`) — re-exported from `types.ts` so every
 * existing `from './types.js'` import keeps working unchanged.
 */

/**
 * Response from MCP `apply_namespace_rename` (SMI-5325). UNGATED. Mirrors the
 * server envelope (`apply-namespace-rename.types.ts`). Application-level failure
 * is `success: false` + `errorCode` (the dispatcher wraps every result with
 * `okBody` → `isError: false`, so this never surfaces as a thrown McpToolError).
 * The SMI-5213 preview fields are present (with `applied: false`) when the tool
 * was called without `confirmed: true`. `result` is opaque to the extension.
 */
export interface McpApplyNamespaceRenameResponse {
  success: boolean
  collisionId: string
  result?: unknown
  errorCode?:
    | 'namespace.audit.invalid_input'
    | 'namespace.audit.history_not_found'
    | 'namespace.audit.collision_not_found'
    | 'namespace.rename.subcall_failed'
  error?: string
  preview?: boolean
  action?: string
  target?: string
  before?: string
  after?: string
  applied?: boolean
}

/**
 * Response from MCP `undo_apply` (SMI-5456 Wave 1 Step 3 / SMI-5470).
 * Session-scoped undo of the most recent `apply_namespace_rename` /
 * `apply_recommended_edit` changeset(s), restored from the apply tool's own
 * backup. Mirrors the server envelope (`undo-apply.types.ts`).
 */
export interface McpUndoApplyResponse {
  success: boolean
  undone: Array<{
    tool: string
    suggestionId: string
    targetPath: string
    restoredHash: string
  }>
  errorCode?:
    | 'undo.invalid_input'
    | 'undo.no_session_applies'
    | 'undo.backup_missing'
    | 'undo.content_changed'
    | 'undo.scope_violation'
    | 'undo.restore_failed'
  error?: string
}

/**
 * Response from MCP `apply_manifest_reconcile` (SMI-6343 Wave 4). Community
 * tier. Repairs a corrupted or ambiguous `~/.skillsmith/manifest.json` entry
 * — mirrors the server envelope (`apply-manifest-reconcile.types.ts`). Unlike
 * {@link McpApplyNamespaceRenameResponse}, this tool has no confirm/preview
 * gate — every call mutates when it succeeds.
 */
export interface McpApplyManifestReconcileResponse {
  success: boolean
  action: 'mark_local' | 'relink' | 'drop_entry' | 'verify' | 'revert'
  name?: string
  manifestKey?: string
  entry?: Record<string, unknown>
  verifyResults?: Array<{
    name: string
    manifestKey: string
    verified: boolean
    reason?:
      | 'offline'
      | 'quota-exhausted'
      | 'network-error'
      | 'no-registry-record'
      | 'hash-mismatch'
    verifiedAt?: string
  }>
  ledgerEntryId?: string
  noOp?: boolean
  backupPath?: string
  errorCode?:
    | 'manifest.reconcile.invalid_input'
    | 'manifest.reconcile.entry_not_found'
    | 'manifest.reconcile.key_shape_ambiguous'
    | 'manifest.reconcile.relink_unvalidated'
    | 'manifest.reconcile.relink_incomplete'
    | 'manifest.reconcile.drop_target_still_resolves'
    | 'manifest.reconcile.backup_target_not_a_file'
    | 'manifest.reconcile.backup_failed'
    | 'manifest.reconcile.lock_timeout'
    | 'manifest.reconcile.entry_changed'
    | 'manifest.reconcile.revert_ambiguous'
    | 'manifest.reconcile.ledger_version_unsupported'
    | 'manifest.reconcile.ledger_malformed'
    | 'manifest.reconcile.verify_unavailable'
  error?: string
}

/**
 * Response from MCP `apply_recommended_edit` (SMI-5325). UNGATED but the tool is
 * conditionally registered server-side (`APPLY_TEMPLATE_REGISTRY`). Mirrors the
 * server envelope (`apply-recommended-edit.types.ts`); same preview/error-code
 * contract as {@link McpApplyNamespaceRenameResponse}. `result` is opaque.
 */
export interface McpApplyRecommendedEditResponse {
  success: boolean
  collisionId: string
  result?: unknown
  errorCode?:
    | 'namespace.audit.invalid_input'
    | 'namespace.audit.history_not_found'
    | 'namespace.audit.collision_not_found'
    | 'edit.template_not_in_apply_registry'
    | 'edit.subcall_failed'
  error?: string
  preview?: boolean
  action?: string
  target?: string
  before?: string
  after?: string
  applied?: boolean
}
