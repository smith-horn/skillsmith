/**
 * Ratio timing for the scaling tests of Check 59's shell scanner (SMI-7241).
 *
 * A scaling test times one input at n and one at 4n and asserts the ratio
 * stays under a limit (linear is about 4, quadratic about 16). Timing each
 * size in its own block let a burst of host load land on one size only: one
 * run in ten read 8.35 for a linear path (review round 2). So the two sizes
 * are timed alternately, small then large, after one untimed warm-up of each,
 * and the fastest run of each size is kept. Noise (load, GC, JIT) only adds
 * time, so the minimum is the stable estimate, and a spike long enough to
 * slow every large run slows the small runs between them too.
 *
 * Fail fast: a quadratic regression makes every large run slow, so timing
 * all the pairs of it wastes minutes. When the warm-ups'
 * ratio already exceeds `failFast` (callers pass twice their limit), one
 * timed pair confirms it, so a single load spike on the large warm-up cannot
 * fail the test, and that pair's ratio is returned at once.
 */
export type RatioTiming = {
  smallMs: number
  largeMs: number
  ratio: number
  smallHits: number
  largeHits: number
  failedFast: boolean
}

/** `run` scans its text and returns the hit count. */
export function timeAlternating(
  run: (text: string) => number,
  small: string,
  large: string,
  { pairs = 7, failFast = Infinity }: { pairs?: number; failFast?: number } = {}
): RatioTiming {
  const timed = (text: string) => {
    const t0 = performance.now()
    const hits = run(text)
    return { ms: performance.now() - t0, hits }
  }
  const smallWarm = timed(small) // warm-up
  const largeWarm = timed(large) // warm-up
  let smallHits = smallWarm.hits
  let largeHits = largeWarm.hits
  let smallMs = Infinity
  let largeMs = Infinity
  for (let k = 0; k < pairs; k++) {
    const s = timed(small)
    const l = timed(large)
    smallHits = s.hits
    largeHits = l.hits
    smallMs = Math.min(smallMs, s.ms)
    largeMs = Math.min(largeMs, l.ms)
    // Only the confirming pair right after slow warm-ups can stop early.
    if (k === 0 && largeWarm.ms / smallWarm.ms > failFast && largeMs / smallMs > failFast) {
      return { smallMs, largeMs, ratio: largeMs / smallMs, smallHits, largeHits, failedFast: true }
    }
  }
  return { smallMs, largeMs, ratio: largeMs / smallMs, smallHits, largeHits, failedFast: false }
}
