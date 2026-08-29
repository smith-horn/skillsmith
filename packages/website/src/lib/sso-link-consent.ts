/**
 * SSO identity-link client helpers (SMI-6205, SMI-6200 Wave 4 Step 3).
 *
 * Extracted from `packages/website/src/pages/account/link-sso.astro` for the
 * same reason `auth-callback-handler.ts` was extracted from
 * `auth/callback.astro`: the page is DOM-bound and past the 500-line gate, and
 * none of the logic below needs the DOM. Everything here is a pure function or
 * a Supabase/fetch call, so it is unit-testable without a browser.
 *
 * The page owns four distinct interactions, split by identity:
 *   1. the SSO identity reading, confirming, declining or RESTORING its own
 *      offer → `get_own_sso_link_candidate()` (here), `link_sso_account()`
 *      (in the page), `dismiss_sso_link_candidate()` /
 *      `undismiss_sso_link_candidate()` (here)
 *   2. the LEGACY identity discovering + consenting to a pending request
 *      → `get_pending_sso_link_requests()` + `record_sso_link_consent()` (here)
 *   3. the post-link notification to the legacy identity's verified email
 *      → the `sso-link-notify` edge function (here)
 *
 * Both reads exist because `sso_account_links` deliberately holds NO client
 * grant (20260829230000 Section 1): without a dedicated reader the legacy
 * identity could never learn a request exists — and `record_sso_link_consent()`
 * takes the SSO user id as an argument it would have no channel to obtain —
 * while the SSO identity's own read had to come from somewhere that is not the
 * side-effecting login write path (see `fetchOwnSsoLinkCandidate()`).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** One row of `get_pending_sso_link_requests()` (20260829230001). */
export interface PendingSsoLinkRequest {
  sso_user_id: string
  team_id: string
  team_name: string | null
  requested_at: string | null
  consent_expires_at: string | null
  consented_at: string | null
}

/**
 * What the legacy identity's discovery read resolved to. `pending` and
 * `consented` are deliberately distinct: dropping an already-consented row
 * would look to the user like their confirmation was lost.
 */
export type PendingLinkLookup =
  | { status: 'none' }
  | { status: 'pending'; request: PendingSsoLinkRequest }
  | { status: 'consented'; request: PendingSsoLinkRequest }
  | { status: 'error'; message: string }

const GENERIC_LOOKUP_ERROR =
  'We could not check for pending account links. Please try again or contact support@smithhorn.ca.'

const GENERIC_CONSENT_ERROR =
  'Something went wrong confirming this request. Please try again or contact support@smithhorn.ca.'

/**
 * Read THIS caller's own pending link requests. Zero arguments by design —
 * the RPC's only selector is `auth.uid()`, so there is no id to pass and none
 * to get wrong.
 *
 * Only the first (oldest) row is surfaced. The RPC orders by `created_at ASC`
 * and a second simultaneous request from a different SSO identity for the same
 * account is a pathological case that should be handled deliberately, not by
 * silently stacking consent prompts.
 */
export async function fetchPendingSsoLinkRequest(
  supabase: SupabaseClient
): Promise<PendingLinkLookup> {
  try {
    const { data, error } = await supabase.rpc('get_pending_sso_link_requests')
    if (error) {
      console.error('get_pending_sso_link_requests failed:', error.message)
      return { status: 'error', message: GENERIC_LOOKUP_ERROR }
    }
    const rows = (data ?? []) as PendingSsoLinkRequest[]
    const request = Array.isArray(rows) ? rows[0] : undefined
    if (!request) return { status: 'none' }
    return request.consented_at ? { status: 'consented', request } : { status: 'pending', request }
  } catch (err) {
    console.error('get_pending_sso_link_requests threw:', err)
    return { status: 'error', message: GENERIC_LOOKUP_ERROR }
  }
}

/**
 * One row of `get_own_sso_link_candidate()` (20260829230001) — the SSO
 * identity's own view of its pending link candidate. Both fields are resolved
 * SERVER-side from the caller's own signed session, never from a URL parameter.
 */
export interface OwnSsoLinkCandidate {
  legacy_user_id: string
  legacy_email: string | null
}

/**
 * Read THIS SSO identity's own link candidate (SMI-6205 adversarial review M9;
 * source corrected by confirmation round N-3/N-4).
 *
 * `/account/link-sso` previously rendered the counterparty's address straight
 * from `?legacy_email=`, an unauthenticated URL parameter that nothing checked
 * against `?legacy_user_id=`. Anyone who could get a user to open a crafted
 * link could therefore choose which account the consent screen SAID they were
 * merging with, while `link_sso_account()` acted on the id — the two halves of
 * an informed-consent screen naming different accounts. Resolving it
 * server-side from the session closed that.
 *
 * The function it resolved from was `record_sso_login()`, justified at the time
 * on the grounds that all of that function's writes are monotonic. Monotonic is
 * not the same as absent, and it was the wrong source on two counts: every call
 * appends an `'sso:login_recorded'` row to `audit_logs` (so merely opening or
 * reloading this page forged login records in the Enterprise
 * `audit_query`/`audit_export`/`siem_export` surfaces), and every call re-arms
 * the candidate's 7-day `consent_expires_at` window — the "window that never
 * closes" that `dismiss_sso_link_candidate()`'s H3 fix exists to prevent,
 * reintroduced through the page-view path instead of the login path.
 *
 * `get_own_sso_link_candidate()` is the read-only replacement: zero arguments
 * (its only selector is `auth.uid()`, so there is no id to point at someone
 * else), `STABLE` so it is structurally incapable of either write, and carrying
 * exactly the predicate `link_sso_account()` applies — so a candidate surfaced
 * here is one the Confirm button would still be accepted for. Only the first
 * (oldest) row is used, mirroring `fetchPendingSsoLinkRequest()` above. Returns
 * `null` when there is none, which the page renders as its "no pending account
 * link" state.
 */
export async function fetchOwnSsoLinkCandidate(
  supabase: SupabaseClient
): Promise<OwnSsoLinkCandidate | null> {
  try {
    const { data, error } = await supabase.rpc('get_own_sso_link_candidate')
    if (error) {
      console.error('get_own_sso_link_candidate failed:', error.message)
      return null
    }
    const rows = (data ?? []) as OwnSsoLinkCandidate[]
    const candidate = Array.isArray(rows) ? rows[0] : undefined
    if (!candidate || typeof candidate.legacy_user_id !== 'string') return null
    return {
      legacy_user_id: candidate.legacy_user_id,
      legacy_email: typeof candidate.legacy_email === 'string' ? candidate.legacy_email : null,
    }
  } catch (err) {
    console.error('get_own_sso_link_candidate threw:', err)
    return null
  }
}

/**
 * The SSO identity declines its own link offer (SMI-6205 adversarial review
 * H3). Keyed server-side on `sso_user_id = auth.uid()`, so the id passed here
 * only names WHICH offer to decline, never WHO is declining.
 *
 * Deliberately fire-and-forget from the caller's point of view: "Not now" must
 * navigate away whether or not the dismissal landed, because failing to record
 * a decline is strictly less bad than trapping the user on the page they were
 * trying to leave. The boolean exists for tests.
 */
export async function dismissSsoLinkCandidate(
  supabase: SupabaseClient,
  legacyUserId: string
): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('dismiss_sso_link_candidate', {
      p_legacy_user_id: legacyUserId,
    })
    if (error) {
      console.warn('dismiss_sso_link_candidate refused:', error.message)
      return false
    }
    return true
  } catch (err) {
    console.warn('dismiss_sso_link_candidate threw — non-fatal', err)
    return false
  }
}

const GENERIC_RESTORE_ERROR =
  'We could not restore that request. Please try again or contact support@smithhorn.ca.'

/**
 * Classify `undismiss_sso_link_candidate()`'s refusal text into user-facing
 * copy. The server collapses "no candidate", "never dismissed", "already
 * linked" and "not yours" into ONE message so a signed-in caller cannot probe
 * for links between two specific accounts — so, exactly as
 * `mapConsentErrorToCopy()` does, the copy here must stay equally
 * undifferentiated rather than inventing a specificity the server refuses to
 * provide.
 */
export function mapRestoreErrorToCopy(msg: string | undefined): string {
  const m = (msg ?? '').toLowerCase()
  if (m.includes('no dismissed link candidate')) {
    return "There's nothing to restore — the request may have expired, already been completed, or never been dismissed. Ask whoever started it to sign in through your team's SSO again."
  }
  if (m.includes('only be restored while signed in')) {
    return 'Your session expired. Sign in again and reopen this page to restore the request.'
  }
  // Never surface raw upstream text verbatim (SMI-6204's convention).
  console.error('undismiss_sso_link_candidate refused:', msg)
  return GENERIC_RESTORE_ERROR
}

/**
 * The SSO identity RESTORES a link offer it previously declined (SMI-6205
 * confirmation round N-2). Keyed server-side on `sso_user_id = auth.uid()`,
 * exactly as `dismissSsoLinkCandidate()` is, so the id passed here only names
 * WHICH offer to restore, never WHO is restoring it.
 *
 * Unlike its dismissal counterpart this is NOT fire-and-forget. "Not now" had
 * to navigate away whether or not it landed; "restore" is the opposite — the
 * user is asking to get something back, so a silent failure would look like the
 * request was gone for good. The outcome is surfaced in the page's
 * `role="alert"` region instead.
 */
export async function undismissSsoLinkCandidate(
  supabase: SupabaseClient,
  legacyUserId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const { error } = await supabase.rpc('undismiss_sso_link_candidate', {
      p_legacy_user_id: legacyUserId,
    })
    if (error) return { ok: false, message: mapRestoreErrorToCopy(error.message) }
    return { ok: true }
  } catch (err) {
    console.error('undismiss_sso_link_candidate threw:', err)
    return { ok: false, message: GENERIC_RESTORE_ERROR }
  }
}

/**
 * Classify `record_sso_link_consent()`'s RAISE EXCEPTION text into user-facing
 * copy, matching the substring-match convention `team-invitations.ts`'s
 * `mapRpcErrorToCopy()` established. Matched against the migration's ACTUAL
 * exception strings (`20260829230000_sso_member_lifecycle.sql`,
 * `record_sso_link_consent()`), which collapse "no candidate", "already
 * linked" and "expired" into ONE deliberately-undifferentiated message so a
 * signed-in caller cannot probe for candidates — so the copy here must stay
 * equally undifferentiated rather than inventing a specificity the server
 * refuses to provide.
 */
export function mapConsentErrorToCopy(msg: string | undefined): string {
  const m = (msg ?? '').toLowerCase()
  if (m.includes('no pending link request') || m.includes('has expired')) {
    return 'This request is no longer available — it may have expired, or already been completed. Ask whoever started it to try again from their account page.'
  }
  if (m.includes('consent must be recorded while signed in')) {
    return 'Your session expired. Sign in again and reopen this page to confirm.'
  }
  // Never surface raw upstream text verbatim (SMI-6204's convention).
  console.error('record_sso_link_consent refused:', msg)
  return GENERIC_CONSENT_ERROR
}

/**
 * Classify `link_sso_account()`'s RAISE EXCEPTION text into user-facing copy.
 * Matched against the migration's actual strings — note the real refusal is
 * "the legacy account owns a team", NOT the substring "owner", which an
 * earlier draft of this matcher (written before the migration landed) would
 * have missed and silently fallen through to the generic fallback below.
 */
export function mapLinkErrorToCopy(msg: string | undefined): string {
  const m = (msg ?? '').toLowerCase()

  // "forbidden: the legacy account owns a team -- transfer ownership first"
  if (m.includes('owns a team') || m.includes('transfer ownership')) {
    return "This account is a team owner, so it can't be linked this way. Ownership transfer isn't supported here — contact support@smithhorn.ca to move ownership first."
  }
  // "forbidden: link_consent_required -- the legacy account must confirm this
  // link from its own verified email before it can be executed"
  if (m.includes('link_consent_required') || m.includes('must confirm this link')) {
    return "We're still waiting for confirmation from the other account. Ask them to sign in to Skillsmith and open their account page to confirm, then try again."
  }
  // "forbidden: the legacy account's email is not verified"
  if (m.includes("legacy account's email is not verified") || m.includes('email is not verified')) {
    return "The other account's email isn't verified yet. Ask them to verify their email, then try again."
  }
  // "legacy identity and SSO identity are the same account"
  if (m.includes('same account')) {
    return "That's already your own account — there's nothing to link."
  }
  // "forbidden: link_sso_account must be called as an SSO identity bound to a team (...)"
  if (m.includes('bound to a team') || m.includes('must be called as an sso identity')) {
    return "We couldn't confirm your SSO session. Try signing out and back in via your team's SSO, then retry."
  }
  console.error('link_sso_account refused:', msg)
  return 'Something went wrong linking your account. Please try again or contact support@smithhorn.ca.'
}

/**
 * The LEGACY identity records its consent. Authorization IS the caller's
 * identity — the RPC is keyed on `legacy_user_id = auth.uid()`, so an SSO
 * identity calling this for its own candidate simply finds no row.
 */
export async function recordSsoLinkConsent(
  supabase: SupabaseClient,
  ssoUserId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const { error } = await supabase.rpc('record_sso_link_consent', {
      p_sso_user_id: ssoUserId,
    })
    if (error) return { ok: false, message: mapConsentErrorToCopy(error.message) }
    return { ok: true }
  } catch (err) {
    console.error('record_sso_link_consent threw:', err)
    return { ok: false, message: GENERIC_CONSENT_ERROR }
  }
}

/**
 * Fire the post-link security notification to the legacy identity's own
 * verified email (What Changes §4: "A notification email fires on link
 * regardless").
 *
 * Client-triggered on purpose. The alternative — dispatching from inside
 * `link_sso_account()` via `pg_net` — is this codebase's pattern for
 * CRON-triggered background jobs with no live client (`sso-domain-reverify`);
 * here there is a live authenticated client right at the confirm button, which
 * is exactly the shape `team-invite-send` already uses.
 *
 * ALWAYS NON-FATAL. The link itself already committed in Postgres before this
 * is called, so a failed notification must never be surfaced to the user as a
 * failed link. It is logged, never thrown, and never blocks the redirect.
 * Returns a boolean purely so callers/tests can assert the outcome.
 */
export async function notifySsoLinkComplete(
  supabase: SupabaseClient,
  legacyUserId: string
): Promise<boolean> {
  try {
    const session = await supabase.auth.getSession()
    const accessToken = session.data.session?.access_token
    if (!accessToken) return false

    // SUPABASE_URL is exposed as supabase.supabaseUrl on the runtime client —
    // use it so the project ref is never hardcoded. The property exists at
    // runtime but isn't in the public type, so narrow through unknown (same
    // approach as team-invitations.ts's sendInviteEmail).
    const baseUrl = (supabase as unknown as { supabaseUrl?: string }).supabaseUrl
    if (!baseUrl) return false

    const res = await fetch(`${baseUrl}/functions/v1/sso-link-notify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ legacy_user_id: legacyUserId }),
    })
    if (!res.ok) {
      console.warn('sso-link-notify returned', res.status)
      return false
    }
    const body = (await res.json()) as { ok?: boolean }
    if (!body.ok) console.warn('sso-link-notify did not send the notification')
    return body.ok === true
  } catch (err) {
    console.warn('sso-link-notify failed — non-fatal, the link itself succeeded', err)
    return false
  }
}

/** Format an ISO timestamp as "September 4, 2026", or `null` if unusable. */
export function formatConsentDeadline(isoTimestamp: string | null | undefined): string | null {
  if (!isoTimestamp) return null
  const d = new Date(isoTimestamp)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}
