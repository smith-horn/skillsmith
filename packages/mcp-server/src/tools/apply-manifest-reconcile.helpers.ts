/**
 * @fileoverview Execution helpers for `apply_manifest_reconcile`
 *               (SMI-6343 Wave 4).
 * @module @skillsmith/mcp-server/tools/apply-manifest-reconcile.helpers
 *
 * Split out of `apply-manifest-reconcile.ts` (500-line file gate): H9 key
 * resolution + scope contract, C8 backup guard rail, and the `verify`
 * action's live registry-comparison logic (reusing Wave 2's shared
 * comparator + `lookupSkillFromRegistry`'s offline/quota degradation
 * contract, the SAME pattern `outdated.ts` already uses).
 */

import * as fs from 'node:fs/promises'
import type { Stats } from 'node:fs'

import {
  compareSkillContentHashes,
  manifestKeyFor,
  type SkillManifest,
  type SkillManifestEntry,
} from '@skillsmith/core'
import {
  CANONICAL_CLIENT,
  InvalidScopeValueError,
  UnsatisfiableWorkspaceScopeError,
  parseInstallScope,
  resolveClientId,
  resolveScopedSkillsDir,
  type ClientId,
} from '@skillsmith/core/install'

import type { ToolContext } from '../context.js'
import { createProseBackup, hashContent } from './install.conflict-helpers.js'
import { lookupSkillFromRegistry } from './install.helpers.js'
import { readInstalledContent } from './outdated.helpers.js'
import { MANIFEST_PATH } from './install.types.js'
import type {
  ApplyManifestReconcileInput,
  ManifestReconcileErrorCode,
  ManifestReconcileVerifyResult,
} from './apply-manifest-reconcile.types.js'
import type { ReconcileErrorContext } from './apply-manifest-reconcile.errors.js'

/**
 * Thrown from inside a synchronous `ManifestManager.updateSafely()` update
 * function (or by scope/backup preflight) to carry a typed
 * `ManifestReconcileErrorCode` out to the tool's top-level dispatcher,
 * which maps it to the response envelope via `describeReconcileError()`.
 */
export class ReconcileGuardError extends Error {
  readonly code: ManifestReconcileErrorCode
  readonly ctx: ReconcileErrorContext

  constructor(code: ManifestReconcileErrorCode, ctx: ReconcileErrorContext = {}) {
    super(code)
    this.name = 'ReconcileGuardError'
    this.code = code
    this.ctx = ctx
  }
}

export interface ReconcileScopeTarget {
  manifestPath: string
  client: ClientId
  scope: 'global' | 'workspace'
}

/**
 * H9: resolve the manifest path for the requested scope BEFORE any read.
 * Mirrors `uninstall_skill`'s ADR-139 scope resolution exactly (same
 * resolver, same three inputs) so `apply_manifest_reconcile` reconciles
 * the SAME manifest a workspace-scoped install/uninstall would touch.
 *
 * `InvalidScopeValueError`/`UnsatisfiableWorkspaceScopeError` propagate to
 * the caller, which maps them to `manifest.reconcile.invalid_input`.
 */
export function resolveReconcileScope(input: ApplyManifestReconcileInput): ReconcileScopeTarget {
  const client = resolveClientId(input.client)
  const scopeTarget = resolveScopedSkillsDir({
    client,
    explicitScope: parseInstallScope(input.scope),
    ...(input.cwd !== undefined && { cwd: input.cwd }),
    globalManifestPath: MANIFEST_PATH,
  })
  return { manifestPath: scopeTarget.manifestPath, client, scope: scopeTarget.scope }
}

/** Re-exported so the main tool file can catch these without importing core/install directly twice. */
export { InvalidScopeValueError, UnsatisfiableWorkspaceScopeError, CANONICAL_CLIENT }

/**
 * H9: derive the manifest key ONLY via `manifestKeyFor(name, client)` —
 * never by indexing `installedSkills[name]` directly — and refuse rather
 * than guess when a bare-name key exists under a DIFFERENT client (the
 * SMI-6358/6359 bare-key writer hazard this plan cannot fix but must not
 * assume away).
 *
 * Throws `ReconcileGuardError('manifest.reconcile.entry_not_found')` or
 * `ReconcileGuardError('manifest.reconcile.key_shape_ambiguous')`.
 */
export function resolveReconcileEntry(
  manifest: SkillManifest,
  name: string,
  client: ClientId
): { key: string; entry: SkillManifestEntry } {
  const key = manifestKeyFor(name, client)
  const entry = manifest.installedSkills[key] as SkillManifestEntry | undefined
  if (entry) {
    // Adversarial-review finding (Wave 4): for the CANONICAL client,
    // `manifestKeyFor` returns the bare `name` itself — the same bare key
    // the SMI-6358/6359 bug can leave a NON-canonical entry sitting under.
    // Finding the entry at the resolved key is not proof it belongs to the
    // requested `client`: if the entry itself carries a recorded `client`
    // that disagrees, silently trusting it would let mark_local/relink/
    // drop_entry mutate a DIFFERENT client's row than the caller intended.
    // A missing `entry.client` is the documented legacy-entry default
    // (implicitly canonical, per SMI-5894) and is NOT a conflict.
    if (entry.client && entry.client !== client) {
      throw new ReconcileGuardError('manifest.reconcile.key_shape_ambiguous', {
        name,
        manifestKey: key,
        otherKey: key,
      })
    }
    return { key, entry }
  }

  // Not found under the resolved key. Before refusing entry_not_found,
  // check whether a bare-name key exists carrying a DIFFERENT client —
  // that is the key-shape-ambiguous case, not a genuine absence.
  if (client !== CANONICAL_CLIENT) {
    const bareEntry = manifest.installedSkills[name] as SkillManifestEntry | undefined
    if (bareEntry && bareEntry.client && bareEntry.client !== client) {
      throw new ReconcileGuardError('manifest.reconcile.key_shape_ambiguous', {
        name,
        manifestKey: key,
        otherKey: name,
      })
    }
  }

  throw new ReconcileGuardError('manifest.reconcile.entry_not_found', { name, manifestKey: key })
}

/**
 * On `revert`, re-derive the manifest key from the LEDGER ENTRY's own
 * recorded `(name, client)` pair, never from caller input (H9) — a revert
 * cannot be aimed at a different row than the action it reverses.
 */
export function reconcileKeyForLedgerEntry(name: string, client: string): string {
  return manifestKeyFor(name, client as ClientId)
}

// ============================================================================
// drop_entry — installPath-still-resolves guard (adversarial-review finding)
// ============================================================================

/**
 * `drop_entry`'s own tool description and the plan's Actions table both
 * describe it as removing an entry "whose installPath no longer resolves"
 * — the implementation must actually enforce that, not just narrate it.
 * Without this check, `drop_entry` would silently orphan a healthy,
 * currently-installed skill's on-disk files by deleting only its manifest
 * record. Refuses when `installPath` still resolves to an existing
 * directory; any stat failure (ENOENT or otherwise) is treated as
 * "no longer resolves" — exactly the case this action exists for.
 */
export async function assertDropTargetNoLongerResolves(
  name: string,
  entry: SkillManifestEntry
): Promise<void> {
  if (!entry.installPath) return
  let stat: Stats
  try {
    stat = await fs.stat(entry.installPath)
  } catch {
    return
  }
  if (stat.isDirectory()) {
    throw new ReconcileGuardError('manifest.reconcile.drop_target_still_resolves', {
      name,
      path: entry.installPath,
    })
  }
}

// ============================================================================
// C8 — backup step (security)
// ============================================================================

/**
 * C8 guard rail: assert the backup target is a regular FILE before ever
 * calling `createProseBackup`. Makes the "someone later passes the parent
 * directory (~/.skillsmith/, which holds config.json's live API key)"
 * mistake structurally impossible rather than merely unlikely — see the
 * plan's C8 subsection and the regression test asserting `config.json`
 * never appears in the backups tree.
 */
export async function assertBackupTargetIsFile(filePath: string): Promise<void> {
  let stat: Stats
  try {
    stat = await fs.stat(filePath)
  } catch (err) {
    throw new ReconcileGuardError('manifest.reconcile.backup_target_not_a_file', {
      path: filePath,
      detail: (err as Error).message,
    })
  }
  if (!stat.isFile()) {
    throw new ReconcileGuardError('manifest.reconcile.backup_target_not_a_file', {
      path: filePath,
    })
  }
}

/**
 * Take a pre-mutation backup of the manifest via `createProseBackup` —
 * NEVER `createSkillBackup` (C8: the latter does a recursive `readdir`+
 * copy and, if ever pointed at `~/.skillsmith/` instead of the file
 * itself, would copy `config.json`'s live API key into the backups tree).
 * `createProseBackup` is structurally incapable of this — one `copyFile`
 * of one caller-supplied path, no `readdir`, no recursion.
 */
export async function takeManifestBackup(manifestPath: string): Promise<string> {
  await assertBackupTargetIsFile(manifestPath)
  try {
    const { backupPath } = await createProseBackup(manifestPath, 'manifest-reconcile')
    return backupPath
  } catch (err) {
    throw new ReconcileGuardError('manifest.reconcile.backup_failed', {
      detail: (err as Error).message,
    })
  }
}

// ============================================================================
// verify — live registry comparison (mirrors outdated.ts's H1 contract)
// ============================================================================

/**
 * Compare one manifest entry's on-disk content hash against the
 * registry's LIVE current content hash for its claimed `id`. Unlike
 * `skill_outdated`, `verify` deliberately does NOT fall back to the
 * historical `skill_versions` arm — ADR-144 §6's `verifiedAt` promotion
 * specifically requires validating against ground truth NOW, not a
 * possibly-stale cached hash (see this tool's own doc comment on the
 * `verify` action).
 *
 * Never throws — every failure mode degrades to
 * `{ verified: false, reason }`, mirroring `lookupSkillFromRegistry`'s own
 * fail-soft contract and `outdated.ts`'s H1 degradation table.
 */
export async function verifyEntryAgainstRegistry(
  entry: SkillManifestEntry,
  context: ToolContext,
  onQuotaExceeded: () => void,
  quotaAlreadyExhausted: boolean
): Promise<Omit<ManifestReconcileVerifyResult, 'name' | 'manifestKey'>> {
  if (!entry.installPath) {
    return { verified: false, reason: 'no-registry-record' }
  }
  const localContent = await readInstalledContent(entry.installPath)
  const localHash = localContent !== null ? hashContent(localContent) : null
  if (localHash === null) {
    return { verified: false, reason: 'no-registry-record' }
  }

  if (context.apiClient.isOffline()) {
    return { verified: false, reason: 'offline' }
  }
  if (quotaAlreadyExhausted) {
    return { verified: false, reason: 'quota-exhausted' }
  }

  let liveArmFailed = false
  let registryHash: string | null = null
  try {
    const registryInfo = await lookupSkillFromRegistry(entry.id, context, {
      onQuotaExceeded,
      onLiveLookupFailed: () => {
        liveArmFailed = true
      },
    })
    registryHash = registryInfo?.contentHash ?? null
  } catch {
    liveArmFailed = true
  }

  if (liveArmFailed) {
    return { verified: false, reason: 'network-error' }
  }
  if (registryHash === null) {
    return { verified: false, reason: 'no-registry-record' }
  }

  const comparison = compareSkillContentHashes(localHash, registryHash)
  if (comparison.outcome === 'current') {
    return { verified: true, verifiedAt: new Date().toISOString() }
  }
  return {
    verified: false,
    reason: comparison.outcome === 'outdated' ? 'hash-mismatch' : 'no-registry-record',
  }
}

/**
 * `relink`'s registry-validation step: confirm the caller-supplied `id`
 * resolves to a real registry skill before writing it. `apply_manifest_
 * reconcile` never infers `source` from the lookup result (ADR-144 §3 —
 * the caller supplies BOTH `id` and `source` explicitly); this only
 * proves `id` is a genuine registry identity, not a hallucinated one.
 */
export async function validateRelinkIdentity(
  id: string,
  context: ToolContext
): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (context.apiClient.isOffline()) {
    return { ok: false, detail: 'registry is offline' }
  }
  try {
    const info = await lookupSkillFromRegistry(id, context)
    if (!info) {
      return { ok: false, detail: `'${id}' was not found in the registry` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}
