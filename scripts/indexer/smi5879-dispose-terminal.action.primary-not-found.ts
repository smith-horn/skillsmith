/**
 * SMI-6444 bulk disposition producer CLI — the `dispose --outcome-class=
 * primary_not_found` flow: stratify, size, open/resume the `.sample.json`
 * sidecar, live-re-fetch every pending row, evaluate acceptance, and — only
 * on a full pass — stage.
 * @module scripts/indexer/smi5879-dispose-terminal.action.primary-not-found
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 5 (stratified exact-hypergeometric sampling), Item 8 (sidecar
 *   lock/resume, live re-fetch, "if EITHER arm fails -> refuse the whole
 *   batch with zero partial ledger writes").
 */

import { randomUUID } from 'node:crypto'
import { stageDispositionBatch } from './smi5879-dispose-terminal.ledger.ts'
import { openSampleRun } from './smi5879-dispose-terminal.sidecar.ts'
import { liveRecheckPendingRows } from './smi5879-dispose-terminal.action.primary-not-found.fetch.ts'
import {
  DEFAULT_SAMPLING_POLICY,
  evaluateAcceptance,
  stratumKeyForRow,
} from './smi5879-dispose-terminal.stats.ts'
import type {
  DisposeActionDeps,
  DisposeOptions,
} from './smi5879-dispose-terminal.action.dispose.ts'
import type { ToolProvenance } from './smi5879-dispose-terminal.provenance.ts'
import type { SampleCandidate, SampleRunIdentity } from './smi5879-dispose-terminal.sidecar.ts'
import type { SamplingPolicy } from './smi5879-dispose-terminal.stats.types.ts'
import type { StagedBatchDraft } from './smi5879-dispose-terminal.ledger.ts'
import type { DispositionBatchStratum } from './smi5879-gate-check.types.ts'
import type {
  SimRowResult,
  SimSnapshotRow,
  SimulatedCohort,
} from './smi5879-simulate-full.types.ts'

function resolvePolicy(opts: DisposeOptions): SamplingPolicy {
  return {
    confidencePct: opts.confidencePct ?? DEFAULT_SAMPLING_POLICY.confidencePct,
    mismatchThresholdBp: opts.mismatchThresholdBp ?? DEFAULT_SAMPLING_POLICY.mismatchThresholdBp,
    stratumThresholdBp: opts.stratumThresholdBp ?? DEFAULT_SAMPLING_POLICY.stratumThresholdBp,
    designPointBadDrawsPerStratum:
      opts.designPointBadDrawsPerStratum ?? DEFAULT_SAMPLING_POLICY.designPointBadDrawsPerStratum,
  }
}

function cohortCounts(
  candidates: readonly SimRowResult[],
  excludedIds: ReadonlySet<string>
): Record<string, number> {
  const counts: Partial<Record<SimulatedCohort, number>> = {}
  for (const row of candidates) {
    if (excludedIds.has(row.id)) continue
    counts[row.cohort] = (counts[row.cohort] ?? 0) + 1
  }
  return counts
}

export interface DisposePrimaryNotFoundParams {
  opts: DisposeOptions
  candidates: readonly SimRowResult[]
  population: readonly SimSnapshotRow[]
  provenance: ToolProvenance
}

export async function disposePrimaryNotFoundAction(
  params: DisposePrimaryNotFoundParams,
  deps: DisposeActionDeps,
  log: (msg: string) => void
): Promise<number> {
  const { opts, candidates, population, provenance } = params
  if (!opts.sidecar) {
    log('REFUSED: --sidecar=<path> is required for --outcome-class=primary_not_found.')
    return 1
  }
  if (!opts.seed) {
    log(
      'REFUSED: --seed=<value> is required for --outcome-class=primary_not_found — the seed must ' +
        'be an explicit, operator-supplied value so a later --sidecar resume can re-derive and ' +
        'verify the exact same selection, never a freshly-randomized one.'
    )
    return 1
  }

  const populationById = new Map(population.map((row) => [row.id, row]))
  const sampleCandidates: SampleCandidate[] = candidates.map((c) => {
    const populationRow = populationById.get(c.id)
    const stratumKey = populationRow
      ? stratumKeyForRow(populationRow.repo_url, populationRow.skill_path)
      : null
    return { id: c.id, stratum_key: stratumKey }
  })

  const policy = resolvePolicy(opts)
  const identity: SampleRunIdentity = {
    run_id: opts.runId,
    outcome_class: 'primary_not_found',
    batch_id: (deps.batchId ?? randomUUID)(),
    sampling_seed: opts.seed,
    policy,
    allocation: 'proportional',
    tool_commit: provenance.tool_commit,
    tool_source_digest: provenance.tool_source_digest,
  }

  const opened = openSampleRun({
    sidecarPath: opts.sidecar,
    identity,
    candidates: sampleCandidates,
    ...(opts.sidecarTimeoutMs !== undefined ? { timeoutMs: opts.sidecarTimeoutMs } : {}),
    ...(deps.sidecarDeps !== undefined ? { deps: deps.sidecarDeps } : {}),
    ...(deps.now !== undefined ? { clock: deps.now } : {}),
  })
  if (!opened.ok) {
    log(`REFUSED [${opened.code}]: ${opened.reason}`)
    return 1
  }
  const handle = opened.handle
  // The SIDECAR's batch_id is authoritative, not `identity.batch_id`: it is
  // generated at sampling time and carried forward into the batch at staging
  // (plan Item 8's field list), which is exactly why resume validation
  // deliberately does NOT compare it. A resumed run that staged under a
  // freshly-minted id would sever the only link between the sampling evidence
  // and the batch staged from it.
  const batchId = handle.sidecar().batch_id
  log(
    `${handle.resumed ? 'Resumed' : 'Opened'} sample run for batch "${batchId}" ` +
      `(${handle.derived.selected.length} row(s) selected across ${handle.derived.strata.length} ` +
      `feasible stratum/strata).`
  )
  if (handle.derived.manual_review_required_ids.length > 0) {
    log(
      `${handle.derived.manual_review_required_ids.length} row(s) unparseable or in an infeasible ` +
        `stratum — NOT staged, route via add-manual: ${handle.derived.manual_review_required_ids.join(', ')}`
    )
  }

  try {
    // No feasible stratum at all — every candidate was routed to manual review
    // (an unparseable URL, an individually infeasible stratum, or the
    // whole-population infeasibility `computeJointSampleSizing` raises when not
    // even a full census clears the population arm). There is nothing to
    // re-fetch and nothing to bound, so refuse here rather than letting
    // `evaluateAcceptance` throw an unhandled RangeError on an empty
    // observation set.
    if (handle.derived.strata.length === 0) {
      log(
        `REFUSED: no feasible stratum for this population at the configured design point ` +
          `(confidence=${policy.confidencePct}%, population arm=${policy.mismatchThresholdBp}bp, ` +
          `stratum arm=${policy.stratumThresholdBp}bp, design point=` +
          `${policy.designPointBadDrawsPerStratum}) — bulk sampling cannot apply here. Dispose all ` +
          `${handle.derived.manual_review_required_ids.length} row(s) individually via add-manual. ` +
          `Zero ledger writes.`
      )
      return 1
    }

    try {
      await liveRecheckPendingRows(handle, populationById, {
        ...(deps.getHeaders !== undefined ? { getHeaders: deps.getHeaders } : {}),
        ...(deps.fetchConcurrency !== undefined ? { concurrency: deps.fetchConcurrency } : {}),
        ...(deps.fetchPrimary !== undefined ? { fetchPrimary: deps.fetchPrimary } : {}),
      })
    } catch (error) {
      // A fatal, non-transient re-fetch failure (e.g. `PrimaryFetchAuthError`
      // on HTTP 401) must REFUSE, never be silently priced as ordinary
      // `unavailable` rows — an aborted run did not attempt every pending row,
      // so its acceptance arms would be evaluated on a sample nobody finished.
      log(
        `REFUSED: the live re-fetch aborted before every pending row was attempted — ` +
          `${(error as Error).message}. Zero ledger writes; the sidecar at ${opts.sidecar} keeps ` +
          `every result recorded so far, so a resume continues from there.`
      )
      return 1
    }

    const acceptance = evaluateAcceptance(handle.observations(), policy)
    if (!acceptance.accepted) {
      log(
        `REFUSED: sampling acceptance failed — ${acceptance.failures.join('; ')}. Zero ledger ` +
          `writes; the sidecar at ${opts.sidecar} remains for audit and resume.`
      )
      return 1
    }

    const frozen = handle.freeze()
    const strata: DispositionBatchStratum[] = frozen.strata.map((s) => {
      const armDetail = acceptance.strata.find((a) => a.stratumKey === s.stratum_key)
      return {
        stratum_key: s.stratum_key,
        population_count: s.population_count,
        selected_ids: s.selected_ids,
        unavailable_ids: s.unavailable_ids,
        mismatched_ids: s.mismatched_ids,
        verified_count: s.verified_count,
        upper_bound_bp: armDetail?.upperBoundBp ?? 0,
      }
    })
    // EVERY population row this batch covers — not just the sampled ones.
    // The sample BOUNDS the misclassification rate over the whole covered
    // population (Item 5); it does not enumerate what the batch disposes.
    // `stageBatch` then withholds `mismatched_ids`/`unavailable_ids` and skips
    // rows that already carry an active entry (Item 8). Passing only
    // `selected_ids` here would leave every unsampled row undisposed at G-1 —
    // the exact 23,597-row problem SMI-6444 exists to solve — while the batch
    // record still claimed `population_count` covered them.
    const manualReviewIds = new Set(handle.derived.manual_review_required_ids)
    const populationIds = candidates.map((row) => row.id).filter((id) => !manualReviewIds.has(id))
    const now = (deps.now ?? (() => new Date().toISOString()))()
    const reason =
      `Sampled re-check of primary_not_found (seed=${opts.seed}): ${frozen.total_selected} live ` +
      `re-fetch(es) across ${strata.length} stratum/strata; population arm ` +
      `${acceptance.populationUpperBoundBp}bp <= ${policy.mismatchThresholdBp}bp, every stratum arm ` +
      `passes.${provenance.reasonSuffix}`

    const draft: StagedBatchDraft = {
      schema_version: 1,
      batch_id: batchId,
      outcome_class: 'primary_not_found',
      run_id: opts.runId,
      tool_commit: provenance.tool_commit,
      tool_source_digest: provenance.tool_source_digest,
      population_count: strata.reduce((sum, s) => sum + s.population_count, 0),
      population_cohort_counts: cohortCounts(
        candidates,
        new Set(handle.derived.manual_review_required_ids)
      ),
      confidence_pct: policy.confidencePct,
      mismatch_threshold_bp: policy.mismatchThresholdBp,
      stratum_threshold_bp: policy.stratumThresholdBp,
      design_point_bad_draws_per_stratum: policy.designPointBadDrawsPerStratum,
      allocation: 'proportional',
      sampling_seed: opts.seed,
      strata,
      verified_count: frozen.total_verified,
      observed_population_upper_bound_bp: acceptance.populationUpperBoundBp,
      verified_at: now,
    }

    const result = stageDispositionBatch({
      ledgerPath: opts.dispositions,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(deps.ledgerDeps !== undefined ? { deps: deps.ledgerDeps } : {}),
      params: { draft, populationIds, reason, operator: opts.operator, now },
    })
    if (!result.ok) {
      log(`REFUSED [${result.code}]: ${result.reason}`)
      return 1
    }
    log(
      `Staged batch "${result.result.batch.batch_id}" — ${result.result.entryIds.length} entr` +
        `${result.result.entryIds.length === 1 ? 'y' : 'ies'}, ${result.result.withheldIds.length} ` +
        `withheld (mismatched/unavailable).\nConfirmation code: ${result.result.confirmationCode}`
    )
    return 0
  } finally {
    handle.release()
  }
}
