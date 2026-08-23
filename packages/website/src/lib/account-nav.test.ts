/**
 * Tests for account sidebar nav data + active-link logic (SMI-5475).
 */

import { describe, expect, it } from 'vitest'
import { ACCOUNT_NAV_SECTIONS, isActiveAccountNav } from './account-nav'

describe('ACCOUNT_NAV_SECTIONS', () => {
  it('matches the post-consolidation sidebar structure exactly', () => {
    expect(ACCOUNT_NAV_SECTIONS).toEqual([
      {
        heading: 'Tools',
        items: [
          { href: '/account/cli-token/', label: 'CLI Token', icon: 'terminal' },
          { href: '/account/skills', label: 'Skill Inventory', icon: 'grid' },
        ],
      },
      {
        heading: 'Billing',
        items: [{ href: '/account/billing', label: 'Billing History', icon: 'credit-card' }],
      },
      {
        heading: 'Preferences',
        items: [
          { href: '/account/outreach-preferences', label: 'Outreach', icon: 'bell' },
          { href: '/account/telemetry', label: 'Telemetry', icon: 'activity' },
        ],
      },
      {
        heading: 'Resources',
        items: [
          { href: '/docs/quickstart', label: 'Getting Started', icon: 'play-circle' },
          { href: '/docs/api', label: 'API Docs', icon: 'code' },
        ],
      },
    ])
  })

  it('has no Dashboard, Email Address, Subscription, or Team item', () => {
    const labels = ACCOUNT_NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.label))
    expect(labels).not.toContain('Dashboard')
    expect(labels).not.toContain('Email Address')
    expect(labels).not.toContain('Subscription')
    expect(labels).not.toContain('Team')
  })

  it('has no Account or Team section heading', () => {
    const headings = ACCOUNT_NAV_SECTIONS.map((s) => s.heading)
    expect(headings).toEqual(['Tools', 'Billing', 'Preferences', 'Resources'])
    expect(headings).not.toContain('Account')
    expect(headings).not.toContain('Team')
  })

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

/** Every href currently retained in ACCOUNT_NAV_SECTIONS, for parametrized coverage. */
const RETAINED_HREFS = ACCOUNT_NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href))

describe('isActiveAccountNav', () => {
  it('matches every retained item exactly, with and without trailing slash on either side', () => {
    for (const href of RETAINED_HREFS) {
      const withoutSlash = href.replace(/\/+$/, '')
      const withSlash = `${withoutSlash}/`
      expect(isActiveAccountNav(href, withoutSlash), `href ${href} vs ${withoutSlash}`).toBe(true)
      expect(isActiveAccountNav(href, withSlash), `href ${href} vs ${withSlash}`).toBe(true)
    }
  })

  it('does not activate on unrelated subpages', () => {
    expect(isActiveAccountNav('/account/billing', '/account/billing/history')).toBe(false)
    expect(isActiveAccountNav('/account/skills', '/account/skills/1')).toBe(false)
  })

  it('returns false for every retained item on /account/team and its sub-tabs', () => {
    const teamPaths = [
      '/account/team',
      '/account/team/',
      '/account/team/members',
      '/account/team/workspaces',
      '/account/team/registry',
      '/account/team/analytics',
    ]
    for (const href of RETAINED_HREFS) {
      for (const path of teamPaths) {
        expect(isActiveAccountNav(href, path), `href ${href} vs ${path}`).toBe(false)
      }
    }
  })

  it('never activates docs links on account paths', () => {
    for (const path of ['/account', '/account/billing', '/account/team/members']) {
      expect(isActiveAccountNav('/docs/quickstart', path)).toBe(false)
      expect(isActiveAccountNav('/docs/api', path)).toBe(false)
    }
  })

  it('activates exactly one retained item for pages that own a sidebar item', () => {
    const allItems = ACCOUNT_NAV_SECTIONS.flatMap((s) => s.items)
    const ownedPaths = [
      '/account/cli-token/',
      '/account/skills',
      '/account/billing',
      '/account/outreach-preferences',
      '/account/telemetry',
    ]
    for (const path of ownedPaths) {
      const active = allItems.filter((i) => isActiveAccountNav(i.href, path))
      expect(active, `path ${path}`).toHaveLength(1)
    }
  })

  it('activates no retained item for hub-only pages no longer in the sidebar', () => {
    const allItems = ACCOUNT_NAV_SECTIONS.flatMap((s) => s.items)
    const hubOnlyPaths = [
      '/account',
      '/account/summary',
      '/account/profile',
      '/account/subscription',
      '/account/team',
      '/account/team/members',
    ]
    for (const path of hubOnlyPaths) {
      const active = allItems.filter((i) => isActiveAccountNav(i.href, path))
      expect(active, `path ${path}`).toHaveLength(0)
    }
  })
})
