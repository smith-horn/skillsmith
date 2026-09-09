/**
 * SMI-6444 G-1 bulk disposition producer — statistical design tests.
 * @module scripts/tests/indexer/smi5879-dispose-terminal
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *       (Item 5 statistical design, Item 7 accounting partition,
 *        Item 9 test list incl. the "Round 5 additions" pinned fixtures)
 *
 * SCOPE: this file currently holds ONLY the statistical/sampling engine's
 * tests, in the single `describe` block below. Other workers append their own
 * top-level `describe` blocks (CLI staging/sign-off, ledger locking,
 * revocation, unfetchable subtype re-derivation) alongside it.
 *
 * ---------------------------------------------------------------------------
 * THREE DIVERGENCES FROM THE PLAN'S PINNED FIXTURE TABLE
 * ---------------------------------------------------------------------------
 * Every value below was computed by the implementation under test AND
 * independently cross-checked with an exact-rational BigInt evaluation of the
 * same probabilities (`40 * sum_i C(M,i)C(N-M,n-i) >= C(N,n)` for alpha=1/40),
 * which agreed on every case. Where this file's pinned value differs from the
 * plan's, the plan's number is named in a comment on the assertion and in the
 * hand-back report; the implementation was NOT adjusted to reproduce it.
 *
 *  1. Joint sizing minimum is 546 / 545 / 545 for the plan's three tested
 *     splits, not a uniform 550. The plan's own quoted evidence reproduces
 *     EXACTLY here (n=540 -> 2.021%, fails; n=550 -> 1.979%, passes), so the
 *     bound agrees — 550 is simply the smaller of the two decade-grid points
 *     the plan tested, not the true minimum. Both the true minimum and the
 *     plan's two evidence points are pinned below.
 *  2. "Two bad draws concentrated in one stratum fails at least one arm" is
 *     FALSE at every n from 546 to 558. Concentration makes the population arm
 *     LOOSER, not tighter, because the emptied stratum's bound drops further
 *     than the loaded stratum's rises. What does fail is one bad draw BEYOND
 *     the design-point total (2,1). Both are pinned below.
 *  3. "Equal-split binomial minimum n=556" does not reproduce under any
 *     allocation convention: the binomial Clopper-Pearson bound clears 200bp
 *     at n_h=277 (199.49bp), not 278, putting the equal-split minimum at
 *     552 (ceil) / 553 (round) / 554 (floor). The boundary values are pinned.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SAMPLING_POLICY,
  POISSON_ANCHORS,
  binomialUpperBoundRate,
  classifyStratum,
  computeJointSampleSizing,
  computeStratumFloor,
  evaluateAcceptance,
  hypergeometricUpperBoundCount,
  perStratumAlpha,
  selectStratumSample,
  stratumKeyForRow,
  upperBoundCountToBp,
  type StratumPopulation,
} from '../../indexer/smi5879-dispose-terminal.stats.ts'
import { hypergeometricCdfAtMost } from '../../indexer/smi5879-dispose-terminal.stats.helpers.ts'
// --- SMI-6444 Items 4/7/8 (ledger mutation core, sidecar, provenance) -------
// Appended alongside the statistical describe above; these imports serve only
// the top-level describe blocks at the end of this file.
import { afterEach, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { StuckLockError, acquireOwnedLock } from '@skillsmith/core/config/owned-lock'
import {
  canonicalJsonStringify,
  computeStageDigest,
  confirmationCodeFor,
  type JsonValue,
} from '../../indexer/smi5879-disposition-digest.ts'
import {
  validateDispositionLedger,
  validateDispositionLedgerShape,
} from '../../indexer/smi5879-gate-check.ledger-validation.ts'
import {
  LEDGER_LOCK_CONTEXT_LINE,
  LEDGER_LOCK_LABEL,
  addManual,
  addManualEntry,
  computeEntryIdsDigest,
  revokeBatchSignOff,
  revokeDispositionBatch,
  revokeManualEntry,
  runLockedLedgerMutation,
  serializeLedger,
  sha256,
  signOffDispositionBatch,
  stageDispositionBatch,
  type LedgerCommandResult,
  type SignOffResult,
  type StagedBatchDraft,
} from '../../indexer/smi5879-dispose-terminal.ledger.ts'
import type { FileIoDeps } from '../../indexer/smi5879-dispose-terminal.io.ts'
import {
  SIDECAR_LOCK_CONTEXT_LINE,
  deriveSampleSelection,
  openSampleRun,
  type SampleCandidate,
  type SampleRunHandle,
  type SampleRunIdentity,
} from '../../indexer/smi5879-dispose-terminal.sidecar.ts'
import {
  PRODUCER_SOURCE_FILES,
  computeToolSourceDigest,
  detectDirtyWorktree,
  isProducerCoreModule,
  resolveToolCommit,
  resolveToolProvenance,
  type GitRunner,
} from '../../indexer/smi5879-dispose-terminal.provenance.ts'
import type { Smi5879DispositionLedger } from '../../indexer/smi5879-gate-check.types.ts'
import type { SamplingPolicy } from '../../indexer/smi5879-dispose-terminal.stats.types.ts'
// --- SMI-6444 producer CLI flow tests (this task) --------------------------
import { initAction } from '../../indexer/smi5879-dispose-terminal.action.ts'
import { disposeAction } from '../../indexer/smi5879-dispose-terminal.action.dispose.ts'
import type {
  DisposeActionDeps,
  DisposeOptions,
} from '../../indexer/smi5879-dispose-terminal.action.dispose.ts'
import type { Smi5879DisposeTerminalDbDeps } from '../../indexer/smi5879-dispose-terminal.db.ts'
import type { ParsedSkillUrl } from '../../indexer/_shared/skill-md-fetch.ts'
import type { FetchRetryOutcome } from '../../indexer/smi5879-fetch-retry.ts'
import {
  ALL_SIMULATED_COHORTS,
  EMPTY_OUTCOME_COUNTS,
  type BranchMap,
  type SimRowResult,
  type SimSnapshotRow,
  type Smi5879SimulateFullReport,
} from '../../indexer/smi5879-simulate-full.types.ts'

/** The completed decision-purpose census's real `primary_not_found` count. */
const CENSUS_POPULATION = 23_597
/** Per-stratum alpha at the ratified defaults with H = 2. */
const ALPHA = 0.025

/** The plan's three tested stratum splits of the census population. */
const CENSUS_SPLITS: ReadonlyArray<readonly [number, number]> = [
  [11_799, 11_798],
  [15_000, 8_597],
  [7_538, 16_059],
]

function strata(embeddedRef: number, defaultBranch: number): StratumPopulation[] {
  return [
    { stratumKey: 'embedded_ref', populationCount: embeddedRef },
    { stratumKey: 'default_branch', populationCount: defaultBranch },
  ]
}

/**
 * The plan's allocation formula, reimplemented here so the sizing search's
 * minimality can be checked against an independent expression of the rule
 * rather than against the search's own internals.
 */
function allocate(overall: number, sizes: readonly number[], floors: readonly number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  return sizes.map((populationCount, index) => {
    const floor = floors[index] ?? 1
    const proportional = Math.ceil((overall * populationCount) / total)
    return Math.min(populationCount, Math.max(proportional, Math.min(populationCount, floor)))
  })
}

/** Both acceptance arms, evaluated directly from the bound function. */
function armsPass(
  populations: readonly number[],
  sampleSizes: readonly number[],
  badDraws: readonly number[]
): { population: boolean; stratum: boolean; totalUpperBound: number } {
  const total = populations.reduce((sum, size) => sum + size, 0)
  let totalUpperBound = 0
  let stratum = true
  populations.forEach((populationCount, index) => {
    const upperBound = hypergeometricUpperBoundCount({
      populationCount,
      sampleSize: sampleSizes[index] ?? 0,
      badDraws: badDraws[index] ?? 0,
      alpha: ALPHA,
    })
    if (upperBound * 10000 > DEFAULT_SAMPLING_POLICY.stratumThresholdBp * populationCount) {
      stratum = false
    }
    totalUpperBound += upperBound
  })
  return {
    population: totalUpperBound * 10000 <= DEFAULT_SAMPLING_POLICY.mismatchThresholdBp * total,
    stratum,
    totalUpperBound,
  }
}

describe('SMI-6444 Item 5 — stratified exact-hypergeometric sampling design', () => {
  // -------------------------------------------------------------------------
  describe('exact one-sided hypergeometric upper bound', () => {
    it('satisfies its own definition: M_u qualifies and M_u + 1 does not', () => {
      // Self-verifying: independent of any pinned reference value.
      for (const [populationCount, sampleSize, badDraws] of [
        [100, 40, 1],
        [500, 51, 1],
        [11_799, 274, 1],
        [11_798, 273, 0],
        [11_799, 274, 2],
      ] as const) {
        const upperBound = hypergeometricUpperBoundCount({
          populationCount,
          sampleSize,
          badDraws,
          alpha: ALPHA,
        })
        expect(
          hypergeometricCdfAtMost(populationCount, upperBound, sampleSize, badDraws)
        ).toBeGreaterThanOrEqual(ALPHA)
        expect(
          hypergeometricCdfAtMost(populationCount, upperBound + 1, sampleSize, badDraws)
        ).toBeLessThan(ALPHA)
      }
    })

    it('matches reference values across the fixture table', () => {
      // Cross-checked against an exact BigInt rational evaluation of the same
      // probabilities; both implementations agreed on every row.
      const table: ReadonlyArray<readonly [number, number, number, number]> = [
        // [N, n, k', M_u]
        [100, 40, 1, 10],
        [200, 46, 1, 20],
        [500, 51, 1, 50],
        [2_000, 53, 1, 199],
        [10_000, 54, 1, 987],
        [11_799, 274, 1, 235],
        [11_798, 273, 1, 236],
        [11_799, 274, 2, 305],
        [11_798, 273, 0, 156],
        [23_597, 550, 1, 235],
        [23_497, 280, 0, 305],
      ]
      for (const [populationCount, sampleSize, badDraws, expected] of table) {
        expect(
          hypergeometricUpperBoundCount({ populationCount, sampleSize, badDraws, alpha: ALPHA })
        ).toBe(expected)
      }
    })

    it('degenerates to the exact observed count when n === N', () => {
      for (const [populationCount, badDraws] of [
        [100, 1],
        [50, 0],
        [10, 1],
        [200, 200],
        [23_597, 3],
      ] as const) {
        expect(
          hypergeometricUpperBoundCount({
            populationCount,
            sampleSize: populationCount,
            badDraws,
            alpha: ALPHA,
          })
        ).toBe(badDraws)
      }
    })

    it('is non-increasing in n and non-decreasing in k prime', () => {
      const bySampleSize = [200, 250, 274, 300, 400].map((sampleSize) =>
        hypergeometricUpperBoundCount({
          populationCount: 11_799,
          sampleSize,
          badDraws: 1,
          alpha: ALPHA,
        })
      )
      expect(bySampleSize).toEqual([322, 258, 235, 215, 161])
      const byBadDraws = [0, 1, 2, 3].map((badDraws) =>
        hypergeometricUpperBoundCount({
          populationCount: 11_799,
          sampleSize: 274,
          badDraws,
          alpha: ALPHA,
        })
      )
      expect(byBadDraws).toEqual([155, 235, 305, 370])
    })

    it('rejects out-of-domain inputs rather than returning a plausible number', () => {
      expect(() =>
        hypergeometricUpperBoundCount({
          populationCount: 100,
          sampleSize: 101,
          badDraws: 1,
          alpha: ALPHA,
        })
      ).toThrow(/sampleSize must be an integer/)
      expect(() =>
        hypergeometricUpperBoundCount({
          populationCount: 100,
          sampleSize: 10,
          badDraws: 11,
          alpha: ALPHA,
        })
      ).toThrow(/badDraws must be an integer/)
      expect(() =>
        hypergeometricUpperBoundCount({
          populationCount: 100,
          sampleSize: 10,
          badDraws: 1,
          alpha: 0,
        })
      ).toThrow(/alpha must be in/)
    })

    it('rounds the reported basis-point rate up, never down', () => {
      // 235/11799 = 199.17bp -> 200bp; understating it would advertise a rate
      // the data does not support.
      expect(upperBoundCountToBp(235, 11_799)).toBe(200)
      expect(upperBoundCountToBp(1, 10)).toBe(1000)
      expect(upperBoundCountToBp(0, 10)).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  describe('per-stratum floor', () => {
    it('reproduces the plan-pinned floors 40/46/51/53/54', () => {
      const floors = [100, 200, 500, 2_000, 10_000].map((populationCount) =>
        computeStratumFloor({
          populationCount,
          stratumThresholdBp: DEFAULT_SAMPLING_POLICY.stratumThresholdBp,
          alpha: ALPHA,
        })
      )
      expect(floors).toEqual([40, 46, 51, 53, 54])
    })

    it('never exceeds the Poisson floor anchor of 56', () => {
      for (const populationCount of [100, 500, 2_000, 10_000, 11_799, CENSUS_POPULATION]) {
        const floor = computeStratumFloor({
          populationCount,
          stratumThresholdBp: DEFAULT_SAMPLING_POLICY.stratumThresholdBp,
          alpha: ALPHA,
        })
        expect(floor).not.toBeNull()
        expect(floor).toBeLessThanOrEqual(POISSON_ANCHORS.stratumFloor)
      }
    })

    it('is the true minimum: the floor clears the threshold and floor - 1 does not', () => {
      for (const populationCount of [100, 200, 500, 2_000, 10_000]) {
        const floor = computeStratumFloor({
          populationCount,
          stratumThresholdBp: DEFAULT_SAMPLING_POLICY.stratumThresholdBp,
          alpha: ALPHA,
        })
        expect(floor).not.toBeNull()
        const atFloor = hypergeometricUpperBoundCount({
          populationCount,
          sampleSize: floor ?? 1,
          badDraws: 1,
          alpha: ALPHA,
        })
        const belowFloor = hypergeometricUpperBoundCount({
          populationCount,
          sampleSize: (floor ?? 2) - 1,
          badDraws: 1,
          alpha: ALPHA,
        })
        expect(atFloor * 10000).toBeLessThanOrEqual(1000 * populationCount)
        expect(belowFloor * 10000).toBeGreaterThan(1000 * populationCount)
      }
    })

    it('forces a full census on a small-but-feasible stratum', () => {
      // At N <= 18 the floor is the population itself: nothing short of a
      // census clears 10% at one bad draw.
      for (const populationCount of [10, 12, 18]) {
        expect(
          computeStratumFloor({ populationCount, stratumThresholdBp: 1000, alpha: ALPHA })
        ).toBe(populationCount)
      }
      expect(
        computeStratumFloor({ populationCount: 20, stratumThresholdBp: 1000, alpha: ALPHA })
      ).toBe(18)
    })

    it('returns null for a stratum no sample size can rescue', () => {
      expect(
        computeStratumFloor({ populationCount: 9, stratumThresholdBp: 1000, alpha: ALPHA })
      ).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  describe('stratum feasibility classification', () => {
    it('omits empty strata, routes sub-threshold strata to manual review', () => {
      expect(classifyStratum(0)).toBe('empty')
      expect(classifyStratum(1)).toBe('infeasible')
      expect(classifyStratum(9)).toBe('infeasible')
      expect(classifyStratum(10)).toBe('feasible')
      expect(classifyStratum(CENSUS_POPULATION)).toBe('feasible')
    })

    it('tracks the design point rather than hard-coding N < 10', () => {
      const policy = { ...DEFAULT_SAMPLING_POLICY, designPointBadDrawsPerStratum: 2 }
      expect(classifyStratum(19, policy)).toBe('infeasible')
      expect(classifyStratum(20, policy)).toBe('feasible')
    })
  })

  // -------------------------------------------------------------------------
  describe('joint sizing search', () => {
    it.each([
      // [embedded_ref, default_branch, expected minimum n]
      // PLAN DIVERGENCE: the plan pins 550 for all three splits. 550 is the
      // smaller of the two decade-grid points it tested (540 fails, 550
      // passes); the true minimum is lower. See this file's header.
      [11_799, 11_798, 546],
      [15_000, 8_597, 545],
      [7_538, 16_059, 545],
    ])('finds the true minimum n for the %i/%i split', (first, second, expected) => {
      const result = computeJointSampleSizing(strata(first, second))
      expect(result.overallSampleSize).toBe(expected)
      expect(result.populationCount).toBe(CENSUS_POPULATION)
      expect(result.strata.map((s) => s.floor)).toEqual([54, 54])
    })

    it.each(CENSUS_SPLITS)(
      'is minimal for the %i/%i split: n passes both arms and n - 1 does not',
      (first, second) => {
        const result = computeJointSampleSizing(strata(first, second))
        const populations = [first, second]
        const floors = result.strata.map((s) => s.floor)
        const at = armsPass(
          populations,
          allocate(result.overallSampleSize, populations, floors),
          [1, 1]
        )
        const below = armsPass(
          populations,
          allocate(result.overallSampleSize - 1, populations, floors),
          [1, 1]
        )
        expect(at.population && at.stratum).toBe(true)
        expect(below.population && below.stratum).toBe(false)
      }
    )

    it('lands at or below the Poisson anchor of 558', () => {
      for (const [first, second] of CENSUS_SPLITS) {
        expect(
          computeJointSampleSizing(strata(first, second)).overallSampleSize
        ).toBeLessThanOrEqual(POISSON_ANCHORS.overallSampleSize)
      }
    })

    it("reproduces the plan's own two evidence points at the equal split", () => {
      // The plan states n=540 fails at ~2.02% and n=550 passes at ~1.98%.
      // Both reproduce exactly, which is what establishes that the bound
      // itself agrees and only the search granularity differed.
      const populations = [11_799, 11_798]
      const at540 = armsPass(populations, allocate(540, populations, [54, 54]), [1, 1])
      const at550 = armsPass(populations, allocate(550, populations, [54, 54]), [1, 1])
      expect(at540.population).toBe(false)
      expect((at540.totalUpperBound / CENSUS_POPULATION) * 100).toBeCloseTo(2.021, 3)
      expect(at550.population).toBe(true)
      expect((at550.totalUpperBound / CENSUS_POPULATION) * 100).toBeCloseTo(1.979, 3)
    })

    it('omits an empty stratum silently, with no divide-by-zero', () => {
      const result = computeJointSampleSizing([
        { stratumKey: 'embedded_ref', populationCount: 11_799 },
        { stratumKey: 'default_branch', populationCount: 11_798 },
        { stratumKey: 'never_populated', populationCount: 0 },
      ])
      expect(result.emptyStrataKeys).toEqual(['never_populated'])
      expect(result.perStratumAlpha).toBe(ALPHA)
      expect(result.overallSampleSize).toBe(546)
      expect(Number.isFinite(result.populationUpperBoundBp)).toBe(true)
    })

    it('excludes an infeasible stratum and reports it for manual routing', () => {
      const result = computeJointSampleSizing([
        { stratumKey: 'embedded_ref', populationCount: 9 },
        { stratumKey: 'default_branch', populationCount: 5_000 },
      ])
      expect(result.infeasibleStrata).toEqual([{ stratumKey: 'embedded_ref', populationCount: 9 }])
      expect(result.strata.map((s) => s.stratumKey)).toEqual(['default_branch'])
      expect(result.populationCount).toBe(5_000)
      // Confidence is claimed about one stratum now, so H = 1.
      expect(result.perStratumAlpha).toBe(0.05)
    })

    it('handles a census-forcing feasible stratum beside a sampled one', () => {
      const result = computeJointSampleSizing([
        { stratumKey: 'embedded_ref', populationCount: 12 },
        { stratumKey: 'default_branch', populationCount: 5_000 },
      ])
      const [tiny, big] = result.strata
      expect(tiny?.sampleSize).toBe(12)
      expect(tiny?.populationCount).toBe(12)
      expect(tiny?.floor).toBe(12)
      expect(tiny?.upperBoundCount).toBe(1)
      expect(big?.sampleSize).toBeGreaterThan(big?.floor ?? 0)
      expect(result.infeasibleStrata).toEqual([])
      expect(result.totalSelectedCount).toBe((tiny?.sampleSize ?? 0) + (big?.sampleSize ?? 0))
    })

    it('refuses when no stratum is feasible', () => {
      expect(() =>
        computeJointSampleSizing([
          { stratumKey: 'embedded_ref', populationCount: 5 },
          { stratumKey: 'default_branch', populationCount: 0 },
        ])
      ).toThrow(/no feasible stratum/)
    })

    it('refuses when even a full census cannot clear the population arm', () => {
      // Per-stratum feasibility does not imply population feasibility: a
      // census bottoms the population bound out at H * designPoint / N, which
      // is 334bp for two strata over 60 rows.
      expect(() => computeJointSampleSizing(strata(30, 30))).toThrow(
        /cannot clear the 200bp population arm even at a full census/
      )
    })
  })

  // -------------------------------------------------------------------------
  describe('acceptance evaluation', () => {
    const equalSplitSizing = computeJointSampleSizing(strata(11_799, 11_798))
    const sampleSizes = equalSplitSizing.strata.map((s) => s.sampleSize)

    function observe(
      bad: readonly [number, number],
      unavailable: readonly [number, number] = [0, 0]
    ) {
      return evaluateAcceptance([
        {
          stratumKey: 'embedded_ref',
          populationCount: 11_799,
          selectedCount: sampleSizes[0] ?? 0,
          mismatchedCount: bad[0],
          unavailableCount: unavailable[0],
        },
        {
          stratumKey: 'default_branch',
          populationCount: 11_798,
          selectedCount: sampleSizes[1] ?? 0,
          mismatchedCount: bad[1],
          unavailableCount: unavailable[1],
        },
      ])
    }

    it('accepts exactly one bad draw in every stratum at the computed n', () => {
      const result = observe([1, 1])
      expect(result.accepted).toBe(true)
      expect(result.populationArmPass).toBe(true)
      expect(result.stratumArmPass).toBe(true)
      expect(result.populationUpperBoundBp).toBe(200)
      expect(result.failures).toEqual([])
    })

    it('still accepts two bad draws concentrated in one stratum', () => {
      // PLAN DIVERGENCE: the plan's Round-5 fixture asserts this FAILS at
      // least one arm. It does not, at any n from 546 to 558. Concentration
      // loosens the population arm (196bp vs 200bp for the spread case),
      // because the emptied stratum's bound falls further than the loaded
      // stratum's rises; the stratum arm has ~5x headroom at 259bp vs 1000bp.
      for (const scenario of [
        [2, 0],
        [0, 2],
      ] as const) {
        const result = observe(scenario)
        expect(result.accepted).toBe(true)
        expect(result.populationUpperBoundBp).toBe(196)
      }
    })

    it('refuses one bad draw beyond the design-point total', () => {
      // This is the neighbouring claim that does hold: (2,1) is one more bad
      // draw than the design point sizes for, and it fails the population arm.
      const result = observe([2, 1])
      expect(result.accepted).toBe(false)
      expect(result.populationArmPass).toBe(false)
      expect(result.stratumArmPass).toBe(true)
      expect(result.populationUpperBoundBp).toBe(230)
      expect(result.failures).toEqual(['population arm: bound 230bp exceeds 200bp'])
    })

    it('prices an unavailable row identically to a mismatched one', () => {
      expect(observe([1, 0]).populationUpperBoundBp).toBe(
        observe([0, 0], [1, 0]).populationUpperBoundBp
      )
      expect(observe([1, 1]).populationUpperBoundBp).toBe(
        observe([1, 0], [0, 1]).populationUpperBoundBp
      )
      expect(observe([0, 0], [1, 1]).strata.map((s) => s.badDraws)).toEqual([1, 1])
    })

    it('lowers the bound when a resumed retry converts unavailable to verified', () => {
      const beforeRetry = observe([0, 0], [1, 0]).populationUpperBoundBp
      const afterRetry = observe([0, 0], [0, 0]).populationUpperBoundBp
      expect(afterRetry).toBeLessThan(beforeRetry)
      expect(beforeRetry).toBe(166)
      expect(afterRetry).toBe(132)
    })

    it('catches a wholesale-broken narrow stratum the population arm alone would miss', () => {
      // The motivating case for arm (b): 100 rows at an 11% bound is 1100bp
      // per-stratum but barely moves a 23,597-row population average.
      const result = evaluateAcceptance([
        {
          stratumKey: 'embedded_ref',
          populationCount: 100,
          selectedCount: 100,
          mismatchedCount: 11,
          unavailableCount: 0,
        },
        {
          stratumKey: 'default_branch',
          populationCount: 23_497,
          selectedCount: 280,
          mismatchedCount: 0,
          unavailableCount: 0,
        },
      ])
      expect(result.populationArmPass).toBe(true)
      expect(result.populationUpperBoundBp).toBe(134)
      expect(result.stratumArmPass).toBe(false)
      expect(result.accepted).toBe(false)
      expect(result.failures).toEqual([
        "stratum embedded_ref: bound 1100bp exceeds 1000bp (k'=11 of n=100, N=100)",
      ])
    })

    it('shares its bound function with the sizing search', () => {
      // Sizing and acceptance must never structurally disagree: acceptance at
      // the design point must reproduce the sizing result's own bounds.
      const accepted = observe([1, 1])
      expect(accepted.strata.map((s) => s.upperBoundCount)).toEqual(
        equalSplitSizing.strata.map((s) => s.upperBoundCount)
      )
      expect(accepted.populationUpperBoundBp).toBe(equalSplitSizing.populationUpperBoundBp)
    })
  })

  // -------------------------------------------------------------------------
  describe('stratification key', () => {
    it('splits on embedded-ref presence, not reason text or cohort', () => {
      expect(stratumKeyForRow('https://github.com/o/r/tree/main/skills/x', null)).toBe(
        'embedded_ref'
      )
      expect(stratumKeyForRow('https://github.com/o/r/tree/v1.2.3', null)).toBe('embedded_ref')
      expect(stratumKeyForRow('https://github.com/o/r', 'skills/x')).toBe('default_branch')
      expect(stratumKeyForRow('https://github.com/o/r', null)).toBe('default_branch')
    })

    it('returns null for a row whose URL does not parse, rather than defaulting', () => {
      expect(stratumKeyForRow('https://gitlab.com/o/r', null)).toBeNull()
      expect(stratumKeyForRow(null, null)).toBeNull()
      expect(stratumKeyForRow('https://github.com/o', null)).toBeNull()
      expect(stratumKeyForRow('https://github.com/o/r/tree/main/../x', null)).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  describe('deterministic seeded selection', () => {
    const candidates = Array.from(
      { length: 40 },
      (_, index) => `owner/skill-${String(index).padStart(2, '0')}`
    )

    it('re-derives byte-identically from the same seed and candidate set', () => {
      const first = selectStratumSample({
        candidateIds: candidates,
        sampleSize: 8,
        seed: 'seed-1',
        stratumKey: 'embedded_ref',
      })
      const rederived = selectStratumSample({
        candidateIds: candidates,
        sampleSize: 8,
        seed: 'seed-1',
        stratumKey: 'embedded_ref',
      })
      expect(rederived).toEqual(first)
      // Pinned so a change to the PRNG or shuffle cannot pass silently: a
      // resumed run compares its re-derivation against the persisted list.
      expect(first).toEqual([
        'owner/skill-02',
        'owner/skill-17',
        'owner/skill-20',
        'owner/skill-21',
        'owner/skill-22',
        'owner/skill-23',
        'owner/skill-25',
        'owner/skill-38',
      ])
    })

    it('is invariant to the caller candidate ordering', () => {
      const forward = selectStratumSample({
        candidateIds: candidates,
        sampleSize: 8,
        seed: 'seed-1',
        stratumKey: 'embedded_ref',
      })
      const reversed = selectStratumSample({
        candidateIds: [...candidates].reverse(),
        sampleSize: 8,
        seed: 'seed-1',
        stratumKey: 'embedded_ref',
      })
      expect(reversed).toEqual(forward)
    })

    it('draws differently for a different seed and for a different stratum', () => {
      const base = selectStratumSample({
        candidateIds: candidates,
        sampleSize: 8,
        seed: 'seed-1',
        stratumKey: 'embedded_ref',
      })
      const otherSeed = selectStratumSample({
        candidateIds: candidates,
        sampleSize: 8,
        seed: 'seed-2',
        stratumKey: 'embedded_ref',
      })
      const otherStratum = selectStratumSample({
        candidateIds: candidates,
        sampleSize: 8,
        seed: 'seed-1',
        stratumKey: 'default_branch',
      })
      expect(otherSeed).not.toEqual(base)
      expect(otherStratum).not.toEqual(base)
    })

    it('returns a sorted, duplicate-free subset of the right size', () => {
      const drawn = selectStratumSample({
        candidateIds: candidates,
        sampleSize: 13,
        seed: 'seed-3',
        stratumKey: 'embedded_ref',
      })
      expect(drawn).toHaveLength(13)
      expect(new Set(drawn).size).toBe(13)
      expect([...drawn].sort()).toEqual(drawn)
      for (const id of drawn) expect(candidates).toContain(id)
    })

    it('returns the whole stratum for a full census', () => {
      const drawn = selectStratumSample({
        candidateIds: candidates,
        sampleSize: candidates.length,
        seed: 'seed-4',
        stratumKey: 'embedded_ref',
      })
      expect([...drawn].sort()).toEqual([...candidates].sort())
    })

    it('refuses an oversized draw or a duplicated candidate', () => {
      expect(() =>
        selectStratumSample({
          candidateIds: candidates,
          sampleSize: candidates.length + 1,
          seed: 's',
          stratumKey: 'embedded_ref',
        })
      ).toThrow(/exceeds 40 candidates/)
      expect(() =>
        selectStratumSample({
          candidateIds: ['a/b', 'a/b', 'c/d'],
          sampleSize: 2,
          seed: 's',
          stratumKey: 'embedded_ref',
        })
      ).toThrow(/duplicate candidate id/)
    })

    it('spreads draws across the candidate space', () => {
      // A stuck or degenerate PRNG would keep returning the same handful of
      // ids. 40 seeds x 4 draws over 40 candidates leaves ~0.6 candidates
      // untouched in expectation, so 35 is a wide margin below the honest
      // outcome (39 here) and far above a broken generator's ~4. Deterministic
      // inputs, so this cannot flake.
      const seen = new Set<string>()
      for (let seed = 0; seed < 40; seed++) {
        for (const id of selectStratumSample({
          candidateIds: candidates,
          sampleSize: 4,
          seed: `seed-${seed}`,
          stratumKey: 'embedded_ref',
        })) {
          seen.add(id)
        }
      }
      expect(seen.size).toBeGreaterThanOrEqual(35)
    })
  })

  // -------------------------------------------------------------------------
  describe('policy and the binomial fallback', () => {
    it('splits alpha across the strata a claim is made about', () => {
      expect(perStratumAlpha(95, 2)).toBe(0.025)
      expect(perStratumAlpha(95, 1)).toBe(0.05)
      expect(perStratumAlpha(99, 2)).toBeCloseTo(0.005, 12)
      expect(() => perStratumAlpha(100, 2)).toThrow(/confidencePct/)
      expect(() => perStratumAlpha(95, 0)).toThrow(/nonEmptyStrataCount/)
    })

    it('keeps the ratified defaults as integers', () => {
      expect(DEFAULT_SAMPLING_POLICY).toEqual({
        confidencePct: 95,
        mismatchThresholdBp: 200,
        stratumThresholdBp: 1000,
        designPointBadDrawsPerStratum: 1,
      })
      for (const value of Object.values(DEFAULT_SAMPLING_POLICY)) {
        expect(Number.isInteger(value)).toBe(true)
      }
    })

    it('is never tighter than the binomial fallback, which is never tighter than Poisson', () => {
      const sampleSize = 274
      const hypergeometric =
        hypergeometricUpperBoundCount({
          populationCount: 11_799,
          sampleSize,
          badDraws: 1,
          alpha: ALPHA,
        }) / 11_799
      const binomial = binomialUpperBoundRate(sampleSize, 1, ALPHA)
      const poisson = 5.5716 / sampleSize
      expect(hypergeometric).toBeLessThanOrEqual(binomial)
      expect(binomial).toBeLessThanOrEqual(poisson)
    })

    it('places the equal-split binomial boundary at n_h = 277, not 278', () => {
      // PLAN DIVERGENCE: the plan pins "equal-split binomial minimum n=556",
      // which implies n_h = 278. The Clopper-Pearson bound already clears
      // 200bp at 277, putting the equal-split minimum at 552 (ceil
      // allocation) / 553 (round) / 554 (floor). See this file's header.
      expect(binomialUpperBoundRate(276, 1, ALPHA) * 10000).toBeCloseTo(200.207, 3)
      expect(binomialUpperBoundRate(277, 1, ALPHA) * 10000).toBeCloseTo(199.49, 3)
      expect(binomialUpperBoundRate(278, 1, ALPHA) * 10000).toBeCloseTo(198.779, 3)
    })
  })
})

// ===========================================================================
// SMI-6444 Items 4/7/8 — locked ledger mutation core, `.sample.json` sidecar,
// tool provenance. Everything below is appended alongside (never inside) the
// statistical describe above.
// ===========================================================================

const RUN_ID = 'run-smi6444-test'
const NOW = '2026-09-08T12:00:00.000Z'
const POPULATION_IDS = [
  'p001',
  'p002',
  'p003',
  'p004',
  'p005',
  'p006',
  'p007',
  'p008',
  'p009',
  'p010',
]

let workDir = ''

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'smi6444-ledger-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function stagedDraft(overrides: Partial<StagedBatchDraft> = {}): StagedBatchDraft {
  return {
    schema_version: 1,
    batch_id: 'batch-1',
    outcome_class: 'primary_not_found',
    run_id: RUN_ID,
    tool_commit: 'a'.repeat(40),
    tool_source_digest: 'b'.repeat(64),
    population_count: 10,
    population_cohort_counts: { C4: 10 },
    confidence_pct: 95,
    mismatch_threshold_bp: 200,
    stratum_threshold_bp: 1000,
    design_point_bad_draws_per_stratum: 1,
    allocation: 'proportional',
    sampling_seed: 'seed-1',
    strata: [
      {
        stratum_key: 'default_branch',
        population_count: 4,
        selected_ids: ['p007', 'p008'],
        unavailable_ids: [],
        mismatched_ids: [],
        verified_count: 2,
        upper_bound_bp: 400,
      },
      {
        stratum_key: 'embedded_ref',
        population_count: 6,
        selected_ids: ['p001', 'p002', 'p003'],
        unavailable_ids: [],
        mismatched_ids: ['p003'],
        verified_count: 2,
        upper_bound_bp: 500,
      },
    ],
    verified_count: 4,
    observed_population_upper_bound_bp: 180,
    verified_at: '2026-09-08T11:00:00.000Z',
    ...overrides,
  }
}

function newLedgerFile(name = 'dispositions.json'): string {
  const ledgerPath = join(workDir, name)
  writeFileSync(ledgerPath, serializeLedger({ run_id: RUN_ID, entries: [] }), 'utf8')
  return ledgerPath
}

function readLedgerFile(ledgerPath: string): Smi5879DispositionLedger {
  const parsed = validateDispositionLedgerShape(JSON.parse(readFileSync(ledgerPath, 'utf8')))
  if (!parsed.ok) throw new Error(`fixture ledger failed shape validation: ${parsed.reason}`)
  return parsed.value
}

/** Hand-edit the ledger file the way an operator bypassing every subcommand
 *  would — the residual this design names as not closable by any filesystem
 *  primitive (plan Item 8). */
function handEditLedger(ledgerPath: string, edit: (raw: Record<string, unknown>) => void): void {
  const raw = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<string, unknown>
  edit(raw)
  writeFileSync(ledgerPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
}

function expectOk<T>(
  result: LedgerCommandResult<T>
): Extract<LedgerCommandResult<T>, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.reason}`)
  return result
}

function expectRefusal<T>(
  result: LedgerCommandResult<T>
): Extract<LedgerCommandResult<T>, { ok: false }> {
  if (result.ok) throw new Error('expected a refusal, got success')
  return result
}

function stageFixture(
  ledgerPath: string,
  overrides: Partial<StagedBatchDraft> = {},
  reason = 'Sampled re-check, both arms passed.'
): { batchId: string; confirmationCode: string; entryIds: string[]; skippedIds: string[] } {
  const result = expectOk(
    stageDispositionBatch({
      ledgerPath,
      params: {
        draft: stagedDraft(overrides),
        populationIds: POPULATION_IDS,
        reason,
        operator: 'operator@example.test',
        now: NOW,
      },
    })
  )
  return {
    batchId: result.result.batch.batch_id,
    confirmationCode: result.result.confirmationCode,
    entryIds: result.result.entryIds,
    skippedIds: result.result.skippedIds,
  }
}

function signFixture(ledgerPath: string, batchId: string, confirmCode: string): void {
  expectOk(
    signOffDispositionBatch({
      ledgerPath,
      params: { batchId, operator: 'signer@example.test', confirmCode, now: NOW },
    })
  )
}

function signOffResult(result: LedgerCommandResult<SignOffResult>): SignOffResult {
  return expectOk(result).result
}

/** Records the exact I/O ordering so a test can assert the lock spans the
 *  WHOLE read-mutate-write sequence, not just part of it. */
function instrument(ledgerPath: string, events: string[]): Partial<FileIoDeps> {
  const label = (path: string): string => (path === ledgerPath ? 'ledger' : 'temp')
  return {
    acquireLock: (_target, opts) => {
      events.push(`acquire:${opts.label}`)
      return () => events.push('release')
    },
    fileExists: (path) => {
      events.push(`exists:${label(path)}`)
      return existsSync(path)
    },
    readFile: (path) => {
      events.push(`read:${label(path)}`)
      return readFileSync(path, 'utf8')
    },
    writeFile: (path, data) => {
      events.push(`write:${label(path)}`)
      writeFileSync(path, data, 'utf8')
    },
    rename: (from, to) => {
      events.push('rename')
      renameSync(from, to)
    },
    removeFile: (path) => {
      events.push(`remove:${label(path)}`)
      rmSync(path, { force: true })
    },
  }
}

describe('SMI-6444 Item 8 — the locked five-step ledger write protocol', () => {
  it('runs every mutating subcommand inside one lock spanning read → mutate → write → rename', () => {
    const cases: Array<{
      name: string
      build: () => {
        ledgerPath: string
        run: (deps: Partial<FileIoDeps>) => LedgerCommandResult<unknown>
      }
    }> = [
      {
        name: 'add-manual',
        build: () => {
          const ledgerPath = newLedgerFile('add-manual.json')
          return {
            ledgerPath,
            run: (deps) =>
              addManualEntry({
                ledgerPath,
                deps,
                params: {
                  id: 'm001',
                  verdict: 'exclude',
                  reason: 'Known-dead upstream.',
                  operator: 'op',
                  now: NOW,
                },
              }),
          }
        },
      },
      {
        name: 'stage',
        build: () => {
          const ledgerPath = newLedgerFile('stage.json')
          return {
            ledgerPath,
            run: (deps) =>
              stageDispositionBatch({
                ledgerPath,
                deps,
                params: {
                  draft: stagedDraft(),
                  populationIds: POPULATION_IDS,
                  reason: 'Sampled re-check.',
                  operator: 'op',
                  now: NOW,
                },
              }),
          }
        },
      },
      {
        name: 'sign-off',
        build: () => {
          const ledgerPath = newLedgerFile('sign-off.json')
          const staged = stageFixture(ledgerPath)
          return {
            ledgerPath,
            run: (deps) =>
              signOffDispositionBatch({
                ledgerPath,
                deps,
                params: {
                  batchId: staged.batchId,
                  operator: 'op',
                  confirmCode: staged.confirmationCode,
                  now: NOW,
                },
              }),
          }
        },
      },
      {
        name: 'revoke-manual',
        build: () => {
          const ledgerPath = newLedgerFile('revoke-manual.json')
          expectOk(
            addManualEntry({
              ledgerPath,
              params: {
                id: 'm001',
                verdict: 'exclude',
                reason: 'Known-dead upstream.',
                operator: 'op',
                now: NOW,
              },
            })
          )
          return {
            ledgerPath,
            run: (deps) =>
              revokeManualEntry({
                ledgerPath,
                deps,
                params: { id: 'm001', reason: 'Recorded in error.', operator: 'op', now: NOW },
              }),
          }
        },
      },
      {
        name: 'revoke-sign-off',
        build: () => {
          const ledgerPath = newLedgerFile('revoke-sign-off.json')
          const staged = stageFixture(ledgerPath)
          signFixture(ledgerPath, staged.batchId, staged.confirmationCode)
          return {
            ledgerPath,
            run: (deps) =>
              revokeBatchSignOff({
                ledgerPath,
                deps,
                params: {
                  batchId: staged.batchId,
                  reason: 'Signed against stale evidence.',
                  operator: 'op',
                  now: NOW,
                },
              }),
          }
        },
      },
      {
        name: 'revoke-batch',
        build: () => {
          const ledgerPath = newLedgerFile('revoke-batch.json')
          const staged = stageFixture(ledgerPath)
          return {
            ledgerPath,
            run: (deps) =>
              revokeDispositionBatch({
                ledgerPath,
                deps,
                params: {
                  batchId: staged.batchId,
                  reason: 'Botched staging.',
                  operator: 'op',
                  now: NOW,
                },
              }),
          }
        },
      },
    ]

    for (const testCase of cases) {
      const { ledgerPath, run } = testCase.build()
      const events: string[] = []
      expectOk(run(instrument(ledgerPath, events)))
      expect(events, testCase.name).toEqual([
        `acquire:${LEDGER_LOCK_LABEL}`,
        'exists:ledger',
        'read:ledger',
        'write:temp',
        'read:temp',
        'read:ledger',
        'rename',
        'release',
      ])
    }
  })

  it('fails a second concurrent invocation with StuckLockError plus one line of added context', () => {
    const ledgerPath = newLedgerFile()
    const holder = acquireOwnedLock(ledgerPath, { label: 'test holder', timeoutMs: 500 })
    try {
      let thrown: unknown
      try {
        addManualEntry({
          ledgerPath,
          timeoutMs: 40,
          params: {
            id: 'm001',
            verdict: 'exclude',
            reason: 'r',
            operator: 'op',
            now: NOW,
          },
        })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(StuckLockError)
      const stuck = thrown as StuckLockError
      // Propagates AS-IS (same class, same lock-file attribution, same manual
      // unstick recipe) with exactly one line of producer context appended.
      expect(stuck.reason).toBe('held')
      expect(stuck.lockPath).toBe(`${ledgerPath}.lock`)
      expect(stuck.message).toContain('Manual unstick')
      expect(stuck.message).toContain(LEDGER_LOCK_CONTEXT_LINE)
      expect(readLedgerFile(ledgerPath).entries).toHaveLength(0)
    } finally {
      holder()
    }
  })

  it('does NOT refuse merely because the temp file differs from the initial read (round-5 wording bug)', () => {
    // The regression this pins: an earlier draft of the protocol compared the
    // MUTATED temp file's digest against the pre-mutation ledger digest, which
    // always differs — every write would have refused. Only a changed
    // DESTINATION file may refuse.
    const ledgerPath = newLedgerFile()
    const initialDigest = sha256(readFileSync(ledgerPath, 'utf8'))
    let tempContent = ''
    const result = expectOk(
      addManualEntry({
        ledgerPath,
        deps: {
          writeFile: (path, data) => {
            if (path !== ledgerPath) tempContent = data
            writeFileSync(path, data, 'utf8')
          },
        },
        params: {
          id: 'm001',
          verdict: 'exclude',
          reason: 'Known-dead upstream.',
          operator: 'op',
          now: NOW,
        },
      })
    )
    expect(sha256(tempContent)).not.toBe(initialDigest)
    expect(result.written).toBe(true)
    expect(readLedgerFile(ledgerPath).entries).toHaveLength(1)
  })

  it('refuses when the DESTINATION file changed since the initial read, under the lock', () => {
    // The hand-editor-bypassed-the-CLI case: the mutate callback stands in for
    // a writer landing an edit inside this invocation's critical section.
    const ledgerPath = newLedgerFile()
    const handEdited: Smi5879DispositionLedger = {
      run_id: RUN_ID,
      entries: [{ id: 'hand', verdict: 'exclude', method: 'manual' }],
    }
    const result = expectRefusal(
      runLockedLedgerMutation({
        ledgerPath,
        mutate: (ledger) => {
          writeFileSync(ledgerPath, serializeLedger(handEdited), 'utf8')
          return addManual(ledger, {
            id: 'm001',
            verdict: 'exclude',
            reason: 'r',
            operator: 'op',
            now: NOW,
          })
        },
      })
    )
    expect(result.code).toBe('ledger_changed')
    expect(result.reason).toContain('re-run it')
    // The hand edit survives untouched — the tool's rename never landed.
    expect(readLedgerFile(ledgerPath).entries).toEqual(handEdited.entries)
  })

  it('refuses and leaves no temp file when the mutated ledger fails its own re-validation', () => {
    const ledgerPath = newLedgerFile()
    const before = readFileSync(ledgerPath, 'utf8')
    const events: string[] = []
    const result = expectRefusal(
      runLockedLedgerMutation({
        ledgerPath,
        deps: instrument(ledgerPath, events),
        mutate: (ledger) => ({
          ok: true,
          write: true,
          ledger: {
            ...ledger,
            entries: [
              { id: 'dup', verdict: 'exclude', method: 'manual' },
              { id: 'dup', verdict: 'exclude', method: 'manual' },
            ],
          },
          result: undefined,
        }),
      })
    )
    expect(result.code).toBe('temp_validation_failed')
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before)
    expect(events).toContain('remove:temp')
    expect(events).not.toContain('rename')
    expect(events[events.length - 1]).toBe('release')
  })

  it('refuses a missing ledger and still releases the lock', () => {
    const events: string[] = []
    const missing = join(workDir, 'nope.json')
    const result = expectRefusal(
      addManualEntry({
        ledgerPath: missing,
        deps: instrument(missing, events),
        params: { id: 'm001', verdict: 'exclude', reason: 'r', operator: 'op', now: NOW },
      })
    )
    expect(result.code).toBe('ledger_not_found')
    expect(events).toEqual([`acquire:${LEDGER_LOCK_LABEL}`, 'exists:ledger', 'release'])
  })

  it('releases the lock even when the mutation throws', () => {
    const ledgerPath = newLedgerFile()
    const events: string[] = []
    expect(() =>
      runLockedLedgerMutation({
        ledgerPath,
        deps: instrument(ledgerPath, events),
        mutate: () => {
          throw new Error('boom')
        },
      })
    ).toThrow('boom')
    expect(events[events.length - 1]).toBe('release')
  })
})

describe('SMI-6444 Item 8 — add-manual and the one-active-entry rule', () => {
  it('writes method:"manual" with auto-filled recorded_by/recorded_at', () => {
    const ledgerPath = newLedgerFile()
    const result = expectOk(
      addManualEntry({
        ledgerPath,
        params: {
          id: 'p042',
          verdict: 'exclude',
          reason: 'Repository deleted upstream.',
          operator: 'operator@example.test',
          now: NOW,
        },
      })
    )
    expect(result.result.entry).toEqual({
      id: 'p042',
      verdict: 'exclude',
      reason: 'Repository deleted upstream.',
      recorded_by: 'operator@example.test',
      recorded_at: NOW,
      method: 'manual',
    })
    const onDisk = readLedgerFile(ledgerPath)
    expect(onDisk.entries).toHaveLength(1)
    expect(validateDispositionLedger(onDisk).byId.get('p042')).toBe('exclude')
  })

  it('refuses a second entry while the first is active, and allows one after revoke-manual', () => {
    const ledgerPath = newLedgerFile()
    const params = {
      id: 'p042',
      verdict: 'exclude' as const,
      reason: 'Repository deleted upstream.',
      operator: 'op',
      now: NOW,
    }
    expectOk(addManualEntry({ ledgerPath, params }))
    const blocked = expectRefusal(addManualEntry({ ledgerPath, params }))
    expect(blocked.code).toBe('active_entry_exists')

    expectOk(
      revokeManualEntry({
        ledgerPath,
        params: { id: 'p042', reason: 'Wrong verdict.', operator: 'op', now: NOW },
      })
    )
    expectOk(addManualEntry({ ledgerPath, params: { ...params, verdict: 'confirm' } }))

    const onDisk = readLedgerFile(ledgerPath)
    // The tombstoned entry is RETAINED — it is the only guaranteed history of
    // the revocation — so the file holds two entries for one id, of which
    // exactly one is active. That is not a conflict.
    expect(onDisk.entries).toHaveLength(2)
    const validation = validateDispositionLedger(onDisk)
    expect(validation.valid).toBe(true)
    expect(validation.byId.get('p042')).toBe('confirm')
  })

  it('still treats two simultaneously ACTIVE entries for one id as a conflict', () => {
    const conflicting: Smi5879DispositionLedger = {
      run_id: RUN_ID,
      entries: [
        { id: 'p042', verdict: 'exclude', method: 'manual' },
        { id: 'p042', verdict: 'exclude', method: 'manual' },
      ],
    }
    const validation = validateDispositionLedger(conflicting)
    expect(validation.valid).toBe(false)
    expect(validation.conflictingIds).toEqual(['p042'])
  })
})

describe('SMI-6444 Item 4 — stage → sign-off round trip', () => {
  it('stages the batch and its bulk entries in one mutation, withholding sampled mismatches', () => {
    const ledgerPath = newLedgerFile()
    const staged = stageFixture(ledgerPath)
    // p003 is a sampled mismatch: withheld from this batch's own entries.
    expect(staged.entryIds).toEqual([
      'p001',
      'p002',
      'p004',
      'p005',
      'p006',
      'p007',
      'p008',
      'p009',
      'p010',
    ])
    const onDisk = readLedgerFile(ledgerPath)
    const batch = (onDisk.batches ?? [])[0]
    expect(batch?.entry_count).toBe(9)
    expect(batch?.entry_ids_digest).toBe(computeEntryIdsDigest(staged.entryIds))
    expect(batch?.stage_digest).toBeTruthy()
    expect(batch?.signed_off_by).toBeUndefined()
    expect(onDisk.entries.every((e) => e.method === 'bulk' && e.verdict === 'exclude')).toBe(true)
    expect(staged.confirmationCode).toBe(confirmationCodeFor(batch?.stage_digest ?? ''))
  })

  it('computes entry_ids_digest with the same convention computeStageDigest recomputes internally', () => {
    // Guards the one duplicated line in this feature: `computeEntryIdsDigest`
    // mirrors a PRIVATE helper inside smi5879-disposition-digest.ts. If the two
    // ever drift, a batch's stored entry_ids_digest would stop matching what
    // gate-check recomputes — and nothing else would notice.
    const ledgerPath = newLedgerFile()
    stageFixture(ledgerPath)
    const batch = (readLedgerFile(ledgerPath).batches ?? [])[0]
    if (batch === undefined) throw new Error('fixture batch missing')
    const ids = ['p010', 'p001', 'p004']
    const excluded = new Set([
      'signed_off_by',
      'signed_off_at',
      'sign_off_digest',
      'stage_digest',
      'revoked',
      'sign_off_revocations',
      'entry_ids_digest',
    ])
    const payload: Record<string, JsonValue> = {}
    for (const [key, value] of Object.entries(batch)) {
      if (!excluded.has(key) && value !== undefined) payload[key] = value as JsonValue
    }
    payload['entry_ids_digest'] = computeEntryIdsDigest(ids)
    const independent = createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex')
    expect(computeStageDigest(batch, ids)).toBe(independent)
  })

  it('refuses a duplicate batch_id and a run_id that does not match the ledger', () => {
    const ledgerPath = newLedgerFile()
    stageFixture(ledgerPath)
    const duplicate = expectRefusal(
      stageDispositionBatch({
        ledgerPath,
        params: {
          draft: stagedDraft(),
          populationIds: [],
          reason: 'r',
          operator: 'op',
          now: NOW,
        },
      })
    )
    expect(duplicate.code).toBe('duplicate_batch_id')

    const wrongRun = expectRefusal(
      stageDispositionBatch({
        ledgerPath,
        params: {
          draft: stagedDraft({ batch_id: 'batch-2', run_id: 'some-other-run' }),
          populationIds: [],
          reason: 'r',
          operator: 'op',
          now: NOW,
        },
      })
    )
    expect(wrongRun.code).toBe('run_id_mismatch')
  })

  it('sign-off without --confirm is display-only and writes nothing', () => {
    const ledgerPath = newLedgerFile()
    const staged = stageFixture(ledgerPath)
    const before = readFileSync(ledgerPath, 'utf8')
    const result = expectOk(
      signOffDispositionBatch({
        ledgerPath,
        params: { batchId: staged.batchId, operator: 'op', now: NOW },
      })
    )
    expect(result.written).toBe(false)
    const preview = result.result
    expect(preview.kind).toBe('preview')
    expect(preview.summary.confirmation_code).toBe(staged.confirmationCode)
    expect(preview.summary.total_mismatched).toBe(1)
    expect(preview.summary.mismatched_ids_preview).toEqual(['p003'])
    expect(preview.summary.already_signed).toBe(false)
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before)
  })

  it('refuses a stale confirmation code and a tampered stage_digest with distinct messages', () => {
    const ledgerPath = newLedgerFile()
    const staged = stageFixture(ledgerPath)

    const wrongCode = expectRefusal(
      signOffDispositionBatch({
        ledgerPath,
        params: {
          batchId: staged.batchId,
          operator: 'op',
          confirmCode: 'deadbeefcafe',
          now: NOW,
        },
      })
    )
    expect(wrongCode.code).toBe('confirmation_code_mismatch')
    expect(wrongCode.reason).toContain('does not match this batch')

    // A hand edit to one of THIS batch's own staged fields: shape stays valid,
    // but the stored digest no longer matches a fresh recomputation.
    handEditLedger(ledgerPath, (raw) => {
      const batches = raw['batches'] as Array<Record<string, unknown>>
      batches[0]['verified_at'] = '2020-01-01T00:00:00.000Z'
    })
    const tampered = expectRefusal(
      signOffDispositionBatch({
        ledgerPath,
        params: {
          batchId: staged.batchId,
          operator: 'op',
          confirmCode: staged.confirmationCode,
          now: NOW,
        },
      })
    )
    expect(tampered.code).toBe('stage_digest_tampered')
    expect(tampered.reason).toContain('changed outside this tool')
    expect(tampered.reason).not.toContain('does not match this batch')
  })

  it('invalidates the code on an edit to THIS batch entries, but not on an edit elsewhere', () => {
    const ledgerPath = newLedgerFile()
    const staged = stageFixture(ledgerPath)

    // An unrelated manual entry: a different part of the ledger entirely.
    expectOk(
      addManualEntry({
        ledgerPath,
        params: {
          id: 'unrelated-999',
          verdict: 'exclude',
          reason: 'Unrelated row.',
          operator: 'op',
          now: NOW,
        },
      })
    )
    const stillValid = signOffResult(
      signOffDispositionBatch({
        ledgerPath,
        params: { batchId: staged.batchId, operator: 'op', now: NOW },
      })
    )
    expect(stillValid.summary.confirmation_code).toBe(staged.confirmationCode)

    // Now change THIS batch's entry membership (consistently, so the shape
    // validator still accepts the file) — the code must change.
    handEditLedger(ledgerPath, (raw) => {
      const entries = raw['entries'] as Array<Record<string, unknown>>
      entries.push({
        id: 'p011',
        verdict: 'exclude',
        method: 'bulk',
        batch_id: staged.batchId,
      })
      const batches = raw['batches'] as Array<Record<string, unknown>>
      batches[0]['entry_count'] = 10
    })
    const changed = signOffResult(
      signOffDispositionBatch({
        ledgerPath,
        params: { batchId: staged.batchId, operator: 'op', now: NOW },
      })
    )
    expect(changed.summary.confirmation_code).not.toBe(staged.confirmationCode)
    expect(changed.summary.stage_digest_matches_stored).toBe(false)
  })

  it('writes the sign-off triple on a matching confirmation code', () => {
    const ledgerPath = newLedgerFile()
    const staged = stageFixture(ledgerPath)
    signFixture(ledgerPath, staged.batchId, staged.confirmationCode)
    const batch = (readLedgerFile(ledgerPath).batches ?? [])[0]
    expect(batch?.signed_off_by).toBe('signer@example.test')
    expect(batch?.signed_off_at).toBe(NOW)
    expect(batch?.sign_off_digest).toBe(batch?.stage_digest)

    const again = expectRefusal(
      signOffDispositionBatch({
        ledgerPath,
        params: {
          batchId: staged.batchId,
          operator: 'op',
          confirmCode: staged.confirmationCode,
          now: NOW,
        },
      })
    )
    expect(again.code).toBe('batch_already_signed')
  })
})

describe('SMI-6444 Item 8 — revocation subcommands', () => {
  it('revoke-manual tombstones the entry (retained) and reverts the row to undisposed', () => {
    const ledgerPath = newLedgerFile()
    expectOk(
      addManualEntry({
        ledgerPath,
        params: { id: 'p042', verdict: 'exclude', reason: 'r', operator: 'op', now: NOW },
      })
    )
    expectOk(
      revokeManualEntry({
        ledgerPath,
        params: {
          id: 'p042',
          reason: 'Recorded against the wrong row.',
          operator: 'rev',
          now: NOW,
        },
      })
    )
    const onDisk = readLedgerFile(ledgerPath)
    expect(onDisk.entries).toHaveLength(1)
    expect(onDisk.entries[0]?.revoked).toEqual({
      revoked_by: 'rev',
      revoked_at: NOW,
      reason: 'Recorded against the wrong row.',
    })
    const validation = validateDispositionLedger(onDisk)
    expect(validation.byId.has('p042')).toBe(false)
    expect(validation.provenanceById.has('p042')).toBe(false)
  })

  it('revoke-manual refuses a nonexistent id, a bulk-covered id, and an already-revoked id', () => {
    const ledgerPath = newLedgerFile()
    const staged = stageFixture(ledgerPath)
    expect(staged.entryIds).toContain('p001')

    expect(
      expectRefusal(
        revokeManualEntry({
          ledgerPath,
          params: { id: 'nope', reason: 'r', operator: 'op', now: NOW },
        })
      ).code
    ).toBe('entry_not_found')

    const bulk = expectRefusal(
      revokeManualEntry({
        ledgerPath,
        params: { id: 'p001', reason: 'r', operator: 'op', now: NOW },
      })
    )
    expect(bulk.code).toBe('entry_is_bulk')
    expect(bulk.reason).toContain('revoke-batch')

    expectOk(
      addManualEntry({
        ledgerPath,
        params: { id: 'm001', verdict: 'exclude', reason: 'r', operator: 'op', now: NOW },
      })
    )
    expectOk(
      revokeManualEntry({
        ledgerPath,
        params: { id: 'm001', reason: 'r', operator: 'op', now: NOW },
      })
    )
    expect(
      expectRefusal(
        revokeManualEntry({
          ledgerPath,
          params: { id: 'm001', reason: 'r', operator: 'op', now: NOW },
        })
      ).code
    ).toBe('entry_already_revoked')
  })

  it('revoke-sign-off reverts to staged-unsigned, archives the prior triple, and re-signs cleanly', () => {
    const ledgerPath = newLedgerFile()
    const staged = stageFixture(ledgerPath)
    signFixture(ledgerPath, staged.batchId, staged.confirmationCode)
    const signedBatch = (readLedgerFile(ledgerPath).batches ?? [])[0]
    const priorDigest = signedBatch?.sign_off_digest
    const stageDigest = signedBatch?.stage_digest

    expectOk(
      revokeBatchSignOff({
        ledgerPath,
        params: {
          batchId: staged.batchId,
          reason: 'Signed against stale evidence.',
          operator: 'rev',
          now: NOW,
        },
      })
    )
    const reverted = (readLedgerFile(ledgerPath).batches ?? [])[0]
    expect(reverted?.signed_off_by).toBeUndefined()
    expect(reverted?.signed_off_at).toBeUndefined()
    expect(reverted?.sign_off_digest).toBeUndefined()
    // stage_digest is deliberately NOT covered by revocation metadata, so the
    // expensive sampling evidence — and the confirmation code — survive.
    expect(reverted?.stage_digest).toBe(stageDigest)
    expect(reverted?.sign_off_revocations).toEqual([
      {
        revoked_by: 'rev',
        revoked_at: NOW,
        reason: 'Signed against stale evidence.',
        prior_signed_off_by: 'signer@example.test',
        prior_signed_off_at: NOW,
        prior_sign_off_digest: priorDigest,
      },
    ])

    const preview = signOffResult(
      signOffDispositionBatch({
        ledgerPath,
        params: { batchId: staged.batchId, operator: 'op', now: NOW },
      })
    )
    expect(preview.summary.confirmation_code).toBe(staged.confirmationCode)
    signFixture(ledgerPath, staged.batchId, staged.confirmationCode)
    expect((readLedgerFile(ledgerPath).batches ?? [])[0]?.signed_off_by).toBe('signer@example.test')
  })

  it('revoke-sign-off refuses an unknown batch, an unsigned batch, and a revoked batch', () => {
    const ledgerPath = newLedgerFile()
    const staged = stageFixture(ledgerPath)
    expect(
      expectRefusal(
        revokeBatchSignOff({
          ledgerPath,
          params: { batchId: 'nope', reason: 'r', operator: 'op', now: NOW },
        })
      ).code
    ).toBe('batch_not_found')
    expect(
      expectRefusal(
        revokeBatchSignOff({
          ledgerPath,
          params: { batchId: staged.batchId, reason: 'r', operator: 'op', now: NOW },
        })
      ).code
    ).toBe('batch_not_signed')

    expectOk(
      revokeDispositionBatch({
        ledgerPath,
        params: { batchId: staged.batchId, reason: 'Botched.', operator: 'op', now: NOW },
      })
    )
    expect(
      expectRefusal(
        revokeBatchSignOff({
          ledgerPath,
          params: { batchId: staged.batchId, reason: 'r', operator: 'op', now: NOW },
        })
      ).code
    ).toBe('batch_revoked')
  })

  it('revoke-batch removes entries, archives a live sign-off, and tombstones the batch', () => {
    const ledgerPath = newLedgerFile()
    const staged = stageFixture(ledgerPath)
    signFixture(ledgerPath, staged.batchId, staged.confirmationCode)

    const result = expectOk(
      revokeDispositionBatch({
        ledgerPath,
        params: {
          batchId: staged.batchId,
          reason: 'Population was wrong.',
          operator: 'rev',
          now: NOW,
        },
      })
    )
    expect(result.result.removedEntryIds).toEqual(staged.entryIds)
    expect(result.result.archivedSignOff?.prior_signed_off_by).toBe('signer@example.test')

    const onDisk = readLedgerFile(ledgerPath)
    expect(onDisk.entries).toHaveLength(0)
    const batch = (onDisk.batches ?? [])[0]
    expect(batch?.revoked?.reason).toBe('Population was wrong.')
    expect(batch?.signed_off_by).toBeUndefined()
    // Frozen from staging and deliberately never re-checked for a revoked
    // batch — its entries are gone by design.
    expect(batch?.entry_count).toBe(9)
    const validation = validateDispositionLedger(onDisk)
    expect(validation.batchById.has(staged.batchId)).toBe(false)

    expect(
      expectRefusal(
        revokeDispositionBatch({
          ledgerPath,
          params: { batchId: staged.batchId, reason: 'r', operator: 'op', now: NOW },
        })
      ).code
    ).toBe('batch_revoked')
    expect(
      expectRefusal(
        revokeDispositionBatch({
          ledgerPath,
          params: { batchId: 'nope', reason: 'r', operator: 'op', now: NOW },
        })
      ).code
    ).toBe('batch_not_found')
  })

  it('rejects the whole ledger when an active entry references a revoked batch', () => {
    const ledgerPath = newLedgerFile()
    const staged = stageFixture(ledgerPath)
    expectOk(
      revokeDispositionBatch({
        ledgerPath,
        params: { batchId: staged.batchId, reason: 'Botched.', operator: 'op', now: NOW },
      })
    )
    handEditLedger(ledgerPath, (raw) => {
      const entries = raw['entries'] as Array<Record<string, unknown>>
      entries.push({ id: 'p001', verdict: 'exclude', method: 'bulk', batch_id: staged.batchId })
    })
    const parsed = validateDispositionLedgerShape(JSON.parse(readFileSync(ledgerPath, 'utf8')))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain('which is revoked')
  })

  it('refuses every revocation without a reason', () => {
    const ledgerPath = newLedgerFile()
    const staged = stageFixture(ledgerPath)
    signFixture(ledgerPath, staged.batchId, staged.confirmationCode)
    expectOk(
      addManualEntry({
        ledgerPath,
        params: { id: 'm001', verdict: 'exclude', reason: 'r', operator: 'op', now: NOW },
      })
    )
    const blank = { reason: '   ', operator: 'op', now: NOW }
    expect(
      expectRefusal(revokeManualEntry({ ledgerPath, params: { id: 'm001', ...blank } })).code
    ).toBe('invalid_input')
    expect(
      expectRefusal(
        revokeBatchSignOff({ ledgerPath, params: { batchId: staged.batchId, ...blank } })
      ).code
    ).toBe('invalid_input')
    expect(
      expectRefusal(
        revokeDispositionBatch({ ledgerPath, params: { batchId: staged.batchId, ...blank } })
      ).code
    ).toBe('invalid_input')
  })

  it('round-trips revoke-batch → add-manual → stage without a provenance conflict', () => {
    const ledgerPath = newLedgerFile()
    const first = stageFixture(ledgerPath)
    signFixture(ledgerPath, first.batchId, first.confirmationCode)
    expectOk(
      revokeDispositionBatch({
        ledgerPath,
        params: { batchId: first.batchId, reason: 'One bad row.', operator: 'op', now: NOW },
      })
    )
    expectOk(
      addManualEntry({
        ledgerPath,
        params: {
          id: 'p005',
          verdict: 'confirm',
          reason: 'Investigated individually.',
          operator: 'op',
          now: NOW,
        },
      })
    )
    const replacement = stageFixture(ledgerPath, { batch_id: 'batch-2' }, 'Corrected re-stage.')
    expect(replacement.skippedIds).toEqual(['p005'])
    expect(replacement.entryIds).not.toContain('p005')

    const onDisk = readLedgerFile(ledgerPath)
    const batch = (onDisk.batches ?? []).find((b) => b.batch_id === 'batch-2')
    expect(batch?.reason).toBe(
      'Corrected re-stage. Skipped 1 population row(s) that already had an active ledger entry.'
    )
    expect(batch?.entry_count).toBe(8)
    const validation = validateDispositionLedger(onDisk)
    expect(validation.valid).toBe(true)
    expect(validation.byId.get('p005')).toBe('confirm')
    expect(validation.provenanceById.get('p001')).toEqual({ method: 'bulk', batch_id: 'batch-2' })
  })
})

// ---------------------------------------------------------------------------
// `.sample.json` sidecar
// ---------------------------------------------------------------------------

const TEST_POLICY: SamplingPolicy = {
  confidencePct: 95,
  mismatchThresholdBp: 5000,
  stratumThresholdBp: 8000,
  designPointBadDrawsPerStratum: 1,
}

function sampleCandidates(): SampleCandidate[] {
  const candidates: SampleCandidate[] = []
  for (let i = 0; i < 12; i += 1) {
    candidates.push({ id: `e${String(i).padStart(3, '0')}`, stratum_key: 'embedded_ref' })
  }
  for (let i = 0; i < 8; i += 1) {
    candidates.push({ id: `d${String(i).padStart(3, '0')}`, stratum_key: 'default_branch' })
  }
  // A stratum too small to satisfy the design point at any sample size, and a
  // row whose URL never parsed: both route to manual review, never into a
  // bulk batch under a weaker guarantee (plan Item 5).
  candidates.push({ id: 'tiny-1', stratum_key: 'tiny' })
  candidates.push({ id: 'unparseable-1', stratum_key: null })
  return candidates
}

function sampleIdentity(overrides: Partial<SampleRunIdentity> = {}): SampleRunIdentity {
  return {
    run_id: RUN_ID,
    outcome_class: 'primary_not_found',
    batch_id: 'batch-sample-1',
    sampling_seed: 'seed-abc',
    policy: TEST_POLICY,
    allocation: 'proportional',
    tool_commit: 'c'.repeat(40),
    tool_source_digest: 'd'.repeat(64),
    ...overrides,
  }
}

function openSample(
  sidecarPath: string,
  overrides: Partial<SampleRunIdentity> = {},
  candidates: SampleCandidate[] = sampleCandidates()
): SampleRunHandle {
  const result = openSampleRun({
    sidecarPath,
    identity: sampleIdentity(overrides),
    candidates,
    clock: () => NOW,
    timeoutMs: 200,
  })
  if (!result.ok) throw new Error(`expected sidecar success, got ${result.code}: ${result.reason}`)
  return result.handle
}

function refuseSample(
  sidecarPath: string,
  overrides: Partial<SampleRunIdentity> = {},
  candidates: SampleCandidate[] = sampleCandidates()
): { code: string; reason: string } {
  const result = openSampleRun({
    sidecarPath,
    identity: sampleIdentity(overrides),
    candidates,
    clock: () => NOW,
    timeoutMs: 200,
  })
  if (result.ok) {
    result.handle.release()
    throw new Error('expected a sidecar refusal, got success')
  }
  return { code: result.code, reason: result.reason }
}

function handEditSidecar(path: string, edit: (raw: Record<string, unknown>) => void): void {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  edit(raw)
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
}

describe('SMI-6444 Item 8 — .sample.json sidecar lock, checkpointing, and resume', () => {
  it('creates a sidecar carrying every sizing input, and routes infeasible rows to manual review', () => {
    const sidecarPath = join(workDir, 'batch-sample-1.sample.json')
    const handle = openSample(sidecarPath)
    try {
      const sidecar = handle.sidecar()
      expect(sidecar.sidecar_kind).toBe('smi5879_disposition_sample')
      expect(sidecar.schema_version).toBe(1)
      expect(sidecar.run_id).toBe(RUN_ID)
      expect(sidecar.outcome_class).toBe('primary_not_found')
      expect(sidecar.batch_id).toBe('batch-sample-1')
      expect(sidecar.sampling_seed).toBe('seed-abc')
      expect(sidecar.confidence_pct).toBe(TEST_POLICY.confidencePct)
      expect(sidecar.mismatch_threshold_bp).toBe(TEST_POLICY.mismatchThresholdBp)
      expect(sidecar.stratum_threshold_bp).toBe(TEST_POLICY.stratumThresholdBp)
      expect(sidecar.design_point_bad_draws_per_stratum).toBe(1)
      expect(sidecar.allocation).toBe('proportional')
      expect(sidecar.tool_commit).toBe('c'.repeat(40))
      expect(sidecar.tool_source_digest).toBe('d'.repeat(64))
      expect(sidecar.created_at).toBe(NOW)
      expect(sidecar.results).toEqual({})
      expect(sidecar.strata.map((s) => s.stratum_key)).toEqual(['default_branch', 'embedded_ref'])
      expect(handle.resumed).toBe(false)
      expect(handle.derived.manual_review_required_ids).toEqual(['tiny-1', 'unparseable-1'])
      expect(sidecar.selected.length).toBeGreaterThan(0)
      expect(existsSync(sidecarPath)).toBe(true)
    } finally {
      handle.release()
    }
  })

  it('rejects a second invocation on the SAME sidecar while a different sidecar proceeds', () => {
    const first = join(workDir, 'batch-a.sample.json')
    const second = join(workDir, 'batch-b.sample.json')
    const handleA = openSample(first)
    try {
      let thrown: unknown
      try {
        openSample(first)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(StuckLockError)
      expect((thrown as StuckLockError).message).toContain(SIDECAR_LOCK_CONTEXT_LINE)

      // A different batch's sidecar is a different lock target entirely.
      const handleB = openSample(second, { batch_id: 'batch-sample-2' })
      handleB.release()
    } finally {
      handleA.release()
    }
  })

  it('re-attempts unavailable and unrecorded rows on resume; verified/mismatched are terminal', () => {
    const sidecarPath = join(workDir, 'resume.sample.json')
    const first = openSample(sidecarPath)
    const selected = first.sidecar().selected.map((row) => row.id)
    expect(selected.length).toBeGreaterThanOrEqual(3)
    const [a, b, c] = selected
    first.recordResult(a, 'verified')
    first.recordResult(b, 'mismatched')
    first.recordResult(c, 'unavailable')
    first.release()

    const resumed = openSample(sidecarPath)
    try {
      expect(resumed.resumed).toBe(true)
      const pending = resumed.pendingIds()
      expect(pending).not.toContain(a)
      expect(pending).not.toContain(b)
      expect(pending).toContain(c)
      expect(pending).toHaveLength(selected.length - 2)

      resumed.recordResult(c, 'verified')
      expect(resumed.pendingIds()).not.toContain(c)
      expect(() => resumed.recordResult(a, 'mismatched')).toThrow(/terminal/)
      expect(() => resumed.recordResult('not-selected', 'verified')).toThrow(/not in this sample/)
    } finally {
      resumed.release()
    }
  })

  it('lowers the recomputed bound when a retry converts an unavailable row to verified', () => {
    const sidecarPath = join(workDir, 'bound.sample.json')
    const handle = openSample(sidecarPath)
    try {
      const selected = handle.sidecar().selected.map((row) => row.id)
      const [held] = selected
      for (const id of selected) handle.recordResult(id, id === held ? 'unavailable' : 'verified')

      const before = evaluateAcceptance(handle.observations(), TEST_POLICY)
      expect(before.strata.some((s) => s.badDraws === 1)).toBe(true)

      handle.recordResult(held, 'verified')
      const after = evaluateAcceptance(handle.observations(), TEST_POLICY)

      expect(after.populationUpperBoundBp).toBeLessThan(before.populationUpperBoundBp)
      expect(after.strata.every((s) => s.badDraws === 0)).toBe(true)
      expect(handle.freeze().total_unavailable).toBe(0)
      expect(handle.freeze().total_verified).toBe(selected.length)
    } finally {
      handle.release()
    }
  })

  it('counts an unrecorded row as unavailable when the sample is frozen at staging time', () => {
    const sidecarPath = join(workDir, 'freeze.sample.json')
    const handle = openSample(sidecarPath)
    try {
      const frozen = handle.freeze()
      expect(frozen.total_verified).toBe(0)
      expect(frozen.total_mismatched).toBe(0)
      expect(frozen.total_unavailable).toBe(frozen.total_selected)
    } finally {
      handle.release()
    }
  })

  it('refuses resume on a mismatched identity, sizing input, candidate set, or tool digest', () => {
    const sidecarPath = join(workDir, 'validate.sample.json')
    openSample(sidecarPath).release()

    const identity = refuseSample(sidecarPath, { run_id: 'a-different-run' })
    expect(identity.code).toBe('identity_mismatch')
    expect(identity.reason).toContain('run_id')
    expect(identity.reason).toContain('Delete')

    const sizing = refuseSample(sidecarPath, {
      policy: { ...TEST_POLICY, designPointBadDrawsPerStratum: 2 },
    })
    expect(sizing.code).toBe('sizing_input_mismatch')
    expect(sizing.reason).toContain('design_point_bad_draws_per_stratum')

    const candidates = sampleCandidates().filter((c) => c.id !== 'unparseable-1')
    const changed = refuseSample(sidecarPath, {}, candidates)
    expect(changed.code).toBe('candidate_set_changed')

    const toolDigest = refuseSample(sidecarPath, { tool_source_digest: 'e'.repeat(64) })
    expect(toolDigest.code).toBe('tool_source_digest_mismatch')
  })

  it('refuses resume when the selection no longer re-derives, or strata counts went stale', () => {
    const sidecarPath = join(workDir, 'derive.sample.json')
    openSample(sidecarPath).release()

    handEditSidecar(sidecarPath, (raw) => {
      const selected = raw['selected'] as Array<Record<string, unknown>>
      selected.pop()
    })
    const selection = refuseSample(sidecarPath)
    expect(selection.code).toBe('selection_mismatch')
    expect(selection.reason).toContain('re-deriving the selection')

    // Restore a valid selection, then corrupt only the stored per-stratum
    // count — the exact "computed under stale parameters" case.
    rmSync(sidecarPath, { force: true })
    openSample(sidecarPath).release()
    handEditSidecar(sidecarPath, (raw) => {
      const strata = raw['strata'] as Array<Record<string, unknown>>
      strata[0]['selected_count'] = 1
    })
    const strataCounts = refuseSample(sidecarPath)
    expect(strataCounts.code).toBe('stratum_count_mismatch')
    expect(strataCounts.reason).toContain('selected_count')
  })

  it('refuses resume on stray result keys, a bad shape, and unreadable JSON', () => {
    const sidecarPath = join(workDir, 'shape.sample.json')
    openSample(sidecarPath).release()
    handEditSidecar(sidecarPath, (raw) => {
      ;(raw['results'] as Record<string, string>)['not-selected'] = 'verified'
    })
    expect(refuseSample(sidecarPath).code).toBe('results_out_of_range')

    writeFileSync(sidecarPath, '{"sidecar_kind":"wrong"}\n', 'utf8')
    expect(refuseSample(sidecarPath).code).toBe('sidecar_invalid_shape')

    writeFileSync(sidecarPath, 'not json at all\n', 'utf8')
    expect(refuseSample(sidecarPath).code).toBe('sidecar_unreadable')
  })

  it('derives an identical selection from the same seed, and a different one from another seed', () => {
    const candidates = sampleCandidates()
    const a = deriveSampleSelection({ candidates, policy: TEST_POLICY, seed: 'seed-abc' })
    const b = deriveSampleSelection({ candidates, policy: TEST_POLICY, seed: 'seed-abc' })
    const c = deriveSampleSelection({ candidates, policy: TEST_POLICY, seed: 'seed-xyz' })
    expect(b.selected).toEqual(a.selected)
    expect(b.candidate_ids_digest).toBe(a.candidate_ids_digest)
    expect(c.selected).not.toEqual(a.selected)
  })

  it('routes every row to manual review when no stratum is feasible at all', () => {
    const derived = deriveSampleSelection({
      candidates: [
        { id: 'x1', stratum_key: 'only' },
        { id: 'x2', stratum_key: null },
      ],
      policy: DEFAULT_SAMPLING_POLICY,
      seed: 'seed-abc',
    })
    expect(derived.selected).toEqual([])
    expect(derived.strata).toEqual([])
    expect(derived.manual_review_required_ids).toEqual(['x1', 'x2'])
  })
})

describe('SMI-6444 Item 7 — tool provenance', () => {
  const gitStub =
    (responses: Record<string, string>): GitRunner =>
    (args) =>
      responses[args[0] ?? ''] ?? ''

  it('resolves tool_commit and rejects anything that is not a 40-hex SHA', () => {
    expect(
      resolveToolCommit({ repoRoot: workDir, git: gitStub({ 'rev-parse': `${'f'.repeat(40)}\n` }) })
    ).toBe('f'.repeat(40))
    expect(() =>
      resolveToolCommit({ repoRoot: workDir, git: gitStub({ 'rev-parse': 'HEAD\n' }) })
    ).toThrow(/unexpected value/)
  })

  it('digests the producer source order-insensitively and changes when any file changes', () => {
    const sources: Record<string, string> = {
      [join(workDir, 'a.ts')]: 'alpha',
      [join(workDir, 'b.ts')]: 'beta',
    }
    const readSource = (path: string): string => sources[path] ?? ''
    const first = computeToolSourceDigest({
      repoRoot: workDir,
      files: ['a.ts', 'b.ts'],
      readSource,
    })
    const reordered = computeToolSourceDigest({
      repoRoot: workDir,
      files: ['b.ts', 'a.ts'],
      readSource,
    })
    expect(reordered).toBe(first)
    sources[join(workDir, 'b.ts')] = 'beta-changed'
    expect(
      computeToolSourceDigest({ repoRoot: workDir, files: ['a.ts', 'b.ts'], readSource })
    ).not.toBe(first)
  })

  it('keeps PRODUCER_SOURCE_FILES in step with the files that actually exist', () => {
    for (const relPath of PRODUCER_SOURCE_FILES) {
      expect(existsSync(join(process.cwd(), relPath)), relPath).toBe(true)
    }
  })

  // SMI-6444 adversarial review: `tool_source_digest` exists to pin WHAT CODE
  // RAN (plan Item 7). A hand-maintained list silently stops doing that the
  // moment a CORE module gains an import — which is exactly how the original
  // list came to cover `deriveUnfetchableSubtype` and `stratumKeyForRow` while
  // omitting `parseSkillMdUrl`, the predicate both of them are thin wrappers
  // around. This test re-derives the ratified boundary (CORE ∪ every RELATIVE
  // import target of a CORE file, one hop) from the source tree itself, so any
  // future import change forces a conscious list update rather than a silent
  // provenance gap.
  it('PRODUCER_SOURCE_FILES equals CORE ∪ its one-hop relative imports (Item 7 boundary rule)', () => {
    const repoRoot = process.cwd()
    const indexerDir = join(repoRoot, 'scripts/indexer')
    const core = readdirSync(indexerDir)
      .map((name) => `scripts/indexer/${name}`)
      .filter((rel) => rel.endsWith('.ts') && isProducerCoreModule(rel))
    expect(core.length, 'no CORE modules found — the predicate or the tree moved').toBeGreaterThan(
      0
    )

    // Static `import ... from '.'`/`export ... from '.'` plus dynamic
    // `import('.')`. Anything this misses that a future author adds would be a
    // provenance hole, so the pattern is deliberately broad rather than exact.
    const specifierPattern =
      /(?:from\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g

    const oneHop = new Set<string>()
    for (const rel of core) {
      const source = readFileSync(join(repoRoot, rel), 'utf8')
      for (const match of source.matchAll(specifierPattern)) {
        const specifier = match[1] ?? match[2]
        if (specifier === undefined) continue
        const target = relative(repoRoot, resolve(dirname(join(repoRoot, rel)), specifier))
        expect(existsSync(join(repoRoot, target)), `${rel} imports missing ${specifier}`).toBe(true)
        if (!core.includes(target)) oneHop.add(target)
      }
    }

    const expected = [...new Set([...core, ...oneHop])].sort()
    const actual = [...PRODUCER_SOURCE_FILES].sort()
    const missing = expected.filter((f) => !actual.includes(f))
    const extra = actual.filter((f) => !expected.includes(f))
    expect(
      missing,
      `PRODUCER_SOURCE_FILES is MISSING file(s) a CORE module imports — tool_source_digest would ` +
        `not pin them. Add them to scripts/indexer/smi5879-dispose-terminal.provenance.ts.`
    ).toEqual([])
    expect(
      extra,
      `PRODUCER_SOURCE_FILES lists file(s) no CORE module imports any more — remove them, or ` +
        `state why the boundary rule is being widened.`
    ).toEqual([])
    expect(actual).toEqual(expected)
  })

  it('parses git status --porcelain into repo-relative dirty paths', () => {
    const git = gitStub({
      status:
        ' M scripts/indexer/smi5879-dispose-terminal.ledger.ts\n?? scripts/indexer/new.ts\nR  old.ts -> scripts/indexer/renamed.ts\n',
    })
    expect(detectDirtyWorktree({ repoRoot: workDir, files: ['scripts/indexer'], git })).toEqual([
      'scripts/indexer/new.ts',
      'scripts/indexer/renamed.ts',
      'scripts/indexer/smi5879-dispose-terminal.ledger.ts',
    ])
  })

  it('refuses a dirty worktree without the override and records the reason with it', () => {
    const sources: Record<string, string> = { [join(workDir, 'a.ts')]: 'alpha' }
    const readSource = (path: string): string => sources[path] ?? ''
    const dirtyGit = gitStub({
      status: ' M a.ts\n',
      'rev-parse': `${'0'.repeat(40)}\n`,
    })
    const refused = resolveToolProvenance({
      repoRoot: workDir,
      files: ['a.ts'],
      git: dirtyGit,
      readSource,
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.reason).toContain('--allow-dirty-worktree')
      expect(refused.reason).toContain('a.ts')
    }

    const allowed = resolveToolProvenance({
      repoRoot: workDir,
      files: ['a.ts'],
      git: dirtyGit,
      readSource,
      allowDirtyWorktreeReason: 'debugging SMI-6444 locally',
    })
    expect(allowed.ok).toBe(true)
    if (allowed.ok) {
      expect(allowed.provenance.dirtyOverrideUsed).toBe(true)
      expect(allowed.provenance.dirtyPaths).toEqual(['a.ts'])
      expect(allowed.provenance.reasonSuffix).toContain('debugging SMI-6444 locally')
      expect(allowed.provenance.tool_commit).toBe('0'.repeat(40))
    }

    const clean = resolveToolProvenance({
      repoRoot: workDir,
      files: ['a.ts'],
      git: gitStub({ status: '', 'rev-parse': `${'0'.repeat(40)}\n` }),
      readSource,
    })
    expect(clean.ok).toBe(true)
    if (clean.ok) {
      expect(clean.provenance.dirtyOverrideUsed).toBe(false)
      expect(clean.provenance.reasonSuffix).toBe('')
    }
  })
})

// ---------------------------------------------------------------------------
// SMI-6444 producer CLI flow tests (this task's own scope) — `init` plus the
// full `dispose` flow (population/report load, provenance, staging) for both
// outcome classes, exercised through `initAction`/`disposeAction` directly
// (the action layer, not commander parsing — every ledger/sidecar invariant
// is already covered at the mutation-function level above; these tests prove
// the CLI's OWN wiring: candidate filtering, subtype re-derivation dispatch,
// live re-fetch dispatch, and refusal propagation).
// ---------------------------------------------------------------------------

function cleanGit(sha = 'a'.repeat(40)): GitRunner {
  return (args) => (args[0] === 'rev-parse' ? `${sha}\n` : '')
}

function dirtyGit(sha = 'a'.repeat(40)): GitRunner {
  return (args) => {
    if (args[0] === 'rev-parse') return `${sha}\n`
    if (args[0] === 'status') return ' M a.ts\n'
    return ''
  }
}

function flowDb(
  overrides: Partial<Smi5879DisposeTerminalDbDeps> = {}
): Smi5879DisposeTerminalDbDeps {
  return {
    getRunSummary: async () => ({ purpose: 'decision', status: 'sealed' }),
    verifyDigest: async () => ({ populationMatches: true, branchMatches: true }),
    loadCohortRows: async () => [],
    loadBranchMap: async () => new Map(),
    ...overrides,
  }
}

function buildSimulatorReport(rows: SimRowResult[]): Smi5879SimulateFullReport {
  const counts = { ...EMPTY_OUTCOME_COUNTS }
  for (const row of rows) counts[row.outcome] += 1
  const coverage = {} as Smi5879SimulateFullReport['coverage']
  for (const cohort of ALL_SIMULATED_COHORTS) {
    const cohortRows = rows.filter((r) => r.cohort === cohort)
    coverage[cohort] = {
      status: 'full',
      scanned: cohortRows.length,
      total: cohortRows.length,
      unevaluable: cohortRows.filter((r) => r.outcome === 'unevaluable').length,
      unfetchable: cohortRows.filter((r) => r.outcome === 'unfetchable').length,
      primaryNotFound: cohortRows.filter((r) => r.outcome === 'primary_not_found').length,
    }
  }
  return {
    report_kind: 'full_simulation',
    run_id: RUN_ID,
    purpose: 'decision',
    status: 'sealed',
    token_source: 'pat',
    baseline_commit: 'e'.repeat(40),
    coverage,
    estimated_completion_at: null,
    sweep: { passes_run: 1, hard_stopped: null },
    rows,
    counts,
    generated_at: NOW,
  }
}

function writeSimulatorReportFile(rows: SimRowResult[], name = 'sim-report.json'): string {
  const path = join(workDir, name)
  writeFileSync(path, JSON.stringify(buildSimulatorReport(rows), null, 2), 'utf8')
  return path
}

function flowDeps(
  overrides: Partial<DisposeActionDeps> & { db: Smi5879DisposeTerminalDbDeps }
): DisposeActionDeps {
  return {
    now: () => NOW,
    log: () => {},
    repoRoot: workDir,
    git: cleanGit(),
    readSource: () => 'source',
    provenanceFiles: ['a.ts'],
    ...overrides,
  }
}

describe('SMI-6444 producer CLI — init', () => {
  it('creates a valid empty ledger, and refuses when the file already exists', () => {
    const ledgerPath = join(workDir, 'fresh.json')
    expect(existsSync(ledgerPath)).toBe(false)
    const created = initAction({ dispositions: ledgerPath, runId: RUN_ID })
    expect(created).toBe(0)
    const onDisk = readLedgerFile(ledgerPath)
    expect(onDisk).toEqual({ run_id: RUN_ID, entries: [] })
    // The shape validator accepts the freshly-written file on its own terms.
    expect(validateDispositionLedger(onDisk).valid).toBe(true)

    const refused = initAction({ dispositions: ledgerPath, runId: RUN_ID })
    expect(refused).toBe(1)
    // Untouched by the refused second call.
    expect(readLedgerFile(ledgerPath)).toEqual({ run_id: RUN_ID, entries: [] })
  })
})

// ---------------------------------------------------------------------------
// unfetchable
// ---------------------------------------------------------------------------

function unfetchablePopulationRow(id: string, repoUrl: string | null): SimSnapshotRow {
  return {
    id,
    cohort: 'C4',
    repo_url: repoUrl,
    skill_path: null,
    author: 'author',
    name: 'name',
    content_hash: null,
    snapshot_security_score: null,
    snapshot_quarantined: null,
  }
}

function unfetchableCandidateRow(
  id: string,
  subtype?: 'url_parse' | 'branch_resolution'
): SimRowResult {
  return {
    id,
    cohort: 'C4',
    author: 'author',
    name: 'name',
    outcome: 'unfetchable',
    ...(subtype !== undefined ? { unfetchable_subtype: subtype } : {}),
  }
}

describe('SMI-6444 producer CLI — dispose --outcome-class=unfetchable', () => {
  it('full url_parse-subtype run excludes (bulk-verdict=exclude) every matching row', () => {
    const ids = ['uf001', 'uf002', 'uf003']
    // Not a github.com URL at all -> parseSkillMdUrl returns null for every one.
    const population = ids.map((id) => unfetchablePopulationRow(id, `https://example.com/${id}`))
    const rows = ids.map((id) => unfetchableCandidateRow(id, 'url_parse'))
    const reportPath = writeSimulatorReportFile(rows)
    const ledgerPath = newLedgerFile('uf-full.json')

    const exit = disposeAction(
      {
        dispositions: ledgerPath,
        runId: RUN_ID,
        outcomeClass: 'unfetchable',
        simulatorReport: reportPath,
        operator: 'op',
      },
      flowDeps({ db: flowDb({ loadCohortRows: async () => population }) })
    )
    return exit.then((code) => {
      expect(code).toBe(0)
      const onDisk = readLedgerFile(ledgerPath)
      expect(onDisk.entries).toHaveLength(3)
      expect(onDisk.entries.every((e) => e.method === 'bulk' && e.verdict === 'exclude')).toBe(true)
      const batch = (onDisk.batches ?? [])[0]
      // Both subtype buckets are always reported, even when one is empty --
      // an auditor sees the full split, not just the populated half.
      expect(batch?.subtype_counts).toEqual({ url_parse: 3, branch_resolution: 0 })
      expect(batch?.strata?.find((s) => s.stratum_key === 'url_parse')?.mismatched_ids).toEqual([])
    })
  })

  it('a branch_resolution disagreement lands as mismatched — never unavailable, never bulk-excluded', () => {
    const ok = 'bf001'
    const disagree = 'bf002'
    const population = [
      unfetchablePopulationRow(ok, 'https://github.com/acme/dead-repo'),
      unfetchablePopulationRow(disagree, 'https://github.com/acme/actually-fine'),
    ]
    // Both claimed branch_resolution by the report...
    const rows = [
      unfetchableCandidateRow(ok, 'branch_resolution'),
      unfetchableCandidateRow(disagree, 'branch_resolution'),
    ]
    // ...but the sealed branch map only confirms the FIRST as not-found; the
    // second's (owner,repo) is simply absent -- a missing key is a MISMATCH,
    // never "unavailable" (there is no transient-failure mode locally).
    const branchMap: BranchMap = new Map([
      ['acme/dead-repo', { resolution: 'not-found', default_branch: null }],
    ])
    const reportPath = writeSimulatorReportFile(rows)
    const ledgerPath = newLedgerFile('uf-disagree.json')

    return disposeAction(
      {
        dispositions: ledgerPath,
        runId: RUN_ID,
        outcomeClass: 'unfetchable',
        simulatorReport: reportPath,
        operator: 'op',
      },
      flowDeps({
        db: flowDb({
          loadCohortRows: async () => population,
          loadBranchMap: async () => branchMap,
        }),
      })
    ).then((code) => {
      expect(code).toBe(0)
      const onDisk = readLedgerFile(ledgerPath)
      const batch = (onDisk.batches ?? [])[0]
      const stratum = batch?.strata?.find((s) => s.stratum_key === 'branch_resolution')
      expect(stratum?.mismatched_ids).toEqual([disagree])
      expect(stratum?.unavailable_ids).toEqual([])
      expect(stratum?.selected_ids).toContain(disagree)
      // Withheld -- not silently dropped, but not bulk-excluded either.
      expect(onDisk.entries.some((e) => e.id === disagree)).toBe(false)
      expect(onDisk.entries.some((e) => e.id === ok)).toBe(true)
    })
  })

  it('a row also present in R is refused from the bulk batch, never bulk-excluded via a duplicate id', () => {
    const rId = 'dup-r-1'
    const okId = 'uf010'
    const population = [
      unfetchablePopulationRow(rId, `https://example.com/${rId}`),
      unfetchablePopulationRow(okId, `https://example.com/${okId}`),
    ]
    // A malformed/duplicate report: the SAME id appears once as `unfetchable`
    // (a bulk candidate) and once as `newly_quarantined` (in R). The producer
    // must exclude it from the bulk batch defensively rather than trust the
    // report's outcome label in isolation.
    const rows: SimRowResult[] = [
      unfetchableCandidateRow(rId, 'url_parse'),
      { id: rId, cohort: 'C4', author: 'a', name: 'n', outcome: 'newly_quarantined' },
      unfetchableCandidateRow(okId, 'url_parse'),
    ]
    const reportPath = writeSimulatorReportFile(rows)
    const ledgerPath = newLedgerFile('uf-r-excl.json')
    const logs: string[] = []

    return disposeAction(
      {
        dispositions: ledgerPath,
        runId: RUN_ID,
        outcomeClass: 'unfetchable',
        simulatorReport: reportPath,
        operator: 'op',
      },
      flowDeps({
        db: flowDb({ loadCohortRows: async () => population }),
        log: (msg) => logs.push(msg),
      })
    ).then((code) => {
      expect(code).toBe(0)
      expect(logs.some((m) => m.includes('also appear in R') && m.includes(rId))).toBe(true)
      const onDisk = readLedgerFile(ledgerPath)
      expect(onDisk.entries.some((e) => e.id === rId)).toBe(false)
      expect(onDisk.entries.some((e) => e.id === okId)).toBe(true)
    })
  })

  it('refuses staging from a dirty worktree without the override, and proceeds (reason recorded) with it', () => {
    const id = 'uf-dirty-1'
    const population = [unfetchablePopulationRow(id, `https://example.com/${id}`)]
    const rows = [unfetchableCandidateRow(id, 'url_parse')]
    const reportPath = writeSimulatorReportFile(rows)

    const refusedLedger = newLedgerFile('uf-dirty-refused.json')
    return disposeAction(
      {
        dispositions: refusedLedger,
        runId: RUN_ID,
        outcomeClass: 'unfetchable',
        simulatorReport: reportPath,
        operator: 'op',
      },
      flowDeps({ db: flowDb({ loadCohortRows: async () => population }), git: dirtyGit() })
    )
      .then((code) => {
        expect(code).toBe(1)
        expect(readLedgerFile(refusedLedger).entries).toHaveLength(0)

        const allowedLedger = newLedgerFile('uf-dirty-allowed.json')
        return disposeAction(
          {
            dispositions: allowedLedger,
            runId: RUN_ID,
            outcomeClass: 'unfetchable',
            simulatorReport: reportPath,
            operator: 'op',
            allowDirtyWorktree: 'testing dirty override',
          },
          flowDeps({ db: flowDb({ loadCohortRows: async () => population }), git: dirtyGit() })
        ).then((code2) => ({ code2, allowedLedger }))
      })
      .then(({ code2, allowedLedger }) => {
        expect(code2).toBe(0)
        const batch = (readLedgerFile(allowedLedger).batches ?? [])[0]
        expect(batch?.reason).toContain('DIRTY worktree')
        expect(batch?.reason).toContain('testing dirty override')
      })
  })

  it('routes a row with neither a derivable nor a reported subtype to manual review, never stages it', () => {
    const unknownId = 'uf-unknown-1'
    const okId = 'uf-known-1'
    // No population row for unknownId at all, and its report row carries no
    // unfetchable_subtype -- nothing to attribute a mismatch to.
    const population = [unfetchablePopulationRow(okId, `https://example.com/${okId}`)]
    const rows: SimRowResult[] = [
      { id: unknownId, cohort: 'C4', author: 'a', name: 'n', outcome: 'unfetchable' },
      unfetchableCandidateRow(okId, 'url_parse'),
    ]
    const reportPath = writeSimulatorReportFile(rows)
    const ledgerPath = newLedgerFile('uf-manual.json')
    const logs: string[] = []

    return disposeAction(
      {
        dispositions: ledgerPath,
        runId: RUN_ID,
        outcomeClass: 'unfetchable',
        simulatorReport: reportPath,
        operator: 'op',
      },
      flowDeps({
        db: flowDb({ loadCohortRows: async () => population }),
        log: (msg) => logs.push(msg),
      })
    ).then((code) => {
      expect(code).toBe(0)
      expect(logs.some((m) => m.includes(unknownId) && m.includes('add-manual'))).toBe(true)
      const onDisk = readLedgerFile(ledgerPath)
      expect(onDisk.entries.some((e) => e.id === unknownId)).toBe(false)
      expect(onDisk.entries.some((e) => e.id === okId)).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// primary_not_found
// ---------------------------------------------------------------------------

function pnfPopulationRow(id: string, repoUrl: string | null = null): SimSnapshotRow {
  return {
    id,
    cohort: 'C4',
    repo_url: repoUrl,
    skill_path: null,
    author: 'author',
    name: 'name',
    content_hash: null,
    snapshot_security_score: null,
    snapshot_quarantined: null,
  }
}

function pnfCandidateRow(id: string): SimRowResult {
  return { id, cohort: 'C4', author: 'author', name: 'name', outcome: 'primary_not_found' }
}

/** Builds N single-stratum (`default_branch`, no embedded ref) primary_not_found
 *  candidates with unique repo_urls, so the id space is disjoint per test. */
function pnfFixture(
  n: number,
  prefix: string
): { rows: SimRowResult[]; population: SimSnapshotRow[] } {
  const ids = Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`)
  return {
    rows: ids.map((id) => pnfCandidateRow(id)),
    population: ids.map((id) => pnfPopulationRow(id, `https://github.com/acme/${id}`)),
  }
}

/** A policy whose per-stratum/population threshold sits EXACTLY at
 *  `badDraws=1 / populationCount` (in bp, rounded up) — the tightest
 *  threshold a full census can still clear. At `n_h < N_h` the bound is
 *  STRICTLY looser (a single unobserved row can double the apparent bad
 *  rate in a small population), so this threshold is only satisfiable at
 *  `n_h = N_h`, forcing full census deterministically without depending on
 *  the sizing search's own internals. */
function forceFullCensusPolicy(populationCount: number): SamplingPolicy {
  const bp = Math.ceil(10000 / populationCount)
  return {
    confidencePct: 95,
    mismatchThresholdBp: bp,
    stratumThresholdBp: bp,
    designPointBadDrawsPerStratum: 1,
  }
}

function fetchPrimaryFromRepoUrls(
  outcomeById: ReadonlyMap<string, FetchRetryOutcome>,
  population: readonly SimSnapshotRow[],
  fallback: FetchRetryOutcome
): (parsed: ParsedSkillUrl) => Promise<FetchRetryOutcome> {
  const outcomeByApiUrl = new Map<string, FetchRetryOutcome>()
  for (const row of population) {
    const outcome = outcomeById.get(row.id)
    if (outcome === undefined) continue
    const parsed = parseSkillMdUrlForFixture(row.repo_url)
    if (parsed) outcomeByApiUrl.set(parsed, outcome)
  }
  return async (parsed) => outcomeByApiUrl.get(parsed.apiUrl) ?? fallback
}

// Mirrors the real parseSkillMdUrl's apiUrl derivation for a bare repo_url
// (no ref, no skill_path) -- used only to key the fixture's outcome map by
// the SAME apiUrl `fetchPrimary` will actually be called with.
function parseSkillMdUrlForFixture(repoUrl: string | null): string | null {
  if (!repoUrl) return null
  const rest = repoUrl.replace('https://github.com/', '')
  const [owner, repo] = rest.split('/')
  if (!owner || !repo) return null
  return `https://api.github.com/repos/${owner}/${repo}/contents/SKILL.md`
}

describe('SMI-6444 producer CLI — dispose --outcome-class=primary_not_found', () => {
  it('withholds a mismatched row from entries and stages with the recomputed bound within threshold', async () => {
    const N = 10
    const { rows, population } = pnfFixture(N, 'pmf1')
    const [firstRow] = rows
    const mismatchedId = firstRow.id
    const reportPath = writeSimulatorReportFile(rows)
    const ledgerPath = newLedgerFile('pnf-mismatch.json')
    const sidecarPath = join(workDir, 'pnf-mismatch.sample.json')
    const policy = forceFullCensusPolicy(N)
    const outcomeById = new Map<string, FetchRetryOutcome>(
      rows.map((r) => [
        r.id,
        r.id === mismatchedId ? { content: 'found' } : { removed: true as const },
      ])
    )

    const opts: DisposeOptions = {
      dispositions: ledgerPath,
      runId: RUN_ID,
      outcomeClass: 'primary_not_found',
      simulatorReport: reportPath,
      operator: 'op',
      seed: 'seed-mismatch',
      sidecar: sidecarPath,
      ...policy,
    }
    const code = await disposeAction(
      opts,
      flowDeps({
        db: flowDb({ loadCohortRows: async () => population }),
        fetchPrimary: fetchPrimaryFromRepoUrls(outcomeById, population, { removed: true }),
      })
    )
    expect(code).toBe(0)
    const onDisk = readLedgerFile(ledgerPath)
    const batch = (onDisk.batches ?? [])[0]
    expect(batch).toBeDefined()
    const stratum = batch?.strata?.[0]
    expect(stratum?.selected_ids).toHaveLength(N) // full census, forced by the policy
    expect(stratum?.mismatched_ids).toEqual([mismatchedId])
    expect(stratum?.unavailable_ids).toEqual([])
    // Recomputed bound at k'=1, n=N=full census: exactly the design point --
    // must clear the (exactly-as-tight) threshold, never exceed it.
    const expectedBound = upperBoundCountToBp(
      hypergeometricUpperBoundCount({
        populationCount: N,
        sampleSize: N,
        badDraws: 1,
        alpha: 0.025,
      }),
      N
    )
    expect(batch?.observed_population_upper_bound_bp).toBe(expectedBound)
    expect(batch?.observed_population_upper_bound_bp).toBeLessThanOrEqual(
      policy.mismatchThresholdBp
    )
    expect(onDisk.entries.some((e) => e.id === mismatchedId)).toBe(false)
    expect(onDisk.entries).toHaveLength(N - 1)
  })

  it('refuses the whole batch with ZERO ledger writes when an acceptance arm fails', async () => {
    const N = 10
    const { rows, population } = pnfFixture(N, 'pmf2')
    const reportPath = writeSimulatorReportFile(rows)
    const ledgerPath = newLedgerFile('pnf-refuse.json')
    const sidecarPath = join(workDir, 'pnf-refuse.sample.json')
    const policy = forceFullCensusPolicy(N)
    // TWO mismatches -- k'=2 exceeds the design point (1) the threshold was
    // calibrated for, so even full census must fail.
    const outcomeById = new Map<string, FetchRetryOutcome>(
      rows.map((r, i) => [r.id, i < 2 ? { content: 'found' } : { removed: true as const }])
    )

    const opts: DisposeOptions = {
      dispositions: ledgerPath,
      runId: RUN_ID,
      outcomeClass: 'primary_not_found',
      simulatorReport: reportPath,
      operator: 'op',
      seed: 'seed-refuse',
      sidecar: sidecarPath,
      ...policy,
    }
    const code = await disposeAction(
      opts,
      flowDeps({
        db: flowDb({ loadCohortRows: async () => population }),
        fetchPrimary: fetchPrimaryFromRepoUrls(outcomeById, population, { removed: true }),
      })
    )
    expect(code).toBe(1)
    const onDisk = readLedgerFile(ledgerPath)
    expect(onDisk.entries).toHaveLength(0)
    expect(onDisk.batches ?? []).toHaveLength(0)
    // The sidecar remains for audit/resume -- never deleted on a refusal.
    expect(existsSync(sidecarPath)).toBe(true)
  })

  it('selects the identical sample from the same seed across two independent invocations', async () => {
    const N = 24
    const { rows, population } = pnfFixture(N, 'pmf3')
    const reportPath = writeSimulatorReportFile(rows)
    const policy: SamplingPolicy = {
      ...TEST_POLICY,
      mismatchThresholdBp: 9000,
      stratumThresholdBp: 9500,
    }
    const allVerified: (parsed: ParsedSkillUrl) => Promise<FetchRetryOutcome> = async () => ({
      removed: true,
    })

    async function runOnce(name: string): Promise<string[]> {
      const ledgerPath = newLedgerFile(`pnf-seed-${name}.json`)
      const sidecarPath = join(workDir, `pnf-seed-${name}.sample.json`)
      const code = await disposeAction(
        {
          dispositions: ledgerPath,
          runId: RUN_ID,
          outcomeClass: 'primary_not_found',
          simulatorReport: reportPath,
          operator: 'op',
          seed: 'stable-seed-1',
          sidecar: sidecarPath,
          ...policy,
        },
        flowDeps({
          db: flowDb({ loadCohortRows: async () => population }),
          fetchPrimary: allVerified,
        })
      )
      expect(code).toBe(0)
      const batch = (readLedgerFile(ledgerPath).batches ?? [])[0]
      return batch?.strata?.[0]?.selected_ids ?? []
    }

    const first = await runOnce('a')
    const second = await runOnce('b')
    expect(first.length).toBeGreaterThan(0)
    expect(second).toEqual(first)
  })

  // SMI-6444 adversarial review: every other end-to-end primary_not_found test
  // above uses `forceFullCensusPolicy`, where `selected_ids === the whole
  // population`, so the distinction this test pins is invisible in all of
  // them. A SAMPLED batch (n < N — the actual production shape: N=23,597,
  // n~550) must generate a ledger entry for EVERY population row it covers,
  // not just for the sampled ones; the sample bounds the misclassification
  // rate, it does not enumerate what the batch disposes.
  it('a SAMPLED batch (n < N) generates an entry for every covered population row, not just the sampled ones', async () => {
    const N = 40
    const { rows, population } = pnfFixture(N, 'pmf6')
    const reportPath = writeSimulatorReportFile(rows)
    const ledgerPath = newLedgerFile('pnf-sampled.json')
    const sidecarPath = join(workDir, 'pnf-sampled.sample.json')
    const policy: SamplingPolicy = {
      confidencePct: 95,
      mismatchThresholdBp: 5000,
      stratumThresholdBp: 8000,
      designPointBadDrawsPerStratum: 1,
    }

    const code = await disposeAction(
      {
        dispositions: ledgerPath,
        runId: RUN_ID,
        outcomeClass: 'primary_not_found',
        simulatorReport: reportPath,
        operator: 'op',
        seed: 'seed-sampled',
        sidecar: sidecarPath,
        ...policy,
      },
      flowDeps({
        db: flowDb({ loadCohortRows: async () => population }),
        fetchPrimary: async () => ({ removed: true }),
      })
    )
    expect(code).toBe(0)

    const onDisk = readLedgerFile(ledgerPath)
    const batch = (onDisk.batches ?? [])[0]
    expect(batch).toBeDefined()
    const stratum = batch?.strata?.[0]
    // Precondition: this really is a SAMPLED run, not a full census.
    expect(stratum?.selected_ids.length).toBeGreaterThan(0)
    expect(stratum?.selected_ids.length).toBeLessThan(N)
    // The batch claims to cover the whole population...
    expect(batch?.population_count).toBe(N)
    // ...so it must have written one entry per covered row.
    expect(batch?.entry_count).toBe(N)
    expect(onDisk.entries).toHaveLength(N)
    for (const row of rows) {
      expect(onDisk.entries.some((e) => e.id === row.id && e.method === 'bulk')).toBe(true)
    }
  })

  // SMI-6444 adversarial review: `runCancellablePool` CAPTURES a thrown
  // `processItem` error into `abortedBy` and returns normally. A fatal,
  // non-transient failure (`PrimaryFetchAuthError` on HTTP 401 — which
  // `withFetchRetry` deliberately rethrows rather than retrying) must surface
  // as a REFUSAL, never be laundered into "unavailable" rows by
  // `observations()` and then staged.
  it('refuses when the live re-fetch aborts on a fatal error, never staging the partial run', async () => {
    const N = 10
    const { rows, population } = pnfFixture(N, 'pmf7')
    const reportPath = writeSimulatorReportFile(rows)
    const ledgerPath = newLedgerFile('pnf-abort.json')
    const sidecarPath = join(workDir, 'pnf-abort.sample.json')
    const policy = forceFullCensusPolicy(N)
    const logs: string[] = []

    const code = await disposeAction(
      {
        dispositions: ledgerPath,
        runId: RUN_ID,
        outcomeClass: 'primary_not_found',
        simulatorReport: reportPath,
        operator: 'op',
        seed: 'seed-abort',
        sidecar: sidecarPath,
        ...policy,
      },
      flowDeps({
        db: flowDb({ loadCohortRows: async () => population }),
        // Fatal credential-shaped failure, exactly as retryPrimaryFetch would
        // rethrow it — not a `{ exhausted }` outcome.
        fetchPrimary: async () => {
          throw new Error('HTTP 401 for acme/pmf7000 — credential rejected')
        },
        fetchConcurrency: 1,
        log: (msg) => logs.push(msg),
      })
    )
    expect(code).toBe(1)
    expect(logs.some((m) => m.includes('aborted') && m.includes('401'))).toBe(true)
    const onDisk = readLedgerFile(ledgerPath)
    expect(onDisk.entries).toHaveLength(0)
    expect(onDisk.batches ?? []).toHaveLength(0)
    // The sidecar survives for resume, and the abort left rows unrecorded
    // rather than recording them as `unavailable`.
    expect(existsSync(sidecarPath)).toBe(true)
  })

  // SMI-6444 adversarial review: the sidecar's `batch_id` is "generated at
  // sampling time and carried forward into the batch at staging" (plan Item
  // 8's field list; `checkIdentity`'s own comment says the same, which is why
  // resume deliberately does NOT compare it). A resumed run that mints a fresh
  // id for the staged batch severs the only link between the sampling evidence
  // and the batch staged from it.
  it('a resumed run stages under the SIDECAR’s batch_id, not a freshly minted one', async () => {
    const N = 10
    const { rows, population } = pnfFixture(N, 'pmf8')
    const reportPath = writeSimulatorReportFile(rows)
    const ledgerPath = newLedgerFile('pnf-batchid.json')
    const sidecarPath = join(workDir, 'pnf-batchid.sample.json')
    const policy = forceFullCensusPolicy(N)
    const opts: DisposeOptions = {
      dispositions: ledgerPath,
      runId: RUN_ID,
      outcomeClass: 'primary_not_found',
      simulatorReport: reportPath,
      operator: 'op',
      seed: 'seed-batchid',
      sidecar: sidecarPath,
      ...policy,
    }

    // Pass 1: two rows unavailable -> k'=2 overshoots the design point, so the
    // run refuses and leaves the sidecar (with its batch_id) behind.
    const [heldA, heldB] = rows
    const heldIds = new Set([heldA.id, heldB.id])
    const firstCode = await disposeAction(
      opts,
      flowDeps({
        db: flowDb({ loadCohortRows: async () => population }),
        fetchPrimary: fetchPrimaryFromRepoUrls(
          new Map(
            rows.map((r) => [
              r.id,
              heldIds.has(r.id)
                ? { exhausted: true as const, lastStatus: 503 }
                : { removed: true as const },
            ])
          ),
          population,
          { removed: true }
        ),
      })
    )
    expect(firstCode).toBe(1)
    const sidecarBatchId = (JSON.parse(readFileSync(sidecarPath, 'utf8')) as { batch_id: string })
      .batch_id
    expect(sidecarBatchId).toBeTruthy()

    // Pass 2: resume; every held row now resolves, so the batch stages.
    const secondCode = await disposeAction(
      opts,
      flowDeps({
        db: flowDb({ loadCohortRows: async () => population }),
        fetchPrimary: async () => ({ removed: true }),
      })
    )
    expect(secondCode).toBe(0)
    const batch = (readLedgerFile(ledgerPath).batches ?? [])[0]
    expect(batch?.batch_id).toBe(sidecarBatchId)
  })

  // SMI-6444 adversarial review: a population where NO stratum is feasible is
  // an input the plan explicitly anticipates (Item 5's infeasible-stratum
  // handling, plus the whole-population-infeasible refusal in the plan's
  // Implementation-corrections section). It must refuse cleanly with every row
  // routed to manual review, not crash out of `evaluateAcceptance` with an
  // unhandled RangeError after the sidecar has already been created.
  it('refuses cleanly when no stratum is feasible, routing every row to manual review', async () => {
    const N = 5 // below the ratified-default feasibility floor of 10
    const { rows, population } = pnfFixture(N, 'pmf9')
    const reportPath = writeSimulatorReportFile(rows)
    const ledgerPath = newLedgerFile('pnf-infeasible.json')
    const sidecarPath = join(workDir, 'pnf-infeasible.sample.json')
    const logs: string[] = []

    const code = await disposeAction(
      {
        dispositions: ledgerPath,
        runId: RUN_ID,
        outcomeClass: 'primary_not_found',
        simulatorReport: reportPath,
        operator: 'op',
        seed: 'seed-infeasible',
        sidecar: sidecarPath,
        confidencePct: 95,
        mismatchThresholdBp: 200,
        stratumThresholdBp: 1000,
        designPointBadDrawsPerStratum: 1,
      },
      flowDeps({
        db: flowDb({ loadCohortRows: async () => population }),
        fetchPrimary: async () => ({ removed: true }),
        log: (msg) => logs.push(msg),
      })
    )
    expect(code).toBe(1)
    expect(logs.some((m) => m.includes('add-manual'))).toBe(true)
    const onDisk = readLedgerFile(ledgerPath)
    expect(onDisk.entries).toHaveLength(0)
    expect(onDisk.batches ?? []).toHaveLength(0)
  })

  it('routes an unparseable-URL row to manual review, never stages it', async () => {
    const N = 10
    const { rows, population } = pnfFixture(N, 'pmf4')
    const unparseableId = 'pmf4-unparseable'
    rows.push(pnfCandidateRow(unparseableId))
    population.push(pnfPopulationRow(unparseableId, null))
    const reportPath = writeSimulatorReportFile(rows)
    const ledgerPath = newLedgerFile('pnf-manual.json')
    const sidecarPath = join(workDir, 'pnf-manual.sample.json')
    const policy = forceFullCensusPolicy(N)
    const logs: string[] = []

    const code = await disposeAction(
      {
        dispositions: ledgerPath,
        runId: RUN_ID,
        outcomeClass: 'primary_not_found',
        simulatorReport: reportPath,
        operator: 'op',
        seed: 'seed-manual',
        sidecar: sidecarPath,
        ...policy,
      },
      flowDeps({
        db: flowDb({ loadCohortRows: async () => population }),
        fetchPrimary: fetchPrimaryFromRepoUrls(new Map(), population, { removed: true }),
        log: (msg) => logs.push(msg),
      })
    )
    expect(code).toBe(0)
    expect(logs.some((m) => m.includes(unparseableId) && m.includes('add-manual'))).toBe(true)
    const onDisk = readLedgerFile(ledgerPath)
    expect(onDisk.entries.some((e) => e.id === unparseableId)).toBe(false)
    expect(onDisk.entries).toHaveLength(N)
  })

  it('a resumed run converting unavailable to verified stages successfully with a lower recomputed bound', async () => {
    const N = 10
    const { rows, population } = pnfFixture(N, 'pmf5')
    const reportPath = writeSimulatorReportFile(rows)
    const ledgerPath = newLedgerFile('pnf-resume.json')
    const sidecarPath = join(workDir, 'pnf-resume.sample.json')
    // Calibrated to k'=1 (the ratified design point) at full census, so TWO
    // unavailable rows (k'=2) overshoots the design point and must refuse,
    // while zero unavailable rows on the resumed retry clears it easily.
    const policy = forceFullCensusPolicy(N)
    const [heldRowA, heldRowB] = rows
    const heldIds = new Set([heldRowA.id, heldRowB.id])

    const firstPassOutcomes = new Map<string, FetchRetryOutcome>(
      rows.map((r) => [
        r.id,
        heldIds.has(r.id)
          ? { exhausted: true as const, lastStatus: 503 }
          : { removed: true as const },
      ])
    )
    const opts: DisposeOptions = {
      dispositions: ledgerPath,
      runId: RUN_ID,
      outcomeClass: 'primary_not_found',
      simulatorReport: reportPath,
      operator: 'op',
      seed: 'seed-resume',
      sidecar: sidecarPath,
      ...policy,
    }
    const firstCode = await disposeAction(
      opts,
      flowDeps({
        db: flowDb({ loadCohortRows: async () => population }),
        fetchPrimary: fetchPrimaryFromRepoUrls(firstPassOutcomes, population, { removed: true }),
      })
    )
    // k'=2 (two unavailable rows, priced as mismatches) exceeds the k'=1
    // design point this threshold was calibrated for -- the first pass must
    // refuse, leaving the sidecar in place (with both rows recorded
    // 'unavailable') for a later resume, and zero ledger writes.
    expect(firstCode).toBe(1)
    expect(readLedgerFile(ledgerPath).entries).toHaveLength(0)
    expect(readLedgerFile(ledgerPath).batches ?? []).toHaveLength(0)
    const firstAttemptBound = upperBoundCountToBp(
      hypergeometricUpperBoundCount({
        populationCount: N,
        sampleSize: N,
        badDraws: 2,
        alpha: 0.025,
      }),
      N
    )

    // Resume: SAME sidecar/ledger/seed, but both previously-'unavailable'
    // rows now resolve to a confirmed 404 (verified) on retry -- proving
    // 'unavailable' is retryable, never terminal.
    const secondPassOutcomes = new Map<string, FetchRetryOutcome>(
      rows.map((r) => [r.id, { removed: true as const }])
    )
    const secondCode = await disposeAction(
      opts,
      flowDeps({
        db: flowDb({ loadCohortRows: async () => population }),
        fetchPrimary: fetchPrimaryFromRepoUrls(secondPassOutcomes, population, { removed: true }),
      })
    )
    expect(secondCode).toBe(0)
    const batch = (readLedgerFile(ledgerPath).batches ?? [])[0]
    expect(batch?.strata?.[0]?.unavailable_ids).toEqual([])
    expect(batch?.strata?.[0]?.mismatched_ids).toEqual([])
    expect(batch?.observed_population_upper_bound_bp).toBeLessThan(firstAttemptBound)
    expect(batch?.observed_population_upper_bound_bp).toBeLessThanOrEqual(
      policy.mismatchThresholdBp
    )
    for (const id of heldIds)
      expect(readLedgerFile(ledgerPath).entries.some((e) => e.id === id)).toBe(true)
  })
})
