/**
 * Tests for version-utils shared library
 */

import { describe, it, expect } from 'vitest'
import {
  incrementVersion,
  isValidSemver,
  compareSemver,
  parseConventionalCommit,
  formatChangelogSection,
} from '../lib/version-utils'

describe('incrementVersion', () => {
  it('should increment patch version', () => {
    expect(incrementVersion('1.2.3', 'patch')).toBe('1.2.4')
    expect(incrementVersion('0.0.0', 'patch')).toBe('0.0.1')
    expect(incrementVersion('0.4.17', 'patch')).toBe('0.4.18')
  })

  it('should increment minor version and reset patch', () => {
    expect(incrementVersion('1.2.3', 'minor')).toBe('1.3.0')
    expect(incrementVersion('0.4.17', 'minor')).toBe('0.5.0')
  })

  it('should increment major version and reset minor/patch', () => {
    expect(incrementVersion('1.2.3', 'major')).toBe('2.0.0')
    expect(incrementVersion('0.4.17', 'major')).toBe('1.0.0')
  })

  it('should throw on invalid semver', () => {
    expect(() => incrementVersion('1.2', 'patch')).toThrow('Invalid semver')
    expect(() => incrementVersion('abc', 'patch')).toThrow('Invalid semver')
    expect(() => incrementVersion('1.2.3.4', 'patch')).toThrow('Invalid semver')
    expect(() => incrementVersion('1.a.3', 'patch')).toThrow('Invalid semver')
  })
})

describe('isValidSemver', () => {
  it('should accept valid semver strings', () => {
    expect(isValidSemver('0.0.0')).toBe(true)
    expect(isValidSemver('1.2.3')).toBe(true)
    expect(isValidSemver('10.20.30')).toBe(true)
  })

  it('should reject invalid semver strings', () => {
    expect(isValidSemver('1.2')).toBe(false)
    expect(isValidSemver('abc')).toBe(false)
    expect(isValidSemver('1.2.3-beta')).toBe(false)
    expect(isValidSemver('v1.2.3')).toBe(false)
    expect(isValidSemver('')).toBe(false)
  })
})

describe('compareSemver', () => {
  it('should return 0 for equal versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  })

  it('should return positive when a > b', () => {
    expect(compareSemver('1.2.4', '1.2.3')).toBeGreaterThan(0)
    expect(compareSemver('1.3.0', '1.2.9')).toBeGreaterThan(0)
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0)
  })

  it('should return negative when a < b', () => {
    expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0)
    expect(compareSemver('0.4.17', '0.5.0')).toBeLessThan(0)
  })
})

describe('parseConventionalCommit', () => {
  it('should parse feat commits', () => {
    const result = parseConventionalCommit('feat: add new feature')
    expect(result.type).toBe('feat')
    expect(result.message).toBe('add new feature')
    expect(result.breaking).toBe(false)
  })

  it('should parse scoped commits', () => {
    const result = parseConventionalCommit('fix(core): resolve db issue')
    expect(result.type).toBe('fix')
    expect(result.scope).toBe('core')
    expect(result.message).toBe('resolve db issue')
  })

  it('should parse PR numbers', () => {
    const result = parseConventionalCommit('feat: add feature (#123)')
    expect(result.type).toBe('feat')
    expect(result.message).toBe('add feature')
    expect(result.pr).toBe('123')
  })

  it('should parse breaking changes', () => {
    const result = parseConventionalCommit('feat!: breaking change')
    expect(result.type).toBe('feat')
    expect(result.breaking).toBe(true)
    expect(result.message).toBe('breaking change')
  })

  it('should parse scoped breaking changes with PR', () => {
    const result = parseConventionalCommit('fix(api)!: remove deprecated endpoint (#456)')
    expect(result.type).toBe('fix')
    expect(result.scope).toBe('api')
    expect(result.breaking).toBe(true)
    expect(result.message).toBe('remove deprecated endpoint')
    expect(result.pr).toBe('456')
  })

  it('should handle non-conventional commits as other', () => {
    const result = parseConventionalCommit('bump version to 1.0.0')
    expect(result.type).toBe('other')
    expect(result.message).toBe('bump version to 1.0.0')
  })

  it('should extract PR from non-conventional commits', () => {
    const result = parseConventionalCommit('update readme (#789)')
    expect(result.type).toBe('other')
    expect(result.pr).toBe('789')
    expect(result.message).toBe('update readme')
  })
})

describe('formatChangelogSection', () => {
  it('should format entries grouped by type', () => {
    const entries = [
      { type: 'feat', message: 'add search', hash: 'abc1234', breaking: false },
      { type: 'fix', message: 'fix crash', hash: 'def5678', breaking: false, pr: '42' },
    ]
    const result = formatChangelogSection('1.0.0', entries)
    expect(result).toContain('## v1.0.0')
    expect(result).toContain('**Feature**: add search')
    expect(result).toContain('**Fix**: fix crash (#42)')
  })

  it('should filter out chore/ci/docs when meaningful entries exist', () => {
    const entries = [
      { type: 'feat', message: 'add feature', hash: 'a', breaking: false },
      { type: 'chore', message: 'bump deps', hash: 'b', breaking: false },
      { type: 'ci', message: 'fix pipeline', hash: 'c', breaking: false },
    ]
    const result = formatChangelogSection('1.0.0', entries)
    expect(result).toContain('**Feature**: add feature')
    expect(result).not.toContain('bump deps')
    expect(result).not.toContain('fix pipeline')
  })

  it('should include chore entries when no meaningful entries exist', () => {
    const entries = [{ type: 'chore', message: 'bump deps', hash: 'a', breaking: false }]
    const result = formatChangelogSection('1.0.0', entries)
    expect(result).toContain('**Chore**: bump deps')
  })
})
