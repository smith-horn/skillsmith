/**
 * Authoritative-population binding for `smi5879-merge-shards.ts`: the
 * digest-verified load of the sealed generation's row set, the artifact
 * binding that ties the shard reports to that generation, and the EXACT SET
 * EQUALITY check that is this tool's whole reason for touching a database at
 * all. Split into its own module per CLAUDE.md's <500-line-per-file
 * convention, and along the same seam `smi5879-gate-check.ts` uses when it
 * keeps `bindGeneration` in `smi5879-gate-check.binding.ts` rather than
 * inline: "prove these artifacts describe this generation" is a separable
 * concern from "combine these artifacts".
 * @module scripts/indexer/smi5879-merge-shards.population
 *
 * Plan: docs/internal/implementation/smi-6015-pat-sharded-fetch-plan.md
 *       ("### 3. N-way checkpoint/report merge tool (new script)")
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.3.5.2.4/§8.5
 *
 * WHY ROW-DISJOINTNESS IS NOT ENOUGH
 * ----------------------------------
 * `mergeRows` (`.merge-rules.ts`) proves no row was reported twice. It cannot
 * prove that every row was reported at all, and neither can any amount of
 * internal arithmetic: a merged report missing rows balances perfectly
 * against its own reduced coverage numbers, and a same-cohort id substituted
 * for a genuinely-dropped row keeps every count intact. Only comparison
 * against the authoritative population catches those, and only if that
 * population is itself proven un-drifted first — hence the strict ordering in
 * {@link loadVerifiedPopulation}: exists -> sealed -> digests re-verify ->
 * only THEN read the rows.
 */

import { ALL_SIMULATED_COHORTS } from './smi5879-simulate-full.types.ts'
import { MAX_IDS_IN_ERROR, formatIds } from './smi5879-merge-shards.merge-rules.ts'
import type { Smi5879Purpose, Smi5879RunStatus } from './smi5879-census.types.ts'
import type {
  CoverageByCohort,
  SimRowResult,
  SimSnapshotRow,
  Smi5879SimulateFullDbDeps,
} from './smi5879-simulate-full.types.ts'

/**
 * The DB surface the merge tool needs, expressed as a structural SUBSET of
 * `Smi5879SimulateFullDbDeps` rather than as a new interface — so the EXISTING
 * production adapter (`createSmi5879SimulateFullDbDeps`, which already wraps
 * `smi5879_population_digest()`/`smi5879_branch_digest()` and the cohort row
 * load) satisfies it with no new implementation, and so a test injects a fake
 * exactly the way `runSimulateFull`'s own tests already do. This is the plan's
 * "reuse that mechanism, don't reinvent a second one" expressed in the type
 * system: there is no second digest path that could drift out of sync with
 * the first.
 */
export type Smi5879MergeShardsDbDeps = Pick<
  Smi5879SimulateFullDbDeps,
  'getRunSummary' | 'verifyDigest' | 'loadCohortRows'
>

export interface VerifiedPopulation {
  population: SimSnapshotRow[]
  summary: { purpose: Smi5879Purpose; status: Smi5879RunStatus }
}

/**
 * Materialise the authoritative population for `runId`, refusing anything
 * short of a sealed, digest-verified generation.
 *
 * The first three steps are the same binding `bindGeneration`
 * (`smi5879-gate-check.binding.ts`) performs before any gate and
 * `runSimulateFull` performs on a cold start — exists, `sealed`, digests
 * re-verify — reused rather than re-derived; the population itself is then
 * read through the SAME `loadCohortRows` the simulator used to build its own
 * `coverage[cohort].total`. BOTH digests are required, not just the
 * population one: a branch-digest mismatch means the generation as a whole is
 * corrupt, and the design doc's answer to a corrupt generation is a new
 * generation, never a repair.
 *
 * There is deliberately no flag to skip any of this. A merge produced without
 * it is not a weaker artifact, it is an unsound one, and an escape hatch here
 * would be an escape hatch on the merge gate itself.
 */
export async function loadVerifiedPopulation(
  db: Smi5879MergeShardsDbDeps,
  runId: string
): Promise<VerifiedPopulation> {
  const summary = await db.getRunSummary(runId)
  if (!summary) {
    throw new Error(
      `SMI-6015: no smi5879_run row for run_id=${runId} — cannot verify the merged rows against ` +
        'an authoritative population, so the merge cannot be trusted.'
    )
  }
  if (summary.status !== 'sealed') {
    throw new Error(
      `SMI-6015: generation ${runId} is "${summary.status}", not "sealed" — shard reports may only ` +
        'be merged against a sealed generation, whose population is immutable by construction.'
    )
  }
  const digest = await db.verifyDigest(runId)
  if (!digest.populationMatches || !digest.branchMatches) {
    throw new Error(
      `SMI-6015: digest verification failed for run_id=${runId} ` +
        `(population_matches=${digest.populationMatches}, branch_matches=${digest.branchMatches}). ` +
        'The generation is corrupt — the correct action is a new generation, not a repair. Merging ' +
        'against a drifted population would make the set-equality check meaningless.'
    )
  }
  const population = await db.loadCohortRows(runId)
  if (population.length === 0) {
    throw new Error(
      `SMI-6015: the sealed population for run_id=${runId} is empty (zero C1-C4 rows). A merge ` +
        'against an empty population would vacuously "prove" set equality for a report containing ' +
        'no rows at all.'
    )
  }
  return { population, summary }
}

/**
 * The shard reports and the live generation must describe the same thing.
 * Applies the `checkArtifactRunIdBinding` precedent
 * (`smi5879-gate-check.binding.ts`): a plausible-looking but mismatched
 * combination is rejected rather than silently gated on. Without the `run_id`
 * half in particular, an operator could merge generation A's shard reports
 * while verifying set equality against generation B's population.
 */
export function assertReportsBindToGeneration(
  identity: { run_id: string; purpose: Smi5879Purpose; status: Smi5879RunStatus },
  runId: string,
  summary: { purpose: Smi5879Purpose; status: Smi5879RunStatus }
): void {
  const mismatches: string[] = []
  if (identity.run_id !== runId) {
    mismatches.push(`run_id (shard reports="${identity.run_id}", --run-id=${runId})`)
  }
  if (identity.purpose !== summary.purpose) {
    mismatches.push(
      `purpose (shard reports="${identity.purpose}", smi5879_run="${summary.purpose}")`
    )
  }
  if (identity.status !== summary.status) {
    mismatches.push(`status (shard reports="${identity.status}", smi5879_run="${summary.status}")`)
  }
  if (mismatches.length > 0) {
    throw new Error(
      'SMI-6015: the shard reports do not bind to the generation being merged — ' +
        `${mismatches.join('; ')}. Refusing to verify one generation's reports against another ` +
        "generation's population."
    )
  }
}

/**
 * THE safety property (plan §3, round-1 review Critical finding #2): exact set
 * equality between the merged `rows` id set and the authoritative sealed
 * population's id set — zero missing, zero extra, zero duplicate — plus
 * agreement on every field each row carries over from its canonical row.
 *
 * `population` MUST come from {@link loadVerifiedPopulation}; see this
 * module's own doc comment for why an unverified population makes this check
 * vacuous.
 *
 * The per-row field checks mirror `assertCheckpointRowsBelongToGeneration`
 * (`smi5879-simulate-full.checkpoint.ts`) one-for-one and for the same reason:
 * `report.rows`/`report.counts` are built from the simulator's stored per-row
 * results, never re-derived from the canonical row set, so a row carrying a
 * real id but a wrong `cohort` would corrupt coverage/counts accounting while
 * every id-level check still passed, and a wrong `author`/`name` would
 * misattribute a row to the human reviewer reading the merged report.
 */
export function assertMergedRowsMatchPopulation(
  mergedRows: readonly SimRowResult[],
  population: readonly SimSnapshotRow[]
): void {
  const populationById = new Map(population.map((r) => [r.id, r]))
  const mergedById = new Map<string, SimRowResult>()
  const duplicates: string[] = []
  for (const row of mergedRows) {
    if (mergedById.has(row.id)) duplicates.push(row.id)
    else mergedById.set(row.id, row)
  }

  const missing = population.filter((r) => !mergedById.has(r.id)).map((r) => r.id)
  const extra = mergedRows.filter((r) => !populationById.has(r.id)).map((r) => r.id)
  const fieldMismatches: string[] = []
  for (const row of mergedRows) {
    const canonical = populationById.get(row.id)
    if (canonical === undefined) continue // already reported as `extra`
    if (row.cohort !== canonical.cohort) {
      fieldMismatches.push(
        `${row.id} (reported cohort=${row.cohort}, population cohort=${canonical.cohort})`
      )
    } else if (row.author !== canonical.author || row.name !== canonical.name) {
      fieldMismatches.push(
        `${row.id} (reported author/name=${row.author}/${row.name}, ` +
          `population author/name=${canonical.author}/${canonical.name})`
      )
    }
  }

  if (
    missing.length === 0 &&
    extra.length === 0 &&
    duplicates.length === 0 &&
    fieldMismatches.length === 0
  ) {
    return
  }
  const parts: string[] = []
  if (missing.length > 0) {
    parts.push(
      `${missing.length} population row(s) reported by NO shard: ${formatIds(missing)} — the ` +
        'merged report would silently omit them from every gate that reads report.rows'
    )
  }
  if (extra.length > 0) {
    parts.push(
      `${extra.length} reported row(s) not present in the sealed population: ${formatIds(extra)}`
    )
  }
  if (duplicates.length > 0) {
    parts.push(`${duplicates.length} duplicate row id(s): ${formatIds(duplicates)}`)
  }
  if (fieldMismatches.length > 0) {
    parts.push(
      `${fieldMismatches.length} row(s) disagree with their canonical population row: ` +
        `${fieldMismatches.slice(0, MAX_IDS_IN_ERROR).join('; ')}` +
        `${fieldMismatches.length > MAX_IDS_IN_ERROR ? ', ...' : ''}`
    )
  }
  throw new Error(
    'SMI-6015: the merged rows are not EXACTLY the sealed population for this run_id — ' +
      `${parts.join('; ')}. Row-count and digest agreement alone are not sufficient; set equality ` +
      'is the actual requirement, because a same-cohort id can substitute for a genuinely-dropped ' +
      'row while every count still balances. Refusing to write a gate-eligible merged report.'
  )
}

/**
 * Cross-check the (already agreed-upon) per-cohort `total` against the
 * authoritative population rather than only against the other shards. All N
 * shards agreeing on a WRONG total is not hypothetical — they would all
 * inherit the same wrong value from the same wrong row load. Since
 * `coverage[cohort].status === 'full'` hinges on `scanned === total`, an
 * inflated total silently downgrades the merged report to `partial` (visible,
 * survivable), but a DEFLATED total would let `scanned === total` hold while
 * rows were missing.
 */
export function assertCoverageTotalsMatchPopulation(
  coverage: CoverageByCohort,
  population: readonly SimSnapshotRow[]
): void {
  const mismatches: string[] = []
  for (const cohort of ALL_SIMULATED_COHORTS) {
    const populationTotal = population.filter((r) => r.cohort === cohort).length
    if (coverage[cohort].total !== populationTotal) {
      mismatches.push(
        `${cohort} (reports say total=${coverage[cohort].total}, sealed population has ${populationTotal})`
      )
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      'SMI-6015: shard-reported cohort total(s) do not match the digest-verified sealed ' +
        `population — ${mismatches.join('; ')}. G-2's "coverage is full" decision is exactly ` +
        '`scanned === total`, so a wrong total makes that decision meaningless. Refusing to merge.'
    )
  }
}
