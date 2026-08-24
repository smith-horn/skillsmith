/**
 * Tests for the shared account-area path normalization (SMI-6112).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  isAccountPageMounted,
  isCurrentAccountPath,
  normalizeAccountPath,
} from './account-page-path'

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

describe('isAccountPageMounted', () => {
  /** Minimal `{ querySelector }` stub — no real DOM in the `node` vitest environment. */
  function fakeDoc(present: string[]): Pick<Document, 'querySelector'> {
    return {
      querySelector: vi.fn((selector: string) => {
        for (const path of present) {
          if (selector === `[data-account-page="${path}"]`) return {} as Element
        }
        return null
      }),
    }
  }

  it('reports true when the marker for the expected path is present', () => {
    for (const path of CANONICAL_PATHS) {
      expect(isAccountPageMounted(path, fakeDoc([path])), path).toBe(true)
    }
  })

  it('reports false when the live document has no marker at all', () => {
    expect(isAccountPageMounted('/account', fakeDoc([]))).toBe(false)
  })

  it('reports false when the live document has a DIFFERENT page marker (SMI-6154 core case: DOM belongs to another route)', () => {
    expect(isAccountPageMounted('/account', fakeDoc(['/account/team/members']))).toBe(false)
  })

  it('queries the exact attribute selector, not a substring or prefix match', () => {
    const doc = fakeDoc(['/account/team/members'])
    expect(isAccountPageMounted('/account/team', doc)).toBe(false)
    expect(doc.querySelector).toHaveBeenCalledWith('[data-account-page="/account/team"]')
  })

  it('defaults to the global document when none is injected', () => {
    // No real DOM in the `node` vitest environment — stub a global
    // `document` for the duration of this test so the omitted-second-arg
    // call shape (the real production call site: `isAccountPageMounted('/account')`)
    // is genuinely exercised, not just documented.
    vi.stubGlobal('document', fakeDoc(['/account']))
    try {
      expect(isAccountPageMounted('/account')).toBe(true)
      expect(isAccountPageMounted('/account/team/members')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
