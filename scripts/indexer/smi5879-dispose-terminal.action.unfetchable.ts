/**
 * SMI-6444 bulk disposition producer CLI — the `dispose --outcome-class=
 * unfetchable` flow: authoritative, 100%-local re-derivation of every
 * candidate row's `unfetchable` subtype via the shared
 * `deriveUnfetchableSubtype` (never trusting the report's own
 * `unfetchable_subtype` field beyond a cross-check), then staging.
 * @module scripts/indexer/smi5879-dispose-terminal.action.unfetchable
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 6 — two subtypes, not one uniform re-check; a row that doesn't
 *   independently re-derive as `unfetchable` at all is withheld as
 *   mismatched, never bulk-excluded on the strength of the report's label
 *   alone. Item 5 — 100% local re-check, no confidence interval needed.
 */

import { randomUUID } from 'node:crypto'
import { stageDispositionBatch } from './smi5879-dispose-terminal.ledger.ts'
import { deriveUnfetchableSubtype } from './smi5879-terminal-derivation.ts'
import type {
  DisposeActionDeps,
  DisposeOptions,
} from './smi5879-dispose-terminal.action.dispose.ts'
import type { ToolProvenance } from './smi5879-dispose-terminal.provenance.ts'
import type { StagedBatchDraft } from './smi5879-dispose-terminal.ledger.ts'
import type { DispositionBatchStratum } from './smi5879-gate-check.types.ts'
import type {
  BranchMap,
  SimRowResult,
  SimSnapshotRow,
  SimulatedCohort,
} from './smi5879-simulate-full.types.ts'

type UnfetchableSubtype = 'url_parse' | 'branch_resolution'
const UNFETCHABLE_SUBTYPES: readonly UnfetchableSubtype[] = ['url_parse', 'branch_resolution']

interface SubtypeBucket {
  verifiedIds: string[]
  mismatchedIds: string[]
}

function emptyBuckets(): Record<UnfetchableSubtype, SubtypeBucket> {
  return {
    url_parse: { verifiedIds: [], mismatchedIds: [] },
    branch_resolution: { verifiedIds: [], mismatchedIds: [] },
  }
}

/**
 * Classify every candidate against digest-verified data, never against the
 * report's own claim beyond a cross-check log line.
 *
 * - `deriveUnfetchableSubtype` returns non-null (the row genuinely
 *   re-derives as `unfetchable`, of that subtype) -> VERIFIED, attributed to
 *   the DERIVED subtype's bucket (authoritative — even when it disagrees
 *   with the report's own claimed subtype, the underlying "this row is
 *   terminally unfetchable" fact still holds).
 * - Re-derivation fails (returns `null` — a missing population row, a URL
 *   that now parses fine, or a branch-map citation that no longer confirms
 *   not-found/unparseable, including a MISSING branchMap key, which is a
 *   mismatch, never "unavailable" — there is no transient-failure mode in a
 *   purely local check) but the report claimed a subtype -> MISMATCHED,
 *   attributed to the REPORTED subtype's bucket (withheld from this batch's
 *   entries, routed to `add-manual`).
 * - Neither a population row nor a reported subtype is available -> routed
 *   to `manualReviewIds`, entirely outside this batch (nothing to attribute
 *   it to).
 */
function classifyCandidates(
  candidates: readonly SimRowResult[],
  populationById: ReadonlyMap<string, SimSnapshotRow>,
  branchMap: BranchMap
): { buckets: Record<UnfetchableSubtype, SubtypeBucket>; manualReviewIds: string[] } {
  const buckets = emptyBuckets()
  const manualReviewIds: string[] = []
  for (const candidate of candidates) {
    const populationRow = populationById.get(candidate.id)
    const derived = populationRow ? deriveUnfetchableSubtype(populationRow, branchMap) : null
    if (derived !== null) {
      buckets[derived].verifiedIds.push(candidate.id)
      continue
    }
    const reported = candidate.unfetchable_subtype
    if (reported !== undefined) {
      buckets[reported].mismatchedIds.push(candidate.id)
      continue
    }
    manualReviewIds.push(candidate.id)
  }
  for (const subtype of UNFETCHABLE_SUBTYPES) {
    buckets[subtype].verifiedIds.sort()
    buckets[subtype].mismatchedIds.sort()
  }
  return { buckets, manualReviewIds: manualReviewIds.sort() }
}

function buildStratum(subtype: UnfetchableSubtype, bucket: SubtypeBucket): DispositionBatchStratum {
  const selectedIds = [...bucket.verifiedIds, ...bucket.mismatchedIds].sort()
  return {
    stratum_key: subtype,
    population_count: selectedIds.length,
    selected_ids: selectedIds,
    unavailable_ids: [],
    mismatched_ids: bucket.mismatchedIds,
    verified_count: bucket.verifiedIds.length,
    upper_bound_bp: 0,
  }
}

function cohortCounts(
  candidates: readonly SimRowResult[],
  ids: ReadonlySet<string>
): Record<string, number> {
  const counts: Partial<Record<SimulatedCohort, number>> = {}
  for (const row of candidates) {
    if (!ids.has(row.id)) continue
    counts[row.cohort] = (counts[row.cohort] ?? 0) + 1
  }
  return counts
}

export interface DisposeUnfetchableParams {
  opts: DisposeOptions
  candidates: readonly SimRowResult[]
  population: readonly SimSnapshotRow[]
  branchMap: BranchMap
  provenance: ToolProvenance
}

export function disposeUnfetchableAction(
  params: DisposeUnfetchableParams,
  deps: DisposeActionDeps,
  log: (msg: string) => void
): number {
  const { opts, candidates, population, branchMap, provenance } = params
  const populationById = new Map(population.map((row) => [row.id, row]))
  const { buckets, manualReviewIds } = classifyCandidates(candidates, populationById, branchMap)

  if (manualReviewIds.length > 0) {
    log(
      `${manualReviewIds.length} row(s) neither re-derive as unfetchable nor carry a reported ` +
        `subtype to attribute a mismatch to — NOT staged, route via add-manual: ${manualReviewIds.join(', ')}`
    )
  }

  const strata = UNFETCHABLE_SUBTYPES.map((s) => buildStratum(s, buckets[s]))
  const populationCount = strata.reduce((sum, s) => sum + s.population_count, 0)
  if (populationCount === 0) {
    log(
      'No unfetchable row(s) re-derive (or were reportedly claimed) for either subtype — nothing to stage.'
    )
    return 0
  }
  const verifiedCount = strata.reduce((sum, s) => sum + s.verified_count, 0)
  const allDisposedIds = new Set(strata.flatMap((s) => s.selected_ids))
  const subtypeCounts: Record<string, number> = Object.fromEntries(
    strata.map((s) => [s.stratum_key, s.population_count])
  )
  const now = (deps.now ?? (() => new Date().toISOString()))()

  const reason =
    `Bulk unfetchable disposition: ${buckets.url_parse.verifiedIds.length} url_parse row(s) ` +
    `re-confirmed via parseSkillMdUrl, ${buckets.branch_resolution.verifiedIds.length} ` +
    `branch_resolution row(s) re-confirmed via the sealed branch-resolution citation; ` +
    `${strata.reduce((n, s) => n + s.mismatched_ids.length, 0)} row(s) failed re-derivation and ` +
    `are withheld as mismatched.${provenance.reasonSuffix}`

  const draft: StagedBatchDraft = {
    schema_version: 1,
    batch_id: (deps.batchId ?? randomUUID)(),
    outcome_class: 'unfetchable',
    run_id: opts.runId,
    tool_commit: provenance.tool_commit,
    tool_source_digest: provenance.tool_source_digest,
    population_count: populationCount,
    population_cohort_counts: cohortCounts(candidates, allDisposedIds),
    subtype_counts: subtypeCounts,
    strata,
    verified_count: verifiedCount,
    verified_at: now,
  }

  const result = stageDispositionBatch({
    ledgerPath: opts.dispositions,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(deps.ledgerDeps !== undefined ? { deps: deps.ledgerDeps } : {}),
    params: {
      draft,
      populationIds: [...allDisposedIds],
      reason,
      operator: opts.operator,
      now,
    },
  })
  if (!result.ok) {
    log(`REFUSED [${result.code}]: ${result.reason}`)
    return 1
  }
  log(
    `Staged batch "${result.result.batch.batch_id}" — ${result.result.entryIds.length} entr` +
      `${result.result.entryIds.length === 1 ? 'y' : 'ies'}, ${result.result.withheldIds.length} withheld as mismatched.\n` +
      `Confirmation code: ${result.result.confirmationCode}`
  )
  return 0
}
