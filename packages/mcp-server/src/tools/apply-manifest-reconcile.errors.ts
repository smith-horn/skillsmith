/**
 * @fileoverview `describeReconcileError()` — the M2 error-taxonomy prose
 *               generator for `apply_manifest_reconcile`.
 * @module @skillsmith/mcp-server/tools/apply-manifest-reconcile.errors
 *
 * Modeled on `StuckLockError` (`packages/core/src/config/owned-lock.acquire.ts`):
 * "`reason` is a stable discriminant for mechanical triage (never
 * prose-matching); the message embeds the manual unstick procedure
 * verbatim." Every `ManifestReconcileErrorCode` message is generated HERE,
 * from the code plus its context, so code and prose cannot drift apart —
 * and each message embeds the exact next remediation command inline.
 */

import type { StuckLockReason } from '@skillsmith/core'
import type { ManifestReconcileErrorCode } from './apply-manifest-reconcile.types.js'

export interface ReconcileErrorContext {
  name?: string
  manifestKey?: string
  /** H9: the other key found when `key_shape_ambiguous` fires. */
  otherKey?: string
  id?: string
  source?: string
  path?: string
  /**
   * lock_timeout only: the underlying `StuckLockError.reason` (SMI-6735
   * adversarial-review finding 1). Drives wording — `unreclaimable_legacy`
   * and `unreclaimable_unparseable` never clear on their own (they are not
   * in `file-lock.ts`'s `RETRYABLE_REASONS`, so `withFileLock` fails on the
   * FIRST attempt), so telling the caller it "timed out" implies a retry
   * will help when it never will.
   */
  lockReason?: StuckLockReason
  /**
   * lock_timeout only, present when `lockReason === 'reclaim_unavailable'`:
   * the second file `owned-lock.ts`'s own module docstring documents as the
   * accepted mitigation for its R1 residual risk (a `SIGKILL` inside the
   * reclaim critical section orphans `<lock>.reclaim`) — naming ONLY the
   * main lock path here would leave that orphan permanently un-diagnosable.
   */
  reclaimPath?: string
  ledgerEntryId?: string
  /** entry_changed: the value recorded at write time vs. what is on disk now. */
  recordedValue?: unknown
  currentValue?: unknown
  /** revert_ambiguous: candidate ledger entry ids. */
  candidateIds?: string[]
  /** ledger_version_unsupported. */
  found?: number
  expected?: number
  /** underlying error message, when wrapping a caught error. */
  detail?: string
}

/**
 * Generate the human-readable message for a `ManifestReconcileErrorCode`,
 * embedding the exact next command a caller should run.
 */
export function describeReconcileError(
  code: ManifestReconcileErrorCode,
  ctx: ReconcileErrorContext = {}
): string {
  switch (code) {
    case 'manifest.reconcile.invalid_input':
      return `Invalid apply_manifest_reconcile input${ctx.detail ? `: ${ctx.detail}` : '.'}`
    case 'manifest.reconcile.entry_not_found':
      return (
        `No manifest entry found for '${ctx.name ?? '<unknown>'}'` +
        (ctx.manifestKey ? ` (key '${ctx.manifestKey}')` : '') +
        `. Confirm the skill name and client — run skill_outdated to list known entries.`
      )
    case 'manifest.reconcile.key_shape_ambiguous':
      return (
        `Ambiguous manifest key for '${ctx.name ?? '<unknown>'}': found both '${ctx.manifestKey ?? '<unknown>'}' ` +
        `and '${ctx.otherKey ?? '<unknown>'}' recorded under different clients (SMI-6358/6359). ` +
        `Refusing to guess which entry to reconcile — pass an explicit 'client' matching the entry you intend.`
      )
    case 'manifest.reconcile.relink_unvalidated':
      return (
        `Could not confirm registry id '${ctx.id ?? '<unknown>'}' exists in the registry` +
        (ctx.detail ? ` (${ctx.detail})` : '.') +
        ` relink never infers or guesses an identity (ADR-144 §3) — retry when the registry is reachable, ` +
        `or run skill_recover_source for evidence and use mark_local instead if the identity cannot be confirmed.`
      )
    case 'manifest.reconcile.relink_incomplete':
      return `relink requires BOTH 'id' and 'source' — apply_manifest_reconcile never infers an identity implicitly (ADR-144 §3).`
    case 'manifest.reconcile.drop_target_still_resolves':
      return (
        `Refusing to drop '${ctx.name ?? '<unknown>'}': its installPath` +
        (ctx.path ? ` ('${ctx.path}')` : '') +
        ` still resolves on disk. drop_entry is for entries whose install directory no longer ` +
        `exists — if you intend to remove a still-installed skill's manifest record anyway, use ` +
        `mark_local instead, or uninstall the skill first.`
      )
    case 'manifest.reconcile.backup_target_not_a_file':
      return `Refusing to back up '${ctx.path ?? '<unknown>'}' — it is not a regular file (C8 guard rail; see createProseBackup's single-file contract).`
    case 'manifest.reconcile.backup_failed':
      return `Failed to create the pre-mutation manifest backup${ctx.detail ? `: ${ctx.detail}` : '.'} No write was made.`
    case 'manifest.reconcile.lock_timeout': {
      // `unreclaimable_legacy`/`unreclaimable_unparseable` fail on the FIRST
      // attempt (never in `RETRYABLE_REASONS`) and never clear on their own —
      // "timed out ... waiting" would wrongly imply retrying helps.
      const nonRetryable =
        ctx.lockReason === 'unreclaimable_legacy' || ctx.lockReason === 'unreclaimable_unparseable'
      const verb = nonRetryable
        ? `Could not acquire the manifest lock at '${ctx.path ?? '<unknown>'}'`
        : `Timed out waiting for the manifest lock at '${ctx.path ?? '<unknown>'}'`
      const lockPath = ctx.path ?? '<manifest>.lock'
      const namesReclaim = Boolean(ctx.reclaimPath)
      return (
        `${verb}${ctx.lockReason ? ` (reason: ${ctx.lockReason})` : ''}. Manual unstick -- ` +
        `1) confirm no skillsmith process is running: ps -ax | grep -E '[s]killsmith|[s]klx'; ` +
        `2) inspect (read-only): cat ${lockPath}${namesReclaim ? ` ; cat ${ctx.reclaimPath}` : ''}; ` +
        `3) if stale, remove it: rm ${lockPath}${namesReclaim ? ` ; rm ${ctx.reclaimPath}` : ''}.`
      )
    }
    case 'manifest.reconcile.entry_changed':
      return (
        `Refusing to revert ledger entry '${ctx.ledgerEntryId ?? '<unknown>'}' for '${ctx.name ?? '<unknown>'}': ` +
        `the entry changed since this action ran (recorded ${JSON.stringify(ctx.recordedValue)}, now ${JSON.stringify(ctx.currentValue)}). ` +
        `Something else wrote this entry after the reconcile — inspect it with skill_outdated before retrying.`
      )
    case 'manifest.reconcile.revert_ambiguous':
      return (
        `revert is ambiguous for '${ctx.name ?? '<unknown>'}': ${(ctx.candidateIds ?? []).length} ledger entries match ` +
        `and none was disambiguated. Pass 'ledgerEntryId' explicitly — candidates: ${(ctx.candidateIds ?? []).join(', ')}.`
      )
    case 'manifest.reconcile.ledger_version_unsupported':
      return (
        `manifest-reconcile-ledger.json version ${String(ctx.found)} is newer than supported version ${String(ctx.expected)}. ` +
        `This client cannot safely read or write the ledger — upgrade @skillsmith/mcp-server, or manually inspect ` +
        `~/.skillsmith/manifest-reconcile-ledger.json before proceeding.`
      )
    case 'manifest.reconcile.ledger_malformed':
      return `manifest-reconcile-ledger.json could not be parsed${ctx.detail ? ` (${ctx.detail})` : '.'} Inspect it manually at ~/.skillsmith/manifest-reconcile-ledger.json before retrying.`
    case 'manifest.reconcile.verify_unavailable':
      return (
        `Could not reach the registry to verify '${ctx.name ?? '<unknown>'}'${ctx.detail ? ` (${ctx.detail})` : '.'} ` +
        `Retry when online, or re-run without 'name' to get a partial batch result across every entry that CAN be checked.`
      )
    default: {
      const exhaustive: never = code
      return exhaustive
    }
  }
}
