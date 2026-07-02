/**
 * Account-area sidebar navigation data + active-link logic (SMI-5475).
 *
 * Pure module so `isActiveAccountNav` is unit-testable outside Astro
 * (same pattern as other extracted utils in src/lib/). Consumed by
 * src/components/AccountSidebar.astro.
 */

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
    heading: 'Account',
    items: [
      { href: '/account', label: 'Dashboard', icon: 'home' },
      { href: '/account/profile', label: 'Email Address', icon: 'mail' },
      // Trailing slash matches the page's own path guard, which accepts both forms.
      { href: '/account/cli-token/', label: 'CLI Token', icon: 'terminal' },
    ],
  },
  {
    heading: 'Billing',
    items: [
      { href: '/account/subscription', label: 'Subscription', icon: 'repeat' },
      { href: '/account/billing', label: 'Billing History', icon: 'credit-card' },
    ],
  },
  {
    heading: 'Team',
    items: [{ href: '/account/team', label: 'Team', icon: 'users' }],
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

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/**
 * Whether a sidebar item should render as active for the current path.
 *
 * `/account/team` is a section root: its sub-tabs (/members, /workspaces,
 * /analytics — navigated via TeamNav) keep the Team item lit. Everything
 * else is an exact match after trailing-slash normalization, so
 * `/account/cli-token/` matches both slash forms and `/account` never
 * lights up on subpages.
 */
export function isActiveAccountNav(href: string, currentPath: string): boolean {
  const current = stripTrailingSlash(currentPath)
  const target = stripTrailingSlash(href)
  if (target === '/account/team') {
    return current === target || current.startsWith(`${target}/`)
  }
  return current === target
}
