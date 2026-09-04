/**
 * @fileoverview Unit tests for the shared skill content-hash comparator
 * @see SMI-6343 Wave 2 — repair the content-hash comparison
 */

import { describe, it, expect } from 'vitest'
import { compareSkillContentHashes } from './skill-content-comparison.js'

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
