/**
 * @fileoverview `verify` action implementation for `apply_manifest_reconcile`
 *               (SMI-6343 Wave 4, C3).
 * @module @skillsmith/mcp-server/tools/apply-manifest-reconcile.verify
 *
 * Split out of `apply-manifest-reconcile.actions.ts` (500-line file gate) —
 * the Wave 4 adversarial-review fix for the async-verify-then-locked-write
 * race (see the two doc comments inside `runVerify` below) pushed the
 * combined actions file over the limit.
 */

import { ManifestManager, type SkillManifest, type SkillManifestEntry } from '@skillsmith/core'

import type { ToolContext } from '../context.js'
import { appendReconcileLedgerEntry } from './manifest-reconcile-ledger.js'
import type { ManifestReconcileLedgerEntry } from './manifest-reconcile-ledger.types.js'
import type {
  ApplyManifestReconcileInput,
  ApplyManifestReconcileResponse,
  ManifestReconcileVerifyResult,
} from './apply-manifest-reconcile.types.js'
import {
  ReconcileGuardError,
  resolveReconcileEntry,
  takeManifestBackup,
  verifyEntryAgainstRegistry,
  type ReconcileScopeTarget,
} from './apply-manifest-reconcile.helpers.js'
import { withLockTimeoutMapping } from './apply-manifest-reconcile.lock-helpers.js'

// ============================================================================
// verify (C3)
// ============================================================================

export async function runVerify(
  input: ApplyManifestReconcileInput,
  scopeTarget: ReconcileScopeTarget,
  context: ToolContext
): Promise<ApplyManifestReconcileResponse> {
  const manager = new ManifestManager(scopeTarget.manifestPath)
  const manifest = await manager.load()

  let targets: Array<{ key: string; entry: SkillManifestEntry }>
  if (input.name) {
    // Single-entry verify: total unavailability is a hard failure — the
    // caller asked about ONE entry and there is nothing partial to report.
    if (context.apiClient.isOffline()) {
      throw new ReconcileGuardError('manifest.reconcile.verify_unavailable', {
        name: input.name,
        detail: 'registry is offline',
      })
    }
    const { key, entry } = resolveReconcileEntry(manifest, input.name, scopeTarget.client)
    targets = [{ key, entry }]
  } else {
    // Batch (C3: "Batch by default"). Never hard-fails on offline/quota —
    // each entry degrades to an honest unverified result (H1 philosophy).
    targets = Object.entries(manifest.installedSkills).map(([key, entry]) => ({
      key,
      entry: entry as SkillManifestEntry,
    }))
  }

  let quotaExhausted = false
  const results: ManifestReconcileVerifyResult[] = []
  const writes: Array<{ key: string; verifiedAt: string }> = []

  for (const { key, entry } of targets) {
    const outcome = await verifyEntryAgainstRegistry(
      entry,
      context,
      () => {
        quotaExhausted = true
      },
      quotaExhausted
    )
    results.push({ name: entry.name ?? key, manifestKey: key, ...outcome })
    if (outcome.verified && outcome.verifiedAt) {
      writes.push({ key, verifiedAt: outcome.verifiedAt })
    }
  }

  if (writes.length === 0) {
    // C3: "Writes nothing on a mismatch" — no backup/ledger churn for a
    // pass that changed nothing.
    return { success: true, action: 'verify', verifyResults: results }
  }

  const backupPath = await takeManifestBackup(scopeTarget.manifestPath)
  const ledgerEntries: ManifestReconcileLedgerEntry[] = []
  // Adversarial-review finding: `writes` was PLANNED from the pre-lock
  // registry comparison — it is not proof any of them actually happened.
  // `actuallyWritten` records only the entries this lock's callback truly
  // mutated, so the ledger below can never claim a write that didn't occur
  // (the exact gap that made a `revert` of a phantom verify immediately
  // hit `entry_changed`, since the manifest never matched the claimed
  // `afterState` in the first place).
  const actuallyWritten: Array<{
    key: string
    verifiedAt: string
    priorEntry: SkillManifestEntry
  }> = []

  await withLockTimeoutMapping(scopeTarget.manifestPath, () =>
    manager.updateSafely((m: SkillManifest) => {
      const updatedSkills = { ...m.installedSkills }
      for (const { key, verifiedAt } of writes) {
        const current = updatedSkills[key] as SkillManifestEntry | undefined
        const verifiedSnapshot = targets.find((t) => t.key === key)?.entry
        // Defense-in-depth: an entry that vanished between the async verify
        // pass and this lock (dropped by a concurrent writer) is skipped —
        // there is nothing left to stamp verifiedAt onto. Likewise, if the
        // entry's IDENTITY (id/installPath) changed since it was verified —
        // e.g. a concurrent relink or reinstall of the same key — the
        // content that was actually hashed against the registry is no
        // longer what this entry claims to be, so stamping verifiedAt onto
        // the NEW identity would certify a pair that was never checked.
        if (
          !current ||
          !verifiedSnapshot ||
          current.id !== verifiedSnapshot.id ||
          current.installPath !== verifiedSnapshot.installPath
        ) {
          continue
        }
        updatedSkills[key] = { ...current, verifiedAt }
        actuallyWritten.push({ key, verifiedAt, priorEntry: current })
      }
      return { ...m, installedSkills: updatedSkills }
    })
  )

  // Ledger entries recorded AFTER the write, and ONLY for keys the lock's
  // callback actually mutated (see `actuallyWritten` above) — never for a
  // key that was merely planned and then skipped inside the lock.
  for (const { key, verifiedAt, priorEntry } of actuallyWritten) {
    const ledgerEntry = await appendReconcileLedgerEntry({
      manifestPath: scopeTarget.manifestPath,
      manifestKey: key,
      name: priorEntry.name ?? key,
      client: scopeTarget.client,
      action: 'verify',
      beforeState: priorEntry as unknown as Record<string, unknown>,
      afterState: { ...priorEntry, verifiedAt } as unknown as Record<string, unknown>,
      reason: input.reason ?? 'apply_manifest_reconcile: verify',
    })
    ledgerEntries.push(ledgerEntry)
  }

  return {
    success: true,
    action: 'verify',
    verifyResults: results,
    backupPath,
    // Single-entry verify: surface the one ledger entry id directly for a
    // later precise revert, mirroring the other single-write actions.
    ledgerEntryId: input.name ? ledgerEntries[0]?.id : undefined,
  }
}
