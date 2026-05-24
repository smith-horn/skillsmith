/**
 * OAuth email-sync outcome mapping — SMI-5173
 *
 * Pure, framework-free helper that maps the `sync-oauth-email` edge function
 * response (HTTP status + JSON body) onto a user-facing outcome. Kept free of
 * DOM/Supabase dependencies so it is unit-testable in isolation; the Astro page
 * imports `describeSyncOAuthEmailOutcome` and renders the result.
 */

export interface SyncOAuthEmailResponse {
  ok?: boolean
  updated?: boolean
  email?: string
  skipped?: 'no_drift' | 'no_verified_identity' | 'lookup_failed'
  error?: string
}

export interface SyncOAuthEmailOutcome {
  kind: 'success' | 'info' | 'error'
  message: string
}

/**
 * Map a sync-oauth-email response onto a user-facing outcome.
 *
 * @param status - HTTP status code from the edge function response.
 * @param body - Parsed JSON body (best-effort; fields may be absent).
 * @param providerLabel - Human-readable provider name, e.g. 'GitHub' or 'Google'.
 */
export function describeSyncOAuthEmailOutcome(
  status: number,
  body: SyncOAuthEmailResponse,
  providerLabel: string
): SyncOAuthEmailOutcome {
  if (status === 200) {
    if (body.updated === true) {
      return {
        kind: 'success',
        message: `Your Skillsmith email is now ${body.email}.`,
      }
    }
    if (body.skipped === 'no_drift') {
      return {
        kind: 'info',
        message: `Your Skillsmith email already matches ${providerLabel}. If you just changed it there, sign out of Skillsmith and back in first, then try again.`,
      }
    }
    if (body.skipped === 'no_verified_identity') {
      return {
        kind: 'info',
        message: `We couldn't find a verified email on your ${providerLabel} account. Set it as your primary email and verify it at ${providerLabel}, then sign out and back in.`,
      }
    }
    if (body.skipped === 'lookup_failed') {
      return {
        kind: 'error',
        message: `We couldn't reach ${providerLabel} to check your email. Please try again in a moment.`,
      }
    }
  }

  if (status === 409 || body.error === 'email_conflict') {
    return {
      kind: 'error',
      message: `That email is already used by another Skillsmith account. Contact support to resolve it.`,
    }
  }

  if (status === 401) {
    return {
      kind: 'error',
      message: `Your session expired. Please sign in again.`,
    }
  }

  return {
    kind: 'error',
    message: `Something went wrong updating your email. Please try again.`,
  }
}
