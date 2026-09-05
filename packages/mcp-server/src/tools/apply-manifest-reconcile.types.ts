/**
 * @fileoverview Type vocabulary for the `apply_manifest_reconcile` MCP tool
 *               (SMI-6343 Wave 4).
 * @module @skillsmith/mcp-server/tools/apply-manifest-reconcile.types
 *
 * Plan: docs/internal/implementation/smi-6343-manifest-hygiene.md
 * ("4. Reconciliation tool (Wave 4 ...)").
 */

import type { ClientId } from '@skillsmith/core/install'
import type { SkillManifestEntry } from '@skillsmith/core'

/**
 * M2 error taxonomy, modeled on `StuckLockError`
 * (`owned-lock.acquire.ts:70-94`): `errorCode` is a stable discriminant for
 * mechanical triage (never prose-matching); `describeReconcileError()`
 * (`apply-manifest-reconcile.errors.ts`) generates the human-readable
 * message from the code so code and prose cannot drift, embedding the
 * exact next remediation command inline. Mirrors the existing
 * dot-namespaced unions on `apply_namespace_rename`
 * (`namespace.rename.revert_ambiguous`, ...) and `undo_apply`
 * (`undo.scope_violation`, ...).
 */
export type ManifestReconcileErrorCode =
  | 'manifest.reconcile.invalid_input'
  | 'manifest.reconcile.entry_not_found'
  | 'manifest.reconcile.key_shape_ambiguous' // H9: bare-key vs manifestKeyFor collision
  | 'manifest.reconcile.relink_unvalidated' // relink id/source not confirmed against the registry
  | 'manifest.reconcile.relink_incomplete' // relink without BOTH id and source
  | 'manifest.reconcile.drop_target_still_resolves' // adversarial-review finding: drop_entry's own contract requires installPath to no longer resolve
  | 'manifest.reconcile.backup_target_not_a_file' // C8 guard rail
  | 'manifest.reconcile.backup_failed'
  | 'manifest.reconcile.lock_timeout' // ManifestManager's 30s ceiling
  | 'manifest.reconcile.entry_changed' // C7 same-entry conflict
  | 'manifest.reconcile.revert_ambiguous' // mirrors namespace.rename.revert_ambiguous
  | 'manifest.reconcile.ledger_version_unsupported'
  | 'manifest.reconcile.ledger_malformed'
  | 'manifest.reconcile.verify_unavailable' // verify could not reach the registry

export type ManifestReconcileAction = 'mark_local' | 'relink' | 'drop_entry' | 'verify' | 'revert'

/**
 * Input for the `apply_manifest_reconcile` MCP tool.
 *
 * H9 (manifest key + scope contract): `client` defaults to
 * `CANONICAL_CLIENT`; `scope`/`cwd` follow the same ADR-139 contract as
 * `uninstall_skill` — the manifest path for the requested scope is
 * resolved BEFORE any read, and the manifest key is derived ONLY via
 * `manifestKeyFor(name, client)`, never by indexing `installedSkills[name]`
 * directly.
 *
 * `name` is required for every action except `verify`, where omitting it
 * runs the batch pass over every manifest entry (C3: "Batch by default").
 *
 * `revert` may target a ledger entry either precisely (`ledgerEntryId`,
 * returned by a prior mutating action's response) or by `(name, client)`
 * — see the revert action's own doc comment in `apply-manifest-reconcile.ts`
 * for the disambiguation policy.
 */
export interface ApplyManifestReconcileInput {
  action: ManifestReconcileAction
  /** Required for mark_local/relink/drop_entry/revert-by-name; optional for verify (batch). */
  name?: string
  /** Target client (ADR-139). Defaults to the canonical client. */
  client?: ClientId
  /** Explicit install scope (ADR-139). Defaults to auto-detected. */
  scope?: 'global' | 'workspace'
  /** Ancestor-walk starting point for workspace scope resolution. */
  cwd?: string
  /** relink only: registry skill id (author/name). Required together with `source`. */
  id?: string
  /** relink only: the source reference to record (e.g. `github:owner/repo`). Required together with `id`. */
  source?: string
  /** Optional human-readable reason, recorded in the ledger. */
  reason?: string
  /** revert only: precise ledger entry id (`mrc_...`) from a prior mutating action's response. */
  ledgerEntryId?: string
}

/** Per-entry outcome of a `verify` pass (batch or single-entry). */
export interface ManifestReconcileVerifyResult {
  name: string
  manifestKey: string
  verified: boolean
  /** Populated when `verified` is false. */
  reason?: 'offline' | 'quota-exhausted' | 'network-error' | 'no-registry-record' | 'hash-mismatch'
  /** ISO-8601 UTC timestamp written on a match. Absent when not verified. */
  verifiedAt?: string
}

/**
 * Wire response shape. `success: true` for mark_local/relink/drop_entry
 * carries the entry's post-write state, read back INSIDE the same
 * `updateSafely()` transaction (M11 — the AC#2 verification-gate
 * requirement), plus the ledger entry id for a later precise revert.
 */
export interface ApplyManifestReconcileResponse {
  success: boolean
  action: ManifestReconcileAction
  /** Echoes the input `name` when known. */
  name?: string
  manifestKey?: string
  /** Post-write entry state (mark_local/relink). Absent for drop_entry (removed) and verify (batch). */
  entry?: SkillManifestEntry
  /** verify only: per-entry results (length 1 for a single-name verify). */
  verifyResults?: ManifestReconcileVerifyResult[]
  /** mark_local/relink/drop_entry/verify(single-write): ledger entry id for a later precise revert. */
  ledgerEntryId?: string
  /** revert only: true when the revert was a no-op (no matching ledger entry — already reverted or never applied). */
  noOp?: boolean
  /** Absolute path to the pre-mutation manifest backup (C8), when a backup was taken. */
  backupPath?: string
  errorCode?: ManifestReconcileErrorCode
  error?: string
}
