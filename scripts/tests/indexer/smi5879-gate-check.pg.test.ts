/**
 * SMI-5879 Wave 3 item 4: smi5879-gate-check.pg.ts test suite — direct unit
 * tests of {@link parseFreezeLeakCount} (finding #6, adversarial review).
 * Pure-function test, no live Postgres needed — matches this suite's own
 * documented convention (`smi5879-gate-check.fixtures.ts`'s module doc:
 * "gate-check.ts introduces NO new SQL objects... this suite does not need
 * to re-verify [.pg.ts] against Postgres"). `countFreezeLeak` itself is a
 * thin `queryScalar` wrapper around this function — exercising the parser in
 * isolation covers the actual bug (a malformed scalar silently becoming a
 * "clean" 0) without standing up a database.
 * @module scripts/tests/indexer/smi5879-gate-check.pg
 *
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.5, §12
 */

import { describe, it, expect } from 'vitest'
import { parseFreezeLeakCount } from '../../indexer/smi5879-gate-check.pg.ts'

describe('smi5879-gate-check.pg.ts — finding #6: parseFreezeLeakCount', () => {
  it('parses well-formed non-negative integer strings', () => {
    expect(parseFreezeLeakCount('0')).toBe(0)
    expect(parseFreezeLeakCount('1')).toBe(1)
    expect(parseFreezeLeakCount('12345')).toBe(12345)
  })

  it('throws on null (the query returned no row / no cell) — never silently 0', () => {
    expect(() => parseFreezeLeakCount(null)).toThrow(/unparseable\/malformed scalar/)
    expect(() => parseFreezeLeakCount(null)).toThrow(/raw=null/)
  })

  it('throws on a negative number string — never silently 0 or the (wrong) negative value', () => {
    expect(() => parseFreezeLeakCount('-5')).toThrow(/unparseable\/malformed scalar/)
  })

  it('throws on a non-integer (decimal) string — never silently coerced', () => {
    expect(() => parseFreezeLeakCount('3.5')).toThrow(/unparseable\/malformed scalar/)
  })

  it('throws on a non-numeric garbage string — never silently 0 (the exact bug: Number("abc") is NaN, and NaN > 0 is false)', () => {
    expect(() => parseFreezeLeakCount('abc')).toThrow(/unparseable\/malformed scalar/)
    expect(() => parseFreezeLeakCount('NaN')).toThrow(/unparseable\/malformed scalar/)
  })

  it('throws on an empty string', () => {
    expect(() => parseFreezeLeakCount('')).toThrow(/unparseable\/malformed scalar/)
  })

  it('throws on a numeric string with leading/trailing whitespace or a sign prefix (strict format only)', () => {
    expect(() => parseFreezeLeakCount(' 5')).toThrow(/unparseable\/malformed scalar/)
    expect(() => parseFreezeLeakCount('5 ')).toThrow(/unparseable\/malformed scalar/)
    expect(() => parseFreezeLeakCount('+5')).toThrow(/unparseable\/malformed scalar/)
  })
})
