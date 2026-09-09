/**
 * SMI-6481: direct unit coverage of
 * `smi5879-simulate-full.checkpoint-coherence.ts`'s
 * `assertCheckpointRowsAreCoherent` — specifically the
 * `MAX_IDS_IN_CHECKPOINT_REMEDIATION` (500) truncation branch, which the
 * indirect `runSimulateFull`-driven regression test in
 * `smi5879-simulate-full.test.ts` never exercises (that test uses exactly
 * ONE poisoned row). Real `SimRowResult` objects throughout — 500/501 of
 * them is cheap (small plain objects), so there's no need for test-only
 * constant injection.
 * @module scripts/tests/indexer/smi5879-simulate-full.checkpoint-coherence
 */

import { describe, it, expect } from 'vitest'
import { assertCheckpointRowsAreCoherent } from '../../indexer/smi5879-simulate-full.checkpoint-coherence.ts'
import type { SimRowResult } from '../../indexer/smi5879-simulate-full.types.ts'

const FAKE_CHECKPOINT_PATH = '/tmp/fake-smi5879-checkpoint.json'

/** A cheap, deliberately-incoherent bundle_absent row (real verdict change mislabeled). */
function incoherentRow(id: string): SimRowResult {
  return {
    id,
    cohort: 'C2',
    author: 'acme',
    name: id,
    outcome: 'bundle_absent',
    prePortQuarantine: true,
    postPortQuarantine: false,
    prePortRiskScore: 40,
    postPortRiskScore: 0,
  }
}

function captureThrow(rows: SimRowResult[]): Error {
  let caught: Error | undefined
  try {
    assertCheckpointRowsAreCoherent(rows, FAKE_CHECKPOINT_PATH)
  } catch (err) {
    caught = err as Error
  }
  expect(caught).toBeDefined()
  return caught as Error
}

describe('assertCheckpointRowsAreCoherent — MAX_IDS_IN_CHECKPOINT_REMEDIATION truncation', () => {
  it('lists ALL ids, with no truncation marker or offline one-liner, at exactly the 500 boundary', () => {
    const rows = Array.from({ length: 500 }, (_, i) => incoherentRow(`bad-${i}`))

    const err = captureThrow(rows)

    expect(err.message).toMatch(/contains 500 internally-\s*inconsistent row\(s\)/)
    // Every one of the 500 ids is actually named.
    for (let i = 0; i < 500; i++) {
      expect(err.message).toContain(`bad-${i}`)
    }
    expect(err.message).not.toMatch(/, and \d+ more/)
    expect(err.message).not.toMatch(/enumerate the full list offline/)
  })

  it('truncates to the first 500 ids, names the true total, adds an "and N more" marker, and includes the offline enumeration one-liner once the population exceeds 500', () => {
    const TOTAL = 501
    const rows = Array.from({ length: TOTAL }, (_, i) => incoherentRow(`bad-${i}`))

    const t0 = Date.now()
    const err = captureThrow(rows)
    const elapsedMs = Date.now() - t0
    expect(elapsedMs).toBeLessThan(1000)

    // True total count (501), not the capped 500.
    expect(err.message).toMatch(/contains 501 internally-\s*inconsistent row\(s\)/)
    // Exactly the first 500 ids (bad-0..bad-499) are listed; the 501st
    // (bad-500) is NOT — it's the one folded into "and 1 more".
    for (let i = 0; i < 500; i++) {
      expect(err.message).toContain(`bad-${i}`)
    }
    expect(err.message).not.toContain('bad-500')
    expect(err.message).toMatch(/, and 1 more/)
    // The offline enumeration one-liner, naming both the real function and
    // the checkpoint path, only renders when capped.
    expect(err.message).toMatch(/enumerate the full list offline/)
    expect(err.message).toContain('findIncoherentRowIds')
    expect(err.message).toContain(FAKE_CHECKPOINT_PATH)
  })
})
