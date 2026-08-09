/**
 * G-7 (freeze) and G-8 (gate pre-condition) evaluators — split out of
 * `smi5879-gate-check.gates.ts` (CLAUDE.md's <500-line-per-file convention;
 * these two attestation-driven gates share the `checkAttestationCompleteness`
 * shape and were the largest single chunk of that file).
 * @module scripts/indexer/smi5879-gate-check.gates.attestation
 *
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.5, §12
 */

import {
  checkAttestationCompleteness,
  G7_REQUIRED_ATTESTATION_IDS,
  G8_REQUIRED_ATTESTATION_IDS,
  type LoadResult,
} from './smi5879-gate-check.helpers.ts'
import type { GateResult, Smi5879FreezeAttestation } from './smi5879-gate-check.types.ts'

// ---------------------------------------------------------------------------
// G-7 — freeze
// ---------------------------------------------------------------------------

export function evaluateG7(attestation: LoadResult<Smi5879FreezeAttestation>): GateResult {
  if (attestation.status === 'missing') {
    return {
      id: 'G-7',
      outcome: 'INCONCLUSIVE',
      reason: `freeze attestation unavailable: ${attestation.reason}`,
    }
  }
  if (attestation.status === 'malformed') {
    return {
      id: 'G-7',
      outcome: 'INCONCLUSIVE',
      reason: `freeze attestation malformed: ${attestation.reason}`,
    }
  }
  const att = attestation.value
  const completeness = checkAttestationCompleteness(att.checks, G7_REQUIRED_ATTESTATION_IDS)
  if (!completeness.ok) {
    const parts: string[] = []
    if (completeness.missingIds.length > 0) {
      parts.push(`missing (never recorded): ${completeness.missingIds.join(', ')}`)
    }
    if (completeness.redIds.length > 0)
      parts.push(`present but red: ${completeness.redIds.join(', ')}`)
    if (completeness.conflictingIds.length > 0) {
      parts.push(
        `conflicting duplicate records (never resolved by last-write-wins): ` +
          completeness.conflictingIds.join(', ')
      )
    }
    return {
      id: 'G-7',
      outcome: 'INCONCLUSIVE',
      reason: `F-1..F-9/F-1S..F-6S incomplete — ${parts.join('; ')}`,
      detail: {
        missingIds: completeness.missingIds,
        redIds: completeness.redIds,
        conflictingIds: completeness.conflictingIds,
      },
    }
  }
  if (!att.backfill_kill_switch_clean) {
    return {
      id: 'G-7',
      outcome: 'INCONCLUSIVE',
      reason:
        'BACKFILL_KILL_SWITCH was not clean for the full Δ span — a successful indexer-backfill.yml ' +
        'run was recorded during the freeze',
    }
  }
  return {
    id: 'G-7',
    outcome: 'PASS',
    reason: 'F-1..F-9 and F-1S..F-6S all recorded green; selective freeze held unbroken for Δ',
  }
}

// ---------------------------------------------------------------------------
// G-8 — gate pre-condition
// ---------------------------------------------------------------------------

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

export function evaluateG8(
  attestation: LoadResult<Smi5879FreezeAttestation>,
  /** DB-sourced (`smi5879_run.snapshot_started_at` for the DECISION generation) — never
   *  file-provided, per the task spec's "independently re-derive from the DB" instruction. */
  decisionSnapshotStartedAt: string | null
): GateResult {
  if (attestation.status === 'missing') {
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason: `freeze attestation unavailable: ${attestation.reason}`,
    }
  }
  if (attestation.status === 'malformed') {
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason: `freeze attestation malformed: ${attestation.reason}`,
    }
  }
  const att = attestation.value
  const completeness = checkAttestationCompleteness(att.checks, G8_REQUIRED_ATTESTATION_IDS)
  if (!completeness.ok) {
    const parts: string[] = []
    if (completeness.missingIds.length > 0) {
      parts.push(`missing (never recorded): ${completeness.missingIds.join(', ')}`)
    }
    if (completeness.redIds.length > 0)
      parts.push(`present but red: ${completeness.redIds.join(', ')}`)
    if (completeness.conflictingIds.length > 0) {
      parts.push(
        `conflicting duplicate records (never resolved by last-write-wins): ` +
          completeness.conflictingIds.join(', ')
      )
    }
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason: `P-0.1..P-0.6 incomplete — ${parts.join('; ')}`,
      detail: {
        missingIds: completeness.missingIds,
        redIds: completeness.redIds,
        conflictingIds: completeness.conflictingIds,
      },
    }
  }
  if (!att.pr2192a_merged) {
    return { id: 'G-8', outcome: 'INCONCLUSIVE', reason: 'PR-2192a not recorded as merged' }
  }
  if (!att.pr2192a_deploy_green) {
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason: 'PR-2192a scoped deploy (mode=changed functions=indexer) not recorded green',
    }
  }
  if (!att.pr2192a_merged_at) {
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason: 'pr2192a_merged_at missing — cannot verify the 24h settle window',
    }
  }
  if (!decisionSnapshotStartedAt) {
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason:
        'decision generation snapshot_started_at unavailable from the DB — cannot independently ' +
        'verify the 24h settle window',
    }
  }
  const mergedAtMs = Date.parse(att.pr2192a_merged_at)
  const snapshotMs = Date.parse(decisionSnapshotStartedAt)
  if (Number.isNaN(mergedAtMs) || Number.isNaN(snapshotMs)) {
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason: 'pr2192a_merged_at or the DB-sourced snapshot_started_at is not a parseable date',
    }
  }
  const elapsedMs = snapshotMs - mergedAtMs
  if (elapsedMs < TWENTY_FOUR_HOURS_MS) {
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason:
        `only ${(elapsedMs / 3_600_000).toFixed(2)}h elapsed between PR-2192a's merge and the ` +
        `decision snapshot (DB-sourced snapshot_started_at=${decisionSnapshotStartedAt}) — 24h required`,
      detail: { elapsedMs },
    }
  }
  return {
    id: 'G-8',
    outcome: 'PASS',
    reason:
      'P-0.1..P-0.6 recorded green; PR-2192a merged, deploy green, and >=24h elapsed before the ' +
      'decision snapshot (independently verified against the DB)',
  }
}
