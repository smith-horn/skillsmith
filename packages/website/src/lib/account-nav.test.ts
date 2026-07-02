/**
 * Tests for account sidebar nav data + active-link logic (SMI-5475).
 */

import { describe, expect, it } from 'vitest'
import { ACCOUNT_NAV_SECTIONS, isActiveAccountNav } from './account-nav'

describe('isActiveAccountNav', () => {
  it('matches the dashboard exactly, with and without trailing slash', () => {
    expect(isActiveAccountNav('/account', '/account')).toBe(true)
    expect(isActiveAccountNav('/account', '/account/')).toBe(true)
  })

  it('does not light the dashboard on subpages', () => {
    expect(isActiveAccountNav('/account', '/account/subscription')).toBe(false)
    expect(isActiveAccountNav('/account', '/account/team/members')).toBe(false)
  })

  it('matches exact subpages regardless of trailing slash on either side', () => {
    expect(isActiveAccountNav('/account/cli-token/', '/account/cli-token')).toBe(true)
    expect(isActiveAccountNav('/account/cli-token/', '/account/cli-token/')).toBe(true)
    expect(isActiveAccountNav('/account/billing', '/account/billing/')).toBe(true)
  })

  it('keeps Team lit across the team sub-tabs', () => {
    expect(isActiveAccountNav('/account/team', '/account/team')).toBe(true)
    expect(isActiveAccountNav('/account/team', '/account/team/')).toBe(true)
    expect(isActiveAccountNav('/account/team', '/account/team/members')).toBe(true)
    expect(isActiveAccountNav('/account/team', '/account/team/workspaces')).toBe(true)
    expect(isActiveAccountNav('/account/team', '/account/team/analytics')).toBe(true)
  })

  it('does not false-positive on sibling paths sharing the team prefix', () => {
    expect(isActiveAccountNav('/account/team', '/account/teammates')).toBe(false)
  })

  it('never activates docs links on account paths', () => {
    for (const path of ['/account', '/account/billing', '/account/team/members']) {
      expect(isActiveAccountNav('/docs/quickstart', path)).toBe(false)
      expect(isActiveAccountNav('/docs/api', path)).toBe(false)
    }
  })

  it('activates exactly one item per account page', () => {
    const allItems = ACCOUNT_NAV_SECTIONS.flatMap((s) => s.items)
    const accountPaths = [
      '/account',
      '/account/profile',
      '/account/cli-token/',
      '/account/skills',
      '/account/subscription',
      '/account/billing',
      '/account/team',
      '/account/team/members',
      '/account/outreach-preferences',
      '/account/telemetry',
    ]
    for (const path of accountPaths) {
      const active = allItems.filter((i) => isActiveAccountNav(i.href, path))
      expect(active, `path ${path}`).toHaveLength(1)
    }
  })
})

describe('ACCOUNT_NAV_SECTIONS', () => {
  it('has unique hrefs', () => {
    const hrefs = ACCOUNT_NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href))
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('has an icon and label on every item', () => {
    for (const item of ACCOUNT_NAV_SECTIONS.flatMap((s) => s.items)) {
      expect(item.icon).toBeTruthy()
      expect(item.label).toBeTruthy()
    }
  })
})
