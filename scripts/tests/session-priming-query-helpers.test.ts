/**
 * Direct tests for `buildSignal2` in `scripts/session-priming-query.helpers.ts`
 * (SMI-5860) — split into its own file rather than growing
 * `session-priming-query.test.ts` past the 500-line pre-commit gate.
 *
 * `buildSignal2` had zero direct fetch-path coverage before SMI-5860's
 * migration from a hand-rolled `fetch()` + `AbortController` to the shared,
 * `options.signal`-accepting `graphql()` client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSignal2, LINEAR_TIMEOUT_MS, type CliArgs } from '../session-priming-query.helpers.js'
import { mockFetchSteps } from './linear-api-test-helpers'

function args(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    sessionId: 's1',
    branch: 'fix/smi-100',
    smi: 'smi-100',
    cwd: '/tmp',
    out: '/tmp/out',
    ...overrides,
  }
}

describe('buildSignal2 (SMI-5860)', () => {
  beforeEach(() => {
    process.env.LINEAR_API_KEY = 'test-key'
  })

  afterEach(() => {
    // @ts-expect-error -- undo patch
    delete global.fetch
    delete process.env.LINEAR_API_KEY
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('returns "" immediately when args.smi is empty — no fetch attempted', async () => {
    const fetchMock = mockFetchSteps([])
    const result = await buildSignal2(args({ smi: '' }))
    expect(result).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns "" when LINEAR_API_KEY is unset — no fetch attempted', async () => {
    delete process.env.LINEAR_API_KEY
    const fetchMock = mockFetchSteps([])
    const result = await buildSignal2(args())
    expect(result).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the issue description, truncated, on a happy-path response', async () => {
    mockFetchSteps([{ kind: 'ok', body: { data: { issue: { description: 'hello world' } } } }])
    const result = await buildSignal2(args())
    expect(result).toBe('hello world')
  })

  it('uppercases the smi identifier as the $id variable', async () => {
    const fetchMock = mockFetchSteps([
      { kind: 'ok', body: { data: { issue: { description: '' } } } },
    ])
    await buildSignal2(args({ smi: 'smi-100' }))
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    const parsed = JSON.parse(init.body) as { variables: Record<string, unknown> }
    expect(parsed.variables).toEqual({ id: 'SMI-100' })
  })

  it('returns "" on a non-ok HTTP response (graphql() throws, caught by the blanket catch)', async () => {
    mockFetchSteps([{ kind: 'httpError', status: 500 }])
    const result = await buildSignal2(args())
    expect(result).toBe('')
  })

  it('returns "" on a GraphQL body-error response', async () => {
    mockFetchSteps([{ kind: 'ok', body: { errors: [{ message: 'nope' }] } }])
    const result = await buildSignal2(args())
    expect(result).toBe('')
  })

  it('returns "" on a transport failure', async () => {
    mockFetchSteps([{ kind: 'transportError', error: new Error('ECONNRESET') }])
    const result = await buildSignal2(args())
    expect(result).toBe('')
  })

  it('clears the abort timer on the success path (no leaked timer)', async () => {
    vi.useFakeTimers()
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
    mockFetchSteps([{ kind: 'ok', body: { data: { issue: { description: 'ok' } } } }])
    const result = await buildSignal2(args())
    expect(result).toBe('ok')
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })

  it('clears the abort timer on the failure path too (no leaked timer)', async () => {
    vi.useFakeTimers()
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
    mockFetchSteps([{ kind: 'transportError', error: new Error('boom') }])
    const result = await buildSignal2(args())
    expect(result).toBe('')
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })

  it('aborts and returns "" if the request outlasts the timeout', async () => {
    vi.useFakeTimers()
    // @ts-expect-error -- patch global fetch to honor AbortSignal like real fetch(), never resolving otherwise
    global.fetch = vi.fn((_url: string, init: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    })
    const promise = buildSignal2(args())
    // Driven off the source constant, not a hardcoded 1800 — a raised timeout
    // would otherwise surface as an opaque vitest "test timed out".
    await vi.advanceTimersByTimeAsync(LINEAR_TIMEOUT_MS)
    const result = await promise
    expect(result).toBe('')
  })
})
