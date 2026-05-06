/**
 * SMI-4702 — Type-level + runtime guard for rerank.ts exports.
 *
 * Purpose: catch any Wave 3c (SMI-4707) rename of DEFAULT_BOOST_MEMORY or
 * DEFAULT_DAMPEN_PROCESS that would silently break eval/ablation-runner.ts.
 * If either export disappears or changes value, this test fails immediately.
 */

import { describe, it, expect } from 'vitest'
import { DEFAULT_BOOST_MEMORY, DEFAULT_DAMPEN_PROCESS } from '../../src/rerank.js'

describe('rerank.ts — eval-harness-contract exports', () => {
  it('DEFAULT_BOOST_MEMORY is a number', () => {
    expect(typeof DEFAULT_BOOST_MEMORY).toBe('number')
  })

  it('DEFAULT_BOOST_MEMORY equals 1.5', () => {
    expect(DEFAULT_BOOST_MEMORY).toBe(1.5)
  })

  it('DEFAULT_DAMPEN_PROCESS is a number', () => {
    expect(typeof DEFAULT_DAMPEN_PROCESS).toBe('number')
  })

  it('DEFAULT_DAMPEN_PROCESS equals 0.85', () => {
    expect(DEFAULT_DAMPEN_PROCESS).toBe(0.85)
  })

  it('both constants are finite positive numbers', () => {
    expect(Number.isFinite(DEFAULT_BOOST_MEMORY)).toBe(true)
    expect(DEFAULT_BOOST_MEMORY).toBeGreaterThan(0)
    expect(Number.isFinite(DEFAULT_DAMPEN_PROCESS)).toBe(true)
    expect(DEFAULT_DAMPEN_PROCESS).toBeGreaterThan(0)
  })
})
