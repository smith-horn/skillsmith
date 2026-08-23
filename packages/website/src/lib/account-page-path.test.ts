/**
 * Tests for the shared account-area path normalization (SMI-6112).
 */

import { describe, expect, it } from 'vitest'
import { isCurrentAccountPath, normalizeAccountPath } from './account-page-path'

/** The five team-gated account pages this predicate guards (SMI-6112). */
const CANONICAL_PATHS = [
  '/account',
  '/account/team/members',
  '/account/team/workspaces',
  '/account/team/registry',
  '/account/team/analytics',
] as const

describe('normalizeAccountPath', () => {
  it('strips a single trailing slash', () => {
    expect(normalizeAccountPath('/account/')).toBe('/account')
  })

  it('strips multiple trailing slashes', () => {
    expect(normalizeAccountPath('/account///')).toBe('/account')
  })

  it('leaves a path with no trailing slash unchanged', () => {
    expect(normalizeAccountPath('/account/team/members')).toBe('/account/team/members')
  })

  it('leaves the root path as-is rather than stripping it to an empty string', () => {
    expect(normalizeAccountPath('/')).toBe('/')
  })
})

describe('isCurrentAccountPath', () => {
  it('accepts every canonical path against itself', () => {
    for (const path of CANONICAL_PATHS) {
      expect(isCurrentAccountPath(path, path), path).toBe(true)
    }
  })

  it('accepts every canonical path with a trailing slash on the actual path', () => {
    for (const path of CANONICAL_PATHS) {
      expect(isCurrentAccountPath(`${path}/`, path), path).toBe(true)
    }
  })

  it('accepts every canonical path with a trailing slash on the expected path', () => {
    for (const path of CANONICAL_PATHS) {
      expect(isCurrentAccountPath(path, `${path}/`), path).toBe(true)
    }
  })

  it('accepts a trailing slash on both sides', () => {
    for (const path of CANONICAL_PATHS) {
      expect(isCurrentAccountPath(`${path}/`, `${path}/`), path).toBe(true)
    }
  })

  it('rejects every other route', () => {
    expect(isCurrentAccountPath('/account/summary', '/account')).toBe(false)
    expect(isCurrentAccountPath('/account/team', '/account')).toBe(false)
    expect(isCurrentAccountPath('/account/team/members', '/account/team/workspaces')).toBe(false)
    expect(isCurrentAccountPath('/account/team/registry', '/account/team/analytics')).toBe(false)
    expect(isCurrentAccountPath('/login', '/account')).toBe(false)
    expect(isCurrentAccountPath('/', '/account')).toBe(false)
  })

  it('rejects a subpath of the expected route', () => {
    expect(isCurrentAccountPath('/account/team/members/1', '/account/team/members')).toBe(false)
  })

  it('is not fooled by a shared prefix', () => {
    expect(isCurrentAccountPath('/account/team/membersextra', '/account/team/members')).toBe(false)
  })
})
