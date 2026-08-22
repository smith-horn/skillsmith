/**
 * Account hub tab navigation data + active-path matcher (M8, L2-14).
 *
 * Pure module — no Astro-specific imports — so the canonical tab list,
 * hrefs, and active-path matching logic are independently unit-testable
 * outside Astro (same extraction pattern as account-nav.ts / team-access.ts).
 * Consumed by src/components/AccountHubNav.astro.
 *
 * @see docs/internal/implementation/account-dashboard-ux-consolidation.md
 *   Decision #9 (canonical tab order), Section 3 (component contract).
 */

export interface AccountHubTab {
  href: string
  label: string
  /**
   * True for the four team-administration tabs (Members, Workspaces,
   * Registry, Analytics) that render the M9 muted/lock affordance for
   * non-entitled users. Team Overview is intentionally excluded — Decision
   * #4 / L2-8: non-entitled users self-route off it to /account/summary, so
   * a lock icon there would falsely signal a dead end on the row's first
   * tab.
   */
  teamAdmin: boolean
}

/**
 * Canonical 8-tab order (Decision #9). Personal destinations (Summary,
 * Subscription, Email Address) precede the team-administration tabs
 * (L2-11) so a Community/Individual user redirected to Summary is never
 * more than one tab away from usable content.
 */
export const ACCOUNT_HUB_TABS: readonly AccountHubTab[] = [
  { href: '/account', label: 'Team Overview', teamAdmin: false },
  { href: '/account/summary', label: 'Summary', teamAdmin: false },
  { href: '/account/subscription', label: 'Subscription', teamAdmin: false },
  { href: '/account/profile', label: 'Email Address', teamAdmin: false },
  { href: '/account/team/members', label: 'Members', teamAdmin: true },
  { href: '/account/team/workspaces', label: 'Workspaces', teamAdmin: true },
  { href: '/account/team/registry', label: 'Registry', teamAdmin: true },
  { href: '/account/team/analytics', label: 'Analytics', teamAdmin: true },
] as const

/**
 * M10/L2-13: the presentational divider renders immediately after this
 * tab's href, separating the four team-administration tabs from the
 * landing and personal-account tabs.
 */
export const ACCOUNT_HUB_DIVIDER_AFTER_HREF = '/account/profile'

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/**
 * Whether a hub tab should render as active (`aria-current="page"`) for the
 * given request path. Exact match only after trailing-slash normalization —
 * no prefix/section-root matching, so `/account/subscription` and
 * `/account/subscription/` share active state but no tab ever lights up on
 * an unrelated subpath.
 */
export function isActiveHubTab(href: string, currentPath: string): boolean {
  return stripTrailingSlash(href) === stripTrailingSlash(currentPath)
}
