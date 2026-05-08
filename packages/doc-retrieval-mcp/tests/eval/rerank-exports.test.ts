/**
 * SMI-4702 — Type-level + runtime guard for rerank.ts exports.
 *
 * Purpose: catch any Wave 3c (SMI-4707) rename of DEFAULT_BOOST_MEMORY or
 * DEFAULT_DAMPEN_PROCESS that would silently break eval/ablation-runner.ts.
 *
 * SMI-4764 Wave 4 finding 1: literal value-pins (toBe(1.5), toBe(0.85))
 * short-circuited the byCategory regression detector + sticky-comment
 * renderer when ranking knobs change intentionally — every PR tuning a
 * constant had to update this test in the same commit, defeating the
 * Wave 1 hybrid-threshold gate. Replaced with sane-range bounds: catches
 * absurd values (zero, negative, wildly out-of-range) and the rename
 * case (still covered by typeof + Number.isFinite + the import line),
 * while letting intentional tuning flow through to the proper byCategory
 * regression signal.
 */

import { describe, it, expect } from 'vitest'
import { DEFAULT_BOOST_MEMORY, DEFAULT_DAMPEN_PROCESS } from '../../src/rerank.js'

describe('rerank.ts — eval-harness-contract exports', () => {
  it('DEFAULT_BOOST_MEMORY is a number', () => {
    expect(typeof DEFAULT_BOOST_MEMORY).toBe('number')
  })

  it('DEFAULT_BOOST_MEMORY is in sane range (0 < x <= 5)', () => {
    expect(DEFAULT_BOOST_MEMORY).toBeGreaterThan(0)
    expect(DEFAULT_BOOST_MEMORY).toBeLessThanOrEqual(5)
  })

  it('DEFAULT_DAMPEN_PROCESS is a number', () => {
    expect(typeof DEFAULT_DAMPEN_PROCESS).toBe('number')
  })

  it('DEFAULT_DAMPEN_PROCESS is in sane range (0 < x <= 1)', () => {
    expect(DEFAULT_DAMPEN_PROCESS).toBeGreaterThan(0)
    expect(DEFAULT_DAMPEN_PROCESS).toBeLessThanOrEqual(1)
  })

  it('both constants are finite positive numbers', () => {
    expect(Number.isFinite(DEFAULT_BOOST_MEMORY)).toBe(true)
    expect(DEFAULT_BOOST_MEMORY).toBeGreaterThan(0)
    expect(Number.isFinite(DEFAULT_DAMPEN_PROCESS)).toBe(true)
    expect(DEFAULT_DAMPEN_PROCESS).toBeGreaterThan(0)
  })
})
