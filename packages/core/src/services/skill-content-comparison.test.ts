/**
 * @fileoverview Unit tests for the shared skill content-hash comparator
 * @see SMI-6343 Wave 2 — repair the content-hash comparison
 */

import { describe, it, expect } from 'vitest'
import { compareSkillContentHashes, firstNonBlankHash } from './skill-content-comparison.js'

describe('compareSkillContentHashes', () => {
  it('returns current when both hashes match exactly', () => {
    const result = compareSkillContentHashes('abc123', 'abc123')
    expect(result.outcome).toBe('current')
    expect(result.reason).toBeUndefined()
  })

  it('returns outdated when the hashes differ', () => {
    const result = compareSkillContentHashes('abc123', 'def456')
    expect(result.outcome).toBe('outdated')
    expect(result.reason).toBeUndefined()
  })

  it('returns unknown with a reason when the installed hash is missing', () => {
    const result = compareSkillContentHashes(null, 'def456')
    expect(result.outcome).toBe('unknown')
    expect(result.reason).toMatch(/no installed content hash/i)
  })

  it('returns unknown with a reason when the installed hash is undefined', () => {
    const result = compareSkillContentHashes(undefined, 'def456')
    expect(result.outcome).toBe('unknown')
    expect(result.reason).toMatch(/no installed content hash/i)
  })

  it('returns unknown with a reason when the registry hash is missing', () => {
    const result = compareSkillContentHashes('abc123', null)
    expect(result.outcome).toBe('unknown')
    expect(result.reason).toMatch(/no registry content hash/i)
  })

  it('returns unknown with a reason when the registry hash is undefined', () => {
    const result = compareSkillContentHashes('abc123', undefined)
    expect(result.outcome).toBe('unknown')
    expect(result.reason).toMatch(/no registry content hash/i)
  })

  it('returns unknown when both hashes are missing', () => {
    const result = compareSkillContentHashes(null, null)
    expect(result.outcome).toBe('unknown')
    expect(result.reason).toMatch(/no installed content hash and no registry content hash/i)
  })

  it('treats a blank/whitespace-only hash the same as missing', () => {
    expect(compareSkillContentHashes('   ', 'abc123').outcome).toBe('unknown')
    expect(compareSkillContentHashes('abc123', '   ').outcome).toBe('unknown')
    expect(compareSkillContentHashes('', '').outcome).toBe('unknown')
  })

  it('is case-sensitive — differently-cased hex digests are treated as different hashes', () => {
    const result = compareSkillContentHashes('ABC123', 'abc123')
    expect(result.outcome).toBe('outdated')
  })

  it('trims surrounding whitespace before comparing', () => {
    const result = compareSkillContentHashes('  abc123  ', 'abc123')
    expect(result.outcome).toBe('current')
  })
})

describe('firstNonBlankHash (adversarial-review addition, SMI-6343)', () => {
  it('returns the first candidate when it is non-blank', () => {
    expect(firstNonBlankHash('abc123', 'def456')).toBe('abc123')
  })

  it('falls through past null/undefined to the next candidate', () => {
    expect(firstNonBlankHash(null, 'def456')).toBe('def456')
    expect(firstNonBlankHash(undefined, 'def456')).toBe('def456')
  })

  it('falls through past a BLANK (whitespace-only) first candidate — the exact case a raw `??` chain gets wrong', () => {
    // `'   ' ?? 'def456'` would incorrectly return '   ' (?? only falls
    // through on null/undefined) — this is the whole reason this helper
    // exists instead of a raw `??` chain at each call site.
    expect(firstNonBlankHash('   ', 'def456')).toBe('def456')
    expect(firstNonBlankHash('', 'def456')).toBe('def456')
  })

  it('trims a winning candidate', () => {
    expect(firstNonBlankHash('  abc123  ')).toBe('abc123')
  })

  it('returns null when every candidate is blank/null/undefined', () => {
    expect(firstNonBlankHash(null, undefined, '   ', '')).toBeNull()
    expect(firstNonBlankHash()).toBeNull()
  })

  it('supports three or more candidates (on-disk-hash fallback chains)', () => {
    expect(firstNonBlankHash('   ', undefined, 'on-disk-hash')).toBe('on-disk-hash')
  })
})
