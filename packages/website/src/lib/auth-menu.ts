/**
 * Authenticated user-menu contract (SMI-6110, plan-review loop 2 issue L2-5).
 *
 * Single source of truth for the desktop UserMenu.astro dropdown's link
 * items and the mobile Nav.astro auth-state HTML fragment. Both surfaces
 * were reduced from Dashboard/Subscription/Email Address down to a single
 * "Account" link (relabeled from "Dashboard", H3) plus Sign out as part of
 * the account-dashboard-ux-consolidation plan's hub-tab-row rollout — those
 * two destinations moved into AccountHubNav instead. Extracting the item
 * list/template here means a future edit that reintroduces Subscription or
 * Email Address into either surface is caught by the unit tests in
 * auth-menu.test.ts instead of silently drifting back in, the same
 * shared-contract-drift class of bug the plan's P-5 audit exists to catch.
 *
 * @see docs/internal/implementation/account-dashboard-ux-consolidation.md
 *   Section 4 ("Reduce the authenticated user menu on desktop and mobile"),
 *   Shared-State / Coordination Audit (P-5) table, issue L2-5.
 */

export interface UserMenuLinkItem {
  href: string
  label: string
}

/**
 * Desktop UserMenu.astro dropdown link items, rendered in order. "Sign out"
 * is a `<button>` (no href — it has its own logout handler, not a nav
 * destination), so it is not part of this list; see
 * `AUTH_MENU_SIGN_OUT_LABEL` below for its shared label.
 */
export const USER_MENU_LINK_ITEMS: readonly UserMenuLinkItem[] = [
  { href: '/account', label: 'Account' },
] as const

/** Shared text label for both the desktop dropdown's and mobile menu's sign-out control. */
export const AUTH_MENU_SIGN_OUT_LABEL = 'Sign out'

/**
 * Authenticated mobile-nav HTML fragment. Nav.astro's client script assigns
 * this to `#nav-mobile-auth`'s `innerHTML` after session resolution on every
 * `astro:page-load`. Pure string builder — idempotent by construction:
 * repeated calls return byte-identical output, and each call fully replaces
 * (never appends to) the container, so no duplicate listeners/items
 * accumulate across repeated session-resolution passes.
 */
export function renderMobileAuthMenu(): string {
  return `
        <a href="/account" class="nav-mobile-link">Account</a>
        <button type="button" class="nav-mobile-link" style="color: #f87171; text-align: left; width: 100%; background: none; border: none; cursor: pointer;" id="nav-mobile-logout">Sign out</button>
      `
}
