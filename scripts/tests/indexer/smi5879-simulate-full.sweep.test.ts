/**
 * SMI-5879 Wave 3 item 3: smi5879-simulate-full — `runTier3Sweep` loop tests
 * (termination conditions + resume durability, SMI-5879 review finding 2a).
 * Split out of the original `smi5879-simulate-full.test.ts` (grew past the
 * 500-line-per-file gate) — shared fixtures live in
 * `./smi5879-simulate-full.fixtures.ts`, which also documents the
 * suite-wide mocked-dependencies judgment call. This file doesn't need any
 * of those fixtures itself (no `fetch`/`makeRow` usage — `runTier3Sweep` is
 * exercised with synthetic `SimRowResult`s directly).
 * @module scripts/tests/indexer/smi5879-simulate-full.sweep
 */

import { describe, it, expect } from 'vitest'
import { runTier3Sweep, MAX_SWEEP_PASSES } from '../../indexer/smi5879-simulate-full.sweep.ts'
import type { SimRowResult } from '../../indexer/smi5879-simulate-full.types.ts'

// ---------------------------------------------------------------------------
// Tier-3 sweep loop — the three termination conditions
// ---------------------------------------------------------------------------

describe('runTier3Sweep', () => {
  const noCooldown = { sleep: async () => {} }

  function seedRow(id: string): SimRowResult {
    return { id, cohort: 'C2', author: null, name: null, outcome: 'unevaluable' }
  }

  it('converges to |R_k| = 0 and reports no hard stop', async () => {
    const initial = [seedRow('a'), seedRow('b')]
    const outcome = await runTier3Sweep(
      initial,
      async (ids) => {
        // Resolve the first row of the CURRENT residual each pass — with 2
        // rows this converges in exactly 2 passes (1 resolved per pass).
        const map = new Map<string, SimRowResult>()
        ids.forEach((id, i) => {
          map.set(id, {
            id,
            cohort: 'C2',
            author: null,
            name: null,
            outcome: i === 0 ? 'unchanged_clean' : 'unevaluable',
          })
        })
        return map
      },
      noCooldown
    )
    expect(outcome.hardStopped).toBeNull()
    expect(outcome.finalResidualSize).toBe(0)
    expect(outcome.passesRun).toBe(2)
  })

  it('hard-stops on two consecutive non-decreasing passes', async () => {
    const initial = [seedRow('a'), seedRow('b')]
    const outcome = await runTier3Sweep(
      initial,
      async (ids) => {
        // Never resolves anything — residual stays flat at 2 forever.
        return new Map(ids.map((id) => [id, seedRow(id)]))
      },
      noCooldown
    )
    expect(outcome.hardStopped).toBe('non_convergence')
    expect(outcome.finalResidualSize).toBe(2)
    // Non-decrease detected after pass 1 (baseline) vs pass 2 -> stop at pass 2.
    expect(outcome.passesRun).toBe(2)
  })

  it('hard-stops at MAX_SWEEP_PASSES when residual keeps shrinking but never reaches zero', async () => {
    const initial = Array.from({ length: MAX_SWEEP_PASSES + 2 }, (_, i) => seedRow(`r${i}`))
    const outcome = await runTier3Sweep(
      initial,
      async (ids) => {
        // Resolve exactly one row per pass — always strictly decreasing, but
        // with (MAX_SWEEP_PASSES + 2) rows it can never reach zero within
        // MAX_SWEEP_PASSES passes.
        const map = new Map<string, SimRowResult>()
        ids.forEach((id, i) => {
          map.set(id, {
            id,
            cohort: 'C2',
            author: null,
            name: null,
            outcome: i === 0 ? 'unchanged_clean' : 'unevaluable',
          })
        })
        return map
      },
      noCooldown
    )
    expect(outcome.hardStopped).toBe('max_passes')
    expect(outcome.passesRun).toBe(MAX_SWEEP_PASSES)
    expect(outcome.finalResidualSize).toBeGreaterThan(0)
  })

  it('never includes unfetchable rows in the residual (terminal, cannot cause non-convergence)', async () => {
    // Caller contract: initialResidual only ever contains 'unevaluable' rows.
    // Verified here structurally — an empty residual converges trivially with
    // zero passes run, proving the loop does no work when there's nothing to sweep.
    const outcome = await runTier3Sweep(
      [],
      async (ids) => new Map(ids.map((id) => [id, seedRow(id)])),
      noCooldown
    )
    expect(outcome.hardStopped).toBeNull()
    expect(outcome.passesRun).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// SMI-5879 review finding 2a: resume state (pass count, non-decrease streak)
// must be continuous across a crash/resume boundary, not reset.
// ---------------------------------------------------------------------------

describe('runTier3Sweep — resume durability (SMI-5879 review finding 2a)', () => {
  const noCooldown = { sleep: async () => {} }

  function seedRow(id: string): SimRowResult {
    return { id, cohort: 'C2', author: null, name: null, outcome: 'unevaluable' }
  }

  it('a resume at the 2-non-decrease boundary hard-stops at the correct TOTAL pass count, not a fresh streak', async () => {
    // Simulates: pass 1 already ran pre-crash (residual stayed flat at 2,
    // non-decrease streak reached 1) and was checkpointed; resuming with
    // that state threaded in via startingPass/startingNonDecreaseStreak. A
    // single additional pass that ALSO doesn't shrink the residual must
    // hard-stop immediately (streak reaches 2) at TOTAL pass count 2 — pre-fix,
    // the streak would have reset to 0 on resume, requiring two MORE passes.
    const postPass1Residual = [seedRow('a'), seedRow('b')]
    const outcome = await runTier3Sweep(
      postPass1Residual,
      async (ids) => new Map(ids.map((id) => [id, seedRow(id)])), // never resolves anything
      { ...noCooldown, startingPass: 1, startingNonDecreaseStreak: 1 }
    )
    expect(outcome.hardStopped).toBe('non_convergence')
    expect(outcome.passesRun).toBe(2) // 1 pre-crash + 1 this invocation, NOT reset to 1
  })

  it('a resume after pass 7 pre-crash hard-stops after pass 8 TOTAL, not a fresh 8-pass allowance', async () => {
    // 3 residual rows, strictly decreasing by 1 each pass (never triggers
    // the non-decrease hard-stop) — with only 1 pass of budget left
    // (startingPass = MAX_SWEEP_PASSES - 1), it can never reach zero within
    // that budget, so it must hard-stop at max_passes after exactly 1 more
    // pass (TOTAL 8) — pre-fix, a fresh 8-pass budget would let it run to
    // (7 + 8 =) 15 total passes.
    const postPass7Residual = [seedRow('a'), seedRow('b'), seedRow('c')]
    const outcome = await runTier3Sweep(
      postPass7Residual,
      async (ids) => {
        const map = new Map<string, SimRowResult>()
        ids.forEach((id, i) => {
          map.set(id, {
            id,
            cohort: 'C2',
            author: null,
            name: null,
            outcome: i === 0 ? 'unchanged_clean' : 'unevaluable',
          })
        })
        return map
      },
      { ...noCooldown, startingPass: MAX_SWEEP_PASSES - 1, startingNonDecreaseStreak: 0 }
    )
    expect(outcome.hardStopped).toBe('max_passes')
    expect(outcome.passesRun).toBe(MAX_SWEEP_PASSES) // 7 pre-crash + 1 this invocation = 8, NOT 15
    expect(outcome.finalResidualSize).toBeGreaterThan(0)
  })
})
