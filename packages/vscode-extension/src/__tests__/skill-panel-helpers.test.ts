/**
 * Tests for skill-panel-helpers.ts
 * Covers: inferRepositoryUrl validation logic
 */
import { describe, it, expect } from 'vitest'
import { inferRepositoryUrl } from '../views/skill-panel-helpers.js'

describe('inferRepositoryUrl', () => {
  it('returns GitHub URL for valid author/name pattern', () => {
    expect(inferRepositoryUrl('tester/test-skill')).toBe('https://github.com/tester/test-skill')
  })

  it('returns null for UUID in second segment (lowercase)', () => {
    expect(inferRepositoryUrl('claude-plugins/550e8400-e29b-41d4-a716-446655440000')).toBeNull()
  })

  it('returns null for UUID in second segment (uppercase)', () => {
    expect(inferRepositoryUrl('claude-plugins/A7584183-4DF5-435E-BB24-CE219C3FAB0A')).toBeNull()
  })

  it('returns null for UUID in first segment', () => {
    expect(inferRepositoryUrl('550e8400-e29b-41d4-a716-446655440000/some-skill')).toBeNull()
  })

  it('returns null for IDs without a slash', () => {
    expect(inferRepositoryUrl('no-slash-id')).toBeNull()
  })

  it('returns null for IDs with multiple slashes', () => {
    expect(inferRepositoryUrl('a/b/c')).toBeNull()
  })

  it('allows dots in repo name', () => {
    expect(inferRepositoryUrl('octocat/hello.world')).toBe('https://github.com/octocat/hello.world')
  })

  it('allows single-character segments', () => {
    expect(inferRepositoryUrl('x/y')).toBe('https://github.com/x/y')
  })

  it('allows underscores in segments', () => {
    expect(inferRepositoryUrl('my_org/my_repo')).toBe('https://github.com/my_org/my_repo')
  })

  it('returns null for empty segments', () => {
    expect(inferRepositoryUrl('/repo')).toBeNull()
    expect(inferRepositoryUrl('owner/')).toBeNull()
  })
})
