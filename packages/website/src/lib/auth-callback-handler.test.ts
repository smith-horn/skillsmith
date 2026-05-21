import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  dispatchAuthCallback,
  fetchAndStoreGitHubOrgs,
  handleEmailVerification,
  parseCallbackParams,
  routePostAuth,
  type DispatchCallbacks,
  type ProfileGateCallbacks,
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
  setSessionCalls: number
  exchangeCodeCalls: number
  client: SupabaseClient
}

function makeSupabase(opts?: {
  setSessionError?: string
  exchangeCodeError?: string
  exchangeCodeThrows?: boolean
  session?: unknown
}): MockSupabase {
  const mock: MockSupabase = {
    setSessionResult: { error: opts?.setSessionError ? { message: opts.setSessionError } : null },
    exchangeCodeResult: {
      error: opts?.exchangeCodeError ? { message: opts.exchangeCodeError } : null,
    },
    getSessionResult: { data: { session: opts?.session ?? null } },
    setSessionCalls: 0,
    exchangeCodeCalls: 0,
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
