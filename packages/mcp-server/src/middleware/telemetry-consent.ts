/**
 * Telemetry Consent Gate — SMI-5019 W2.S4
 *
 * For MCP-only clients (Cursor, Continue, Copilot users without a CLI install)
 * we cannot rely on a CLI first-run prompt or a VS Code toast. Per user
 * decision U5 in the implementation plan, the consent surface is the web
 * dashboard at https://skillsmith.app/account/telemetry.
 *
 * This module supplies the MCP-side half of that flow:
 *
 *  1. On every tool call, resolve the calling anonymous_id's preference from
 *     `user_telemetry_preferences` (RLS-scoped via the same anon-key client
 *     used elsewhere in this package).
 *  2. If the row is missing, signal `consent_required:true` + the privacy URL
 *     in the response envelope so the client can prompt the user to open the
 *     dashboard.
 *  3. Cache the resolved state per process (Map keyed by anonymous_id) so
 *     repeated calls within a session don't re-query, and so two parallel
 *     calls from the same unrecognized anonymous_id observe identical state.
 *  4. Suppress telemetry writes (consult `shouldEmitTelemetry`) for that
 *     anonymous_id until the preference resolves to `enabled:true`.
 *
 * SMI-5016 (`packages/core/src/telemetry/wrap.ts`) and SMI-5017 (tool /
 * command dispatchers) are wave-sibling deliverables — this module
 * deliberately stays out of those files.
 */

import { getSupabaseClient } from '../supabase-client.js'

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

interface SupabaseLike {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        col: string,
        val: string
      ) => {
        maybeSingle: () => Promise<{
          data: { enabled?: boolean | null } | null
          error: unknown
        }>
      }
    }
  }
}

/**
 * Per-process cache keyed by anonymous_id. We deliberately use a single shared
 * Map so two parallel `withConsentGate` invocations for the same
 * anonymous_id observe identical state — the constraint flagged in the spec.
 *
 * Stored value is a Promise (not the resolved ConsentState) so concurrent
 * lookups share one in-flight Supabase query.
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

/**
 * Look up the consent row for `anonymousId` and translate it into a
 * `ConsentState`. Falls back to "consent required" on any error so we never
 * silently emit telemetry from an unknown identity.
 */
async function fetchConsentState(anonymousId: string): Promise<ConsentState> {
  let client: SupabaseLike
  try {
    client = (await getSupabaseClient()) as SupabaseLike
  } catch {
    // Supabase isn't configured in this environment (e.g. offline CLI run);
    // safest interpretation is "no consent → no emit" but also "no need to
    // prompt the user" because the network surface isn't reachable anyway.
    return { ...DEFAULT_NO_ID }
  }

  try {
    const { data, error } = await client
      .from('user_telemetry_preferences')
      .select('enabled')
      .eq('anonymous_id', anonymousId)
      .maybeSingle()

    if (error || !data) {
      return { ...DEFAULT_CONSENT_REQUIRED }
    }

    return {
      enabled: data.enabled === true,
      consentRequired: false,
      privacyUrl: TELEMETRY_PRIVACY_URL,
    }
  } catch {
    return { ...DEFAULT_CONSENT_REQUIRED }
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
