/**
 * Telemetry Consent Gate — SMI-5019 W2.S4, rewired by SMI-6362 §3/B-6
 *
 * For MCP-only clients (Cursor, Continue, Copilot users without a CLI install)
 * we cannot rely on a CLI first-run prompt or a VS Code toast. Per user
 * decision U5 in the implementation plan, the consent surface is the web
 * dashboard at https://skillsmith.app/account/telemetry.
 *
 * This module supplies the MCP-side half of that flow:
 *
 *  1. On every tool call, resolve the caller's preference by POSTing to the
 *     already-deployed `telemetry-consent` edge function (SMI-6362 B-6 —
 *     see the fetchConsentState doc-comment for why this replaced a direct
 *     `user_telemetry_preferences` query keyed on an anonymous id).
 *  2. If the row is missing (or the caller has never decided), signal
 *     `consent_required:true` + the privacy URL in the response envelope so
 *     the client can prompt the user to open the dashboard.
 *  3. Cache the resolved state per process (Map keyed by the caller's id) so
 *     repeated calls within a session don't re-query, and so two parallel
 *     calls from the same id observe identical state.
 *  4. Suppress telemetry writes (consult `shouldEmitTelemetry`) for that id
 *     until the preference resolves to `enabled:true`.
 *
 * SMI-5016 (`packages/core/src/telemetry/wrap.ts`) and SMI-5017 (tool /
 * command dispatchers) are wave-sibling deliverables — this module
 * deliberately stays out of those files.
 */

import { getApiBaseUrl, getApiKey, resolveFreshAccessToken } from '@skillsmith/core'

/**
 * Canonical absolute URL of the consent dashboard. Must remain stable across
 * surfaces so MCP clients can deep-link to a known landing page.
 */
export const TELEMETRY_PRIVACY_URL = 'https://skillsmith.app/account/telemetry'

/**
 * Result of resolving the consent state for a given anonymous_id.
 */
export interface ConsentState {
  /** True iff a preference row was found AND `enabled = true`. */
  enabled: boolean
  /**
   * True iff there is no row for this anonymous_id yet (the user hasn't
   * visited the consent page). Surface this in the response envelope so the
   * client can prompt the user.
   */
  consentRequired: boolean
  /** Stable URL to direct the user to when `consentRequired` is true. */
  privacyUrl: string
}

/**
 * Per-process cache keyed by the caller's id (post-D-7, this is
 * `getOrCreateInstallId()`'s persisted value — see `context.async.ts`). We
 * deliberately use a single shared Map so two parallel `withConsentGate`
 * invocations for the same id observe identical state — the constraint
 * flagged in the spec.
 *
 * Stored value is a Promise (not the resolved ConsentState) so concurrent
 * lookups share one in-flight request.
 */
const consentCache = new Map<string, Promise<ConsentState>>()

const DEFAULT_CONSENT_REQUIRED: ConsentState = {
  enabled: false,
  consentRequired: true,
  privacyUrl: TELEMETRY_PRIVACY_URL,
}

const DEFAULT_NO_ID: ConsentState = {
  enabled: false,
  consentRequired: false,
  privacyUrl: TELEMETRY_PRIVACY_URL,
}

const CONSENT_ENDPOINT = '/functions/v1/telemetry-consent'
const CONSENT_REQUEST_TIMEOUT_MS = 2000

interface TelemetryConsentResponse {
  data?: { enabled?: unknown; consentRequired?: unknown }
}

/**
 * Resolve the consent state for `installId` by POSTing to the already
 * -deployed `telemetry-consent` edge function (SMI-6362 B-6/§3).
 *
 * This REPLACES a direct `user_telemetry_preferences` query keyed on an
 * anonymous id — B-6 found that query structurally unmatchable: the MCP
 * process supplied a fresh per-process `crypto.randomUUID()` while the
 * website wrote a browser-minted `sa_<32hex>` id into that column, so the
 * two id spaces could never collide and the gate was always closed for a
 * real MCP client, regardless of the caller's actual consent. Re-keying
 * consent resolution off the ACCOUNT (via a server-verified credential)
 * rather than off any anonymous id retires that mismatch instead of trying
 * to reconcile two id spaces that were never the same thing (D-7).
 *
 * Credential precedence is fixed, not opportunistic (round-2 required
 * change #5): send the caller's JWT (`resolveFreshAccessToken()`) whenever
 * one is available, and fall back to `X-API-Key` ONLY when none is. Never
 * both, never key-preferred. A key-derived consent answer is somebody
 * else's decision on a shared team credential — the same fact
 * `team-resolver.ts` already documents. This is enforced independently and
 * authoritatively server-side by `resolve_telemetry_identity` (D-2f) and by
 * `telemetry-consent`'s own JWT-first resolution (§3b) — a client that got
 * this precedence wrong would still write nothing attributable, but would
 * show the user someone else's consent state, which is its own defect.
 *
 * Falls back to "consent required" on any transport/shape failure so this
 * never silently emits telemetry the caller never actually consented to.
 */
async function fetchConsentState(installId: string): Promise<ConsentState> {
  let accessToken: string | null = null
  try {
    accessToken = await resolveFreshAccessToken()
  } catch {
    accessToken = null
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`
  } else {
    const apiKey = getApiKey()
    if (apiKey) headers['X-API-Key'] = apiKey
  }
  // Neither credential present: the request still POSTs with no auth
  // headers, matching the server's own `lane: 'anonymous'`-shaped
  // resolution — it returns the unchanged DEFAULT_NO_ID shape for that
  // case (SMI-6362 D-2a step 2), so no special-casing is needed here.

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONSENT_REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${getApiBaseUrl()}${CONSENT_ENDPOINT}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ installId }),
      signal: controller.signal,
    })
    if (!res.ok) {
      return { ...DEFAULT_CONSENT_REQUIRED }
    }
    const json = (await res.json()) as TelemetryConsentResponse
    if (
      !json?.data ||
      typeof json.data.enabled !== 'boolean' ||
      typeof json.data.consentRequired !== 'boolean'
    ) {
      return { ...DEFAULT_CONSENT_REQUIRED }
    }
    // The server's own "no identified caller" answer IS
    // {enabled:false, consentRequired:false} — the DEFAULT_NO_ID shape —
    // so passing its response straight through already covers that case
    // without a separate branch here.
    return {
      enabled: json.data.enabled,
      consentRequired: json.data.consentRequired,
      privacyUrl: TELEMETRY_PRIVACY_URL,
    }
  } catch {
    // Network/timeout/parse failure. Deliberately simplified from the
    // pre-SMI-6362 design, which distinguished "Supabase client construction
    // threw" (→ DEFAULT_NO_ID, no prompt) from "the query itself failed"
    // (→ DEFAULT_CONSENT_REQUIRED). A single fetch call has no equivalent
    // "not configured, no network surface at all" branch to distinguish —
    // every failure here means a real attempt was made and did not
    // complete, so it fails closed uniformly, consistent with D-1's server-
    // side "fail-closed on consent-lookup error" philosophy applied
    // client-side too. Cost: a genuinely offline user sees one extra
    // consent_required flag they cannot act on until back online — harmless,
    // since nothing is emitted either way while offline.
    return { ...DEFAULT_CONSENT_REQUIRED }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve the consent state for `anonymousId`, caching the result for the
 * lifetime of the process. Concurrent calls share one in-flight query.
 *
 * Passing `null`/`undefined`/empty triggers the no-id branch — telemetry is
 * suppressed but no prompt is shown (there's nothing to link the user's
 * eventual web-dashboard choice back to).
 *
 * `fetchState` defaults to {@link fetchConsentState} and exists purely as a
 * test seam (SMI-5479) — `fetchConsentState` is written so every internal
 * error path resolves to a `DEFAULT_*` state instead of rejecting, which
 * means the eviction-on-rejection behavior below is unreachable through the
 * real fetcher today. Passing a rejecting `fetchState` in a test exercises
 * that defense-in-depth path deterministically without weakening
 * `fetchConsentState`'s own never-rejects contract.
 */
export function resolveConsent(
  anonymousId: string | null | undefined,
  fetchState: (id: string) => Promise<ConsentState> = fetchConsentState
): Promise<ConsentState> {
  if (!anonymousId) {
    return Promise.resolve({ ...DEFAULT_NO_ID })
  }
  const cached = consentCache.get(anonymousId)
  if (cached) return cached
  // SMI-5479: eviction-on-rejection. Without this, a single rejecting fetch
  // would poison the cache entry for `anonymousId` for the rest of the
  // process lifetime — every subsequent call would replay the SAME rejected
  // promise instead of re-querying. Evicting immediately means the NEXT call
  // gets a fresh attempt; THIS call's caller still observes the failure
  // (rethrow) so callers that `await` it (e.g. the CallTool handler) see the
  // error and can fall back to their own error envelope.
  const promise = fetchState(anonymousId).catch((error: unknown) => {
    consentCache.delete(anonymousId)
    throw error
  })
  consentCache.set(anonymousId, promise)
  return promise
}

/**
 * Convenience: true iff telemetry may be emitted for this anonymous_id.
 * Wraps `resolveConsent` for callers that only need the boolean.
 */
export async function shouldEmitTelemetry(
  anonymousId: string | null | undefined
): Promise<boolean> {
  if (!anonymousId) return false
  const state = await resolveConsent(anonymousId)
  return state.enabled
}

/**
 * Invalidate the cache entry for `anonymousId`. Called by the consent page
 * after a successful save would, in a future iteration, ping an MCP refresh
 * endpoint — for now this is exposed for tests and for the explicit
 * resync-on-rotate UI in the consent page.
 */
export function invalidateConsentCache(anonymousId?: string): void {
  if (anonymousId === undefined) {
    consentCache.clear()
    return
  }
  consentCache.delete(anonymousId)
}

/**
 * Augment an existing MCP tool response with a `consent_required` envelope
 * when the user has not yet visited the consent page.
 *
 * The MCP `CallToolResult` shape is `{ content: [{ type: 'text', text: <json> }] }`.
 * We parse `text`, splice in the consent fields, and re-serialize. If parsing
 * fails for any reason (binary content, malformed payload), we return the
 * response untouched — telemetry consent is a soft signal and must never
 * corrupt a successful tool result.
 *
 * Idempotent: calling this twice on the same response is a no-op once the
 * fields are already present.
 */
export function annotateResponseWithConsent<T extends { content?: unknown }>(
  response: T,
  consent: ConsentState
): T {
  if (!consent.consentRequired) return response

  const content = (response as { content?: unknown }).content
  if (!Array.isArray(content) || content.length === 0) return response

  const first = content[0] as { type?: unknown; text?: unknown } | undefined
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return response

  let parsed: unknown
  try {
    parsed = JSON.parse(first.text)
  } catch {
    return response
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return response
  }

  const annotated = parsed as Record<string, unknown>
  // Idempotency: if the caller has already added these, leave them alone.
  if ('consent_required' in annotated && 'privacy_url' in annotated) return response

  annotated.consent_required = true
  annotated.privacy_url = consent.privacyUrl

  const nextContent = [...content]
  nextContent[0] = { ...first, text: JSON.stringify(annotated, null, 2) }
  return { ...response, content: nextContent }
}

/**
 * Per-process set of anonymous_ids that have already received a
 * `consent_required` annotation on a DIRECT-DISPATCH response (SMI-5479
 * Step 3, Option A — ratified at plan kickoff). Distinct from `consentCache`
 * (which caches the resolved *preference*, not "have we prompted yet").
 *
 * Scope: this governs ONLY the dispatch-level annotation the CallTool
 * handler applies (`call-tool-handler.ts`'s `maybeAnnotate`). The
 * `withLicenseAndQuota` middleware path (`license.gate.ts`) is UNCHANGED —
 * it keeps its own unconditional per-call annotation. Gated tools (~4 of 24
 * always-emitting tools) are an accepted exception to the once-per-process
 * behavior; see the plan's decision note.
 */
const promptedIds = new Set<string>()

/**
 * True iff `anonymousId` has already been annotated with `consent_required`
 * on a direct-dispatch response this process. A peek, not a mutation — pair
 * with {@link markConsentPrompted}, called only after annotation actually
 * happens, so a fail-open no-op (e.g. a non-JSON response body) never
 * consumes the one-shot prompt for a user who never actually saw it.
 */
export function wasConsentPrompted(anonymousId: string | null | undefined): boolean {
  if (!anonymousId) return false
  return promptedIds.has(anonymousId)
}

/**
 * Record that `anonymousId` has now been shown the `consent_required`
 * prompt on a direct-dispatch response. No-ops for a falsy id.
 */
export function markConsentPrompted(anonymousId: string | null | undefined): void {
  if (!anonymousId) return
  promptedIds.add(anonymousId)
}

/**
 * Test-only helper. Not exported from the package index.
 *
 * Clears both the consent-preference cache AND the once-per-process
 * `promptedIds` set — the two share a process-lifetime scope and every
 * existing caller of this helper wants a fully clean slate between tests.
 */
export function _resetConsentCacheForTests(): void {
  consentCache.clear()
  promptedIds.clear()
}
