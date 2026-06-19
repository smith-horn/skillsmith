/**
 * Tests for skill-ID normalization helpers (#1436 / #1437 cross-reference, C2).
 */
import { describe, it, expect } from 'vitest'
import { skillComparisonKey, buildInstalledKeySet } from '../skillId.js'

describe('skillComparisonKey', () => {
  it('strips an author/ prefix and lowercases', () => {
    expect(skillComparisonKey('smith-horn/My-Skill')).toBe('my-skill')
  })

  it('passes a bare slug through (lowercased)', () => {
    expect(skillComparisonKey('My-Skill')).toBe('my-skill')
  })

  it('keeps only the trailing segment for nested ids', () => {
    expect(skillComparisonKey('org/group/the-skill')).toBe('the-skill')
  })

  it('handles an empty string without throwing', () => {
    expect(skillComparisonKey('')).toBe('')
  })
})

describe('buildInstalledKeySet', () => {
  it('normalizes installed dir slugs into a lookup set', () => {
    const set = buildInstalledKeySet(['my-skill', 'Other-Skill'])
    expect(set.has('my-skill')).toBe(true)
    expect(set.has('other-skill')).toBe(true)
  })

  it('matches a registry author/name hit against an installed dir slug (C2)', () => {
    const set = buildInstalledKeySet(['my-skill'])
    // registry id is `author/name`; installed id is the bare dir slug
    expect(set.has(skillComparisonKey('smith-horn/my-skill'))).toBe(true)
    expect(set.has(skillComparisonKey('smith-horn/not-installed'))).toBe(false)
  })
})
