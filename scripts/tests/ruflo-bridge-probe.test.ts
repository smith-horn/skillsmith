/**
 * SMI-6967 PR-gate (H-A): no test exercised the payload-to-producer
 * derivation at all before this -- every existing liveness-fold test
 * (`ruflo-bridge-state.test.ts`) injects the already-computed
 * `producerPresentThisProbe` boolean directly, so a mutant at the actual
 * derivation site (`isProducerPresent` in `ruflo-bridge-probe.mjs`) stayed
 * green through three review rounds. These tests drive `isProducerPresent`
 * itself from real `memory_bridge_status` payload shapes, asserting the
 * PROPERTY (a valid non-negative INTEGER count arms; anything else does
 * not) rather than re-asserting a value the production code already
 * computed.
 *
 * The mutation this must catch (H-A): reverting the shared
 * `isValidCount(total) && total > 0` check back to the prior inline
 * `Number.isFinite(total) && total > 0` wrongly re-admits a fractional
 * `totalEntries` such as `0.5` -- finite and positive, but not a count any
 * real probe would ever produce. Because `foldLiveness` LATCHES
 * `everProducerPresent` permanently on a single `true` reading, one invalid
 * fractional payload would otherwise arm the gate forever.
 *
 * Importing `ruflo-bridge-probe.mjs` here is safe only because that file now
 * carries an `isMainModule` entry-point guard (same SMI, same PR) -- without
 * it, importing the module for its export would also run `main()` as a side
 * effect (spawn the launcher, take the bridge lock, write state). See that
 * file's own comment at the bottom for why the guard was added.
 */
import { describe, expect, it } from 'vitest'

import { isProducerPresent } from '../ruflo-bridge-probe.mjs'

describe('isProducerPresent — agentdb.totalEntries arm (SMI-6967 H-A: shared isValidCount, not a second Number.isFinite copy)', () => {
  it('arms on an integer totalEntries > 0', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: 1 } })).toBe(true)
  })

  it('does NOT arm on a fractional totalEntries — the H-A mutant case: 0.5 passes Number.isFinite but is not a count', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: 0.5 } })).toBe(false)
  })

  it('does NOT arm on totalEntries === 0 (valid count, but not > 0)', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: 0 } })).toBe(false)
  })

  it('does NOT arm on a negative totalEntries', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: -1 } })).toBe(false)
  })

  it('does NOT arm on a string totalEntries', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: '5' } })).toBe(false)
  })

  it('does NOT arm on Infinity', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: Infinity } })).toBe(false)
  })

  it('does NOT arm on NaN', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: NaN } })).toBe(false)
  })

  it('does NOT arm on a boolean totalEntries', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: true } })).toBe(false)
  })

  it('does NOT arm on an array totalEntries', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: [1] } })).toBe(false)
  })

  it('does NOT arm on an object totalEntries', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: {} } })).toBe(false)
  })

  it('does NOT arm when totalEntries is absent', () => {
    expect(isProducerPresent({ agentdb: {} })).toBe(false)
    expect(isProducerPresent({})).toBe(false)
  })

  it('does NOT arm when totalEntries is explicitly null', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: null } })).toBe(false)
  })
})

describe("isProducerPresent — bridge.status === 'connected' arm (independent of the totalEntries arm)", () => {
  it("arms on bridge.status === 'connected' alone, with no agentdb block at all", () => {
    expect(isProducerPresent({ bridge: { status: 'connected' } })).toBe(true)
  })

  it('arms on a connected bridge even when totalEntries is invalid — the two arms never gate each other', () => {
    expect(
      isProducerPresent({ bridge: { status: 'connected' }, agentdb: { totalEntries: 0.5 } })
    ).toBe(true)
  })

  it("does NOT arm on a non-'connected' bridge.status", () => {
    expect(isProducerPresent({ bridge: { status: 'not-synced' } })).toBe(false)
  })

  it('does NOT arm when bridge.status is absent', () => {
    expect(isProducerPresent({ bridge: {} })).toBe(false)
  })

  it('does NOT arm when bridge is absent entirely', () => {
    expect(isProducerPresent({})).toBe(false)
  })

  it('does NOT arm when bridge is null', () => {
    expect(isProducerPresent({ bridge: null })).toBe(false)
  })
})

describe('isProducerPresent — malformed top-level payload', () => {
  it('does NOT arm, and does not throw, on a null payload', () => {
    expect(isProducerPresent(null)).toBe(false)
  })

  it('does NOT arm, and does not throw, on an undefined payload', () => {
    expect(isProducerPresent(undefined)).toBe(false)
  })
})
