import { describe, it, expect } from 'vitest'
import { distanceToSimilarity } from '../src/search.js'

describe('distanceToSimilarity', () => {
  it.each([
    { distance: 0, expected: 1.0 },
    { distance: 0.5, expected: 0.75 },
    { distance: 1, expected: 0.5 },
    { distance: 1.5, expected: 0.25 },
    { distance: 2, expected: 0.0 },
  ])('distance=$distance → similarity=$expected', ({ distance, expected }) => {
    expect(distanceToSimilarity(distance)).toBeCloseTo(expected, 6)
  })

  it('clamps slight float-32 negatives to 1.0 (best-match end, per plan-review amendment G)', () => {
    expect(distanceToSimilarity(-1e-7)).toBe(1.0)
  })

  it('clamps large negatives to 1.0 regardless of magnitude', () => {
    expect(distanceToSimilarity(-2)).toBe(1.0)
  })

  it('clamps distance>2 to 0.0 (worst-match end)', () => {
    expect(distanceToSimilarity(2.5)).toBe(0.0)
  })
})
