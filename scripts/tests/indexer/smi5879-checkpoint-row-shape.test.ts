/**
 * SMI-6481: direct unit coverage of
 * `smi5879-simulate-full.checkpoint-row-shape.ts`.
 *
 * The `readCheckpoint`-driven tests in
 * `smi5879-simulate-full.checkpoint.test.ts` exercise this module through JSON
 * on disk, which is the real production path but cannot express `NaN` or
 * `Infinity` — standard JSON has no literal for either. Those are exactly the
 * values `Number.isFinite` exists to reject (a bare `typeof === 'number'`
 * accepts both), so the finite check has no reachable JSON-level test. Calling
 * the exported validator directly is the only way to cover that branch rather
 * than assert it works by inspection.
 *
 * @module scripts/tests/indexer/smi5879-checkpoint-row-shape
 */

import { describe, it, expect } from 'vitest'
import {
  describeValue,
  validateCheckpointRowShape,
} from '../../indexer/smi5879-simulate-full.checkpoint-row-shape.ts'

const validRow = {
  id: 'row-1',
  cohort: 'C2',
  author: null,
  name: null,
  outcome: 'bundle_absent',
}

describe('validateCheckpointRowShape', () => {
  it('accepts a minimal valid row and a fully-populated scored row', () => {
    expect(validateCheckpointRowShape('row-1', validRow)).toEqual([])
    expect(
      validateCheckpointRowShape('row-1', {
        ...validRow,
        prePortQuarantine: true,
        postPortQuarantine: true,
        prePortRiskScore: 40,
        postPortRiskScore: 41,
        reason: 'every sibling target 404d',
        unfetchable_subtype: 'url_parse',
      })
    ).toEqual([])
  })

  it('rejects a non-object row without inspecting further', () => {
    expect(validateCheckpointRowShape('row-1', 'nope')).toEqual([
      'row_results.row-1 (not an object)',
    ])
    expect(validateCheckpointRowShape('row-1', null)).toEqual(['row_results.row-1 (not an object)'])
    expect(validateCheckpointRowShape('row-1', [])).toEqual(['row_results.row-1 (not an object)'])
  })

  // The whole reason this module exists: JSON cannot carry NaN/Infinity, so
  // these branches are unreachable from `readCheckpoint` and would otherwise
  // ship untested.
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects a %s risk score that a bare typeof check would accept', (_label, value) => {
    // Guard the premise: these ARE typeof 'number', so a `typeof` check passes.
    expect(typeof value).toBe('number')

    const preErrors = validateCheckpointRowShape('row-1', { ...validRow, prePortRiskScore: value })
    expect(preErrors).toHaveLength(1)
    expect(preErrors[0]).toMatch(/prePortRiskScore=.* \(must be a finite number/)

    const postErrors = validateCheckpointRowShape('row-1', {
      ...validRow,
      postPortRiskScore: value,
    })
    expect(postErrors).toHaveLength(1)
    expect(postErrors[0]).toMatch(/postPortRiskScore=.* \(must be a finite number/)
  })

  it('reports every violation on a row at once, not just the first', () => {
    const errors = validateCheckpointRowShape('row-1', {
      id: 42,
      cohort: 'C9',
      outcome: 'not_an_outcome',
      prePortQuarantine: 'yes',
      postPortQuarantine: 'no',
      prePortRiskScore: 'forty',
      postPortRiskScore: Number.NaN,
      reason: 7,
      unfetchable_subtype: 'invented',
    })
    // id, cohort, outcome, 2 booleans, 2 scores, reason, subtype = 9.
    expect(errors).toHaveLength(9)
  })

  it('accepts absent optional fields (undefined is not a violation)', () => {
    expect(
      validateCheckpointRowShape('row-1', {
        ...validRow,
        prePortQuarantine: undefined,
        prePortRiskScore: undefined,
        reason: undefined,
        unfetchable_subtype: undefined,
      })
    ).toEqual([])
  })
})

describe('describeValue', () => {
  it.each([
    ['a string, quoted so it is distinct from a boolean', 'true', '"true"'],
    ['null', null, 'null'],
    ['a number', 40, '40'],
    ['NaN as a readable token, not null', Number.NaN, 'NaN'],
    ['Infinity as a readable token, not null', Number.POSITIVE_INFINITY, 'Infinity'],
    ['an object, not [object Object]', { nested: true }, '{"nested":true}'],
    ['an array, not the empty string', [1, 2], '[1,2]'],
    ['a boolean', false, 'false'],
  ])('renders %s', (_label, value, expected) => {
    expect(describeValue(value)).toBe(expected)
  })

  it('falls back rather than throwing on a circular structure', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(() => describeValue(circular)).not.toThrow()
  })

  // SMI-6481 (governance round 3, finding SF4): the truncation cap and the
  // `safeToString` fallback shipped in round 2 with no coverage at all.
  describe('length cap and total fallback', () => {
    it('truncates an over-long rendered value and marks it elided', () => {
      const rendered = describeValue('x'.repeat(5000))
      expect(rendered.endsWith('…')).toBe(true)
      // 200 code points + the ellipsis. Well under the raw 5002-char render.
      expect(Array.from(rendered)).toHaveLength(201)
    })

    it('truncates a bigint too — the number short-circuit must not bypass the cap', () => {
      // Round-3 finding: the original `typeof number|bigint` branch returned
      // before truncation, and a bigint has no length bound (10n ** 300n is
      // 301 chars).
      const rendered = describeValue(10n ** 300n)
      expect(Array.from(rendered)).toHaveLength(201)
      expect(rendered.endsWith('…')).toBe(true)
    })

    it('leaves a short value untouched, with no ellipsis', () => {
      expect(describeValue('short')).toBe('"short"')
      expect(describeValue(42)).toBe('42')
    })

    it('never splits a surrogate pair when truncating', () => {
      // A raw `String.prototype.slice` cuts mid-pair and emits a lone
      // surrogate into an operator-facing message.
      const rendered = describeValue('😀'.repeat(500))
      expect(rendered).not.toMatch(/[\uD800-\uDBFF]$/)
      expect(rendered.endsWith('…')).toBe(true)
    })

    // Covers the multi-byte truncation path. Note what it does NOT prove:
    // `truncateRendered`'s `prefix.length === rendered.length` condition is
    // defensive against a case `describeValue` cannot actually produce (every
    // JSON rendering opens with a BMP character, so a 2*MAX-unit prefix never
    // holds exactly MAX code points). Mutating that condition to the naive
    // `codePoints.length <= MAX` fails no test — stated here so nobody reads
    // this as a regression test for it.
    it('truncates a long all-surrogate-pair value rather than returning it whole', () => {
      const rendered = describeValue('😀'.repeat(5000))
      expect(rendered.endsWith('…')).toBe(true)
      expect(Array.from(rendered).length).toBeLessThanOrEqual(201)
    })

    it('leaves a multi-byte value alone when its CODE POINT count fits', () => {
      // 150 emoji = 300 UTF-16 code units (over the cap) but only 150 code
      // points (under it) — must not truncate. Guards the inverse mistake.
      const value = '😀'.repeat(150)
      const rendered = describeValue(value)
      expect(rendered.endsWith('…')).toBe(false)
      expect(rendered).toBe(JSON.stringify(value))
    })

    it('does not throw on a null-prototype object, whose String() conversion throws', () => {
      // `String(Object.create(null))` raises "Cannot convert object to
      // primitive value" — the fallback must be total, since it runs inside
      // the error-reporting path itself.
      const nullProto = Object.create(null) as Record<string, unknown>
      nullProto['self'] = nullProto // also circular, to force the catch branch
      expect(() => describeValue(nullProto)).not.toThrow()
      expect(describeValue(nullProto)).toBe('(unrenderable value)')
    })
  })
})
