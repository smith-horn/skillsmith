/**
 * Resume validation for SMI-6444's `.sample.json` sidecar — the FULL check
 * list from plan Item 8, split out of `smi5879-dispose-terminal.sidecar.ts`
 * for the repo's 500-line file policy. Pure: no filesystem, no lock, no
 * clock, so the same derivation can be re-run and compared at any time.
 * @module scripts/indexer/smi5879-dispose-terminal.sidecar.validation
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 8 — shape check; run_id/outcome_class/sampling_seed match; EVERY
 *   other sizing input matches the invocation; the candidate set recomputed
 *   and compared to `candidate_ids_digest`; the selection re-derived from the
 *   seed and compared to the persisted `selected`; required per-stratum
 *   `selected_count` re-derived from live sizing inputs + population rather
 *   than trusted; `results` keys a subset of `selected`; `tool_source_digest`
 *   matching the running script. Any failure refuses resume with an explicit
 *   delete-to-restart instruction — never a silent re-sample.
 */

import {
  refuseSidecar,
  type DerivedSampleSelection,
  type SampleRunIdentity,
  type SampleSidecar,
  type SidecarRefusal,
} from './smi5879-dispose-terminal.sidecar.types.ts'

function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function checkIdentity(
  sidecar: SampleSidecar,
  identity: SampleRunIdentity,
  path: string
): SidecarRefusal | null {
  // `batch_id` is deliberately NOT compared: it is generated AT sampling time
  // and carried forward into the batch at staging, so a resuming invocation
  // adopts the sidecar's id rather than asserting one of its own.
  const mismatches: string[] = []
  if (sidecar.run_id !== identity.run_id) {
    mismatches.push(`run_id (sidecar "${sidecar.run_id}", invocation "${identity.run_id}")`)
  }
  if (sidecar.outcome_class !== identity.outcome_class) {
    mismatches.push(
      `outcome_class (sidecar "${sidecar.outcome_class}", invocation "${identity.outcome_class}")`
    )
  }
  if (sidecar.sampling_seed !== identity.sampling_seed) {
    mismatches.push(
      `sampling_seed (sidecar "${sidecar.sampling_seed}", invocation "${identity.sampling_seed}")`
    )
  }
  return mismatches.length === 0
    ? null
    : refuseSidecar(
        'identity_mismatch',
        `refusing to resume: this sidecar was created for a different run — ${mismatches.join('; ')}.`,
        path
      )
}

/**
 * EVERY sizing input, not just the seed (round-5 correction): a resumed run
 * that selected under one design point must never silently stage a batch
 * claiming a different one — the design point is digest-covered at the batch
 * level precisely because it changes what "enough sample" means.
 */
function checkSizingInputs(
  sidecar: SampleSidecar,
  identity: SampleRunIdentity,
  path: string
): SidecarRefusal | null {
  const expected: Array<[string, number | string, number | string]> = [
    ['confidence_pct', sidecar.confidence_pct, identity.policy.confidencePct],
    ['mismatch_threshold_bp', sidecar.mismatch_threshold_bp, identity.policy.mismatchThresholdBp],
    ['stratum_threshold_bp', sidecar.stratum_threshold_bp, identity.policy.stratumThresholdBp],
    [
      'design_point_bad_draws_per_stratum',
      sidecar.design_point_bad_draws_per_stratum,
      identity.policy.designPointBadDrawsPerStratum,
    ],
    ['allocation', sidecar.allocation, identity.allocation],
  ]
  const mismatches = expected
    .filter(([, stored, invocation]) => stored !== invocation)
    .map(([field, stored, invocation]) => `${field} (sidecar ${stored}, invocation ${invocation})`)
  return mismatches.length === 0
    ? null
    : refuseSidecar(
        'sizing_input_mismatch',
        `refusing to resume: this sidecar's sizing inputs differ from this invocation's — ${mismatches.join('; ')}. The selection was drawn under the stored parameters, so resuming would stage a batch claiming parameters it was never sized against.`,
        path
      )
}

function checkSelection(
  sidecar: SampleSidecar,
  derived: DerivedSampleSelection,
  path: string
): SidecarRefusal | null {
  const stored = [...sidecar.selected].sort((a, b) => byBytes(a.id, b.id))
  const expected = [...derived.selected].sort((a, b) => byBytes(a.id, b.id))
  const same =
    stored.length === expected.length &&
    stored.every(
      (row, i) => row.id === expected[i]?.id && row.stratum_key === expected[i]?.stratum_key
    )
  return same
    ? null
    : refuseSidecar(
        'selection_mismatch',
        `refusing to resume: re-deriving the selection from the recorded seed produced a different sample (${expected.length} row(s)) than the sidecar stores (${stored.length} row(s)) — the sidecar is corrupted or was hand-edited.`,
        path
      )
}

function checkStratumCounts(
  sidecar: SampleSidecar,
  derived: DerivedSampleSelection,
  path: string
): SidecarRefusal | null {
  const expectedByKey = new Map(derived.strata.map((s) => [s.stratum_key, s]))
  const mismatches: string[] = []
  for (const stored of sidecar.strata) {
    const expected = expectedByKey.get(stored.stratum_key)
    if (expected === undefined) {
      mismatches.push(`${stored.stratum_key} is no longer a feasible stratum`)
      continue
    }
    if (expected.selected_count !== stored.selected_count) {
      mismatches.push(
        `${stored.stratum_key}.selected_count (sidecar ${stored.selected_count}, re-derived ${expected.selected_count})`
      )
    }
    if (expected.population_count !== stored.population_count) {
      mismatches.push(
        `${stored.stratum_key}.population_count (sidecar ${stored.population_count}, re-derived ${expected.population_count})`
      )
    }
  }
  for (const expected of derived.strata) {
    if (!sidecar.strata.some((s) => s.stratum_key === expected.stratum_key)) {
      mismatches.push(`${expected.stratum_key} is missing from the sidecar`)
    }
  }
  return mismatches.length === 0
    ? null
    : refuseSidecar(
        'stratum_count_mismatch',
        `refusing to resume: per-stratum sizing re-derived from the live population and sizing inputs disagrees with the stored values — ${mismatches.join('; ')}. A stored count computed under stale parameters is never trusted.`,
        path
      )
}

/**
 * Every resume check from plan Item 8, in the order the plan states them.
 * Any failure refuses with an explicit delete-to-restart instruction — a
 * partial sidecar is never silently re-sampled.
 */
export function validateSidecarForResume(params: {
  sidecar: SampleSidecar
  identity: SampleRunIdentity
  derived: DerivedSampleSelection
  sidecarPath: string
}): { ok: true } | SidecarRefusal {
  const { sidecar, identity, derived, sidecarPath } = params
  const identityCheck = checkIdentity(sidecar, identity, sidecarPath)
  if (identityCheck !== null) return identityCheck
  const sizingCheck = checkSizingInputs(sidecar, identity, sidecarPath)
  if (sizingCheck !== null) return sizingCheck
  if (sidecar.candidate_ids_digest !== derived.candidate_ids_digest) {
    return refuseSidecar(
      'candidate_set_changed',
      `refusing to resume: the candidate population changed since selection (sidecar candidate_ids_digest ${sidecar.candidate_ids_digest}, recomputed ${derived.candidate_ids_digest}) — a sample drawn against one population proves nothing about a different one.`,
      sidecarPath
    )
  }
  const selectionCheck = checkSelection(sidecar, derived, sidecarPath)
  if (selectionCheck !== null) return selectionCheck
  const strataCheck = checkStratumCounts(sidecar, derived, sidecarPath)
  if (strataCheck !== null) return strataCheck

  const selectedIds = new Set(sidecar.selected.map((row) => row.id))
  const stray = Object.keys(sidecar.results)
    .filter((id) => !selectedIds.has(id))
    .sort(byBytes)
  if (stray.length > 0) {
    return refuseSidecar(
      'results_out_of_range',
      `refusing to resume: ${stray.length} recorded result(s) name id(s) that are not in the selection (${stray.slice(0, 5).join(', ')}).`,
      sidecarPath
    )
  }
  if (sidecar.tool_source_digest !== identity.tool_source_digest) {
    return refuseSidecar(
      'tool_source_digest_mismatch',
      `refusing to resume: this sidecar was produced by different tool source (sidecar ${sidecar.tool_source_digest}, running ${identity.tool_source_digest}) — the same dirty-worktree stance that applies to staging a batch applies to resuming a sample.`,
      sidecarPath
    )
  }
  return { ok: true }
}
