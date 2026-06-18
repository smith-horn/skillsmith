/**
 * Facet driver state-machine tests (SMI-5286 1c)
 * @module scripts/tests/indexer/backfill-checkpoint.statemachine
 *
 * The cursor <-> crawl-frontier state machine that drives the size-faceted
 * backfill: a depth-first walk of the static `buildSizeFacets()` ladder where a
 * saturated facet is bisected (its halves drained before the next facet) and the
 * frontier (facetIndex + bisection stack + page) round-trips losslessly through
 * the JSON checkpoint. Split out of backfill-checkpoint.test.ts to keep each file
 * focused + under the 500-line convention.
 */

import { describe, it, expect } from 'vitest'
import {
  cursorToFacetState,
  currentFacetRange,
  bisectCurrentFacet,
  advanceFacet,
  isFacetCrawlDone,
  facetStateToCursor,
  type FacetCrawlState,
} from '../../indexer/backfill-checkpoint.ts'
import { buildSizeFacets } from '../../indexer/code-search.facets.ts'

const FACETS = buildSizeFacets()

describe('facet driver state machine (SMI-5286 1c)', () => {
  it('cursorToFacetState cold-starts on null/undefined', () => {
    expect(cursorToFacetState(null)).toEqual({ facetIndex: 0, pendingSubranges: [], lastPage: 0 })
    expect(cursorToFacetState(undefined)).toEqual({
      facetIndex: 0,
      pendingSubranges: [],
      lastPage: 0,
    })
  })

  it('cursorToFacetState reconstructs facet_index, last_page, and pending_subranges', () => {
    const state = cursorToFacetState({
      path: '',
      facet: '0-63',
      last_page: 2,
      facet_index: 3,
      pending_subranges: [
        [0, 63],
        [64, 127],
      ],
    })
    expect(state.facetIndex).toBe(3)
    expect(state.lastPage).toBe(2)
    expect(state.pendingSubranges).toEqual([
      { lo: 0, hi: 63 },
      { lo: 64, hi: 127 },
    ])
  })

  it('cursorToFacetState maps a null upper bound back to Infinity', () => {
    const state = cursorToFacetState({
      path: '',
      facet: '16384+',
      last_page: 0,
      facet_index: 8,
      pending_subranges: [[16384, null]],
    })
    expect(state.pendingSubranges[0]).toEqual({ lo: 16384, hi: Number.POSITIVE_INFINITY })
  })

  it('currentFacetRange returns the top-level facet when the stack is empty', () => {
    const state: FacetCrawlState = { facetIndex: 0, pendingSubranges: [], lastPage: 0 }
    expect(currentFacetRange(state, FACETS)).toEqual(FACETS[0])
  })

  it('currentFacetRange returns the stack head (LIFO) when a bisection is in progress', () => {
    const state: FacetCrawlState = {
      facetIndex: 0,
      pendingSubranges: [
        { lo: 64, hi: 127 },
        { lo: 0, hi: 63 },
      ],
      lastPage: 0,
    }
    expect(currentFacetRange(state, FACETS)).toEqual({ lo: 0, hi: 63 })
  })

  it('currentFacetRange returns null once the ladder is exhausted', () => {
    const state: FacetCrawlState = {
      facetIndex: FACETS.length,
      pendingSubranges: [],
      lastPage: 0,
    }
    expect(currentFacetRange(state, FACETS)).toBeNull()
  })

  it('bisectCurrentFacet RETIRES the top-level facet (facetIndex++) before pushing halves', () => {
    // C-1 regression: a top-level bisection must advance facetIndex so the facet
    // is never re-queried after its halves drain (else it re-saturates forever).
    const state: FacetCrawlState = { facetIndex: 0, pendingSubranges: [], lastPage: 4 }
    const ok = bisectCurrentFacet(state, { lo: 0, hi: 127 })
    expect(ok).toBe(true)
    expect(state.pendingSubranges).toEqual([
      { lo: 64, hi: 127 },
      { lo: 0, hi: 63 },
    ])
    expect(currentFacetRange(state, FACETS)).toEqual({ lo: 0, hi: 63 }) // crawled next
    expect(state.lastPage).toBe(0)
    expect(state.facetIndex).toBe(1) // top-level facet retired
  })

  it('C-1: after a top-level facet bisects and both halves drain, the NEXT facet is reached (no re-crawl)', () => {
    const state: FacetCrawlState = { facetIndex: 0, pendingSubranges: [], lastPage: 0 }
    bisectCurrentFacet(state, FACETS[0]) // facet 0 saturated → halves on stack, facetIndex=1
    expect(currentFacetRange(state, FACETS)).toEqual({ lo: 0, hi: 63 })
    advanceFacet(state) // lower half done → pop
    expect(currentFacetRange(state, FACETS)).toEqual({ lo: 64, hi: 127 })
    advanceFacet(state) // upper half done → pop; stack now empty
    // The frontier must move to facet 1, NOT back to the (saturating) facet 0.
    expect(state.pendingSubranges).toEqual([])
    expect(currentFacetRange(state, FACETS)).toEqual(FACETS[1])
    expect(state.facetIndex).toBe(1)
  })

  it('bisectCurrentFacet replaces the stack head with its halves (sub-range bisection, facetIndex unchanged)', () => {
    const state: FacetCrawlState = {
      facetIndex: 2,
      pendingSubranges: [{ lo: 0, hi: 63 }],
      lastPage: 1,
    }
    bisectCurrentFacet(state, { lo: 0, hi: 63 })
    expect(state.pendingSubranges).toEqual([
      { lo: 32, hi: 63 },
      { lo: 0, hi: 31 },
    ])
    expect(state.facetIndex).toBe(2) // a sub-range bisected — top-level index does not move
  })

  it('bisectCurrentFacet returns false for an unsplittable range (lo === hi)', () => {
    const state: FacetCrawlState = { facetIndex: 0, pendingSubranges: [], lastPage: 0 }
    expect(bisectCurrentFacet(state, { lo: 5, hi: 5 })).toBe(false)
    expect(state.pendingSubranges).toEqual([])
    expect(state.facetIndex).toBe(0) // no retirement on a failed bisect
  })

  it('advanceFacet pops the stack when bisecting, else increments facetIndex', () => {
    const withStack: FacetCrawlState = {
      facetIndex: 1,
      pendingSubranges: [{ lo: 0, hi: 63 }],
      lastPage: 3,
    }
    advanceFacet(withStack)
    expect(withStack.pendingSubranges).toEqual([])
    expect(withStack.facetIndex).toBe(1) // unchanged — a sub-range finished, not the facet
    expect(withStack.lastPage).toBe(0)

    const noStack: FacetCrawlState = { facetIndex: 1, pendingSubranges: [], lastPage: 3 }
    advanceFacet(noStack)
    expect(noStack.facetIndex).toBe(2)
    expect(noStack.lastPage).toBe(0)
  })

  it('isFacetCrawlDone is true only when the ladder AND the bisection frontier are empty', () => {
    expect(
      isFacetCrawlDone({ facetIndex: FACETS.length, pendingSubranges: [], lastPage: 0 }, FACETS)
    ).toBe(true)
    expect(
      isFacetCrawlDone(
        { facetIndex: FACETS.length, pendingSubranges: [{ lo: 0, hi: 63 }], lastPage: 0 },
        FACETS
      )
    ).toBe(false)
    expect(isFacetCrawlDone({ facetIndex: 3, pendingSubranges: [], lastPage: 0 }, FACETS)).toBe(
      false
    )
  })

  it('facetStateToCursor → cursorToFacetState round-trips through JSON (Infinity survives as null)', () => {
    const state: FacetCrawlState = {
      facetIndex: 8,
      pendingSubranges: [{ lo: 16384, hi: Number.POSITIVE_INFINITY }],
      lastPage: 2,
    }
    const cursor = facetStateToCursor(state, '.agents/skills', FACETS)
    // The open-ended upper bound is persisted as null (JSON-safe).
    expect(cursor.pending_subranges).toEqual([[16384, null]])
    expect(cursor.path).toBe('.agents/skills')

    // Survive a real JSON round-trip (the audit_logs metadata path).
    const roundTripped = JSON.parse(JSON.stringify(cursor))
    const restored = cursorToFacetState(roundTripped)
    expect(restored).toEqual(state)
  })

  it("facetStateToCursor reports facet 'done' when the ladder is exhausted", () => {
    const cursor = facetStateToCursor(
      { facetIndex: FACETS.length, pendingSubranges: [], lastPage: 0 },
      '',
      FACETS
    )
    expect(cursor.facet).toBe('done')
    expect(cursor.facet_index).toBe(FACETS.length)
  })
})
