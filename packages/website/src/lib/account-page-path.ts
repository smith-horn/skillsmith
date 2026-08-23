/**
 * Shared account-area path normalization (SMI-6112).
 *
 * Trailing-slash normalization used to live only inside `account-nav.ts`'s
 * private `stripTrailingSlash()`, scoped to the sidebar's active-link
 * matcher. `isCurrentAccountPath()` below needs the identical semantics for
 * the `astro:page-load` entry guard on the five team-gated account pages, so
 * this module is the single shared source — `account-nav.ts`'s
 * `isActiveAccountNav()` imports `normalizeAccountPath()` from here rather
 * than keeping its own copy, so the two can never drift into accepting
 * different slash forms.
 */

/**
 * Normalize a path for exact-match comparison: strip one or more trailing
 * slashes, except for the root path `/` itself (which stays as `/`).
 */
export function normalizeAccountPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/**
 * Whether `actualPath` (typically `window.location.pathname`) is the same
 * route as `expectedPath`, treating `/path` and `/path/` as equivalent and
 * rejecting every other route.
 *
 * Used as the entry guard in each of the five team-gated account pages'
 * `astro:page-load` handlers — a stale handler that fired for a different
 * route (because `astro:page-load` listeners persist across ClientRouter
 * view transitions and re-fire on every navigation) must never proceed past
 * this check. This is the FIRST line of defense; the navigation-epoch guard
 * (`account-navigation-epoch.ts`) covers the remaining suspend points a
 * single entry check cannot close on its own (SMI-6112 plan review Finding
 * #1 — a handler that passed the entry guard can still go stale mid-flight,
 * across an `await`, or in the A-B-A case where the user leaves and returns
 * to the same route before the first check resolves).
 */
export function isCurrentAccountPath(actualPath: string, expectedPath: string): boolean {
  return normalizeAccountPath(actualPath) === normalizeAccountPath(expectedPath)
}
