/**
 * Tests for sendEmail's fetch timeout (SMI-5048).
 *
 * Background: a hanging fetch to api.resend.com (no AbortController) consumed
 * the entire 150s Supabase edge-function wall-clock budget on coverage-report,
 * resulting in zero successful audit rows ever written. The fix wraps the
 * fetch in an AbortController with a 15s default (overridable via
 * SENDEMAIL_TIMEOUT_MS env var) and returns false on timeout.
 *
 * Test strategy: stub `fetch` so it honours `init.signal` (rejects with an
 * AbortError DOMException when the signal aborts). Use fake timers to advance
 * past the timeout without a real wall-clock delay.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Set env vars BEFORE importing the module. The module reads RESEND_API_KEY
// at top-of-file from Deno.env; vitest's `globalThis.Deno` shim is provided
// via the `supabase/functions/**/*.test.ts` vitest config setup.
const ORIG_DENO = (globalThis as { Deno?: { env: { get: (k: string) => string | undefined } } })
  .Deno

beforeEach(() => {
  // Stub Deno.env.get for the duration of each test.
  ;(globalThis as { Deno: { env: { get: (k: string) => string | undefined } } }).Deno = {
    env: {
      get: (k: string) => {
        if (k === 'RESEND_API_KEY') return 're_test_key'
        if (k === 'SENDEMAIL_TIMEOUT_MS') return '100'
        return undefined
      },
    },
  }
})

afterEach(() => {
  if (ORIG_DENO) {
    ;(globalThis as { Deno?: typeof ORIG_DENO }).Deno = ORIG_DENO
  } else {
    delete (globalThis as { Deno?: typeof ORIG_DENO }).Deno
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('sendEmail timeout (SMI-5048)', () => {
  it('returns false when fetch hangs past SENDEMAIL_TIMEOUT_MS', async () => {
    // Stub fetch to honour AbortSignal: rejects with an AbortError DOMException
    // when the signal aborts. Otherwise the Promise never resolves, simulating
    // a hung Resend connection.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        })
      })
    )

    vi.useFakeTimers()
    // Import inside the test so module-level env reads pick up our stub.
    const { sendEmail } = await import('./email.ts')
    const promise = sendEmail('test@example.com', 'subject', '<p>html</p>')

    // Advance fake clock past the 100ms timeout. advanceTimersByTimeAsync
    // also flushes the microtask queue so the catch handler's `return false`
    // propagates back through `await fetch(...)`.
    await vi.advanceTimersByTimeAsync(150)

    const result = await promise
    expect(result).toBe(false)
  })

  it('returns true when fetch resolves quickly within the timeout', async () => {
    // Stub fetch to resolve immediately with a 200 OK. The AbortController
    // timer fires later but does not matter — clearTimeout in the finally
    // block cancels it.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ id: 'resend-id-1234' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      )
    )

    vi.useFakeTimers()
    const { sendEmail } = await import('./email.ts')
    const result = await sendEmail('test@example.com', 'subject', '<p>html</p>')
    expect(result).toBe(true)
  })

  it('returns false when fetch resolves with a 5xx (Resend error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('Internal Server Error', { status: 502 }))
      )
    )

    vi.useFakeTimers()
    const { sendEmail } = await import('./email.ts')
    const result = await sendEmail('test@example.com', 'subject', '<p>html</p>')
    expect(result).toBe(false)
  })
})
