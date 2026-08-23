/**
 * Account-area navigation data + active-link logic (SMI-5475, reorganized
 * SMI-6128 per docs/internal/implementation/account-nav-admin-tools-reorg.md).
 *
 * Pure module so `isActiveAccountNav` (and the rest of this contract) is
 * unit-testable outside Astro (same pattern as other extracted utils in
 * src/lib/). This is the SOLE source of account-navigation structure —
 * `AccountSidebar.astro` (desktop) and `AccountMobileNav.astro` (mobile)
 * both render from `ACCOUNT_NAV_ROOT_LABEL` / `ACCOUNT_NAV_GROUPS` below;
 * neither component owns a second hardcoded copy of labels, hrefs, order,
 * or team-gated metadata (plan Decision #10).
 *
 * This module also absorbs the retired `account-hub-nav.ts`'s canonical
 * tab list and active-path matcher — the eight-destination hub tab row
 * (`AccountHubNav.astro`) is gone; every destination it used to own now
 * lives in the Admin/Tools groups below.
 */

import { normalizeAccountPath } from './account-page-path'

export interface AccountNavItem {
  href: string
  label: string
  icon: string
  /**
   * True for the four team-administration items (Registry, Analytics,
   * Members, Workspaces) that render the muted/lock affordance for
   * non-entitled users. Overview is intentionally excluded even though its
   * content is team-scoped — non-entitled users self-route off it to
   * /account/summary (SMI-6110 Decision #4), so a lock there would falsely
   * signal a dead end on the nav's very first Admin destination.
   */
  teamGated?: boolean
}

export interface AccountNavGroup {
  heading: string
  items: readonly AccountNavItem[]
}

/** Visible root heading above the Admin/Tools/Preferences/Resources groups. */
export const ACCOUNT_NAV_ROOT_LABEL = 'Account'

export const ACCOUNT_NAV_GROUPS: readonly AccountNavGroup[] = [
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
      // Trailing slash matches the page's own path guard, which accepts both forms.
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
] as const

/**
 * Whether a nav item should render as active for the current path.
 *
 * Every item is an exact match after trailing-slash normalization, so
 * `/account/cli-token/` matches both slash forms and no item lights up on
 * a subpage it doesn't own. Normalization is shared with
 * `isCurrentAccountPath()` (`account-page-path.ts`) so this active-link
 * matcher and the page-load entry guards can never drift into accepting
 * different slash forms.
 */
export function isActiveAccountNav(href: string, currentPath: string): boolean {
  return normalizeAccountPath(currentPath) === normalizeAccountPath(href)
}

/**
 * The label of the nav item matching `currentPath`, if any. Used by
 * `AccountMobileNav.astro` to build its `<summary>` text
 * (`Account navigation: {currentLabel}`) — the current destination's label
 * is a hard requirement of the collapsed disclosure text, not merely
 * adjacent to it, so a collapsed disclosure never leaves the visited page
 * unidentified.
 */
export function findCurrentAccountNavLabel(currentPath: string): string | undefined {
  for (const group of ACCOUNT_NAV_GROUPS) {
    for (const item of group.items) {
      if (isActiveAccountNav(item.href, currentPath)) return item.label
    }
  }
  return undefined
}
