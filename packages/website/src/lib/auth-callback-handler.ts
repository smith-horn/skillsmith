/**
 * Auth callback handler module (SMI-5075).
 *
 * Extracted from packages/website/src/pages/auth/callback.astro to keep the
 * .astro file under the 500-line standards gate. Pure orchestration / Supabase
 * calls live here; DOM-touching helpers (showSuccess, showError, isPopupMode,
 * finishCallback) remain inline in the .astro because they read/write the
 * SSR-rendered DOM directly.
 *
 * History:
 *   SMI-1169 — email verification flow
 *   SMI-1715 — GitHub OAuth callback
 *   SMI-2978 — fetchAndStoreGitHubOrgs (provider-token → github_orgs upsert)
 *   SMI-4401 — profile-completion gate (routePostAuth)
 *   SMI-5059 — popup mode dispatch
 *   SMI-5075 — this extraction
 */

import type { SupabaseClient } from '@supabase/supabase-js'

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

/** Parse Supabase hash params + URL into a normalized CallbackParams. */
export function parseCallbackParams(hash: string, url: string): CallbackParams {
  const stripped = hash.startsWith('#') ? hash.substring(1) : hash
  const hashParams = new URLSearchParams(stripped)
  return {
    accessToken: hashParams.get('access_token'),
    refreshToken: hashParams.get('refresh_token'),
    type: hashParams.get('type'),
    errorCode: hashParams.get('error'),
    errorDescription: hashParams.get('error_description'),
    url,
    hash,
  }
}

/**
 * Email verification (type=signup|email): setSession from hash tokens, or PKCE
 * exchange when only `code` is in the URL. Either path ends in finishCallback().
 */
export async function handleEmailVerification(
  supabase: SupabaseClient,
  params: CallbackParams,
  cbs: DispatchCallbacks
): Promise<void> {
  if (params.accessToken && params.refreshToken) {
    const { error } = await supabase.auth.setSession({
      access_token: params.accessToken,
      refresh_token: params.refreshToken,
    })
    if (error) {
      cbs.showError(error.message)
      return
    }
    await cbs.finishCallback()
    return
  }
  const { error } = await supabase.auth.exchangeCodeForSession(params.url)
  if (error) {
    cbs.showError(error.message)
    return
  }
  await cbs.finishCallback()
}

/** Recovery flow: bounce straight to the reset-password page, preserving the hash. */
export function handleRecovery(params: CallbackParams, cbs: DispatchCallbacks): void {
  cbs.navigate(`/auth/reset-password${params.hash}`)
}

/** Generic OAuth (primary GitHub path): setSession from hash and finishCallback. */
export async function handleGenericOAuth(
  supabase: SupabaseClient,
  params: CallbackParams,
  cbs: DispatchCallbacks
): Promise<void> {
  const { error } = await supabase.auth.setSession({
    access_token: params.accessToken ?? '',
    refresh_token: params.refreshToken ?? '',
  })
  if (error) {
    cbs.showError(error.message)
    return
  }
  await cbs.finishCallback()
}

/**
 * No hash tokens. Two sub-cases:
 *   1. A live session is already present → fast-path through finishCallback.
 *   2. No session → attempt PKCE exchange on the URL. Either succeeds and
 *      runs finishCallback, or surfaces a generic expired-link error.
 */
export async function handleAlreadyLoggedInOrPkce(
  supabase: SupabaseClient,
  params: CallbackParams,
  cbs: DispatchCallbacks
): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (session) {
    await cbs.finishCallback()
    return
  }
  try {
    const { error } = await supabase.auth.exchangeCodeForSession(params.url)
    if (error) {
      cbs.showError('Invalid or expired verification link. Please request a new one.')
      return
    }
    await cbs.finishCallback()
  } catch (pkceError) {
    console.error('PKCE exchange error:', pkceError)
    cbs.showError('Invalid or expired verification link. Please request a new one.')
  }
}

/**
 * Top-level dispatcher. Branches on the hash params and delegates to the right
 * handler. Mirrors the original astro:page-load if/else-if chain 1:1 so behavior
 * is preserved exactly.
 */
export async function dispatchAuthCallback(
  supabase: SupabaseClient,
  params: CallbackParams,
  cbs: DispatchCallbacks
): Promise<void> {
  if (params.errorCode) {
    cbs.showError(params.errorDescription || 'Authentication failed')
    return
  }
  if (params.type === 'signup' || params.type === 'email') {
    await handleEmailVerification(supabase, params, cbs)
    return
  }
  if (params.type === 'recovery') {
    handleRecovery(params, cbs)
    return
  }
  if (params.accessToken) {
    await handleGenericOAuth(supabase, params, cbs)
    return
  }
  await handleAlreadyLoggedInOrPkce(supabase, params, cbs)
}

/**
 * SMI-2978: fetch GitHub org memberships using the OAuth provider_token and
 * persist to profiles.github_orgs. Must run BEFORE showSuccess() — the 2s
 * redirect timer there can race a long fetch. Non-fatal: any error is logged
 * and swallowed so the auth flow always completes.
 */
export async function fetchAndStoreGitHubOrgs(supabase: SupabaseClient): Promise<void> {
  try {
    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession()
    if (
      !currentSession?.provider_token ||
      currentSession.user.app_metadata?.provider !== 'github'
    ) {
      return
    }
    const orgsRes = await fetch('https://api.github.com/user/orgs?per_page=100', {
      headers: {
        Authorization: `token ${currentSession.provider_token}`,
        Accept: 'application/vnd.github+json',
      },
    })
    if (!orgsRes.ok) return
    const orgs = (await orgsRes.json()) as Array<{ login: string }>
    await supabase
      .from('profiles')
      .update({ github_orgs: orgs.map((o) => o.login) })
      .eq('id', currentSession.user.id)
      .neq('id', '')
  } catch {
    console.warn('[Callback] Could not fetch GitHub orgs — non-fatal')
  }
}

/**
 * SMI-4401 Wave 2: profile-completion gate. Runs after a session is set and
 * decides whether the user gets the success state (and the 2-second redirect
 * to authRedirectTo) or is bounced to /complete-profile to fill in their
 * first/last name.
 *
 * Branches:
 *   - profile query schema-drift (42703/42P01/PGRST204/PGRST205) → /complete-profile
 *   - profile row missing (PGRST116) → /complete-profile
 *   - any other DB error → showError
 *   - profile present but incomplete → /complete-profile (with loop guard)
 *   - profile complete → showSuccess
 *
 * H1 loop guard: if the user arrived FROM /complete-profile (documentReferrer
 * pathname check) and we'd just send them back, surface an error instead of
 * looping.
 */
export async function routePostAuth(
  supabase: SupabaseClient,
  cbs: ProfileGateCallbacks
): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) {
    cbs.showError('Session lost. Please sign in again.')
    return
  }
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('first_name, last_name, profile_completed_at')
    .eq('id', session.user.id)
    .single()
  if (profileError) {
    const code = (profileError as { code?: string }).code ?? ''
    const SCHEMA_DRIFT_CODES = ['42703', '42P01', 'PGRST204', 'PGRST205']
    if (SCHEMA_DRIFT_CODES.includes(code)) {
      console.warn('[auth/callback] schema drift detected', { code, path: '/auth/callback' })
      cbs.navigate('/complete-profile?next=' + encodeURIComponent(cbs.authRedirectTo))
      return
    }
    if (code === 'PGRST116') {
      cbs.navigate('/complete-profile?next=' + encodeURIComponent(cbs.authRedirectTo))
      return
    }
    cbs.showError(
      'We could not verify your profile. Please try again — if it keeps failing, contact us at /contact?topic=signup-help.'
    )
    return
  }
  const needsProfile =
    !profile?.profile_completed_at || !profile?.first_name?.trim() || !profile?.last_name?.trim()
  if (!needsProfile) {
    cbs.showSuccess()
    return
  }
  const cameFromCompleteProfile =
    !!cbs.documentReferrer &&
    (() => {
      try {
        return new URL(cbs.documentReferrer, cbs.windowOrigin).pathname === '/complete-profile'
      } catch {
        return false
      }
    })()
  if (cameFromCompleteProfile) {
    cbs.showError(
      'Something went wrong saving your profile. Try again at /complete-profile or contact us at /contact?topic=signup-help.'
    )
    return
  }
  cbs.navigate('/complete-profile?next=' + encodeURIComponent(cbs.authRedirectTo))
}
