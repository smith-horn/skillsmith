/**
 * Shared types for the auth-callback handler family (SMI-5075, SMI-6205).
 *
 * Split out of `auth-callback-handler.ts` when SMI-6205's link-candidate
 * routing pushed that file past the 500-line standards gate — the
 * `foo.types.ts` half of the split CLAUDE.md's CI Health Requirements
 * prescribe. Types only: no runtime code, so nothing here can create an
 * import cycle between the handler and its `.sso` sibling.
 */

export interface CallbackParams {
  accessToken: string | null
  refreshToken: string | null
  type: string | null
  errorCode: string | null
  errorDescription: string | null
  /** Full URL for PKCE exchange. */
  url: string
  /** Hash fragment (with leading `#` if present) for recovery redirect. */
  hash: string
}

/** Callbacks the dispatcher uses to talk back to the DOM-bound .astro scope. */
export interface DispatchCallbacks {
  showError(message?: string): void
  /** Runs fetchOrgs + popup-postMessage/close OR routePostAuth. Inlined in .astro. */
  finishCallback(): Promise<void>
  /** Navigation hook (defaults to window.location.href assignment in .astro). */
  navigate(url: string): void
  /**
   * `document.referrer` at call time, passed in so this module stays DOM-free
   * (same contract as `ProfileGateCallbacks.documentReferrer`). Optional: when
   * absent, the SSO link-candidate re-offer guard below simply never fires,
   * which is the same behavior as an empty referrer.
   */
  documentReferrer?: string
  /** `window.location.origin` at call time — the base the referrer is resolved against. */
  windowOrigin?: string
}

/** Callbacks the profile-completion gate uses. */
export interface ProfileGateCallbacks {
  showSuccess(): void
  showError(message?: string): void
  navigate(url: string): void
  /** Already-validated next-redirect target (from validateNextParam at SSR time). */
  authRedirectTo: string
  /** document.referrer at call time. Passed in so this module is DOM-free. */
  documentReferrer: string
  /** window.location.origin at call time. */
  windowOrigin: string
}

/**
 * Closed vocabulary `sso_login_refusal_reason()` returns (SMI-6200 Wave 4
 * Step 1) — matched exhaustively by `ssoRefusalCopy` below.
 */
export type SsoLoginRefusalReason =
  | 'not_an_sso_session'
  | 'provider_not_registered'
  | 'sso_inactive'
  | 'domain_not_verified'
  | 'no_authentication_timestamp'
  | 'seat_limit_reached'

/**
 * `record_sso_login()`'s `link_candidate` field: `{legacy_user_id, legacy_email}`
 * when an un-linked, un-expired `sso_account_links` candidate row exists for
 * this session's identity, otherwise `null`
 * (`20260828000003_sso_member_lifecycle.sql`, `record_sso_login()` step 7).
 */
export interface SsoLinkCandidate {
  legacy_user_id: string
  legacy_email?: string | null
}

/** `record_sso_login()`'s typed JSONB return shape (Wave 4 Step 1). */
export type RecordSsoLoginResult =
  | { status: 'ok'; link_candidate?: SsoLinkCandidate | null; [key: string]: unknown }
  | { status: 'unmapped'; team_id?: string; [key: string]: unknown }
  | { status: 'refused'; reason: SsoLoginRefusalReason; [key: string]: unknown }
