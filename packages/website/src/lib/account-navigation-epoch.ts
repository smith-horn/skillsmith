/**
 * Navigation-epoch guard for stale async continuations on team-gated account
 * pages (SMI-6112).
 *
 * Problem: an `astro:page-load` handler on a gated account page validates
 * its pathname once at entry, then `await`s a tier-check RPC (and, on some
 * pages, a session lookup and/or a further data load) before applying a
 * redirect or writing to the DOM. Because `astro:page-load` listeners
 * persist across Astro ClientRouter view transitions, the user can navigate
 * away — or away and back to the SAME route (the A-B-A case) — while any of
 * those `await`s is still in flight. A single pathname recheck placed after
 * only the first `await` cannot close either case: it doesn't protect later
 * continuations, and on a return visit it would wrongly let an older,
 * slower-resolving check win a race against a newer, faster one for the
 * same route.
 *
 * Fix: every genuine `astro:page-load` event (each one represents a
 * completed navigation, including the initial load) advances a single
 * module-level epoch counter. A gated page captures the epoch once, right
 * after its entry pathname guard passes and before its first `await`. Every
 * continuation that would otherwise mutate state — a redirect, a
 * `data-team-entitled`/`setAccountNavTeamEntitled` write, an error/not-member render,
 * or a DOM write of loaded data — checks `isStale()` immediately beforehand
 * and returns without acting if a newer navigation has since occurred.
 *
 * Testability: `packages/website/vitest.config.ts` runs the `node`
 * environment (see `vitest.preset.ts`), not `jsdom` — there is no real
 * `document` to dispatch events against in unit tests. `advanceNavigationEpoch()`
 * is exported directly (not only reachable via a DOM event) so unit tests
 * can simulate a fresh `astro:page-load` firing without a DOM; it is also
 * the function wired to the real event below for production use.
 */

let currentEpoch = 0
let listenerRegistered = false

/**
 * Advance the shared navigation epoch. Any `NavigationEpochGuard` captured
 * before this call reports `isStale() === true` afterward. Wired to the
 * real `astro:page-load` event via `registerNavigationEpochListener()`
 * below; exported directly so it can also be invoked from unit tests that
 * have no DOM to dispatch a real event against.
 */
export function advanceNavigationEpoch(): void {
  currentEpoch += 1
}

/**
 * Register the module's `astro:page-load` listener on `document`, guarded
 * so it registers at most once even if this module is imported from
 * multiple page scripts within the same browser session. No-ops outside a
 * browser (e.g. under the `node` vitest environment) — `advanceNavigationEpoch()`
 * remains directly callable there for tests.
 *
 * Why `listenerRegistered` is sufficient here (and the usual
 * `window.__xInited` idempotency pattern for `astro:page-load` binds isn't
 * needed): this call happens once at MODULE top-level, not from inside a
 * page-load handler. Astro's ClientRouter swaps the DOM without a full page
 * reload, so the browser's ES-module cache — which dedupes module
 * evaluation by resolved URL within a single document — evaluates this
 * module's top-level code (including this call) exactly once per SPA
 * session, no matter how many pages import it across however many view
 * transitions. `listenerRegistered` guards the reverse case (calling this
 * function more than once within that single evaluation), not repeated
 * evaluation across transitions.
 */
function registerNavigationEpochListener(): void {
  if (listenerRegistered || typeof document === 'undefined') return
  document.addEventListener('astro:page-load', advanceNavigationEpoch)
  listenerRegistered = true
}

registerNavigationEpochListener()

export interface NavigationEpochGuard {
  /** The epoch captured at creation time. Exposed for debugging/tests. */
  readonly epoch: number
  /** True once a newer `astro:page-load` has fired since this guard was created. */
  isStale: () => boolean
}

/**
 * Capture the current navigation epoch. Call once per `astro:page-load`
 * invocation, immediately after the entry pathname guard
 * (`isCurrentAccountPath`) passes and before the handler's first `await`.
 */
export function createNavigationEpochGuard(): NavigationEpochGuard {
  const epoch = currentEpoch
  return {
    epoch,
    isStale: () => epoch !== currentEpoch,
  }
}
