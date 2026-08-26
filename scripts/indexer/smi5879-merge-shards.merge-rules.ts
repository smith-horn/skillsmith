/**
 * Pure merge rules and invariant assertions for `smi5879-merge-shards.ts`.
 * Split into its own module per CLAUDE.md's <500-line-per-file convention,
 * the same way `smi5879-simulate-full.ts` already splits its own
 * `.cli.ts`/`.checkpoint.ts`/`.sweep.ts`/`.output.ts` siblings: this file
 * owns every row of the plan's merge-rule table plus every invariant that
 * table names, while `smi5879-merge-shards.ts` owns argument parsing, the
 * injected DB round trip, orchestration order, and the atomic write.
 * @module scripts/indexer/smi5879-merge-shards.merge-rules
 *
 * Plan: docs/internal/implementation/smi-6015-pat-sharded-fetch-plan.md
 *       ("### 3. N-way checkpoint/report merge tool (new script)")
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.3.5.2.4/§8.4/§8.5
 *
 * THE SAFETY PROPERTY THIS FILE ENFORCES
 * --------------------------------------
 * N shard processes each produce a `report_kind: 'full_simulation'` report
 * covering a disjoint slice of ONE sealed decision generation's population.
 * `smi5879-gate-check.ts` accepts exactly one such report per decision
 * `run_id` and derives a MERGE-GATE decision from it (G-1's R set, G-2's
 * coverage, G-3's two-sided counts, G-5's +32 delta bound). The merged report
 * assembled here is therefore the single artifact standing between N
 * independent, days-long, partially-observable fetch processes and a security
 * gate deciding whether a scanner port may ship.
 *
 * The property that must hold is NOT "the arithmetic balances" — a merge that
 * silently drops one shard's rows balances perfectly against its own dropped
 * coverage numbers, and a same-cohort id substituted for a genuinely-lost row
 * keeps every count intact. The property is EXACT SET EQUALITY between the
 * merged `rows` id set and the authoritative sealed population's id set: zero
 * missing, zero extra, zero duplicate, with each row's canonical fields
 * agreeing. That check — and the digest-verified population load it depends
 * on — lives in the `.population.ts` sibling; this file holds everything the
 * merge does with the shard reports themselves.
 *
 * Everything here is defense in depth around that property, following
 * the "never trust the label alone" rule `evaluateG2` applies to a report's
 * own `coverage[cohort].status` (`smi5879-gate-check.gates.ts`): every derived
 * field is RECOMPUTED here and cross-checked against what the shard reports
 * claimed, and any disagreement throws rather than silently picking a winner.
 */

import {
  ALL_SIMULATED_COHORTS,
  SIM_ROW_OUTCOMES,
  EMPTY_OUTCOME_COUNTS,
} from './smi5879-simulate-full.types.ts'
import type {
  CohortCoverage,
  CoverageByCohort,
  SimRowOutcome,
  SimRowResult,
  Smi5879SimulateFullReport,
  SweepHardStopReason,
} from './smi5879-simulate-full.types.ts'

/** One shard report plus the path it was read from — the path appears verbatim in every error. */
export interface ShardReportInput {
  path: string
  report: Smi5879SimulateFullReport
}

/**
 * Scalar fields that must be byte-identical across all N shard reports. A
 * mismatch in any of them means the reports do not describe one run of one
 * generation against one baseline, so no merge of them is meaningful — the
 * plan calls for a loud failure here specifically because "pick the first
 * one" would produce a report that looks well-formed and gates cleanly while
 * describing a run that never happened.
 */
const IDENTITY_FIELDS = [
  'report_kind',
  'run_id',
  'purpose',
  'status',
  'token_source',
  'baseline_commit',
] as const

export type ShardIdentity = Pick<Smi5879SimulateFullReport, (typeof IDENTITY_FIELDS)[number]>

/**
 * How many offending ids to name before truncating — matches G-1/G-2R's own
 * `slice(0, 10)` precedent. Exported alongside {@link formatIds} so the
 * `.population.ts` sibling formats its own id lists identically rather than
 * growing a second, subtly-different truncation convention.
 */
export const MAX_IDS_IN_ERROR = 10

export function formatIds(ids: readonly string[]): string {
  return `${ids.slice(0, MAX_IDS_IN_ERROR).join(', ')}${ids.length > MAX_IDS_IN_ERROR ? ', ...' : ''}`
}

/**
 * `loadSimulatorReport` (`smi5879-gate-check.io.ts`) validates every numeric
 * field with a bare `typeof n !== 'number'` — which `NaN`, `Infinity`, `-1`
 * and `1.5` all pass. Adequate for the gate, which only compares those
 * numbers; NOT adequate for a merge, where one `NaN` addend silently poisons
 * an entire summed cohort (`NaN <= total` is `false`, so even the bound
 * checks below would report a confusing failure rather than the real cause)
 * and a fractional/negative count would survive into the merged artifact
 * unremarked. Every number consumed from a shard report passes through here.
 */
function assertNonNegativeInteger(value: number, label: string, path: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `SMI-6015: shard report at ${path} has ${label}=${String(value)}, which is not a ` +
        'non-negative integer. Merging would propagate a nonsensical (NaN/negative/fractional) ' +
        'count into the gate-eligible merged report — refusing to merge a malformed shard report.'
    )
  }
}

/** Validate every numeric field of one shard report up front, before any arithmetic touches it. */
export function assertShardReportNumericSanity(input: ShardReportInput): void {
  assertNonNegativeInteger(input.report.sweep.passes_run, 'sweep.passes_run', input.path)
  for (const cohort of ALL_SIMULATED_COHORTS) {
    const c = input.report.coverage[cohort]
    assertNonNegativeInteger(c.total, `coverage.${cohort}.total`, input.path)
    assertNonNegativeInteger(c.scanned, `coverage.${cohort}.scanned`, input.path)
    assertNonNegativeInteger(c.unevaluable, `coverage.${cohort}.unevaluable`, input.path)
    assertNonNegativeInteger(c.unfetchable, `coverage.${cohort}.unfetchable`, input.path)
  }
  for (const outcome of SIM_ROW_OUTCOMES) {
    assertNonNegativeInteger(input.report.counts[outcome], `counts.${outcome}`, input.path)
  }
}

/**
 * Plan merge-rule table, row 1: the {@link IDENTITY_FIELDS} must be identical
 * across all N shard reports — "fail loudly (not silently pick one) on any
 * mismatch". Every mismatching field is collected and reported at once (the
 * `assertCheckpointIdentity` precedent, `smi5879-simulate-full.checkpoint.ts`)
 * so one run tells the operator everything that is wrong.
 */
export function assertIdenticalIdentityFields(inputs: readonly ShardReportInput[]): ShardIdentity {
  const first = inputs[0]
  if (first === undefined) {
    throw new Error('SMI-6015: cannot merge zero shard reports — at least one is required.')
  }
  const mismatches: string[] = []
  for (const field of IDENTITY_FIELDS) {
    for (const input of inputs.slice(1)) {
      if (input.report[field] !== first.report[field]) {
        mismatches.push(
          `${field} (${first.path}="${first.report[field]}", ${input.path}="${input.report[field]}")`
        )
      }
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      'SMI-6015: shard reports disagree on field(s) that must be identical across every shard of ' +
        `one run — ${mismatches.join('; ')}. These reports do not describe one run of one ` +
        'generation against one baseline commit; refusing to merge them into a single ' +
        "gate-eligible report rather than silently adopting one shard's value."
    )
  }
  return {
    report_kind: first.report.report_kind,
    run_id: first.report.run_id,
    purpose: first.report.purpose,
    status: first.report.status,
    token_source: first.report.token_source,
    baseline_commit: first.report.baseline_commit,
  }
}

/**
 * Plan merge-rule table, `rows` row: CONCATENATED across all N shards, with
 * row-id disjointness enforced — every `row.id` must appear in exactly one
 * shard's `rows` array.
 *
 * Disjointness is NECESSARY BUT NOT SUFFICIENT (plan §3, round-1 review
 * Critical finding #2): it proves no row was double-counted and says nothing
 * about rows no shard reported at all. `assertMergedRowsMatchPopulation`
 * (`.population.ts`) closes that hole; this check exists so an overlap is
 * diagnosed AS an overlap (naming both shard files) instead of surfacing later
 * as a confusing "extra row" against the population.
 *
 * Concatenation order is the operator's `--reports` order, deliberately not
 * re-sorted: no downstream consumer indexes `rows` positionally (G-1's
 * `computeR`, G-3's direction counts, G-5's per-row bound and
 * `validateSimulatorReportConsistency` all filter or tally), so a canonical
 * order would buy byte-stability across operators without buying correctness.
 */
export function mergeRows(inputs: readonly ShardReportInput[]): SimRowResult[] {
  const merged: SimRowResult[] = []
  const seenAt = new Map<string, string>()
  const duplicates: string[] = []
  for (const input of inputs) {
    for (const row of input.report.rows) {
      const priorPath = seenAt.get(row.id)
      if (priorPath !== undefined) {
        duplicates.push(`${row.id} (in both ${priorPath} and ${input.path})`)
        continue
      }
      seenAt.set(row.id, input.path)
      merged.push(row)
    }
  }
  if (duplicates.length > 0) {
    throw new Error(
      `SMI-6015: ${duplicates.length} row id(s) appear in more than one shard report, so the ` +
        'shards did not process disjoint slices of the population: ' +
        `${duplicates.slice(0, MAX_IDS_IN_ERROR).join('; ')}` +
        `${duplicates.length > MAX_IDS_IN_ERROR ? `, and ${duplicates.length - MAX_IDS_IN_ERROR} more` : ''}. ` +
        'Merging would double-count these rows in coverage and counts. Check that each shard ran ' +
        'with the correct --shard-index/--shard-count pair.'
    )
  }
  return merged
}

// `assertRowOutcomeCoherence` lives in the `.outcome-coherence.ts` sibling
// (500-line budget — this file was at 499/500 with it inline).

/**
 * Plan merge-rule table, `coverage` rows.
 *
 * - `total`: must be IDENTICAL across all N shard reports — every shard
 *   reports the TRUE full-population total for every cohort (plan §1: the
 *   shard filter is applied AFTER `loadCohortRows`, never to it).
 * - `scanned`/`unevaluable`/`unfetchable`: SUMMED. `scanned` already CONTAINS
 *   `unevaluable`/`unfetchable`/`bundle_absent` as SUBSETS, so they are never
 *   added to it as separate addends (round-1 review High finding #3).
 * - `status`: RECOMPUTED, never copied from any shard — `'full'` iff
 *   `scanned === total && unevaluable === 0` over the MERGED sums, mirroring
 *   `evaluateG2`'s own independent recheck of exactly those two facts.
 *
 * On top of the plan's bound checks, each summed value is independently
 * re-derived from `mergedRows` and compared: a shard whose `coverage`
 * disagrees with its own `rows` would otherwise carry that disagreement into
 * the merged artifact, where `validateSimulatorReportConsistency`
 * (`smi5879-gate-check.io.ts`) would reject it much later with no indication
 * of WHICH shard introduced it. This also guarantees by construction that the
 * merged report satisfies that same validator.
 */
export function mergeCoverage(
  inputs: readonly ShardReportInput[],
  mergedRows: readonly SimRowResult[]
): CoverageByCohort {
  const first = inputs[0]
  if (first === undefined) {
    throw new Error('SMI-6015: cannot merge coverage from zero shard reports.')
  }
  const coverage = {} as CoverageByCohort
  for (const cohort of ALL_SIMULATED_COHORTS) {
    const total = first.report.coverage[cohort].total
    for (const input of inputs.slice(1)) {
      const otherTotal = input.report.coverage[cohort].total
      if (otherTotal !== total) {
        throw new Error(
          `SMI-6015: shard reports disagree on coverage.${cohort}.total ` +
            `(${first.path}=${total}, ${input.path}=${otherTotal}). Every shard must report the ` +
            'TRUE full-population total for every cohort — a disagreement means the shards ran ' +
            'against different populations, or one filtered its row load instead of filtering ' +
            'after it. Refusing to merge.'
        )
      }
    }

    let scanned = 0
    let unevaluable = 0
    let unfetchable = 0
    for (const input of inputs) {
      const c = input.report.coverage[cohort]
      scanned += c.scanned
      unevaluable += c.unevaluable
      unfetchable += c.unfetchable
    }

    const cohortRows = mergedRows.filter((r) => r.cohort === cohort)
    const summed = { scanned, unevaluable, unfetchable }
    const recomputed = {
      scanned: cohortRows.length,
      unevaluable: cohortRows.filter((r) => r.outcome === 'unevaluable').length,
      unfetchable: cohortRows.filter((r) => r.outcome === 'unfetchable').length,
    }
    for (const key of ['scanned', 'unevaluable', 'unfetchable'] as const) {
      if (summed[key] !== recomputed[key]) {
        throw new Error(
          `SMI-6015: summed coverage.${cohort}.${key}=${summed[key]} across the shard reports does ` +
            `not equal the ${recomputed[key]} matching row(s) actually present in the merged rows. ` +
            "At least one shard's coverage disagrees with its own rows array — that report is " +
            'internally inconsistent and must not be merged into a gate-eligible artifact.'
        )
      }
    }

    if (scanned > total) {
      throw new Error(
        `SMI-6015: merged coverage.${cohort}.scanned=${scanned} exceeds coverage.${cohort}.total=` +
          `${total} — the shards collectively reported more rows than the cohort contains.`
      )
    }
    if (unevaluable > scanned || unfetchable > scanned) {
      throw new Error(
        `SMI-6015: merged coverage.${cohort} subset count(s) exceed scanned=${scanned} ` +
          `(unevaluable=${unevaluable}, unfetchable=${unfetchable}). Both are SUBSETS of scanned, ` +
          'never addends to it.'
      )
    }

    const status: CohortCoverage['status'] =
      scanned === total && unevaluable === 0 ? 'full' : 'partial'
    coverage[cohort] = { status, scanned, total, unevaluable, unfetchable }
  }
  return coverage
}

/**
 * Plan merge-rule table, `counts` row: RECOMPUTED from the merged `rows`
 * array directly, NOT summed from the shard reports' own `counts` fields —
 * defense in depth, the same principle as the coverage recheck above.
 *
 * The tally is deliberately re-implemented here rather than importing
 * `summarizeCounts` from `smi5879-simulate-full.sweep.ts`: that function is
 * the PRODUCER of the numbers this tool exists to verify, and a verifier
 * running the producer's own arithmetic cannot detect a fault in it. The
 * closed outcome VOCABULARY is still shared (`SIM_ROW_OUTCOMES`/
 * `EMPTY_OUTCOME_COUNTS`, whose module doc names them the single source of
 * truth) — a vocabulary that drifted between producer and verifier would
 * itself be a bug, whereas independently-derived arithmetic is the point.
 */
export function recomputeCounts(rows: readonly SimRowResult[]): Record<SimRowOutcome, number> {
  const counts: Record<SimRowOutcome, number> = { ...EMPTY_OUTCOME_COUNTS }
  for (const row of rows) counts[row.outcome] += 1
  return counts
}

/** Plan merge-rule table, `counts` row invariant: `sum(counts) === rows.length`. */
export function assertCountsBalance(
  counts: Record<SimRowOutcome, number>,
  rows: readonly SimRowResult[]
): void {
  const sum = SIM_ROW_OUTCOMES.reduce((acc, outcome) => acc + counts[outcome], 0)
  if (sum !== rows.length) {
    throw new Error(
      `SMI-6015: recomputed counts sum to ${sum} across all outcome buckets but the merged rows ` +
        `array holds ${rows.length} row(s). An outcome outside the closed SimRowOutcome ` +
        'vocabulary would produce exactly this — refusing to write an unbalanced merged report.'
    )
  }
}

/**
 * Plan merge-rule table, `sweep` rows.
 *
 * - `passes_run`: `max()` across shards. Reported only, no gating semantics.
 * - `hard_stopped`: non-null if ANY shard's is non-null. This feeds G-2's hard
 *   gate directly (`smi5879-gate-check.gates.ts`: a non-null `hard_stopped` is
 *   an immediate INCONCLUSIVE), so silently nulling out one shard's
 *   non-convergence would let the gate pass on data that never finished.
 *
 * Two or more shards reporting DIFFERENT non-null reasons is itself a
 * hard-fail (round-1 review Medium finding), not an arbitrary pick — a
 * silently-chosen reason under disagreement is a diagnosability regression at
 * the exact moment an operator most needs to know what happened. Because
 * disagreement throws, the surviving selection only ever chooses among
 * IDENTICAL values, which makes the result deterministic regardless of the
 * order `--reports` was given in.
 */
export function mergeSweep(
  inputs: readonly ShardReportInput[]
): Smi5879SimulateFullReport['sweep'] {
  let passesRun = 0
  for (const input of inputs) passesRun = Math.max(passesRun, input.report.sweep.passes_run)

  const stopped = inputs.filter((i) => i.report.sweep.hard_stopped !== null)
  const distinctReasons = new Set<SweepHardStopReason>(
    stopped.map((i) => i.report.sweep.hard_stopped)
  )
  if (distinctReasons.size > 1) {
    throw new Error(
      'SMI-6015: shard reports disagree on sweep.hard_stopped — ' +
        `${stopped.map((i) => `${i.path}="${String(i.report.sweep.hard_stopped)}"`).join(', ')}. ` +
        'Picking one arbitrarily would discard the other reason(s) at the exact point an operator ' +
        'needs them; resolve why the shards terminated differently before merging.'
    )
  }
  return { passes_run: passesRun, hard_stopped: stopped[0]?.report.sweep.hard_stopped ?? null }
}

/**
 * Assemble the merged report from already-verified parts. `coverage`, `rows`
 * and `counts` are three independently-writable views over the same
 * underlying data (`smi5879-gate-check.io.ts`'s finding #7), which is why
 * each is recomputed and cross-checked by the functions above before reaching
 * this assembler rather than trusted from the shard reports.
 *
 * `estimated_completion_at` is `null` — a merge is a post-hoc step over
 * already-finished shards, never a live estimate. `generated_at` is this
 * tool's own timestamp, injected by the caller so the merge stays a pure
 * function of its inputs and is therefore testable.
 */
export function assembleMergedReport(
  identity: ShardIdentity,
  coverage: CoverageByCohort,
  rows: SimRowResult[],
  counts: Record<SimRowOutcome, number>,
  sweep: Smi5879SimulateFullReport['sweep'],
  generatedAt: string
): Smi5879SimulateFullReport {
  return {
    report_kind: 'full_simulation',
    run_id: identity.run_id,
    purpose: identity.purpose,
    status: identity.status,
    token_source: identity.token_source,
    baseline_commit: identity.baseline_commit,
    coverage,
    estimated_completion_at: null,
    sweep,
    rows,
    counts,
    generated_at: generatedAt,
  }
}
