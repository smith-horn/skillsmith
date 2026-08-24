/**
 * Navigation-epoch guard for stale async continuations on team-gated account
 * pages (SMI-6112, hardened by SMI-6137).
 *
 * Problem: an `astro:page-load` handler on a gated account page validates
 * its pathname once at entry, then `await`s a tier-check RPC (and, on some
 * pages, a session lookup and/or a further data load) before applying a
 * redirect or writing to the DOM. Because `astro:page-load` listeners
 * persist across Astro ClientRouter view transitions (SMI-5158, still
 * open), the user can navigate away — or away and back to the SAME route
 * (the A-B-A case) — while any of those `await`s is still in flight. A
 * single pathname recheck placed after only the first `await` cannot close
 * either case: it doesn't protect later continuations, and on a return
 * visit it would wrongly let an older, slower-resolving check win a race
 * against a newer, faster one for the same route.
 *
 * Fix (SMI-6112): every genuine navigation-lifecycle event advances a
 * single module-level epoch counter. A gated page captures the epoch once,
 * right after its entry pathname guard passes and before its first
 * `await`. Every continuation that would otherwise mutate state — a
 * redirect, a `data-team-entitled`/`setAccountNavTeamEntitled` write, an
 * error/not-member render, or a DOM write of loaded data — checks
 * `isStale()` immediately beforehand and returns without acting if a
 * newer navigation has since occurred.
 *
 * Which event(s) advance the epoch, and why both (SMI-6137): the counter
 * originally advanced on `astro:page-load` only. That event fires *after*
 * Astro's ClientRouter has already swapped the destination page's `<body>`
 * into the document AND re-executed its scripts
 * (`node_modules/astro/dist/transitions/router.js`, as of `astro@7.2.0`:
 * `doSwap()`/`event.swap()` in `events.js:116-124` does the DOM swap;
 * `runScripts()` + `onPageLoad()` in `router.js:72-101` and `:350-354` run
 * afterward, awaiting any external-`src` script's own load first). That left
 * a real window — bounded by however long script re-execution takes —
 * where the DOM already belonged to the destination page but the epoch
 * hadn't advanced yet: a stale continuation resolving in that window passed
 * `isStale()` and wrote onto a DOM it no longer owned (SMI-6137, reproduced
 * without any artificial delay by ordinary async RPC scheduling — WebKit's
 * CI timing happened to land in the window reliably; the gap itself is
 * browser-agnostic).
 *
 * `astro:before-swap` closes that gap: it's the event Astro dispatches
 * immediately before `event.swap()` runs (`events.js:116-124`), so a
 * listener on it (this module has one) advances the epoch strictly before
 * any DOM mutation — nothing after that dispatch can prevent, cancel, or
 * reorder the swap (`TransitionBeforeSwapEvent` is constructed non-
 * cancelable, `events.js:59-85`). `astro:page-load` remains wired too and
 * is NOT redundant: it's the only lifecycle event that fires on the very
 * first, non-SPA page load, which never dispatches `astro:before-swap` at
 * all (that event only exists inside Astro's SPA-transition machinery,
 * `router.js:221-368`) — without it, a guard captured during the first
 * page's own load would have no epoch bump to have ever occurred relative
 * to. On every SPA transition the two listeners both fire (before-swap
 * first, page-load later) and both advance the same counter; the second,
 * later increment is harmless since guards only ever compare for strict
 * inequality.
 *
 * Deliberate trade-off, not a bug: `doSwap()` still `await`s
 * `afterDispatch` (`events.js:116-124`) between dispatching
 * `astro:before-swap` and actually swapping the DOM — a no-op on
 * Chromium's real View-Transitions path, but on WebKit's default
 * fallback-animate path (`getFallback()` defaulting to `"animate"`,
 * `router.js:65-71`) a genuine wait for the outgoing page's own CSS exit
 * animation to finish (`router.js:178-192`). So on WebKit specifically, the
 * epoch can advance a meaningful amount of real time *before* the DOM is
 * actually swapped. A still-technically-valid write from the outgoing page
 * that resolves during that window is now suppressed as "stale" even
 * though its target element technically still exists for a little longer
 * — a false-stale costing at most one already-being-torn-down frame of
 * work, which is the correct fail-safe direction: strictly preferable to
 * ever landing a write on a DOM that no longer belongs to the page that
 * produced it. Do not "fix" this by moving the listener to a later event
 * (e.g. `astro:after-swap`) — that reopens a version of the exact gap this
 * module exists to close, since `updateDOM()` still `await`s `doSwap(...)`
 * (`router.js:202`) before dispatching `astro:after-swap`, meaning the DOM
 * would already belong to the destination page for a stretch before that
 * event fires too.
 *
 * Testability: `packages/website/vitest.config.ts` runs the `node`
 * environment (see `vitest.preset.ts`), not `jsdom` — there is no real
 * `document` to dispatch events against in unit tests. `advanceNavigationEpoch()`
 * is exported directly (not only reachable via a DOM event) so unit tests
 * can simulate either real event firing without a DOM; it is also the
 * function wired to both real events below for production use.
 */

let currentEpoch = 0
let listenerRegistered = false

/**
 * Advance the shared navigation epoch. Any `NavigationEpochGuard` captured
 * before this call reports `isStale() === true` afterward. Wired to both
 * the real `astro:before-swap` and `astro:page-load` events via
 * `registerNavigationEpochListener()` below (see the module doc comment
 * above for why both); exported directly so it can also be invoked from
 * unit tests that have no DOM to dispatch a real event against.
 */
export function advanceNavigationEpoch(): void {
  currentEpoch += 1
}

/**
 * Register the module's `astro:before-swap` and `astro:page-load`
 * listeners on `document`, guarded so they register at most once even if
 * this module is imported from multiple page scripts within the same
 * browser session. No-ops outside a browser (e.g. under the `node` vitest
 * environment) — `advanceNavigationEpoch()` remains directly callable
 * there for tests.
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
  document.addEventListener('astro:before-swap', advanceNavigationEpoch)
  document.addEventListener('astro:page-load', advanceNavigationEpoch)
  listenerRegistered = true
}

registerNavigationEpochListener()

export interface NavigationEpochGuard {
  /** The epoch captured at creation time. Exposed for debugging/tests. */
  readonly epoch: number
  /** True once a newer navigation (`astro:before-swap` or `astro:page-load`) has occurred since this guard was created. */
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
