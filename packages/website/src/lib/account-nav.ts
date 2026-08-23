/**
 * Account-area sidebar navigation data + active-link logic (SMI-5475).
 *
 * Pure module so `isActiveAccountNav` is unit-testable outside Astro
 * (same pattern as other extracted utils in src/lib/). Consumed by
 * src/components/AccountSidebar.astro.
 */

import { normalizeAccountPath } from './account-page-path'

export interface AccountNavItem {
  href: string
  label: string
  icon: string
}

export interface AccountNavSection {
  heading: string
  items: AccountNavItem[]
}

export const ACCOUNT_NAV_SECTIONS: AccountNavSection[] = [
  {
    heading: 'Tools',
    items: [
      // Trailing slash matches the page's own path guard, which accepts both forms.
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
]

/**
 * Whether a sidebar item should render as active for the current path.
 *
 * Every retained item is an exact match after trailing-slash normalization,
 * so `/account/cli-token/` matches both slash forms and no item lights up
 * on subpages it doesn't own. Normalization is shared with
 * `isCurrentAccountPath()` (`account-page-path.ts`) so the sidebar's
 * active-link matching and the page-load entry guards can never drift into
 * accepting different slash forms.
 */
export function isActiveAccountNav(href: string, currentPath: string): boolean {
  return normalizeAccountPath(currentPath) === normalizeAccountPath(href)
}
