/**
 * Tests for the navigation-epoch guard (SMI-6112).
 *
 * `packages/website/vitest.config.ts` runs the `node` environment (no
 * `document`), so these tests drive the guard via the directly-exported
 * `advanceNavigationEpoch()` rather than a real `astro:page-load` DOM event
 * — see the module's own doc comment for why that export exists.
 */

import { describe, expect, it } from 'vitest'
import { advanceNavigationEpoch, createNavigationEpochGuard } from './account-navigation-epoch'

describe('createNavigationEpochGuard', () => {
  it('reports fresh (not stale) immediately after capture', () => {
    const guard = createNavigationEpochGuard()
    expect(guard.isStale()).toBe(false)
  })

  it('reports stale once a newer astro:page-load fires', () => {
    const guard = createNavigationEpochGuard()
    advanceNavigationEpoch()
    expect(guard.isStale()).toBe(true)
  })

  it('stays fresh across repeated isStale() calls when no navigation occurred', () => {
    const guard = createNavigationEpochGuard()
    expect(guard.isStale()).toBe(false)
    expect(guard.isStale()).toBe(false)
    expect(guard.isStale()).toBe(false)
  })

  it('remains stale after multiple subsequent advances, not just the first', () => {
    const guard = createNavigationEpochGuard()
    advanceNavigationEpoch()
    advanceNavigationEpoch()
    advanceNavigationEpoch()
    expect(guard.isStale()).toBe(true)
  })

  it('a guard captured AFTER an advance is fresh relative to that advance', () => {
    advanceNavigationEpoch()
    const guard = createNavigationEpochGuard()
    expect(guard.isStale()).toBe(false)
  })

  it('models the A-B-A case: an older guard stays stale even after a newer guard is also stale', () => {
    // First navigation: page mounts, captures its epoch.
    const first = createNavigationEpochGuard()

    // User navigates away, then back to the same route: two more
    // astro:page-load events fire, and the page mounts again, capturing a
    // second, fresher guard.
    advanceNavigationEpoch()
    advanceNavigationEpoch()
    const second = createNavigationEpochGuard()

    expect(first.isStale()).toBe(true)
    expect(second.isStale()).toBe(false)

    // A third navigation invalidates both.
    advanceNavigationEpoch()
    expect(first.isStale()).toBe(true)
    expect(second.isStale()).toBe(true)
  })

  it('independent guards captured at the same epoch share staleness', () => {
    const guardA = createNavigationEpochGuard()
    const guardB = createNavigationEpochGuard()
    expect(guardA.epoch).toBe(guardB.epoch)
    advanceNavigationEpoch()
    expect(guardA.isStale()).toBe(true)
    expect(guardB.isStale()).toBe(true)
  })
})
