import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  dispatchAuthCallback,
  fetchAndStoreGitHubOrgs,
  handleEmailVerification,
  handleSsoCallback,
  parseCallbackParams,
  routePostAuth,
  ssoLinkRedirectUrl,
  LINK_SSO_PATH,
  type DispatchCallbacks,
  type ProfileGateCallbacks,
  type SsoLoginRefusalReason,
} from './auth-callback-handler'

interface MockCallbacks extends DispatchCallbacks {
  finishCalls: number
  errorMessages: Array<string | undefined>
  navigateUrls: string[]
}

function makeCallbacks(): MockCallbacks {
  const cbs: MockCallbacks = {
    finishCalls: 0,
    errorMessages: [],
    navigateUrls: [],
    showError(message) {
      this.errorMessages.push(message)
    },
    async finishCallback() {
      this.finishCalls += 1
    },
    navigate(url) {
      this.navigateUrls.push(url)
    },
  }
  return cbs
}

interface MockSupabase {
  setSessionResult: { error: { message: string } | null }
  exchangeCodeResult: { error: { message: string } | null }
  getSessionResult: { data: { session: unknown } }
  rpcResult: { data: unknown; error: { message: string } | null }
  setSessionCalls: number
  exchangeCodeCalls: number
  rpcCalls: number
  client: SupabaseClient
}

function makeSupabase(opts?: {
  setSessionError?: string
  exchangeCodeError?: string
  exchangeCodeThrows?: boolean
  session?: unknown
  rpcData?: unknown
  rpcError?: string
  rpcThrows?: boolean
}): MockSupabase {
  const mock: MockSupabase = {
    setSessionResult: { error: opts?.setSessionError ? { message: opts.setSessionError } : null },
    exchangeCodeResult: {
      error: opts?.exchangeCodeError ? { message: opts.exchangeCodeError } : null,
    },
    getSessionResult: { data: { session: opts?.session ?? null } },
    rpcResult: {
      data: opts?.rpcData ?? null,
      error: opts?.rpcError ? { message: opts.rpcError } : null,
    },
    setSessionCalls: 0,
    exchangeCodeCalls: 0,
    rpcCalls: 0,
    client: {} as SupabaseClient,
  }
  mock.client = {
    auth: {
      setSession: vi.fn(async () => {
        mock.setSessionCalls += 1
        return mock.setSessionResult
      }),
      exchangeCodeForSession: vi.fn(async () => {
        mock.exchangeCodeCalls += 1
        if (opts?.exchangeCodeThrows) throw new Error('pkce-throw')
        return mock.exchangeCodeResult
      }),
      getSession: vi.fn(async () => mock.getSessionResult),
    },
    rpc: vi.fn(async () => {
      mock.rpcCalls += 1
      if (opts?.rpcThrows) throw new Error('rpc-throw')
      return mock.rpcResult
    }),
  } as unknown as SupabaseClient
  return mock
}

describe('parseCallbackParams', () => {
  it('parses a full hash fragment with access_token, refresh_token, and type', () => {
    const params = parseCallbackParams(
      '#access_token=abc&refresh_token=def&type=signup&expires_in=3600',
      'https://example.com/auth/callback'
    )
    expect(params.accessToken).toBe('abc')
    expect(params.refreshToken).toBe('def')
    expect(params.type).toBe('signup')
    expect(params.errorCode).toBeNull()
    expect(params.url).toBe('https://example.com/auth/callback')
  })

  it('handles an empty hash', () => {
    const params = parseCallbackParams('', 'https://example.com/auth/callback')
    expect(params.accessToken).toBeNull()
    expect(params.type).toBeNull()
    expect(params.hash).toBe('')
  })

  it('strips a leading # before parsing', () => {
    const fromHash = parseCallbackParams('#access_token=abc', 'https://example.com/cb')
    const fromBare = parseCallbackParams('access_token=abc', 'https://example.com/cb')
    expect(fromHash.accessToken).toBe('abc')
    expect(fromBare.accessToken).toBe('abc')
  })

  it('captures error params for the dispatcher errorCode branch', () => {
    const params = parseCallbackParams(
      '#error=access_denied&error_description=User%20denied%20access',
      'https://example.com/cb'
    )
    expect(params.errorCode).toBe('access_denied')
    expect(params.errorDescription).toBe('User denied access')
  })
})

describe('dispatchAuthCallback', () => {
  it('shows error and stops when errorCode is set', async () => {
    const sb = makeSupabase()
    const cbs = makeCallbacks()
    await dispatchAuthCallback(
      sb.client,
      parseCallbackParams('#error=oops&error_description=Bad', 'https://x/cb'),
      cbs
    )
    expect(cbs.errorMessages).toEqual(['Bad'])
    expect(cbs.finishCalls).toBe(0)
    expect(sb.setSessionCalls).toBe(0)
  })

  it('signup with access+refresh tokens → setSession → finishCallback', async () => {
    const sb = makeSupabase()
    const cbs = makeCallbacks()
    await dispatchAuthCallback(
      sb.client,
      parseCallbackParams('#access_token=at&refresh_token=rt&type=signup', 'https://x/cb'),
      cbs
    )
    expect(sb.setSessionCalls).toBe(1)
    expect(cbs.finishCalls).toBe(1)
    expect(cbs.errorMessages).toEqual([])
  })

  it('signup without tokens falls back to PKCE exchange', async () => {
    const sb = makeSupabase()
    const cbs = makeCallbacks()
    await dispatchAuthCallback(
      sb.client,
      parseCallbackParams('#type=email', 'https://x/cb?code=abc'),
      cbs
    )
    expect(sb.exchangeCodeCalls).toBe(1)
    expect(cbs.finishCalls).toBe(1)
  })

  it('recovery type navigates to /auth/reset-password with the original hash preserved', async () => {
    const sb = makeSupabase()
    const cbs = makeCallbacks()
    await dispatchAuthCallback(
      sb.client,
      parseCallbackParams('#type=recovery&access_token=rec', 'https://x/cb'),
      cbs
    )
    expect(cbs.navigateUrls).toEqual(['/auth/reset-password#type=recovery&access_token=rec'])
    expect(cbs.finishCalls).toBe(0)
    expect(sb.setSessionCalls).toBe(0)
  })

  it('generic OAuth (accessToken without type) → setSession → finishCallback', async () => {
    const sb = makeSupabase()
    const cbs = makeCallbacks()
    await dispatchAuthCallback(
      sb.client,
      parseCallbackParams('#access_token=at&refresh_token=rt', 'https://x/cb'),
      cbs
    )
    expect(sb.setSessionCalls).toBe(1)
    expect(cbs.finishCalls).toBe(1)
  })

  it('no tokens and existing session → fast-path finishCallback (no PKCE attempt)', async () => {
    const sb = makeSupabase({ session: { user: { id: 'u1' } } })
    const cbs = makeCallbacks()
    await dispatchAuthCallback(sb.client, parseCallbackParams('', 'https://x/cb'), cbs)
    expect(cbs.finishCalls).toBe(1)
    expect(sb.exchangeCodeCalls).toBe(0)
  })

  it('no tokens, no session → PKCE exchange → finishCallback', async () => {
    const sb = makeSupabase()
    const cbs = makeCallbacks()
    await dispatchAuthCallback(sb.client, parseCallbackParams('', 'https://x/cb?code=abc'), cbs)
    expect(sb.exchangeCodeCalls).toBe(1)
    expect(cbs.finishCalls).toBe(1)
  })

  it('no tokens, no session, PKCE exchange errors → expired-link showError', async () => {
    const sb = makeSupabase({ exchangeCodeError: 'invalid_grant' })
    const cbs = makeCallbacks()
    await dispatchAuthCallback(sb.client, parseCallbackParams('', 'https://x/cb'), cbs)
    expect(cbs.errorMessages).toEqual([
      'Invalid or expired verification link. Please request a new one.',
    ])
    expect(cbs.finishCalls).toBe(0)
  })

  it('no tokens, no session, PKCE exchange throws → expired-link showError', async () => {
    const sb = makeSupabase({ exchangeCodeThrows: true })
    const cbs = makeCallbacks()
    await dispatchAuthCallback(sb.client, parseCallbackParams('', 'https://x/cb'), cbs)
    expect(cbs.errorMessages).toEqual([
      'Invalid or expired verification link. Please request a new one.',
    ])
  })

  // SMI-6205: SSO routing. An SSO/SAML callback lands via the same
  // no-hash-tokens PKCE/already-logged-in path as email/OAuth PKCE — the
  // session's own app_metadata.provider is what actually distinguishes it.
  it('SSO-provisioned session (already-logged-in fast path) routes through record_sso_login, not finishCallback', async () => {
    const sb = makeSupabase({
      session: { user: { id: 'u1', app_metadata: { provider: 'sso:abc-123' } } },
      rpcData: { status: 'ok' },
    })
    const cbs = makeCallbacks()
    await dispatchAuthCallback(sb.client, parseCallbackParams('', 'https://x/cb'), cbs)
    expect(sb.rpcCalls).toBe(1)
    expect(sb.exchangeCodeCalls).toBe(0)
    // record_sso_login's 'ok' status reuses the real finishCallback exactly once.
    expect(cbs.finishCalls).toBe(1)
    expect(cbs.errorMessages).toEqual([])
  })

  it('SSO-provisioned session on the generic-OAuth hash-token path also routes through record_sso_login', async () => {
    const sb = makeSupabase({
      session: { user: { id: 'u1', app_metadata: { provider: 'sso:abc-123' } } },
      rpcData: { status: 'unmapped', team_id: 't1' },
    })
    const cbs = makeCallbacks()
    await dispatchAuthCallback(
      sb.client,
      parseCallbackParams('#access_token=at&refresh_token=rt', 'https://x/cb'),
      cbs
    )
    expect(sb.setSessionCalls).toBe(1)
    expect(sb.rpcCalls).toBe(1)
    expect(cbs.finishCalls).toBe(0)
    expect(cbs.errorMessages).toHaveLength(1)
  })

  it('a non-SSO session never calls record_sso_login', async () => {
    const sb = makeSupabase({
      session: { user: { id: 'u1', app_metadata: { provider: 'github' } } },
    })
    const cbs = makeCallbacks()
    await dispatchAuthCallback(sb.client, parseCallbackParams('', 'https://x/cb'), cbs)
    expect(sb.rpcCalls).toBe(0)
    expect(cbs.finishCalls).toBe(1)
  })

  it('a session with no app_metadata.provider at all never calls record_sso_login', async () => {
    const sb = makeSupabase({ session: { user: { id: 'u1' } } })
    const cbs = makeCallbacks()
    await dispatchAuthCallback(sb.client, parseCallbackParams('', 'https://x/cb'), cbs)
    expect(sb.rpcCalls).toBe(0)
    expect(cbs.finishCalls).toBe(1)
  })
})

describe('handleSsoCallback', () => {
  it("status 'ok' reuses the normal post-auth success path (finishCallback), not a reinvented one", async () => {
    const sb = makeSupabase({ rpcData: { status: 'ok' } })
    const cbs = makeCallbacks()
    await handleSsoCallback(sb.client, cbs)
    expect(sb.rpcCalls).toBe(1)
    expect(cbs.finishCalls).toBe(1)
    expect(cbs.errorMessages).toEqual([])
  })

  it("status 'unmapped' shows the plan's exact group-not-recognized copy", async () => {
    const sb = makeSupabase({ rpcData: { status: 'unmapped', team_id: 't1' } })
    const cbs = makeCallbacks()
    await handleSsoCallback(sb.client, cbs)
    expect(cbs.finishCalls).toBe(0)
    expect(cbs.errorMessages).toEqual([
      "Your identity provider didn't send a group this team recognizes — contact your team admin.",
    ])
  })

  const REFUSAL_CASES: Array<[SsoLoginRefusalReason, RegExp]> = [
    ['not_an_sso_session', /SSO session/i],
    ['provider_not_registered', /isn't registered with this team/i],
    ['sso_inactive', /turned off for your team/i],
    ['domain_not_verified', /domain hasn't been verified/i],
    ['no_authentication_timestamp', /could not confirm when/i],
    ['seat_limit_reached', /used all its seats — ask your team owner to add more/],
  ]

  it.each(REFUSAL_CASES)(
    'status refused with reason %s shows reason-specific copy',
    async (reason, matcher) => {
      const sb = makeSupabase({ rpcData: { status: 'refused', reason } })
      const cbs = makeCallbacks()
      await handleSsoCallback(sb.client, cbs)
      expect(cbs.finishCalls).toBe(0)
      expect(cbs.errorMessages).toHaveLength(1)
      expect(cbs.errorMessages[0]).toMatch(matcher)
    }
  )

  it("seat_limit_reached gets the plan's exact specified copy verbatim (the one refusal a team admin can fix)", async () => {
    const sb = makeSupabase({ rpcData: { status: 'refused', reason: 'seat_limit_reached' } })
    const cbs = makeCallbacks()
    await handleSsoCallback(sb.client, cbs)
    expect(cbs.errorMessages).toEqual([
      'Your team has used all its seats — ask your team owner to add more.',
    ])
  })

  it('an unrecognized refusal reason still shows a generic, non-crashing message', async () => {
    const sb = makeSupabase({ rpcData: { status: 'refused', reason: 'some_future_reason' } })
    const cbs = makeCallbacks()
    await expect(handleSsoCallback(sb.client, cbs)).resolves.toBeUndefined()
    expect(cbs.errorMessages).toHaveLength(1)
  })

  it('RPC error response is handled gracefully, not thrown', async () => {
    const sb = makeSupabase({ rpcError: 'network down' })
    const cbs = makeCallbacks()
    await expect(handleSsoCallback(sb.client, cbs)).resolves.toBeUndefined()
    expect(cbs.errorMessages).toEqual(['We could not complete your SSO sign-in. Please try again.'])
    expect(cbs.finishCalls).toBe(0)
  })

  it('RPC throw (e.g. network failure) is caught, not an uncaught exception', async () => {
    const sb = makeSupabase({ rpcThrows: true })
    const cbs = makeCallbacks()
    await expect(handleSsoCallback(sb.client, cbs)).resolves.toBeUndefined()
    expect(cbs.errorMessages).toEqual(['We could not complete your SSO sign-in. Please try again.'])
  })

  it('an unexpected response shape (e.g. no status field) is handled gracefully', async () => {
    const sb = makeSupabase({ rpcData: { unexpected: true } })
    const cbs = makeCallbacks()
    await expect(handleSsoCallback(sb.client, cbs)).resolves.toBeUndefined()
    expect(cbs.errorMessages).toHaveLength(1)
    expect(cbs.finishCalls).toBe(0)
  })

  it('an RPC that never resolves times out gracefully via withAuthTimeout, not a hang', async () => {
    vi.useFakeTimers()
    try {
      const client = {
        rpc: vi.fn(
          () =>
            new Promise(() => {
              /* never resolves — simulates an unreachable RPC */
            })
        ),
      } as unknown as SupabaseClient
      const cbs = makeCallbacks()
      const pending = handleSsoCallback(client, cbs)
      await vi.advanceTimersByTimeAsync(8000)
      await pending
      expect(cbs.errorMessages).toEqual(['SSO sign-in did not complete in time. Please try again.'])
      expect(cbs.finishCalls).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ssoLinkRedirectUrl', () => {
  it('builds the /account/link-sso target from a candidate', () => {
    expect(ssoLinkRedirectUrl({ legacy_user_id: 'u1', legacy_email: 'a@b.example' })).toBe(
      `${LINK_SSO_PATH}?legacy_user_id=u1`
    )
  })

  it('URL-encodes the id — an IdP-asserted value may contain & or /', () => {
    const url = ssoLinkRedirectUrl({ legacy_user_id: 'u/1&x' })
    expect(url).not.toMatch(/legacy_user_id=u\/1&x/)
    // The `&` must be encoded, so the query has no separator at all.
    expect((url ?? '').split('&')).toHaveLength(1)
    const parsed = new URLSearchParams((url ?? '').split('?')[1])
    expect(parsed.get('legacy_user_id')).toBe('u/1&x')
  })

  it('NEVER carries legacy_email — the page resolves it server-side (SMI-6205 M9)', () => {
    // Displaying an unauthenticated URL parameter as the counterparty on a
    // consent screen let a crafted link name one account in the copy while
    // link_sso_account() acted on the id beside it. The address is now
    // re-resolved from get_own_sso_link_candidate() against the caller's own
    // session (confirmation round N-3/N-4 moved that read off the
    // side-effecting record_sso_login()), so carrying it here would be dead
    // weight that invites the bug back.
    for (const candidate of [
      { legacy_user_id: 'u1', legacy_email: 'a@b.example' },
      { legacy_user_id: 'u1', legacy_email: null },
      { legacy_user_id: 'u1' },
    ]) {
      expect(ssoLinkRedirectUrl(candidate)).toBe(`${LINK_SSO_PATH}?legacy_user_id=u1`)
      expect(ssoLinkRedirectUrl(candidate)).not.toContain('legacy_email')
    }
  })

  it('returns null for a null/blank/malformed candidate rather than a blank-id redirect', () => {
    expect(ssoLinkRedirectUrl(null)).toBeNull()
    expect(ssoLinkRedirectUrl(undefined)).toBeNull()
    expect(ssoLinkRedirectUrl({ legacy_user_id: '   ' })).toBeNull()
    expect(ssoLinkRedirectUrl({} as never)).toBeNull()
  })
})

describe('handleSsoCallback — link-candidate routing (Wave 4 Step 3)', () => {
  const candidate = { legacy_user_id: 'legacy_1', legacy_email: 'ada@legacy.example' }

  it("routes 'ok' + a candidate to /account/link-sso INSTEAD of the profile-completion gate", async () => {
    const sb = makeSupabase({ rpcData: { status: 'ok', link_candidate: candidate } })
    const cbs = makeCallbacks()
    await handleSsoCallback(sb.client, cbs)
    expect(cbs.navigateUrls).toEqual(['/account/link-sso?legacy_user_id=legacy_1'])
    // finishCallback is what runs routePostAuth (the profile gate). A
    // JIT-provisioned SSO user always has profile_completed_at NULL, so
    // running it first would make this redirect unreachable.
    expect(cbs.finishCalls).toBe(0)
    expect(cbs.errorMessages).toEqual([])
  })

  it("'ok' with link_candidate null takes the normal finish path", async () => {
    const sb = makeSupabase({ rpcData: { status: 'ok', link_candidate: null } })
    const cbs = makeCallbacks()
    await handleSsoCallback(sb.client, cbs)
    expect(cbs.navigateUrls).toEqual([])
    expect(cbs.finishCalls).toBe(1)
  })

  it("'ok' with a malformed candidate falls through to finish, never a blank-id redirect", async () => {
    const sb = makeSupabase({ rpcData: { status: 'ok', link_candidate: { legacy_user_id: '' } } })
    const cbs = makeCallbacks()
    await handleSsoCallback(sb.client, cbs)
    expect(cbs.navigateUrls).toEqual([])
    expect(cbs.finishCalls).toBe(1)
  })

  it('does not re-offer the link when the browser just came FROM /account/link-sso', async () => {
    const sb = makeSupabase({ rpcData: { status: 'ok', link_candidate: candidate } })
    const cbs: MockCallbacks = {
      ...makeCallbacks(),
      documentReferrer: 'https://www.skillsmith.app/account/link-sso',
      windowOrigin: 'https://www.skillsmith.app',
    }
    await handleSsoCallback(sb.client, cbs)
    expect(cbs.navigateUrls).toEqual([])
    expect(cbs.finishCalls).toBe(1)
  })

  it('the trailing-slash form of the referrer also suppresses the re-offer', async () => {
    const sb = makeSupabase({ rpcData: { status: 'ok', link_candidate: candidate } })
    const cbs: MockCallbacks = {
      ...makeCallbacks(),
      documentReferrer: 'https://www.skillsmith.app/account/link-sso/',
      windowOrigin: 'https://www.skillsmith.app',
    }
    await handleSsoCallback(sb.client, cbs)
    expect(cbs.finishCalls).toBe(1)
  })

  it('a CROSS-ORIGIN referrer with the same pathname does NOT suppress a real offer', async () => {
    const sb = makeSupabase({ rpcData: { status: 'ok', link_candidate: candidate } })
    const cbs: MockCallbacks = {
      ...makeCallbacks(),
      documentReferrer: 'https://idp.example.com/account/link-sso',
      windowOrigin: 'https://www.skillsmith.app',
    }
    await handleSsoCallback(sb.client, cbs)
    expect(cbs.navigateUrls).toHaveLength(1)
    expect(cbs.finishCalls).toBe(0)
  })

  it('an unrelated or unparseable referrer leaves the offer intact', async () => {
    for (const referrer of ['https://www.skillsmith.app/complete-profile', 'not a url', '']) {
      const sb = makeSupabase({ rpcData: { status: 'ok', link_candidate: candidate } })
      const cbs: MockCallbacks = {
        ...makeCallbacks(),
        documentReferrer: referrer,
        windowOrigin: 'https://www.skillsmith.app',
      }
      await handleSsoCallback(sb.client, cbs)
      expect(cbs.navigateUrls).toHaveLength(1)
      expect(cbs.finishCalls).toBe(0)
    }
  })

  it('a candidate on a refused/unmapped status is never acted on', async () => {
    for (const rpcData of [
      { status: 'unmapped', link_candidate: candidate },
      { status: 'refused', reason: 'seat_limit_reached', link_candidate: candidate },
    ]) {
      const sb = makeSupabase({ rpcData })
      const cbs = makeCallbacks()
      await handleSsoCallback(sb.client, cbs)
      expect(cbs.navigateUrls).toEqual([])
      expect(cbs.errorMessages).toHaveLength(1)
    }
  })
})

describe('handleEmailVerification', () => {
  it('shows the supabase error message when setSession fails', async () => {
    const sb = makeSupabase({ setSessionError: 'Token expired' })
    const cbs = makeCallbacks()
    await handleEmailVerification(
      sb.client,
      parseCallbackParams('#access_token=at&refresh_token=rt&type=email', 'https://x/cb'),
      cbs
    )
    expect(cbs.errorMessages).toEqual(['Token expired'])
    expect(cbs.finishCalls).toBe(0)
  })

  it('shows the supabase error message when PKCE exchange fails', async () => {
    const sb = makeSupabase({ exchangeCodeError: 'invalid_grant' })
    const cbs = makeCallbacks()
    await handleEmailVerification(
      sb.client,
      parseCallbackParams('#type=email', 'https://x/cb'),
      cbs
    )
    expect(cbs.errorMessages).toEqual(['invalid_grant'])
  })
})

interface MockProfileResult {
  data?: {
    first_name?: string | null
    last_name?: string | null
    profile_completed_at?: string | null
  } | null
  error?: { code?: string; message?: string } | null
}

function makeProfileSupabase(opts: {
  session?: unknown
  profile?: MockProfileResult
}): SupabaseClient {
  const single = vi.fn(async () => opts.profile ?? { data: null, error: null })
  const eq = vi.fn(() => ({ single }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: opts.session ?? null } })),
    },
    from,
  } as unknown as SupabaseClient
}

function makeGateCallbacks(): ProfileGateCallbacks & {
  successCalls: number
  errorMessages: Array<string | undefined>
  navigateUrls: string[]
} {
  const cbs = {
    successCalls: 0,
    errorMessages: [] as Array<string | undefined>,
    navigateUrls: [] as string[],
    authRedirectTo: '/account',
    documentReferrer: '',
    windowOrigin: 'https://www.skillsmith.app',
    showSuccess() {
      this.successCalls += 1
    },
    showError(message?: string) {
      this.errorMessages.push(message)
    },
    navigate(url: string) {
      this.navigateUrls.push(url)
    },
  }
  return cbs
}

describe('routePostAuth', () => {
  it('shows error when no session is present', async () => {
    const sb = makeProfileSupabase({ session: null })
    const cbs = makeGateCallbacks()
    await routePostAuth(sb, cbs)
    expect(cbs.errorMessages).toEqual(['Session lost. Please sign in again.'])
    expect(cbs.successCalls).toBe(0)
  })

  it('happy path: complete profile → showSuccess', async () => {
    const sb = makeProfileSupabase({
      session: { user: { id: 'u1' } },
      profile: {
        data: {
          first_name: 'Ada',
          last_name: 'Lovelace',
          profile_completed_at: '2026-05-21T00:00:00Z',
        },
        error: null,
      },
    })
    const cbs = makeGateCallbacks()
    await routePostAuth(sb, cbs)
    expect(cbs.successCalls).toBe(1)
    expect(cbs.navigateUrls).toEqual([])
  })

  it('schema drift (PGRST204) → /complete-profile', async () => {
    const sb = makeProfileSupabase({
      session: { user: { id: 'u1' } },
      profile: { data: null, error: { code: 'PGRST204' } },
    })
    const cbs = makeGateCallbacks()
    cbs.authRedirectTo = '/account/billing'
    await routePostAuth(sb, cbs)
    expect(cbs.navigateUrls).toEqual(['/complete-profile?next=%2Faccount%2Fbilling'])
    expect(cbs.successCalls).toBe(0)
  })

  it('missing-row (PGRST116) → /complete-profile', async () => {
    const sb = makeProfileSupabase({
      session: { user: { id: 'u1' } },
      profile: { data: null, error: { code: 'PGRST116' } },
    })
    const cbs = makeGateCallbacks()
    await routePostAuth(sb, cbs)
    expect(cbs.navigateUrls).toEqual(['/complete-profile?next=%2Faccount'])
  })

  it('permission-denied / unknown DB error → generic showError', async () => {
    const sb = makeProfileSupabase({
      session: { user: { id: 'u1' } },
      profile: { data: null, error: { code: '42501' } },
    })
    const cbs = makeGateCallbacks()
    await routePostAuth(sb, cbs)
    expect(cbs.errorMessages).toHaveLength(1)
    expect(cbs.errorMessages[0]).toMatch(/We could not verify your profile/)
    expect(cbs.navigateUrls).toEqual([])
  })

  it('profile present but incomplete → /complete-profile', async () => {
    const sb = makeProfileSupabase({
      session: { user: { id: 'u1' } },
      profile: {
        data: { first_name: '', last_name: '', profile_completed_at: null },
        error: null,
      },
    })
    const cbs = makeGateCallbacks()
    await routePostAuth(sb, cbs)
    expect(cbs.navigateUrls).toEqual(['/complete-profile?next=%2Faccount'])
  })

  it('loop guard: came from /complete-profile and still incomplete → showError', async () => {
    const sb = makeProfileSupabase({
      session: { user: { id: 'u1' } },
      profile: {
        data: { first_name: '', last_name: '', profile_completed_at: null },
        error: null,
      },
    })
    const cbs = makeGateCallbacks()
    cbs.documentReferrer = 'https://www.skillsmith.app/complete-profile'
    await routePostAuth(sb, cbs)
    expect(cbs.errorMessages).toHaveLength(1)
    expect(cbs.errorMessages[0]).toMatch(/Something went wrong saving your profile/)
    expect(cbs.navigateUrls).toEqual([])
  })
})

describe('fetchAndStoreGitHubOrgs', () => {
  it('no-ops when no provider_token is on the session', async () => {
    const sb = {
      auth: {
        getSession: vi.fn(async () => ({
          data: { session: { user: { id: 'u1', app_metadata: { provider: 'github' } } } },
        })),
      },
      from: vi.fn(),
    } as unknown as SupabaseClient
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'))
    await fetchAndStoreGitHubOrgs(sb)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('skips non-github providers', async () => {
    const sb = {
      auth: {
        getSession: vi.fn(async () => ({
          data: {
            session: {
              provider_token: 'tok',
              user: { id: 'u1', app_metadata: { provider: 'google' } },
            },
          },
        })),
      },
      from: vi.fn(),
    } as unknown as SupabaseClient
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'))
    await fetchAndStoreGitHubOrgs(sb)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('swallows errors when GitHub API call rejects', async () => {
    const sb = {
      auth: {
        getSession: vi.fn(async () => ({
          data: {
            session: {
              provider_token: 'tok',
              user: { id: 'u1', app_metadata: { provider: 'github' } },
            },
          },
        })),
      },
      from: vi.fn(),
    } as unknown as SupabaseClient
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // Should not throw.
    await fetchAndStoreGitHubOrgs(sb)
    expect(warnSpy).toHaveBeenCalled()
    fetchSpy.mockRestore()
    warnSpy.mockRestore()
  })
})
