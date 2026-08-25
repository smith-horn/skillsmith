/**
 * Shared team-entitlement signal producer for account navigation (SMI-6128).
 *
 * `AccountHubNav.astro` used to be the sole `data-team-entitled` consumer,
 * and every producer page queried `.account-hub-nav` directly to set it.
 * Retiring the hub tab row in favor of two navigation roots — the desktop
 * `.account-sidebar` and the mobile `.account-mobile-nav` — means a naive
 * per-page port would either duplicate the query-and-set logic twice per
 * page or (worse) update only one of the two roots and leave the other
 * stuck fail-open. `setAccountNavTeamEntitled()` is the single mandatory
 * call site every producer page uses instead: it updates every mounted
 * account-navigation root present in the document in one call, and is a
 * no-op if neither is mounted.
 *
 * Producers (pre-decided, see the plan's What Changes §6): /account,
 * Summary, Subscription, Billing History, Members, Workspaces, Registry,
 * and Analytics. The remaining five account pages (Profile, CLI Token,
 * Skill Inventory, Outreach, Telemetry) never call this — their navigation
 * stays fail-open by design.
 */

const ACCOUNT_NAV_ROOT_SELECTOR = '.account-sidebar, .account-mobile-nav'

/**
 * Set the `data-team-entitled` attribute on every mounted account-navigation
 * root (`.account-sidebar` and `.account-mobile-nav`) present in the
 * document. Both `AccountSidebar.astro` and `AccountMobileNav.astro` apply
 * their muted/lock CSS only when this attribute is the literal string
 * `"false"` — any other value, or its absence, fails open.
 *
 * No-ops if neither root is currently mounted (e.g. called before the DOM
 * has settled, or from a context with no account navigation at all).
 */
export function setAccountNavTeamEntitled(entitled: boolean): void {
  document.querySelectorAll(ACCOUNT_NAV_ROOT_SELECTOR).forEach((root) => {
    root.setAttribute('data-team-entitled', String(entitled))
  })
}
