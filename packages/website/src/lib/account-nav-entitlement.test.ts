/**
 * Tests for the shared team-entitlement navigation setter (SMI-6128).
 *
 * `packages/website/vitest.config.ts` runs the `node` environment (see
 * `vitest.preset.ts`), not `jsdom` — there is no real `document` global.
 * These tests stub a minimal fake `document` (just enough `querySelectorAll`
 * + `setAttribute` surface for this module's own usage) via
 * `vi.stubGlobal('document', ...)`, matching the no-DOM-dependency pattern
 * `account-navigation-epoch.test.ts` already established for this package.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAccountNavTeamEntitled } from './account-nav-entitlement'

class FakeElement {
  readonly className: string
  private readonly attributes = new Map<string, string>()

  constructor(className: string) {
    this.className = className
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
}

class FakeDocument {
  private readonly elements: FakeElement[] = []

  register(el: FakeElement): void {
    this.elements.push(el)
  }

  querySelectorAll(selector: string): FakeElement[] {
    const classNames = selector.split(',').map((part) => part.trim().replace(/^\./, ''))
    return this.elements.filter((el) => classNames.includes(el.className))
  }
}

describe('setAccountNavTeamEntitled', () => {
  let fakeDocument: FakeDocument

  beforeEach(() => {
    fakeDocument = new FakeDocument()
    vi.stubGlobal('document', fakeDocument)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sets data-team-entitled="true" on both the desktop and mobile navigation roots', () => {
    const sidebar = new FakeElement('account-sidebar')
    const mobile = new FakeElement('account-mobile-nav')
    fakeDocument.register(sidebar)
    fakeDocument.register(mobile)

    setAccountNavTeamEntitled(true)

    expect(sidebar.getAttribute('data-team-entitled')).toBe('true')
    expect(mobile.getAttribute('data-team-entitled')).toBe('true')
  })

  it('sets data-team-entitled="false" on both the desktop and mobile navigation roots', () => {
    const sidebar = new FakeElement('account-sidebar')
    const mobile = new FakeElement('account-mobile-nav')
    fakeDocument.register(sidebar)
    fakeDocument.register(mobile)

    setAccountNavTeamEntitled(false)

    expect(sidebar.getAttribute('data-team-entitled')).toBe('false')
    expect(mobile.getAttribute('data-team-entitled')).toBe('false')
  })

  it('updates whichever single navigation root is mounted, desktop-only', () => {
    const sidebar = new FakeElement('account-sidebar')
    fakeDocument.register(sidebar)

    setAccountNavTeamEntitled(true)

    expect(sidebar.getAttribute('data-team-entitled')).toBe('true')
  })

  it('updates whichever single navigation root is mounted, mobile-only', () => {
    const mobile = new FakeElement('account-mobile-nav')
    fakeDocument.register(mobile)

    setAccountNavTeamEntitled(false)

    expect(mobile.getAttribute('data-team-entitled')).toBe('false')
  })

  it('is a no-op when neither navigation root is mounted', () => {
    expect(() => setAccountNavTeamEntitled(true)).not.toThrow()
  })

  it('never sets the attribute on an unrelated element', () => {
    const unrelated = new FakeElement('unrelated')
    fakeDocument.register(unrelated)

    setAccountNavTeamEntitled(true)

    expect(unrelated.getAttribute('data-team-entitled')).toBeNull()
  })
})
