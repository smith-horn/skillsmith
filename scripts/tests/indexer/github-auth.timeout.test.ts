/**
 * SMI-6015 post-merge follow-up (2026-08-18): `getInstallationToken()`'s
 * fetch to GitHub's App-token-mint endpoint had no timeout — a hung
 * connection could stall the census pipeline's entire resolution pool
 * indefinitely, with only the independent heartbeat mechanism masking the
 * stall (live production incident: attempt 8 stalled ~14,000/30,477 repos
 * in, heartbeat still fresh). Now bounded by the same `resolveFetchTimeoutMs()`
 * chokepoint `withRateLimitTracking` (SMI-5964) already uses.
 * @module scripts/tests/indexer/github-auth.timeout
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'

// A real (throwaway, test-only) RSA keypair — exercises the actual
// createAppJwt/importPrivateKey crypto path, not a mocked shortcut, so this
// test proves the real fetch call actually happens with a real signed JWT.
const { privateKey: TEST_PRIVATE_KEY_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const ORIGINAL_ENV = { ...process.env }

function setAppEnv(): void {
  process.env.GITHUB_APP_ID = 'test-app-id'
  process.env.GITHUB_APP_INSTALLATION_ID = 'test-installation-id'
  process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY_PEM
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
  setAppEnv()
  vi.resetModules()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SMI-6015 follow-up: getInstallationToken() fetch timeout', () => {
  it('does NOT hang forever on a stalled connection -- aborts and returns null within the configured timeout', async () => {
    // GPT-5.6-Sol review (round 2, Medium): a fake-timers version of this
    // test races real (non-fake-timer-governed) WebCrypto JWT signing --
    // AbortSignal.timeout() isn't constructed until AFTER that signing
    // resolves, so a single upfront advanceTimersByTimeAsync() call can
    // return before the timer is even registered, then never advance again,
    // hanging until Vitest's own real test timeout. Real timers sidestep
    // this entirely -- the configured timeout is only 50ms, so this test
    // still runs fast and deterministically without needing to synchronize
    // fake-timer advancement against unrelated async crypto work.
    process.env.SKILLSMITH_INDEXER_FETCH_TIMEOUT_MS = '50'
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      // Simulates a genuinely hung connection: the promise never settles
      // on its own -- only an abort signal can end it, exactly like the
      // real incident (an established TCP connection with no response).
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { getInstallationToken } = await import('../../indexer/_shared/github-auth.ts')

    // getInstallationToken()'s own try/catch converts the AbortError into a
    // clean `null` return, same contract as every other failure mode here --
    // never an unhandled hang, never an uncaught throw.
    await expect(getInstallationToken()).resolves.toBeNull()
    // GPT-5.6-Sol review (round 1, Low): assert fetch was actually reached
    // and its signal captured, so the `null` result above can only mean the
    // timeout mechanism fired -- not an earlier JWT/crypto failure
    // short-circuiting before fetch() is ever called, which would produce
    // the same `null` for the wrong reason.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const capturedSignal = fetchMock.mock.calls[0]?.[1]?.signal
    expect(capturedSignal).toBeInstanceOf(AbortSignal)
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('passes an AbortSignal to fetch so a hung connection is actually abortable', async () => {
    let observedSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        observedSignal = init?.signal ?? undefined
        return Promise.resolve(
          new Response(
            JSON.stringify({ token: 'ghs_test', expires_at: new Date().toISOString() }),
            {
              status: 200,
            }
          )
        )
      })
    )
    const { getInstallationToken } = await import('../../indexer/_shared/github-auth.ts')

    const token = await getInstallationToken()
    expect(token).toBe('ghs_test')
    expect(observedSignal).toBeInstanceOf(AbortSignal)
  })

  it("SKILLSMITH_INDEXER_FETCH_TIMEOUT_MS=0 disables the timeout -- no signal is attached (matches withRateLimitTracking's own opt-out)", async () => {
    process.env.SKILLSMITH_INDEXER_FETCH_TIMEOUT_MS = '0'
    let observedInit: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        observedInit = init
        return Promise.resolve(
          new Response(
            JSON.stringify({ token: 'ghs_test', expires_at: new Date().toISOString() }),
            {
              status: 200,
            }
          )
        )
      })
    )
    const { getInstallationToken } = await import('../../indexer/_shared/github-auth.ts')

    await getInstallationToken()
    expect(observedInit?.signal).toBeUndefined()
  })

  it('a real (non-hang) network error still returns null, unchanged from the pre-fix contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed')))
    )
    const { getInstallationToken } = await import('../../indexer/_shared/github-auth.ts')

    await expect(getInstallationToken()).resolves.toBeNull()
  })
})
