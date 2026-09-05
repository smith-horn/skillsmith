/**
 * @fileoverview skill_outdated tamper-check classification helpers
 * @module @skillsmith/mcp-server/tools/outdated.identity
 * @see SMI-6343 Wave 3 — tamper-check classification (AC#3)
 *
 * Split out of `outdated.ts` to keep that file under the audit:standards
 * 500-line gate. Adapts `outdated.ts`'s already-in-flight Wave 2 live/
 * historical registry-arm state into the shared, cross-package
 * `@skillsmith/core` identity-classification module (`skill-identity-
 * classification.ts`), and builds the per-state `OutdatedDiagnosis` copy
 * (H6 — this is the tool's entire user-facing surface, since `skill_outdated`
 * has zero renderers).
 */

import {
  classifyOutdatedState,
  type IdentityInconclusiveReason,
  type IdentitySignal,
  type OutdatedClassificationState,
  type RegistryLookupOutcome,
  type ManifestEntryForIdentity,
} from '@skillsmith/core'
import { CANONICAL_CLIENT, CLIENT_NATIVE_PATHS } from '@skillsmith/core/install'
import type { ContentComparisonOutcome } from '@skillsmith/core'
import type { OutdatedDiagnosis } from './outdated.js'
import type { RegistrySkillInfo } from './install.types.js'

/**
 * Reconstruct signal 2's registry-lookup outcome from the state `outdated.
 * ts`'s live registry arm already tracks — no second network call. See that
 * file's own doc comments (`liveArmOffline`/`quotaExhausted`/`liveArmFailed`)
 * for what each flag means; this function is deliberately the single place
 * that translates those Wave 2 flags into the shape Wave 3's shared
 * classification module expects.
 */
export function buildRegistryLookupOutcome(params: {
  liveArmAttempted: boolean
  liveArmOffline: boolean
  quotaExhausted: boolean
  liveArmFailed: boolean
  registryInfo: RegistrySkillInfo | null
}): RegistryLookupOutcome {
  if (!params.liveArmAttempted) {
    return {
      attempted: false,
      record: null,
      failureReason: params.liveArmOffline
        ? 'offline'
        : params.quotaExhausted
          ? 'quota-exhausted'
          : null,
    }
  }
  if (params.liveArmFailed) {
    return { attempted: true, record: null, failureReason: 'network-error' }
  }
  return {
    attempted: true,
    record: params.registryInfo
      ? { author: params.registryInfo.author ?? null, name: params.registryInfo.name ?? null }
      : null,
    failureReason: null,
  }
}

/**
 * Why a plain `compareSkillContentHashes(...).outcome === 'unknown'` row
 * (i.e. one that never even reached signal evaluation) couldn't be
 * resolved. Distinct from signal 2's own inconclusive reason — this covers
 * the Wave 2 hash-comparison layer, not the Wave 3 identity layer.
 */
export function deriveUnknownReason(params: {
  liveArmOffline: boolean
  quotaExhausted: boolean
  liveArmFailed: boolean
}): IdentityInconclusiveReason {
  if (params.liveArmOffline) return 'offline'
  if (params.quotaExhausted) return 'quota-exhausted'
  if (params.liveArmFailed) return 'network-error'
  return 'no-history'
}

/**
 * Classify one manifest entry given its already-computed content-comparison
 * outcome. Resolves `expectedRootDir` (signal 3) from the entry's claimed
 * client, defaulting to the canonical client per `manifestKeyFor()`'s own
 * SMI-5894 default — `skill_outdated` only ever reads the GLOBAL manifest
 * (`loadManifest()` with no override), so every entry it processes is a
 * global-scope install and `CLIENT_NATIVE_PATHS` is the correct root for
 * every one of them (unlike the CLI's `manage.update.ts`, which must also
 * account for workspace-scoped installs — see that file's own resolution).
 */
export function classifyOutdatedEntry(params: {
  entry: ManifestEntryForIdentity
  comparisonOutcome: ContentComparisonOutcome
  localHash: string | null
  localContent: string | null
  registryLookup: RegistryLookupOutcome
  unknownReason: IdentityInconclusiveReason
}): {
  state: OutdatedClassificationState
  signal: IdentitySignal | null
  inconclusiveReason: IdentityInconclusiveReason | null
} {
  const expectedRootDir = CLIENT_NATIVE_PATHS[params.entry.client ?? CANONICAL_CLIENT]
  return classifyOutdatedState({
    comparisonOutcome: params.comparisonOutcome,
    unknownReasonWhenComparisonUnknown: params.unknownReason,
    entry: params.entry,
    localHash: params.localHash,
    localContent: params.localContent,
    expectedRootDir,
    registryLookup: params.registryLookup,
  })
}

/**
 * H6 — the literal per-state diagnosis copy table. `skill_outdated` has zero
 * renderers (verified: grep of `skill_outdated`/`OutdatedSkillInfo` across
 * `packages/cli/src`, `packages/vscode-extension/src`, `packages/website/src`
 * returns zero functional hits), so this MCP JSON response IS the v1
 * surface — the exact text here matters.
 */
export function buildOutdatedDiagnosis(params: {
  state: OutdatedClassificationState
  signal: IdentitySignal | null
  inconclusiveReason: IdentityInconclusiveReason | null
}): OutdatedDiagnosis {
  const { state, signal, inconclusiveReason } = params

  switch (state) {
    case 'current':
      return {
        state,
        signal: null,
        inconclusiveReason: null,
        summary: "On-disk content matches the registry's current content for this id.",
        remediation: null,
        safeToBulkUpdate: true,
      }
    case 'outdated':
      return {
        state,
        signal: null,
        inconclusiveReason: null,
        summary: 'The registry has newer content for this id than what is installed.',
        remediation: 'Run `skillsmith update <name>` to install the newer version.',
        safeToBulkUpdate: true,
      }
    case 'local-drift':
      return {
        state,
        signal: null,
        inconclusiveReason: null,
        summary:
          'On-disk content differs from the registry, and nothing contradicts the recorded ' +
          'identity — this looks like a local edit.',
        remediation:
          'Excluded from bulk update to protect the local edit. Update this one explicitly if ' +
          "you want to discard it, or run `apply_manifest_reconcile({ action: 'mark_local', … })` " +
          'to stop tracking it against the registry.',
        safeToBulkUpdate: false,
      }
    case 'identity-mismatch':
      return {
        state,
        signal,
        inconclusiveReason: null,
        summary:
          "This entry's recorded identity contradicts what is on disk — the recorded id/source " +
          'may name an unrelated skill.',
        remediation:
          'Run `skill_recover_source` for evidence, then `apply_manifest_reconcile` with ' +
          '`mark_local`, `relink`, or `drop_entry`. Do **not** update this entry — doing so would ' +
          'overwrite the installed skill with unrelated content.',
        safeToBulkUpdate: false,
      }
    case 'unknown': {
      const reason = inconclusiveReason ?? 'no-history'
      const remediation =
        reason === 'no-registry-record'
          ? 'Run `skill_recover_source` to identify the source.'
          : 'Re-run when back online / after quota resets.'
      return {
        state,
        signal: null,
        inconclusiveReason: reason,
        summary: `Could not determine whether this entry is current (${reason}).`,
        remediation,
        safeToBulkUpdate: false,
      }
    }
  }
}
