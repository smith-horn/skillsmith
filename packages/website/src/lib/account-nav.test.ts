/**
 * Tests for the account navigation data contract + active-link logic
 * (SMI-5475, reorganized SMI-6128).
 *
 * This also absorbs the retired `account-hub-nav.ts`'s active-path and
 * exact-list coverage: no dedicated `account-hub-nav.test.ts` ever existed
 * (this file covered only the sidebar module), so that module's equivalent
 * behavior — every retained hub destination now lives in Admin/Tools and is
 * covered by the assertions below — is net-new here, not a deletion of a
 * prior file's tests.
 */

import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_NAV_GROUPS,
  ACCOUNT_NAV_ROOT_LABEL,
  findCurrentAccountNavLabel,
  isActiveAccountNav,
} from './account-nav'

describe('ACCOUNT_NAV_ROOT_LABEL', () => {
  it('is "Account"', () => {
    expect(ACCOUNT_NAV_ROOT_LABEL).toBe('Account')
  })
})

describe('ACCOUNT_NAV_GROUPS', () => {
  it('matches the Admin/Tools/Preferences/Resources structure exactly', () => {
    expect(ACCOUNT_NAV_GROUPS).toEqual([
      {
        heading: 'Admin',
        items: [
          { href: '/account', label: 'Overview', icon: 'home' },
          { href: '/account/summary', label: 'Summary', icon: 'bar-chart-2' },
          { href: '/account/subscription', label: 'Subscription', icon: 'repeat' },
          { href: '/account/billing', label: 'Billing History', icon: 'credit-card' },
          { href: '/account/profile', label: 'Email Address', icon: 'mail' },
        ],
      },
      {
        heading: 'Tools',
        items: [
          {
            href: '/account/team/registry',
            label: 'Registry',
            icon: 'database',
            teamGated: true,
          },
          {
            href: '/account/team/analytics',
            label: 'Analytics',
            icon: 'activity',
            teamGated: true,
          },
          { href: '/account/cli-token/', label: 'CLI Token', icon: 'terminal' },
          { href: '/account/skills', label: 'Skill Inventory', icon: 'grid' },
          {
            href: '/account/team/members',
            label: 'Members',
            icon: 'users',
            teamGated: true,
          },
          {
            href: '/account/team/workspaces',
            label: 'Workspaces',
            icon: 'layers',
            teamGated: true,
          },
        ],
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

  it('has exactly the four group headings, in order, with no Billing or Team heading', () => {
    const headings = ACCOUNT_NAV_GROUPS.map((g) => g.heading)
    expect(headings).toEqual(['Admin', 'Tools', 'Preferences', 'Resources'])
    expect(headings).not.toContain('Billing')
    expect(headings).not.toContain('Team')
    expect(headings).not.toContain('Account')
  })

  it('has unique hrefs across the whole contract', () => {
    const hrefs = ACCOUNT_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href))
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('has an icon and label on every item', () => {
    for (const item of ACCOUNT_NAV_GROUPS.flatMap((g) => g.items)) {
      expect(item.icon).toBeTruthy()
      expect(item.label).toBeTruthy()
    }
  })

  it('marks exactly Registry, Analytics, Members, and Workspaces as team-gated', () => {
    const gatedLabels = ACCOUNT_NAV_GROUPS.flatMap((g) => g.items)
      .filter((i) => i.teamGated)
      .map((i) => i.label)
    expect(gatedLabels).toEqual(['Registry', 'Analytics', 'Members', 'Workspaces'])
  })

  it('never marks Overview as team-gated', () => {
    const overview = ACCOUNT_NAV_GROUPS.flatMap((g) => g.items).find((i) => i.href === '/account')
    expect(overview?.teamGated).toBeUndefined()
  })

  it('contains every destination the retired eight-tab hub row used to own', () => {
    // account-hub-nav.ts's ACCOUNT_HUB_TABS, before retirement (SMI-6128):
    // /account, /account/summary, /account/subscription, /account/profile,
    // /account/team/members, /account/team/workspaces,
    // /account/team/registry, /account/team/analytics.
    const formerHubHrefs = [
      '/account',
      '/account/summary',
      '/account/subscription',
      '/account/profile',
      '/account/team/members',
      '/account/team/workspaces',
      '/account/team/registry',
      '/account/team/analytics',
    ]
    const allHrefs = ACCOUNT_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href))
    for (const href of formerHubHrefs) {
      expect(allHrefs, `expected ${href} to be present`).toContain(href)
    }
  })
})

/** Every href in the current contract, for parametrized coverage. */
const ALL_HREFS = ACCOUNT_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href))

describe('isActiveAccountNav', () => {
  it('matches every item exactly, with and without trailing slash on either side', () => {
    for (const href of ALL_HREFS) {
      const withoutSlash = href.replace(/\/+$/, '')
      const withSlash = `${withoutSlash}/`
      expect(isActiveAccountNav(href, withoutSlash), `href ${href} vs ${withoutSlash}`).toBe(true)
      expect(isActiveAccountNav(href, withSlash), `href ${href} vs ${withSlash}`).toBe(true)
    }
  })

  it('does not activate on unrelated subpages', () => {
    expect(isActiveAccountNav('/account/billing', '/account/billing/history')).toBe(false)
    expect(isActiveAccountNav('/account/skills', '/account/skills/1')).toBe(false)
    expect(isActiveAccountNav('/account', '/account/summary')).toBe(false)
  })

  it('never activates docs links on account paths', () => {
    for (const path of ['/account', '/account/billing', '/account/team/members']) {
      expect(isActiveAccountNav('/docs/quickstart', path)).toBe(false)
      expect(isActiveAccountNav('/docs/api', path)).toBe(false)
    }
  })

  it('activates exactly one item for every canonical account destination', () => {
    const allItems = ACCOUNT_NAV_GROUPS.flatMap((g) => g.items)
    for (const path of ALL_HREFS) {
      const active = allItems.filter((i) => isActiveAccountNav(i.href, path))
      expect(active, `path ${path}`).toHaveLength(1)
    }
  })

  it('activates no item for /account/team and its redirect-only shim', () => {
    const allItems = ACCOUNT_NAV_GROUPS.flatMap((g) => g.items)
    for (const path of ['/account/team', '/account/team/', '/account/members']) {
      const active = allItems.filter((i) => isActiveAccountNav(i.href, path))
      expect(active, `path ${path}`).toHaveLength(0)
    }
  })
})

describe('findCurrentAccountNavLabel', () => {
  it('returns the matching item label for every canonical destination', () => {
    const expected: Record<string, string> = {
      '/account': 'Overview',
      '/account/summary': 'Summary',
      '/account/subscription': 'Subscription',
      '/account/billing': 'Billing History',
      '/account/profile': 'Email Address',
      '/account/team/registry': 'Registry',
      '/account/team/analytics': 'Analytics',
      '/account/cli-token/': 'CLI Token',
      '/account/skills': 'Skill Inventory',
      '/account/team/members': 'Members',
      '/account/team/workspaces': 'Workspaces',
      '/account/outreach-preferences': 'Outreach',
      '/account/telemetry': 'Telemetry',
    }
    for (const [path, label] of Object.entries(expected)) {
      expect(findCurrentAccountNavLabel(path), `path ${path}`).toBe(label)
    }
  })

  it('normalizes trailing slashes the same way isActiveAccountNav does', () => {
    expect(findCurrentAccountNavLabel('/account/cli-token')).toBe('CLI Token')
    expect(findCurrentAccountNavLabel('/account/subscription/')).toBe('Subscription')
  })

  it('returns undefined for paths outside the nav contract', () => {
    expect(findCurrentAccountNavLabel('/account/team')).toBeUndefined()
    expect(findCurrentAccountNavLabel('/account/members')).toBeUndefined()
    expect(findCurrentAccountNavLabel('/docs/some-other-page')).toBeUndefined()
  })

  it('resolves Resources-group destinations too, not just Admin/Tools/Preferences', () => {
    expect(findCurrentAccountNavLabel('/docs/quickstart')).toBe('Getting Started')
    expect(findCurrentAccountNavLabel('/docs/api')).toBe('API Docs')
  })
})
