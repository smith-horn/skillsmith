/**
 * SSO half of the auth-callback handler (SMI-6205, SMI-6200 Wave 4).
 *
 * Split out of `auth-callback-handler.ts` when Wave 4 Step 3's link-candidate
 * routing pushed that file past the 500-line standards gate. Everything the
 * SSO path owns lives here — session detection, the refusal vocabulary's
 * user-facing copy, the `/account/link-sso` redirect target, and
 * `handleSsoCallback` itself; `auth-callback-handler.ts` keeps the generic
 * dispatcher and the profile-completion gate and re-exports this module's
 * public surface so existing importers are unaffected.
 *
 * Imports only TYPES from `./auth-callback-handler.types`, so the split
 * introduces no runtime import cycle.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { AuthTimeoutError, withAuthTimeout } from './auth-timeout'
import type {
  DispatchCallbacks,
  RecordSsoLoginResult,
  SsoLinkCandidate,
  SsoLoginRefusalReason,
} from './auth-callback-handler.types'

/**
 * True when `session.user.app_metadata.provider` carries the `sso:<uuid>`
 * prefix `sso_session_identity()` (Wave 4 Step 1) matches against — the only
 * structural signal available client-side. GoTrue's SSO/SAML callback carries
 * no distinguishing URL param of its own: under the client's default
 * `flowType: 'pkce'`, it lands in the exact same `code`-only shape as an
 * email-verification or generic-OAuth PKCE exchange, so the session's own
 * provider claim (set only by GoTrue, never client-writable) is the sole
 * reliable check.
 */
export function isSsoProvisionedSession(
  session: { user?: { app_metadata?: { provider?: string } } } | null | undefined
): boolean {
  const provider = session?.user?.app_metadata?.provider
  return typeof provider === 'string' && provider.startsWith('sso:')
}

const SSO_LOGIN_TIMEOUT_MS = 8000

/** The consented identity-link UI (Wave 4 Step 3). */
export const LINK_SSO_PATH = '/account/link-sso'

const SSO_GENERIC_ERROR_COPY = 'We could not complete your SSO sign-in. Please try again.'

/**
 * The `null`-outcome landing state Wave 4 Step 2 specifies verbatim: no group
 * in the assertion matched any role this team's mapping recognizes.
 */
const SSO_UNMAPPED_COPY =
  "Your identity provider didn't send a group this team recognizes — contact your team admin."

/**
 * User-facing copy for each closed-vocabulary refusal reason. `seat_limit_reached`
 * carries the plan's exact specified copy — "the one refusal a team admin can
 * actually fix." The rest are none of them self-service, so the copy names the
 * cause plainly and defers to the team admin rather than inventing a false
 * "try again" affordance.
 */
function ssoRefusalCopy(reason: SsoLoginRefusalReason | string): string {
  switch (reason) {
    case 'seat_limit_reached':
      return 'Your team has used all its seats — ask your team owner to add more.'
    case 'not_an_sso_session':
      return "This sign-in wasn't recognized as an SSO session. Please use your team's SSO sign-in link."
    case 'provider_not_registered':
      return "Your identity provider isn't registered with this team yet. Contact your team admin."
    case 'sso_inactive':
      return 'SSO is currently turned off for your team. Contact your team admin to re-enable it.'
    case 'domain_not_verified':
      return "Your team's domain hasn't been verified for SSO yet. Contact your team admin."
    case 'no_authentication_timestamp':
      return 'We could not confirm when your identity provider signed you in. Please try signing in again.'
    default:
      return 'Your SSO sign-in was refused. Contact your team admin if this continues.'
  }
}

/**
 * Build the `/account/link-sso` target for a `record_sso_login()` link
 * candidate, or `null` when the candidate is absent/malformed.
 *
 * `legacy_user_id` is required — `link-sso.astro` shows its "no pending
 * account link" state without it, so redirecting there with a blank id would
 * be a strictly worse outcome than the normal finish path. It is URL-encoded:
 * it originates from an IdP assertion, and an unencoded `&` or `#` would
 * otherwise corrupt the query string.
 *
 * `legacy_email` is deliberately NOT carried any more (SMI-6205 adversarial
 * review M9). The page used to display it, which made the counterparty shown
 * on a consent screen an unauthenticated URL parameter that nothing checked
 * against the id beside it. It now re-resolves the whole candidate server-side
 * from the caller's own session, so passing the address here would be dead
 * weight that invites the same mistake back.
 */
export function ssoLinkRedirectUrl(candidate: SsoLinkCandidate | null | undefined): string | null {
  const legacyUserId = candidate?.legacy_user_id
  if (typeof legacyUserId !== 'string' || legacyUserId.trim() === '') return null
  const query = new URLSearchParams({ legacy_user_id: legacyUserId })
  return `${LINK_SSO_PATH}?${query.toString()}`
}

/**
 * True when the browser arrived here FROM `/account/link-sso`. Mirrors
 * `routePostAuth`'s H1 `cameFromCompleteProfile` guard exactly, including its
 * "unparseable referrer means no guard" fallback — the redirect below must
 * never bounce a user straight back to the page they just came from.
 * Same-origin is required, so a referrer from an IdP that happens to use the
 * same pathname cannot suppress a legitimate offer.
 */
function cameFromLinkSso(cbs: DispatchCallbacks): boolean {
  if (!cbs.documentReferrer || !cbs.windowOrigin) return false
  try {
    const ref = new URL(cbs.documentReferrer, cbs.windowOrigin)
    if (ref.origin !== new URL(cbs.windowOrigin).origin) return false
    return ref.pathname.replace(/\/$/, '') === LINK_SSO_PATH
  } catch {
    return false
  }
}

/**
 * SMI-6205 (SMI-6200 Wave 4 Step 2): after a `signInWithSSO` redirect lands
 * back on an SSO-provisioned session, call `record_sso_login()` — the sole
 * writer for SSO member lifecycle (Wave 4 Step 1) — and route on its typed
 * `status`. Takes no `CallbackParams`: `record_sso_login()` itself takes no
 * arguments and reads only the CURRENT session's `auth.uid()`/`auth.jwt()`,
 * the same no-argument, current-session-only contract
 * `previewSsoRoleMapping()` mirrors for `sso_map_role()` (Wave 4 Step 2's "no
 * TypeScript twin" decision — this handler doesn't reimplement any mapping
 * logic, it only interprets the RPC's typed result).
 */
export async function handleSsoCallback(
  supabase: SupabaseClient,
  cbs: DispatchCallbacks
): Promise<void> {
  let result: RecordSsoLoginResult
  try {
    // supabase.rpc(...) returns a PostgrestFilterBuilder (thenable, not a
    // structural Promise — missing .catch/.finally/Symbol.toStringTag), so
    // it must be coerced via Promise.resolve() before withAuthTimeout's
    // Promise<T> race can accept it.
    const { data, error } = await withAuthTimeout(
      Promise.resolve(supabase.rpc('record_sso_login')),
      SSO_LOGIN_TIMEOUT_MS,
      'SSO sign-in did not complete in time. Please try again.'
    )
    if (error) {
      console.error('[auth/callback] record_sso_login RPC error:', error.message)
      cbs.showError(SSO_GENERIC_ERROR_COPY)
      return
    }
    result = data as RecordSsoLoginResult
  } catch (err) {
    console.error('[auth/callback] record_sso_login threw:', err)
    cbs.showError(err instanceof AuthTimeoutError ? err.message : SSO_GENERIC_ERROR_COPY)
    return
  }

  switch (result?.status) {
    case 'ok': {
      // ---------------------------------------------------------------- Wave 4 Step 3
      // ORDERING, stated explicitly because this file owns TWO redirects and
      // What Changes §4 requires the precedence to be a decision, not an
      // accident: the identity-link offer runs BEFORE `finishCallback()` (and
      // therefore before `routePostAuth`'s profile-completion gate). Four
      // reasons, in order of weight:
      //
      //  1. The gate would otherwise make this redirect UNREACHABLE on the one
      //     login where the candidate is freshest. Verified against the real
      //     trigger, not assumed: `handle_new_user()`
      //     (080_profile_completion.sql:230-250) fast-paths
      //     `profile_completed_at` only for `provider = 'email'` and splits
      //     names only for `provider = 'github'`. An SSO session's provider is
      //     `sso:<uuid>`, so a JIT-provisioned SSO user lands with
      //     first_name/last_name/profile_completed_at ALL NULL — i.e.
      //     `routePostAuth` bounces EVERY first-time SSO user to
      //     /complete-profile. Running it first would swallow the candidate.
      //  2. The candidate expires; the profile prompt does not.
      //     `sso_account_links.consent_expires_at` is a 7-day window, and this
      //     redirect is the only thing that puts the SSO identity in front of
      //     it. (`/account/link-sso` re-reads the candidate for itself through
      //     `get_own_sso_link_candidate()`, a read-only RPC added by the
      //     confirmation round — but nothing takes the user there unprompted.)
      //     Profile completion re-prompts on every subsequent callback, so
      //     deferring it costs one navigation.
      //  3. The link is a security-relevant, entitlement-moving consent
      //     decision (it revokes the legacy identity's license keys); the
      //     profile gate is a data-quality prompt.
      //  4. Nothing is skipped, only deferred: profile completion is
      //     independently enforced in SQL at the point it actually matters
      //     (`issue_license_key_if_profile_complete`, 080:507-530), so
      //     bypassing the UI gate for one navigation grants no entitlement.
      //
      // On the EXISTING loop guard: `routePostAuth`'s H1 guard keys strictly
      // on `documentReferrer.pathname === '/complete-profile'`, so it cannot
      // fire for this new `/account/link-sso` target — and when we redirect we
      // return before `finishCallback()`, so `routePostAuth` is not reached at
      // all on that pass. `cameFromLinkSso` is this redirect's own symmetric
      // guard.
      //
      // Popup mode is not a concern here: `login.astro` drives SSO with a
      // full-page `window.location.href = data.url` (never
      // `LoginButton.astro`'s popup), so an SSO callback is never the popup
      // branch of `finishCallback`.
      const linkUrl = ssoLinkRedirectUrl(result.link_candidate)
      if (linkUrl && !cameFromLinkSso(cbs)) {
        cbs.navigate(linkUrl)
        return
      }
      // Reuse the normal post-auth success path — do not reinvent it here.
      await cbs.finishCallback()
      return
    }
    case 'unmapped':
      cbs.showError(SSO_UNMAPPED_COPY)
      return
    case 'refused':
      cbs.showError(ssoRefusalCopy(result.reason))
      return
    default:
      console.error('[auth/callback] record_sso_login returned an unexpected shape:', result)
      cbs.showError(SSO_GENERIC_ERROR_COPY)
  }
}
