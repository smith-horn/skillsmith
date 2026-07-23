/**
 * Status page client-side runtime logic (SMI-5755, Wave 5) — barrel
 * re-export over four focused sibling modules (kept under the repo's
 * 500-line-per-file gate):
 *
 *   - `status-payload.ts`   — payload validation + TTL'd localStorage cache (Codex #7/#8/#10)
 *   - `status-reconcile.ts` — dynamic-row reconciliation plan (Codex #3)
 *   - `status-render.ts`    — safe textContent-only render-content builders (Codex #1/#2/#15)
 *   - `status-poller.ts`    — roving-tabindex keyboard nav (Codex #14) + poll
 *                             lifecycle controller (Codex #4/#10)
 *
 * `status.astro` and this module's own tests import from here so the split
 * is an implementation detail, not a call-site concern.
 *
 * DEVIATION from the brief's literal "one is:inline define:vars script"
 * instruction: this logic is a regular (bundled) ES module imported by
 * status.astro's non-inline `<script>` tag, not inlined directly. Rationale:
 *
 *   1. `import.meta.env.PUBLIC_API_BASE_URL` is available in a bundled
 *      Astro `<script>` exactly as it is in an `is:inline` one (it's a Vite
 *      `define`, not something `define:vars` uniquely provides — see
 *      astro.config.mjs's `vite.define` block) — so the URL-construction
 *      idiom is unaffected either way.
 *   2. BaseLayout.astro already establishes this exact split for
 *      SMI-3595's Supabase client: an `is:inline define:vars` shim for the
 *      truly server-computed value, followed by a regular `<script>` that
 *      imports real logic from `../lib/*`. This module follows that
 *      established precedent.
 *   3. The brief mandates real, executable tests for the untrusted-field
 *      rendering path and the dynamic-row reconciliation contract. Logic
 *      that only ever exists as inert text inside an `is:inline` block can't
 *      be imported by a test file, which would force either (a) no real test
 *      of the shipped code, just a hand-maintained "twin" copy that can
 *      silently drift from production, or (b) executing raw script text
 *      through a headless browser — disproportionate for this change. A
 *      single importable module avoids that drift risk entirely.
 *
 * Untrusted-field inventory (never `innerHTML`/`insertAdjacentHTML`/`set:html`
 * for any of these — always `textContent`/`createElement` + property assign):
 * `component.message`, `component.name`, `incident.title`,
 * `incident.updates[].message`, and the affected-component display-name
 * lookup + raw-slug fallback built from those same fields.
 */

export {
  readCachedStatusPayload,
  STATUS_CACHE_KEY,
  STATUS_CACHE_TTL_MS,
  validateStatusPayload,
  writeCachedStatusPayload,
} from './status-payload'

export {
  dedupeComponentsBySlug,
  planComponentReconciliation,
  type ComponentDedupeResult,
  type ReconcilePlan,
} from './status-reconcile'

export {
  applyComponentRowContent,
  buildAffectedComponentsText,
  buildComponentRowContent,
  buildComponentsBySlug,
  buildIncidentContent,
  buildScaffoldResetContent,
  refreshUptimeStripTiles,
  type ComponentRowContent,
  type ComponentRowElements,
  type IncidentContent,
  type IncidentUpdateContent,
  type UptimeStripHandle,
  type UptimeTileHandle,
} from './status-render'

export {
  computeRovingTabindexMove,
  createStatusPoller,
  INITIAL_POLL_OUTCOME_STATE,
  isRovingNavKey,
  nextPollOutcomeState,
  STALE_AFTER_CONSECUTIVE_FAILURES,
  wireUptimeStripKeyboardNav,
  type PollOutcomeState,
  type StatusPoller,
  type StatusPollerCallbacks,
  type StatusPollerOptions,
} from './status-poller'
