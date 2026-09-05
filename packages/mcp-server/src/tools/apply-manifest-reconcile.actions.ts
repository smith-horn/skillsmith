/**
 * @fileoverview Per-action implementations for `apply_manifest_reconcile`
 *               (SMI-6343 Wave 4).
 * @module @skillsmith/mcp-server/tools/apply-manifest-reconcile.actions
 *
 * Split out of `apply-manifest-reconcile.ts` (500-line file gate). Every
 * write goes through `ManifestManager.updateSafely()` — core's locked,
 * single-key read-modify-write — never a whole-file writer (C7). Every
 * write also takes a `createProseBackup` snapshot first (C8) and records a
 * ledger entry after (C7), so both the forensic backup and the durable
 * revert exist before the caller sees a success response.
 */

import { ManifestManager, type SkillManifest, type SkillManifestEntry } from '@skillsmith/core'
import { resolveClientId, type ClientId } from '@skillsmith/core/install'

import type { ToolContext } from '../context.js'
import {
  appendReconcileLedgerEntry,
  findReconcileLedgerEntriesFor,
  readReconcileLedgerResult,
  removeReconcileLedgerEntry,
} from './manifest-reconcile-ledger.js'
import type { ManifestReconcileLedgerEntry } from './manifest-reconcile-ledger.types.js'
import type {
  ApplyManifestReconcileInput,
  ApplyManifestReconcileResponse,
} from './apply-manifest-reconcile.types.js'
import {
  ReconcileGuardError,
  assertDropTargetNoLongerResolves,
  reconcileKeyForLedgerEntry,
  resolveReconcileEntry,
  takeManifestBackup,
  validateRelinkIdentity,
  type ReconcileScopeTarget,
} from './apply-manifest-reconcile.helpers.js'
import { withLockTimeoutMapping } from './apply-manifest-reconcile.lock-helpers.js'

// `verify` lives in its own sibling file (500-line gate) — re-exported here
// so existing `from './apply-manifest-reconcile.actions.js'` imports (the
// dispatcher, tests) keep working unmodified.
export { runVerify } from './apply-manifest-reconcile.verify.js'

function requireName(input: ApplyManifestReconcileInput): string {
  if (!input.name || input.name.trim().length === 0) {
    throw new ReconcileGuardError('manifest.reconcile.invalid_input', {
      detail: `'name' is required for action '${input.action}'`,
    })
  }
  return input.name
}

// ============================================================================
// mark_local
// ============================================================================

export async function runMarkLocal(
  input: ApplyManifestReconcileInput,
  scopeTarget: ReconcileScopeTarget,
  _context: ToolContext
): Promise<ApplyManifestReconcileResponse> {
  const name = requireName(input)
  const manager = new ManifestManager(scopeTarget.manifestPath)

  // Fast-fail pre-check before spending a backup on a doomed write.
  resolveReconcileEntry(await manager.load(), name, scopeTarget.client)
  const backupPath = await takeManifestBackup(scopeTarget.manifestPath)

  let resolvedKey = ''
  let beforeState: SkillManifestEntry | undefined
  let afterState: SkillManifestEntry | undefined

  await withLockTimeoutMapping(scopeTarget.manifestPath, () =>
    manager.updateSafely((manifest: SkillManifest) => {
      const { key, entry } = resolveReconcileEntry(manifest, name, scopeTarget.client)
      resolvedKey = key
      beforeState = { ...entry }
      // ADR-145 §2: `provenance: 'local'` and `source: 'unknown'` are
      // written in the SAME locked update — never independently. Writing
      // `provenance` alone would produce the illegal `'local'` +
      // registry-ref cell (ADR-145's combination matrix).
      const updated: SkillManifestEntry = { ...entry, source: 'unknown', provenance: 'local' }
      afterState = updated
      return {
        ...manifest,
        installedSkills: { ...manifest.installedSkills, [key]: updated },
      }
    })
  )

  const ledgerEntry = await appendReconcileLedgerEntry({
    manifestPath: scopeTarget.manifestPath,
    manifestKey: resolvedKey,
    name,
    client: scopeTarget.client,
    action: 'mark_local',
    beforeState: beforeState as unknown as Record<string, unknown>,
    afterState: afterState as unknown as Record<string, unknown>,
    reason: input.reason ?? 'apply_manifest_reconcile: mark_local',
  })

  return {
    success: true,
    action: 'mark_local',
    name,
    manifestKey: resolvedKey,
    entry: afterState,
    ledgerEntryId: ledgerEntry.id,
    backupPath,
  }
}

// ============================================================================
// relink
// ============================================================================

export async function runRelink(
  input: ApplyManifestReconcileInput,
  scopeTarget: ReconcileScopeTarget,
  context: ToolContext
): Promise<ApplyManifestReconcileResponse> {
  const name = requireName(input)
  if (!input.id || !input.source) {
    throw new ReconcileGuardError('manifest.reconcile.relink_incomplete')
  }
  const id = input.id
  const source = input.source

  const manager = new ManifestManager(scopeTarget.manifestPath)
  resolveReconcileEntry(await manager.load(), name, scopeTarget.client)

  // Registry-validated pair (ADR-144 §3): confirm `id` is a real registry
  // identity BEFORE writing it. `apply_manifest_reconcile` never accepts a
  // `skill_recover_source` candidate implicitly — the caller supplies both
  // `id` and `source` explicitly; this only proves `id` is not fabricated.
  const validation = await validateRelinkIdentity(id, context)
  if (!validation.ok) {
    throw new ReconcileGuardError('manifest.reconcile.relink_unvalidated', {
      id,
      detail: validation.detail,
    })
  }

  const backupPath = await takeManifestBackup(scopeTarget.manifestPath)

  let resolvedKey = ''
  let beforeState: SkillManifestEntry | undefined
  let afterState: SkillManifestEntry | undefined

  await withLockTimeoutMapping(scopeTarget.manifestPath, () =>
    manager.updateSafely((manifest: SkillManifest) => {
      const { key, entry } = resolveReconcileEntry(manifest, name, scopeTarget.client)
      resolvedKey = key
      beforeState = { ...entry }
      // relink asserts an identity; it does NOT set verifiedAt — a relink
      // is not a content verification (see the tool's Actions doc). Any
      // PRIOR verifiedAt is explicitly cleared here: it was recorded
      // against the entry's OLD claimed id, and carrying it forward onto a
      // freshly-relinked (possibly different) identity would misrepresent
      // stale evidence as current — ADR-145 §3's freshness guarantee only
      // holds when verifiedAt and the identity it was checked against
      // change together.
      const updated: SkillManifestEntry = { ...entry, id, source, provenance: 'registry' }
      delete updated.verifiedAt
      afterState = updated
      return {
        ...manifest,
        installedSkills: { ...manifest.installedSkills, [key]: updated },
      }
    })
  )

  const ledgerEntry = await appendReconcileLedgerEntry({
    manifestPath: scopeTarget.manifestPath,
    manifestKey: resolvedKey,
    name,
    client: scopeTarget.client,
    action: 'relink',
    beforeState: beforeState as unknown as Record<string, unknown>,
    afterState: afterState as unknown as Record<string, unknown>,
    reason: input.reason ?? 'apply_manifest_reconcile: relink',
  })

  return {
    success: true,
    action: 'relink',
    name,
    manifestKey: resolvedKey,
    entry: afterState,
    ledgerEntryId: ledgerEntry.id,
    backupPath,
  }
}

// ============================================================================
// drop_entry
// ============================================================================

export async function runDropEntry(
  input: ApplyManifestReconcileInput,
  scopeTarget: ReconcileScopeTarget,
  _context: ToolContext
): Promise<ApplyManifestReconcileResponse> {
  const name = requireName(input)
  const manager = new ManifestManager(scopeTarget.manifestPath)
  const { entry: preCheckEntry } = resolveReconcileEntry(
    await manager.load(),
    name,
    scopeTarget.client
  )
  // Adversarial-review finding: the tool's own contract for this action is
  // "installPath no longer resolves" — enforce it, don't just narrate it.
  await assertDropTargetNoLongerResolves(name, preCheckEntry)
  const backupPath = await takeManifestBackup(scopeTarget.manifestPath)

  let resolvedKey = ''
  let beforeState: SkillManifestEntry | undefined

  await withLockTimeoutMapping(scopeTarget.manifestPath, () =>
    manager.updateSafely((manifest: SkillManifest) => {
      const { key, entry } = resolveReconcileEntry(manifest, name, scopeTarget.client)
      resolvedKey = key
      beforeState = { ...entry }
      const remaining = { ...manifest.installedSkills }
      delete remaining[key]
      return { ...manifest, installedSkills: remaining }
    })
  )

  const ledgerEntry = await appendReconcileLedgerEntry({
    manifestPath: scopeTarget.manifestPath,
    manifestKey: resolvedKey,
    name,
    client: scopeTarget.client,
    action: 'drop_entry',
    beforeState: beforeState as unknown as Record<string, unknown>,
    afterState: null,
    reason: input.reason ?? 'apply_manifest_reconcile: drop_entry',
  })

  return {
    success: true,
    action: 'drop_entry',
    name,
    manifestKey: resolvedKey,
    ledgerEntryId: ledgerEntry.id,
    backupPath,
  }
}

// ============================================================================
// revert (C7)
// ============================================================================

export async function runRevert(
  input: ApplyManifestReconcileInput,
  scopeTarget: ReconcileScopeTarget,
  _context: ToolContext
): Promise<ApplyManifestReconcileResponse> {
  // Read the raw discriminated union (not the convenience `readReconcileLedger`
  // wrapper, which silently degrades a malformed ledger to empty) — for
  // `revert` specifically, a ledger the tool couldn't actually read must
  // never be indistinguishable from "nothing to revert" (an idempotent
  // no-op). Both failure kinds map to their own M2 error code.
  const ledgerResult = await readReconcileLedgerResult()
  if (ledgerResult.kind === 'manifest.reconcile.ledger_version_unsupported') {
    throw new ReconcileGuardError('manifest.reconcile.ledger_version_unsupported', {
      found: ledgerResult.found,
      expected: ledgerResult.expected,
    })
  }
  if (ledgerResult.kind === 'manifest.reconcile.ledger_malformed') {
    throw new ReconcileGuardError('manifest.reconcile.ledger_malformed', {
      detail: ledgerResult.reason,
    })
  }
  const ledger = ledgerResult.ledger

  let target: ManifestReconcileLedgerEntry | undefined
  if (input.ledgerEntryId) {
    target = ledger.entries.find((e) => e.id === input.ledgerEntryId)
    if (!target) {
      // Idempotent no-op (C7): the entry is gone — already reverted, or
      // the id never existed. Reverting twice is success, not an error.
      return { success: true, action: 'revert', noOp: true, name: input.name }
    }
  } else {
    const name = requireName(input)
    const client: ClientId = resolveClientId(input.client)
    const matches = findReconcileLedgerEntriesFor(ledger, name, client, scopeTarget.manifestPath)
    if (matches.length === 0) {
      return { success: true, action: 'revert', noOp: true, name }
    }
    if (matches.length > 1) {
      throw new ReconcileGuardError('manifest.reconcile.revert_ambiguous', {
        name,
        candidateIds: matches.map((m) => m.id),
      })
    }
    target = matches[0]
  }

  // H9: re-derive the key from the LEDGER ENTRY's own recorded (name,
  // client) — never from caller input — so a revert cannot be aimed at a
  // different row than the action it reverses.
  const key = reconcileKeyForLedgerEntry(target.name, target.client)
  const manager = new ManifestManager(target.manifestPath)

  await withLockTimeoutMapping(target.manifestPath, () =>
    manager.updateSafely((manifest: SkillManifest) => {
      const current = manifest.installedSkills[key] as unknown as
        | Record<string, unknown>
        | undefined
      // Same-entry conflict detection replaces the whole-file hash guard
      // (C7): only THIS entry's current value vs. its recorded after-state
      // matters. An unrelated install of a DIFFERENT skill is invisible to
      // this check, exactly the case the rejected undo_apply design failed.
      const recordedAfter = target!.afterState // null for drop_entry (entry should be absent)
      const currentNormalized = current ?? null
      if (!deepEqualEntry(currentNormalized, recordedAfter)) {
        throw new ReconcileGuardError('manifest.reconcile.entry_changed', {
          name: target!.name,
          manifestKey: key,
          ledgerEntryId: target!.id,
          recordedValue: recordedAfter,
          currentValue: currentNormalized,
        })
      }

      // `beforeState` is never null/absent by construction — every action
      // requires a pre-existing entry, so reverting always has a real
      // entry snapshot to restore (including for `drop_entry`, whose
      // `afterState` is null but `beforeState` is the removed entry).
      const updatedSkills = { ...manifest.installedSkills }
      updatedSkills[key] = target!.beforeState as unknown as SkillManifestEntry
      return { ...manifest, installedSkills: updatedSkills }
    })
  )

  await removeReconcileLedgerEntry(target.id)

  return {
    success: true,
    action: 'revert',
    name: target.name,
    manifestKey: key,
    entry: target.beforeState as unknown as SkillManifestEntry,
    noOp: false,
  }
}

/**
 * Deep equality for a manifest entry snapshot (JSON-serializable values
 * only), independent of object key insertion order — a plain
 * `JSON.stringify(a) === JSON.stringify(b)` would false-positive-diverge
 * on two structurally identical objects whose keys were inserted in a
 * different order (a real risk here: one side comes from a fresh
 * `manifest.json` parse, the other from a `manifest-reconcile-ledger.json`
 * parse recorded at a different point in time).
 */
function deepEqualEntry(
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null
): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(',')
  return `{${body}}`
}
