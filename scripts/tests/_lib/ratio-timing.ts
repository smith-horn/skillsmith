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
 */
export type RatioTiming = {
  smallMs: number
  largeMs: number
  ratio: number
  smallHits: number
  largeHits: number
}

/** `run` scans its text and returns the hit count. */
export function timeAlternating(
  run: (text: string) => number,
  small: string,
  large: string,
  pairs = 7
): RatioTiming {
  let smallHits = run(small) // warm-up, untimed
  let largeHits = run(large) // warm-up, untimed
  let smallMs = Infinity
  let largeMs = Infinity
  for (let k = 0; k < pairs; k++) {
    let t0 = performance.now()
    smallHits = run(small)
    smallMs = Math.min(smallMs, performance.now() - t0)
    t0 = performance.now()
    largeHits = run(large)
    largeMs = Math.min(largeMs, performance.now() - t0)
  }
  return { smallMs, largeMs, ratio: largeMs / smallMs, smallHits, largeHits }
}
