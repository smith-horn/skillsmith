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
 *
 * Pathname alone is NOT sufficient, though (SMI-6154): on a browser
 * back/forward (`popstate`/"traverse") navigation, the browser reverts
 * `location.href` to the destination URL *before* Astro's ClientRouter has
 * actually swapped the DOM to match — a brief window where
 * `window.location.pathname` already reads the destination route but the
 * live document is still the page being navigated away from. An orphaned
 * `astro:page-load` dispatch (the delayed tail of an EARLIER, already-
 * superseded transition — see `isAccountPageMounted()` below) can land in
 * exactly that window and pass this check on a false pretense. Callers
 * MUST pair this with `isAccountPageMounted()` for a real entry guard;
 * see that function's doc comment for why pathname alone can't close this.
 */
export function isCurrentAccountPath(actualPath: string, expectedPath: string): boolean {
  return normalizeAccountPath(actualPath) === normalizeAccountPath(expectedPath)
}

/**
 * Whether the live document actually contains the DOM marker for
 * `expectedPath` (SMI-6154) — a `data-account-page="<expectedPath>"`
 * attribute each of the five team-gated account pages sets on their own
 * `<main>` element, always present regardless of loading/content/error
 * state (never removed, only ever loading/content/error panels toggle
 * visibility inside it).
 *
 * Root cause this closes: `isCurrentAccountPath()` alone is fooled by the
 * `popstate` pathname-updates-before-DOM-swap window (see that function's
 * doc comment). Astro's ClientRouter can also leave a PRIOR transition's
 * `astro:page-load` dispatch pending — its own `runScripts()` →
 * `onPageLoad()` continuation is a separately-chained promise that nothing
 * awaits, cancels, or checks against a newer navigation
 * (`node_modules/astro/dist/transitions/router.js`, as of `astro@7.2.0`,
 * `updateCallbackDone.finally(...)` in `transition()`) — so that orphaned
 * dispatch can fire well after a NEWER navigation has already started,
 * landing squarely in the popstate desync window on the wrong page's DOM.
 * `isCurrentAccountPath()` passes (the URL already reverted); the
 * navigation-epoch guard (`account-navigation-epoch.ts`, SMI-6112/SMI-6137)
 * also can't catch this — the orphaned dispatch's OWN firing is itself the
 * most recent epoch-advancing event, so a guard captured inside it is
 * fresh by construction. Only checking what's ACTUALLY live in the DOM
 * closes the gap.
 *
 * `doc` defaults to the global `document` for production use; accepts an
 * injected value so unit tests (this package's vitest config runs the
 * `node` environment — no real `document`, see
 * `account-navigation-epoch.ts`'s header comment) can pass a minimal
 * `{ querySelector }` stub instead of standing up a real DOM.
 */
export function isAccountPageMounted(
  expectedPath: string,
  doc: Pick<Document, 'querySelector'> = document
): boolean {
  return doc.querySelector(`[data-account-page="${expectedPath}"]`) !== null
}
