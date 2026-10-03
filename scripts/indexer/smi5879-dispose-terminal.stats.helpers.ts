/**
 * Pure numeric + deterministic-selection primitives for the SMI-6444 bulk
 * disposition producer's statistical core. Split from
 * `smi5879-dispose-terminal.stats.ts` per CLAUDE.md's <500-line convention,
 * along the seam that separates "arithmetic with no domain opinions"
 * (this file) from "the sampling design's policy and search" (that file).
 * @module scripts/indexer/smi5879-dispose-terminal.stats.helpers
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *       ("### 5. Statistical design for `primary_not_found`'s sample")
 *
 * WHY LOG-SPACE, AND WHY A CACHED LOG-FACTORIAL TABLE
 * ---------------------------------------------------
 * The hypergeometric pmf is a ratio of three binomial coefficients over
 * populations up to ~24k rows; computed directly those coefficients overflow
 * a double thousands of times over. Working in log space and exponentiating
 * only the final (small) ratio keeps every intermediate finite. The
 * log-factorial table is built once with Kahan compensation — a naive running
 * sum of `Math.log(i)` accumulates ~1e-7 absolute error by i≈24k, which is
 * small but needless when the compensation costs one extra add per term.
 *
 * The tail sums here are always over a tiny number of terms (`k` is the
 * design point, 0..2 in practice), so no log-sum-exp machinery is warranted.
 *
 * DETERMINISM
 * -----------
 * {@link createSeededUint32Stream} is SHA-256 in counter mode: identical
 * output for identical seed material on every platform and Node version, with
 * no floating-point step anywhere in the draw or the shuffle. That is a hard
 * requirement — the sample selection must be re-derivable from the recorded
 * seed at resume-validation and audit time (plan Item 8).
 */

import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Log-factorial / log-binomial
// ---------------------------------------------------------------------------

/** Kahan-compensated running log-factorial table; grown lazily on demand. */
const LOG_FACTORIAL: number[] = [0]
/** Compensation term carried alongside the last computed table entry. */
let logFactorialCompensation = 0

/** `ln(k!)` for a non-negative integer `k`. */
export function logFactorial(k: number): number {
  if (!Number.isInteger(k) || k < 0) {
    throw new RangeError(`logFactorial requires a non-negative integer, got ${k}`)
  }
  // Kahan summation over ln(i), carried across calls via the module-level
  // compensation term (the table is append-only, so the running sum this
  // compensation belongs to is a single continuous sequence).
  let running = LOG_FACTORIAL[LOG_FACTORIAL.length - 1] ?? 0
  for (let i = LOG_FACTORIAL.length; i <= k; i++) {
    const y = Math.log(i) - logFactorialCompensation
    const t = running + y
    logFactorialCompensation = t - running - y
    LOG_FACTORIAL.push(t)
    running = t
  }
  const value = LOG_FACTORIAL[k]
  if (value === undefined) {
    throw new RangeError(`logFactorial table missing entry for ${k}`)
  }
  return value
}

/** `ln(C(n, k))`, or `-Infinity` when the coefficient is zero. */
export function logChoose(n: number, k: number): number {
  if (n < 0 || k < 0 || k > n) return Number.NEGATIVE_INFINITY
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k)
}

// ---------------------------------------------------------------------------
// Distribution tails
// ---------------------------------------------------------------------------

/**
 * `P(X <= atMost)` for `X ~ Hypergeometric(populationCount, successCount,
 * sampleSize)` — drawing `sampleSize` items without replacement from a
 * population of `populationCount` containing `successCount` "bad" items.
 *
 * Returns a value in [0, 1]. Terms whose coefficient is zero (an impossible
 * draw count) contribute nothing rather than `NaN`.
 */
export function hypergeometricCdfAtMost(
  populationCount: number,
  successCount: number,
  sampleSize: number,
  atMost: number
): number {
  if (atMost < 0) return 0
  const logDenominator = logChoose(populationCount, sampleSize)
  if (!Number.isFinite(logDenominator)) {
    throw new RangeError(
      `hypergeometricCdfAtMost: sampleSize ${sampleSize} is not drawable from population ${populationCount}`
    )
  }
  let total = 0
  const upper = Math.min(atMost, successCount, sampleSize)
  for (let i = 0; i <= upper; i++) {
    const logTerm =
      logChoose(successCount, i) +
      logChoose(populationCount - successCount, sampleSize - i) -
      logDenominator
    if (Number.isFinite(logTerm)) total += Math.exp(logTerm)
  }
  // Guard against a hair over 1.0 from accumulated rounding.
  return total > 1 ? 1 : total
}

/** `P(X <= atMost)` for `X ~ Binomial(trials, probability)`. */
export function binomialCdfAtMost(trials: number, atMost: number, probability: number): number {
  if (atMost < 0) return 0
  if (probability <= 0) return 1
  if (probability >= 1) return atMost >= trials ? 1 : 0
  const logP = Math.log(probability)
  const logQ = Math.log1p(-probability)
  let total = 0
  const upper = Math.min(atMost, trials)
  for (let i = 0; i <= upper; i++) {
    total += Math.exp(logChoose(trials, i) + i * logP + (trials - i) * logQ)
  }
  return total > 1 ? 1 : total
}

/**
 * The one-sided binomial Clopper-Pearson upper bound on the RATE:
 * `max{ p : P(X <= badDraws | Binomial(sampleSize, p)) >= alpha }`.
 *
 * This is the always-conservative fallback the SMI-6444 plan names if the
 * exact hypergeometric bound is deferred (it drops the finite-population
 * correction, so it is never tighter than the exact bound). It is kept
 * alongside — never instead of — the exact bound so the ordering
 * hypergeometric <= binomial <= Poisson stays testable rather than asserted.
 */
export function binomialUpperBoundRate(
  sampleSize: number,
  badDraws: number,
  alpha: number
): number {
  if (!Number.isInteger(sampleSize) || sampleSize < 1) {
    throw new RangeError(`sampleSize must be a positive integer, got ${sampleSize}`)
  }
  if (!Number.isInteger(badDraws) || badDraws < 0 || badDraws > sampleSize) {
    throw new RangeError(`badDraws must be an integer in [0, ${sampleSize}], got ${badDraws}`)
  }
  if (!(alpha > 0) || !(alpha < 1)) {
    throw new RangeError(`alpha must be in (0, 1), got ${alpha}`)
  }
  let lo = 0
  let hi = 1
  // The binomial CDF is decreasing in p, so bisection is exact in the limit;
  // 200 iterations drive the interval far below double precision, and a fixed
  // count keeps the function total (no convergence-failure branch).
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (binomialCdfAtMost(sampleSize, badDraws, mid) >= alpha) lo = mid
    else hi = mid
  }
  return lo
}

// ---------------------------------------------------------------------------
// Deterministic seeded selection
// ---------------------------------------------------------------------------

/** Number of 32-bit words a single SHA-256 block yields. */
const WORDS_PER_BLOCK = 8
/** 2^32, the exclusive upper bound of the generated words. */
const UINT32_RANGE = 0x1_0000_0000

/**
 * A counter-mode SHA-256 stream of uniform uint32 values.
 *
 * `sha256(sha256(seedMaterial) || counterBE64)` per block, read as 8
 * big-endian uint32s. Pure, allocation-light, and byte-identical across
 * platforms — no `Math.random`, no float arithmetic, no platform-dependent
 * hash iteration order.
 */
export function createSeededUint32Stream(seedMaterial: string): () => number {
  const root = createHash('sha256').update(seedMaterial, 'utf8').digest()
  let counter = 0n
  let block = Buffer.alloc(0)
  let offset = WORDS_PER_BLOCK

  return function nextUint32(): number {
    if (offset >= WORDS_PER_BLOCK) {
      const counterBytes = Buffer.alloc(8)
      counterBytes.writeBigUInt64BE(counter)
      counter += 1n
      block = createHash('sha256').update(root).update(counterBytes).digest()
      offset = 0
    }
    const word = block.readUInt32BE(offset * 4)
    offset += 1
    return word
  }
}

/**
 * A uniform integer in `[0, bound)` drawn from a uint32 stream via rejection
 * sampling — integer arithmetic only, so no modulo bias and no float rounding
 * anywhere in the shuffle.
 */
export function nextIntBelow(nextUint32: () => number, bound: number): number {
  if (!Number.isInteger(bound) || bound < 1 || bound > UINT32_RANGE) {
    throw new RangeError(`nextIntBelow requires 1 <= bound <= 2^32, got ${bound}`)
  }
  const limit = Math.floor(UINT32_RANGE / bound) * bound
  let draw = nextUint32()
  while (draw >= limit) draw = nextUint32()
  return draw % bound
}

/**
 * Byte-order comparison of two ids (UTF-8 code-unit order), so a candidate
 * list's canonical order never depends on locale or on the order the caller
 * happened to read rows in.
 */
export function compareIdsByBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * Draw `count` ids without replacement from `candidateIds` via a seeded
 * Fisher-Yates shuffle over the byte-sorted candidate list.
 *
 * Returns the drawn ids in **draw order** (the caller sorts for persistence —
 * the batch schema requires sorted `selected_ids`). Same seed + same candidate
 * set => byte-identical result, which is what makes resume validation's
 * "re-derive the selection and compare" check meaningful.
 */
export function seededSampleWithoutReplacement(
  candidateIds: readonly string[],
  count: number,
  seedMaterial: string
): string[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`seededSampleWithoutReplacement requires count >= 0, got ${count}`)
  }
  if (count > candidateIds.length) {
    throw new RangeError(
      `seededSampleWithoutReplacement: count ${count} exceeds ${candidateIds.length} candidates`
    )
  }
  const pool = [...candidateIds].sort(compareIdsByBytes)
  for (let i = 1; i < pool.length; i++) {
    if (pool[i] === pool[i - 1]) {
      throw new RangeError(
        `seededSampleWithoutReplacement: duplicate candidate id ${String(pool[i])}`
      )
    }
  }
  const nextUint32 = createSeededUint32Stream(seedMaterial)
  // Full Fisher-Yates, then take the first `count`. Deliberately NOT a partial
  // shuffle: a partial variant's output depends on `count`, so re-deriving a
  // selection under a different (e.g. corrected) sample size would silently
  // stop being a superset/subset relationship an auditor can reason about.
  for (let i = pool.length - 1; i >= 1; i--) {
    const j = nextIntBelow(nextUint32, i + 1)
    const atI = pool[i]
    const atJ = pool[j]
    if (atI === undefined || atJ === undefined) {
      throw new RangeError(`seededSampleWithoutReplacement: shuffle index ${i}/${j} out of range`)
    }
    pool[i] = atJ
    pool[j] = atI
  }
  return pool.slice(0, count)
}
