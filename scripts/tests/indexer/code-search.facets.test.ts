/**
 * Tests for the size-facet partitioner (SMI-5286 Wave 1c)
 *
 * The facet ladder partitions the broad `filename:SKILL.md` code-search query by
 * file SIZE so each sub-query stays under GitHub's 1000-result ceiling. These
 * tests pin the load-bearing invariants: exhaustive+disjoint+contiguous coverage,
 * a STABLE ladder length across calls (so `facets_total` is static for the
 * checkpoint cursor), inclusive-inclusive `size:` qualifiers (no off-by-one), and
 * the adaptive bisection contract (including its unsplittable guards).
 */

import { describe, it, expect } from 'vitest'
import {
  buildSizeFacets,
  facetId,
  facetToQualifier,
  bisectFacet,
  type SizeFacet,
} from '../../indexer/code-search.facets.ts'

describe('SMI-5286 Wave 1c: buildSizeFacets', () => {
  it('is exhaustive, disjoint, and contiguous over [0, ∞)', () => {
    const facets = buildSizeFacets()

    // Starts at 0.
    expect(facets[0].lo).toBe(0)

    // Each subsequent lo is exactly the prior hi + 1 (disjoint + contiguous, no gaps).
    for (let i = 0; i < facets.length - 1; i++) {
      expect(facets[i + 1].lo).toBe(facets[i].hi + 1)
      // Every interior bucket is finite and well-ordered.
      expect(facets[i].hi).toBeGreaterThanOrEqual(facets[i].lo)
      expect(Number.isFinite(facets[i].hi)).toBe(true)
    }

    // Final bucket is open-ended.
    expect(facets[facets.length - 1].hi).toBe(Number.POSITIVE_INFINITY)
  })

  it('returns a STABLE ladder length across two calls (facets_total must be static)', () => {
    const first = buildSizeFacets()
    const second = buildSizeFacets()
    expect(first.length).toBe(second.length)
    // Same stable identity so facets_total never drifts mid-backfill.
    expect(first).toBe(second)
  })

  it('uses the exact 9-bucket doubling ladder', () => {
    const facets = buildSizeFacets()
    expect(facets).toEqual([
      { lo: 0, hi: 127 },
      { lo: 128, hi: 255 },
      { lo: 256, hi: 511 },
      { lo: 512, hi: 1023 },
      { lo: 1024, hi: 2047 },
      { lo: 2048, hi: 4095 },
      { lo: 4096, hi: 8191 },
      { lo: 8192, hi: 16383 },
      { lo: 16384, hi: Number.POSITIVE_INFINITY },
    ])
  })
})

describe('SMI-5286 Wave 1c: facetToQualifier', () => {
  it('renders the first (finite) bucket as inclusive-inclusive size:0..127', () => {
    const facets = buildSizeFacets()
    expect(facetToQualifier(facets[0])).toBe('size:0..127')
  })

  it('renders the open-ended bucket as size:>=16384 (no off-by-one)', () => {
    const facets = buildSizeFacets()
    expect(facetToQualifier(facets[facets.length - 1])).toBe('size:>=16384')
  })
})

describe('SMI-5286 Wave 1c: facetId', () => {
  it('labels a finite bucket as `${lo}-${hi}`', () => {
    expect(facetId({ lo: 0, hi: 127 })).toBe('0-127')
  })

  it('labels the open-ended bucket as `${lo}+`', () => {
    expect(facetId({ lo: 16384, hi: Number.POSITIVE_INFINITY })).toBe('16384+')
  })
})

describe('SMI-5286 Wave 1c: bisectFacet', () => {
  it('splits a finite bucket into disjoint, contiguous halves covering the same union', () => {
    const halves = bisectFacet({ lo: 0, hi: 127 })
    expect(halves).not.toBeNull()
    const [left, right] = halves as [SizeFacet, SizeFacet]
    expect(left).toEqual({ lo: 0, hi: 63 })
    expect(right).toEqual({ lo: 64, hi: 127 })
    // Disjoint + contiguous: right.lo === left.hi + 1.
    expect(right.lo).toBe(left.hi + 1)
    // Same union: spans the original [0, 127].
    expect(left.lo).toBe(0)
    expect(right.hi).toBe(127)
  })

  it('splits the open-ended bucket by doubling the pivot', () => {
    const halves = bisectFacet({ lo: 16384, hi: Number.POSITIVE_INFINITY })
    expect(halves).not.toBeNull()
    const [left, right] = halves as [SizeFacet, SizeFacet]
    expect(left).toEqual({ lo: 16384, hi: 32767 })
    expect(right).toEqual({ lo: 32768, hi: Number.POSITIVE_INFINITY })
    // Disjoint + contiguous at the pivot.
    expect(right.lo).toBe(left.hi + 1)
  })

  it('returns null for an unsplittable finite facet (lo >= hi)', () => {
    expect(bisectFacet({ lo: 5, hi: 5 })).toBeNull()
    // Inverted/degenerate range is also unsplittable.
    expect(bisectFacet({ lo: 10, hi: 9 })).toBeNull()
  })

  it('returns null for an open-ended facet anchored at 0 (cannot double)', () => {
    expect(bisectFacet({ lo: 0, hi: Number.POSITIVE_INFINITY })).toBeNull()
  })
})
