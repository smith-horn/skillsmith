/**
 * Statistical core of the SMI-6444 G-1 bulk disposition producer: the exact
 * one-sided hypergeometric bound, the per-stratum floor, stratum feasibility
 * classification, the joint sample-size search, acceptance evaluation, the
 * stratification key, and deterministic seeded selection.
 * @module scripts/indexer/smi5879-dispose-terminal.stats
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *       ("### 5. Statistical design for `primary_not_found`'s sample",
 *        "### 7. ... sample accounting")
 *
 * Deliberately PURE: no DB, no filesystem, no network, no CLI. The producer
 * CLI owns every side effect; this file owns only the arithmetic and the
 * selection, so both are unit-testable against pinned reference values with no
 * fixtures beyond plain numbers.
 *
 * THE DESIGN IN ONE PARAGRAPH. Rows split into strata (embedded-ref vs.
 * default-branch). Each nonempty stratum gets an exact one-sided upper bound
 * on its true count of misclassified rows, at a Bonferroni-split alpha
 * (overall 5% / H strata). A batch is accepted only if BOTH arms hold: the
 * population-weighted average of the per-stratum rate bounds clears
 * `mismatchThresholdBp`, and every individual stratum bound clears
 * `stratumThresholdBp`. The second arm exists because the first alone can
 * dilute a wholesale-broken narrow stratum into invisibility, which is the
 * entire reason for stratifying. A selected row that could not be re-fetched
 * is priced as a mismatch (`k' = mismatched + unavailable`) — conservative
 * under ANY missingness mechanism, which matters because fetch availability
 * plausibly correlates with the very path/ref behaviour being audited (plan
 * Items 5/7, round-3 Finding 2).
 *
 * EXACT INTEGER ACCEPTANCE ARITHMETIC. Both arms are evaluated on integers,
 * never on floating-point rates:
 *   stratum arm:     M_u * 10000 <= stratumThresholdBp * N_h
 *   population arm:  (sum_h M_u_h) * 10000 <= mismatchThresholdBp * N
 * The population arm collapses to a sum of counts because
 * `sum_h (N_h/N) * (M_u_h/N_h) === (sum_h M_u_h)/N` exactly. No acceptance
 * decision can hinge on a rounding artefact; the reported basis-point figures
 * are presentation only.
 */

import { parseSkillMdUrl } from './_shared/skill-md-fetch.ts'
import {
  compareIdsByBytes,
  hypergeometricCdfAtMost,
  seededSampleWithoutReplacement,
} from './smi5879-dispose-terminal.stats.helpers.ts'
import {
  DEFAULT_SAMPLING_POLICY,
  type AcceptanceResult,
  type JointSizingResult,
  type SamplingPolicy,
  type StratumAcceptance,
  type StratumFeasibility,
  type StratumKey,
  type StratumObservation,
  type StratumPopulation,
  type StratumSizing,
  type UpperBoundInput,
} from './smi5879-dispose-terminal.stats.types.ts'

// Single public entry point: policy constants, types, and every function below
// come from this module alone (the facade pattern `skill-processor.ts` uses).
export * from './smi5879-dispose-terminal.stats.types.ts'
export { binomialUpperBoundRate } from './smi5879-dispose-terminal.stats.helpers.ts'

// ---------------------------------------------------------------------------
// Alpha
// ---------------------------------------------------------------------------

/**
 * Per-stratum alpha under the Bonferroni split: overall one-sided 95% with
 * H = 2 gives 0.025 each.
 *
 * `H` counts the strata a confidence claim is actually MADE about — empty
 * strata and infeasible ones (whose rows are routed to manual disposition
 * instead) are both excluded by {@link computeJointSampleSizing} before this
 * is called. Including them would tighten every surviving stratum's alpha to
 * pay for an event that is never asserted, inflating the sample for nothing.
 */
export function perStratumAlpha(confidencePct: number, nonEmptyStrataCount: number): number {
  if (!Number.isInteger(confidencePct) || confidencePct <= 0 || confidencePct >= 100) {
    throw new RangeError(`confidencePct must be an integer in (0, 100), got ${confidencePct}`)
  }
  if (!Number.isInteger(nonEmptyStrataCount) || nonEmptyStrataCount < 1) {
    throw new RangeError(`nonEmptyStrataCount must be >= 1, got ${nonEmptyStrataCount}`)
  }
  return (100 - confidencePct) / 100 / nonEmptyStrataCount
}

// ---------------------------------------------------------------------------
// The bound
// ---------------------------------------------------------------------------

/**
 * `M_u = max{ M : P(X <= k' | Hypergeometric(N, M, n)) >= alpha }` — the exact
 * one-sided upper bound on this stratum's true count of misclassified rows.
 *
 * The hypergeometric CDF at fixed `k'` is non-increasing in `M`, so a binary
 * search over `M` is exact. This IS the finite-population correction: it
 * converges to binomial Clopper-Pearson as `N -> infinity`, and is strictly
 * tighter for the large sampling fractions a floor forces on a small stratum.
 *
 * Degenerate full census (`n === N`): every bad row is observed, so
 * `P(X <= k')` is 1 for `M <= k'` and 0 above it, giving `M_u = k'` — the
 * exact observed count, no interval. Returned analytically, since the search
 * would be pure overhead on the one input whose answer is closed-form.
 */
export function hypergeometricUpperBoundCount(input: UpperBoundInput): number {
  const { populationCount, sampleSize, badDraws, alpha } = input
  if (!Number.isInteger(populationCount) || populationCount < 1) {
    throw new RangeError(`populationCount must be a positive integer, got ${populationCount}`)
  }
  if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > populationCount) {
    throw new RangeError(
      `sampleSize must be an integer in [1, ${populationCount}], got ${sampleSize}`
    )
  }
  if (!Number.isInteger(badDraws) || badDraws < 0 || badDraws > sampleSize) {
    throw new RangeError(`badDraws must be an integer in [0, ${sampleSize}], got ${badDraws}`)
  }
  if (!(alpha > 0) || !(alpha < 1)) {
    throw new RangeError(`alpha must be in (0, 1), got ${alpha}`)
  }

  if (sampleSize === populationCount) return badDraws

  let lo = 0
  let hi = populationCount
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2)
    if (hypergeometricCdfAtMost(populationCount, mid, sampleSize, badDraws) >= alpha) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * `M_u / N` in basis points, rounded UP. Rounding up (never nearest, never
 * down) is deliberate: this is the integer persisted into the digest-covered
 * batch record, and an understated one would let an auditor read a rate the
 * data does not support. Acceptance never consults it — it uses the exact
 * integer comparisons documented in this module's header.
 */
export function upperBoundCountToBp(upperBoundCount: number, populationCount: number): number {
  return Math.ceil((upperBoundCount * 10000) / populationCount)
}

// ---------------------------------------------------------------------------
// Floor and feasibility
// ---------------------------------------------------------------------------

/**
 * `f_h` — the smallest `n_h` whose exact bound at `badDraws` clears this
 * stratum's own threshold for this stratum's actual `N_h`.
 *
 * Computed by calling {@link hypergeometricUpperBoundCount}, never
 * hand-derived: the floor is population-dependent, and two review rounds of
 * this plan each caught a hand-derived value that was wrong. Returns `null`
 * when even a full census cannot clear the threshold (an infeasible stratum).
 *
 * `badDraws` defaults to 1, the plan's literal definition of the floor. The
 * floor is only a LOWER BOUND on `n_h`, so a design point above 1 is still
 * enforced by the sizing search itself, never weakened by this default.
 */
export function computeStratumFloor(params: {
  populationCount: number
  stratumThresholdBp: number
  alpha: number
  badDraws?: number
}): number | null {
  const { populationCount, stratumThresholdBp, alpha } = params
  const badDraws = params.badDraws ?? 1
  // At a full census the bound is exactly `badDraws`, so this is the precise
  // feasibility test, not an approximation of one.
  if (badDraws * 10000 > stratumThresholdBp * populationCount) return null

  let lo = Math.max(1, badDraws)
  let hi = populationCount
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const count = hypergeometricUpperBoundCount({
      populationCount,
      sampleSize: mid,
      badDraws,
      alpha,
    })
    if (count * 10000 <= stratumThresholdBp * populationCount) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * Classify a stratum for the sizing search.
 *
 * - `empty` (`N_h === 0`): omitted from `H` entirely — no rows, nothing to
 *   sample or prove, and including it would both inflate the Bonferroni split
 *   and divide by zero.
 * - `infeasible`: even a full census cannot clear the stratum threshold at the
 *   design point (`designPoint / N_h > stratumThresholdBp / 10000`; at the
 *   ratified defaults, any `N_h < 10`). Its rows are NEVER folded into a bulk
 *   batch under a weaker guarantee — the caller routes them to individual
 *   manual disposition.
 * - `feasible`: everything else.
 */
export function classifyStratum(
  populationCount: number,
  policy: SamplingPolicy = DEFAULT_SAMPLING_POLICY
): StratumFeasibility {
  if (!Number.isInteger(populationCount) || populationCount < 0) {
    throw new RangeError(`populationCount must be a non-negative integer, got ${populationCount}`)
  }
  if (populationCount === 0) return 'empty'
  const infeasible =
    policy.designPointBadDrawsPerStratum * 10000 > policy.stratumThresholdBp * populationCount
  return infeasible ? 'infeasible' : 'feasible'
}

// ---------------------------------------------------------------------------
// Joint sizing search
// ---------------------------------------------------------------------------

/** `n_h = min(N_h, max(ceil(n * N_h / N), min(N_h, f_h)))`. */
function allocateSampleSize(
  overallSampleSize: number,
  populationCount: number,
  totalPopulation: number,
  floor: number
): number {
  const proportional = Math.ceil((overallSampleSize * populationCount) / totalPopulation)
  return Math.min(populationCount, Math.max(proportional, Math.min(populationCount, floor)))
}

/**
 * Smallest overall `n` such that, with the allocation above and `k'_h` equal
 * to the design point in EVERY stratum, both acceptance arms pass.
 *
 * Sizing and acceptance deliberately share
 * {@link hypergeometricUpperBoundCount} so the two can never structurally
 * disagree.
 *
 * The predicate is monotone in `n` (the allocation is non-decreasing in `n`,
 * and `M_u` is non-increasing in `n_h`), so a binary search over
 * `[1, populationCount]` finds the exact minimum.
 *
 * Note `overallSampleSize` is a NOMINAL target, not a fetch count: when floors
 * dominate (small strata), the answer can be far below `totalSelectedCount`,
 * which is the number of rows actually re-fetched.
 *
 * Throws in the two cases where no valid answer exists, rather than returning
 * a number that reads as success:
 *  - every stratum is empty or infeasible (nothing to size);
 *  - not even a full census clears the POPULATION arm. Per-stratum
 *    feasibility does not imply this: at a full census each stratum's bound
 *    is exactly the design point, so the population bound bottoms out at
 *    `H * designPoint / N`, which exceeds a 2% threshold for any total
 *    population under 100 at the ratified defaults. That is a whole-population
 *    infeasibility — the caller routes every row to manual review, exactly as
 *    it does for an individually infeasible stratum.
 */
export function computeJointSampleSizing(
  strata: readonly StratumPopulation[],
  policy: SamplingPolicy = DEFAULT_SAMPLING_POLICY
): JointSizingResult {
  const emptyStrataKeys: string[] = []
  const infeasibleStrata: StratumPopulation[] = []
  const feasible: StratumPopulation[] = []
  for (const stratum of strata) {
    const verdict = classifyStratum(stratum.populationCount, policy)
    if (verdict === 'empty') emptyStrataKeys.push(stratum.stratumKey)
    else if (verdict === 'infeasible') infeasibleStrata.push(stratum)
    else feasible.push(stratum)
  }
  if (feasible.length === 0) {
    throw new RangeError(
      'computeJointSampleSizing: no feasible stratum — every stratum is empty or too small to satisfy the design point; route these rows to manual review'
    )
  }

  const alpha = perStratumAlpha(policy.confidencePct, feasible.length)
  const totalPopulation = feasible.reduce((sum, s) => sum + s.populationCount, 0)
  // Closed-form whole-population feasibility: at a full census every stratum's
  // bound is exactly the design point, so this is the tightest the population
  // arm can ever get. Checked up front so the binary search below can assume a
  // passing upper end rather than silently returning its failing right edge.
  const censusUpperBound = feasible.length * policy.designPointBadDrawsPerStratum
  if (censusUpperBound * 10000 > policy.mismatchThresholdBp * totalPopulation) {
    throw new RangeError(
      `computeJointSampleSizing: population of ${totalPopulation} across ${feasible.length} feasible strata cannot clear the ${policy.mismatchThresholdBp}bp population arm even at a full census ` +
        `(a census bottoms out at ${upperBoundCountToBp(censusUpperBound, totalPopulation)}bp at design point ${policy.designPointBadDrawsPerStratum}); route these rows to manual review`
    )
  }
  const prepared = feasible.map((stratum) => {
    const floor = computeStratumFloor({
      populationCount: stratum.populationCount,
      stratumThresholdBp: policy.stratumThresholdBp,
      alpha,
    })
    if (floor === null) {
      // Unreachable for a design-point-feasible stratum (the floor's k'=1 is
      // never above the design point), but a null here would become NaN.
      throw new RangeError(
        `computeJointSampleSizing: stratum ${stratum.stratumKey} has no floor at k'=1 despite being classified feasible`
      )
    }
    return { ...stratum, floor }
  })

  const evaluate = (overall: number): { pass: boolean; strata: StratumSizing[] } => {
    const sized: StratumSizing[] = []
    let totalUpperBound = 0
    let pass = true
    for (const { stratumKey, populationCount, floor } of prepared) {
      const sampleSize = allocateSampleSize(overall, populationCount, totalPopulation, floor)
      const upperBoundCount = hypergeometricUpperBoundCount({
        populationCount,
        sampleSize,
        // Clamped only for the degenerate case of a design point above the
        // allocated sample; the clamp cannot weaken the result, because a
        // clamped stratum's bound is the vacuous `M_u = N_h`, which fails the
        // stratum arm and pushes the search to a larger `n`.
        badDraws: Math.min(policy.designPointBadDrawsPerStratum, sampleSize),
        alpha,
      })
      if (upperBoundCount * 10000 > policy.stratumThresholdBp * populationCount) pass = false
      totalUpperBound += upperBoundCount
      sized.push({
        stratumKey,
        populationCount,
        sampleSize,
        floor,
        upperBoundCount,
        upperBoundBp: upperBoundCountToBp(upperBoundCount, populationCount),
      })
    }
    if (totalUpperBound * 10000 > policy.mismatchThresholdBp * totalPopulation) pass = false
    return { pass, strata: sized }
  }

  let lo = 1
  let hi = totalPopulation
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (evaluate(mid).pass) hi = mid
    else lo = mid + 1
  }
  const final = evaluate(lo)
  if (!final.pass) {
    // Defence in depth: the up-front census check above proves a passing upper
    // end exists, so reaching here means the monotonicity assumption the
    // binary search rests on was violated.
    throw new RangeError(
      `computeJointSampleSizing: search terminated at n=${lo} without both arms passing; the acceptance predicate is not monotone in n as assumed`
    )
  }
  const totalUpperBound = final.strata.reduce((sum, s) => sum + s.upperBoundCount, 0)

  return {
    overallSampleSize: lo,
    totalSelectedCount: final.strata.reduce((sum, s) => sum + s.sampleSize, 0),
    populationCount: totalPopulation,
    strata: final.strata,
    emptyStrataKeys,
    infeasibleStrata,
    perStratumAlpha: alpha,
    populationUpperBoundBp: upperBoundCountToBp(totalUpperBound, totalPopulation),
  }
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

/**
 * Evaluate a completed sample against both acceptance arms, using the same
 * bound function the sizing search used.
 *
 * `floor` is recomputed here for reporting only; acceptance never depends on
 * it — the floor shapes selection, not the verdict on what selection returned.
 */
export function evaluateAcceptance(
  observations: readonly StratumObservation[],
  policy: SamplingPolicy = DEFAULT_SAMPLING_POLICY
): AcceptanceResult {
  const nonEmpty = observations.filter((o) => o.populationCount > 0)
  if (nonEmpty.length === 0) {
    throw new RangeError('evaluateAcceptance: no nonempty stratum to evaluate')
  }
  const alpha = perStratumAlpha(policy.confidencePct, nonEmpty.length)
  const populationCount = nonEmpty.reduce((sum, o) => sum + o.populationCount, 0)

  const failures: string[] = []
  const strata: StratumAcceptance[] = []
  let totalUpperBound = 0
  let stratumArmPass = true

  for (const observation of nonEmpty) {
    const badDraws = observation.mismatchedCount + observation.unavailableCount
    const upperBoundCount = hypergeometricUpperBoundCount({
      populationCount: observation.populationCount,
      sampleSize: observation.selectedCount,
      badDraws,
      alpha,
    })
    const upperBoundBp = upperBoundCountToBp(upperBoundCount, observation.populationCount)
    const pass = upperBoundCount * 10000 <= policy.stratumThresholdBp * observation.populationCount
    if (!pass) {
      stratumArmPass = false
      failures.push(
        `stratum ${observation.stratumKey}: bound ${upperBoundBp}bp exceeds ${policy.stratumThresholdBp}bp ` +
          `(k'=${badDraws} of n=${observation.selectedCount}, N=${observation.populationCount})`
      )
    }
    totalUpperBound += upperBoundCount
    const floor = computeStratumFloor({
      populationCount: observation.populationCount,
      stratumThresholdBp: policy.stratumThresholdBp,
      alpha,
    })
    strata.push({
      stratumKey: observation.stratumKey,
      populationCount: observation.populationCount,
      sampleSize: observation.selectedCount,
      floor: floor ?? observation.populationCount,
      upperBoundCount,
      upperBoundBp,
      badDraws,
      stratumArmPass: pass,
    })
  }

  const populationUpperBoundBp = upperBoundCountToBp(totalUpperBound, populationCount)
  const populationArmPass = totalUpperBound * 10000 <= policy.mismatchThresholdBp * populationCount
  if (!populationArmPass) {
    failures.push(
      `population arm: bound ${populationUpperBoundBp}bp exceeds ${policy.mismatchThresholdBp}bp`
    )
  }

  return {
    accepted: populationArmPass && stratumArmPass,
    populationArmPass,
    stratumArmPass,
    populationCount,
    populationUpperBoundBp,
    perStratumAlpha: alpha,
    strata,
    failures,
  }
}

// ---------------------------------------------------------------------------
// Stratification + selection
// ---------------------------------------------------------------------------

/**
 * The stratum a population row belongs to: `embedded_ref` when the stored
 * `repo_url` carries an explicit `tree/{ref}` segment, `default_branch`
 * otherwise.
 *
 * Returns `null` when the URL does not parse at all. Such a row cannot be a
 * `primary_not_found` row by construction (it never reached a fetch), so the
 * caller routes it to manual review rather than letting it fall into
 * `default_branch` by default — silently folding an unparseable row into a
 * stratum would place it in a bucket whose defining predicate it never met.
 */
export function stratumKeyForRow(
  repoUrl: string | null,
  skillPath: string | null
): StratumKey | null {
  const parsed = parseSkillMdUrl(repoUrl, skillPath)
  if (parsed === null) return null
  return parsed.ref === undefined ? 'default_branch' : 'embedded_ref'
}

/**
 * Deterministic without-replacement selection within one stratum.
 *
 * Seed material binds the run's seed to the stratum key (NUL-separated, so no
 * key can impersonate a different seed/key pair), meaning two strata never
 * consume the same draw sequence. Returns byte-sorted ids, matching the batch
 * schema's `selected_ids` requirement; the selection itself is invariant to
 * the caller's candidate ordering because candidates are byte-sorted before
 * the shuffle.
 */
export function selectStratumSample(params: {
  candidateIds: readonly string[]
  sampleSize: number
  seed: string
  stratumKey: string
}): string[] {
  const { candidateIds, sampleSize, seed, stratumKey } = params
  const drawn = seededSampleWithoutReplacement(
    candidateIds,
    sampleSize,
    `${seed}\u0000${stratumKey}`
  )
  return drawn.sort(compareIdsByBytes)
}
