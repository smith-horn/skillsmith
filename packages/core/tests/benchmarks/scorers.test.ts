import { describe, it, expect } from 'vitest'
import { exactMatchScorer } from '../../src/benchmarks/evoskill/scorers.js'

describe('exactMatchScorer', () => {
  const q = 'test question' // question is unused in exact-match

  it('matches identical strings', () => {
    expect(exactMatchScorer(q, 'hello', 'hello')).toBe(1.0)
  })

  it('matches case-insensitively', () => {
    expect(exactMatchScorer(q, 'Hello', 'hello')).toBe(1.0)
    expect(exactMatchScorer(q, 'HELLO', 'hello')).toBe(1.0)
  })

  it('strips trailing punctuation', () => {
    expect(exactMatchScorer(q, 'hello.', 'hello')).toBe(1.0)
    expect(exactMatchScorer(q, 'hello!', 'hello')).toBe(1.0)
    expect(exactMatchScorer(q, 'hello?', 'hello')).toBe(1.0)
  })

  it('strips whitespace', () => {
    expect(exactMatchScorer(q, '  hello  ', 'hello')).toBe(1.0)
  })

  it('handles numeric tolerance', () => {
    expect(exactMatchScorer(q, '42.005', '42.00')).toBe(1.0)
    expect(exactMatchScorer(q, '42.02', '42.00')).toBe(0.0)
  })

  it('handles with/without units', () => {
    expect(exactMatchScorer(q, '42 kg', '42')).toBe(1.0)
    expect(exactMatchScorer(q, '42', '42 kg')).toBe(1.0)
  })

  it('handles comma-separated alternatives in ground truth', () => {
    expect(exactMatchScorer(q, 'foo', 'foo, bar, baz')).toBe(1.0)
    expect(exactMatchScorer(q, 'bar', 'foo, bar, baz')).toBe(1.0)
    expect(exactMatchScorer(q, 'baz', 'foo, bar, baz')).toBe(1.0)
    expect(exactMatchScorer(q, 'qux', 'foo, bar, baz')).toBe(0.0)
  })

  it('handles commas in numbers', () => {
    expect(exactMatchScorer(q, '1,000', '1000')).toBe(1.0)
    expect(exactMatchScorer(q, '1000', '1,000')).toBe(1.0)
  })

  it('handles percentage sign', () => {
    expect(exactMatchScorer(q, '42%', '42')).toBe(1.0)
    expect(exactMatchScorer(q, '42', '42%')).toBe(1.0)
  })

  it('returns 0.0 for non-matching strings', () => {
    expect(exactMatchScorer(q, 'hello', 'world')).toBe(0.0)
  })

  it('returns 0.0 for empty predicted', () => {
    expect(exactMatchScorer(q, '', 'hello')).toBe(0.0)
  })

  it('handles numeric ground truth vs text predicted', () => {
    expect(exactMatchScorer(q, 'forty-two', '42')).toBe(0.0)
  })
})
