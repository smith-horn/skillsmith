/**
 * @fileoverview Type vocabulary for the manifest-reconcile ledger
 *               (SMI-6343 Wave 4, C7).
 * @module @skillsmith/mcp-server/tools/manifest-reconcile-ledger.types
 *
 * Schema for `~/.skillsmith/manifest-reconcile-ledger.json` — the durable,
 * cross-session revert source of truth for `apply_manifest_reconcile`.
 * Shaped field-for-field on `audit/namespace-overrides.types.ts` (the
 * `apply_namespace_rename` ledger), NOT on `undo_apply`'s in-process
 * session stack (`apply-session.helpers.ts`) or its whole-file backup
 * restore (`undo-apply.ts`) — see the plan's C7 subsection for why both
 * were rejected as the model for THIS ledger:
 *   1. `undo_apply` is session-scoped/in-process, with no cross-session
 *      persistence.
 *   2. Its never-clobber guard hashes the WHOLE target file. The manifest
 *      has seven independent writers (plan §P-5); any unrelated write
 *      between a reconcile and an attempted undo would permanently block
 *      it.
 *   3. `undo_apply`'s restore path takes no manifest lock at all.
 *
 * This ledger instead records ONE manifest key's complete before/after
 * state per entry, and `revertReconcile()` (`manifest-reconcile-ledger.ts`)
 * restores through `ManifestManager.updateSafely()` — a locked,
 * single-key merge that leaves every other manifest entry untouched, so an
 * unrelated install between a reconcile and its revert is invisible to the
 * revert rather than fatal to it.
 */

/**
 * Current ledger schema version. Bumped only when the on-disk shape
 * changes incompatibly. `version > CURRENT_LEDGER_VERSION` on read returns
 * a typed `manifest.reconcile.ledger_version_unsupported` error rather
 * than silently degrading to an empty ledger (mirrors
 * `namespace-overrides.ts`'s `readLedgerResult`).
 */
export const CURRENT_LEDGER_VERSION = 1 as const

export type ManifestReconcileLedgerVersion = typeof CURRENT_LEDGER_VERSION

/** The four `apply_manifest_reconcile` actions that mutate the manifest and are therefore revertible. `verify` is included: writing `verifiedAt` is a mutation like any other, even though it is a low-stakes one to undo. */
export type ManifestReconcileMutatingAction = 'mark_local' | 'relink' | 'drop_entry' | 'verify'

/**
 * One reconcile action recorded in the ledger. Persisted in
 * `~/.skillsmith/manifest-reconcile-ledger.json` under `entries[]`.
 *
 * `beforeState`/`afterState` are the COMPLETE manifest entry object (every
 * field, not a diff) at the moment before/after this action's write —
 * this is what lets `revertReconcile()` do a full single-key restore
 * without needing to know which fields the original action touched.
 * `afterState` is `null` for `drop_entry` (the entry no longer exists
 * after the action) and `beforeState` is never `null` (every action
 * requires a pre-existing entry — `entry_not_found` refuses otherwise).
 */
export interface ManifestReconcileLedgerEntry {
  /** ULID prefixed with `mrc_` for log-grep readability. */
  id: string
  /**
   * Absolute path to the manifest FILE this action wrote (H9: ADR-139
   * scope resolution means the same `(name, client)` pair can exist under
   * different manifest files — global vs. workspace-scoped). Revert reads
   * and writes THIS exact file, never re-resolving scope from caller
   * input, so a workspace-scoped reconcile can only ever be reverted
   * against the same workspace manifest it touched.
   */
  manifestPath: string
  /** The `installedSkills` key this action touched — `manifestKeyFor(name, client)`. */
  manifestKey: string
  /** Skill name, recorded independently of `manifestKey` so H9's revert
   *  key re-derivation does not need to parse the composite key shape. */
  name: string
  /** Client this entry was keyed under at the time of the action. */
  client: string
  action: ManifestReconcileMutatingAction
  /** Complete entry state immediately before this action's write. */
  beforeState: Record<string, unknown>
  /** Complete entry state immediately after this action's write, or
   *  `null` for `drop_entry` (the entry was removed). */
  afterState: Record<string, unknown> | null
  /** ISO-8601 UTC timestamp recorded by the writer. */
  appliedAt: string
  /** Caller-supplied or auto-generated human-readable reason for the action. */
  reason: string
}

/** On-disk shape of `~/.skillsmith/manifest-reconcile-ledger.json`. */
export interface ManifestReconcileLedger {
  version: ManifestReconcileLedgerVersion
  entries: ManifestReconcileLedgerEntry[]
}

/**
 * Typed error returned by `readReconcileLedgerResult` when the on-disk
 * file declares a higher version than this client understands. Never
 * thrown from the read path itself — callers decide whether to abort.
 */
export interface ReconcileLedgerVersionUnsupportedError {
  kind: 'manifest.reconcile.ledger_version_unsupported'
  found: number
  expected: ManifestReconcileLedgerVersion
}

/** Discriminated union returned by `readReconcileLedgerResult`. */
export type ReadReconcileLedgerResult =
  | { kind: 'ok'; ledger: ManifestReconcileLedger }
  | ReconcileLedgerVersionUnsupportedError
  | { kind: 'manifest.reconcile.ledger_malformed'; reason: string }
