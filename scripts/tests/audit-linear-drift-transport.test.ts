/**
 * Tests for `fetchDoneIssues` transport in `scripts/audit-linear-drift.mjs`
 * (SMI-5860) — split out of `audit-linear-drift.test.ts` to stay under the
 * 500-line pre-commit gate, mirroring `linear-api-uuid-resolution.test.ts`'s
 * own split from `linear-api.test.ts`.
 *
 * `fetchDoneIssues`/`fetchWithRetry` had zero test coverage before SMI-5860's
 * migration from a hand-rolled `fetchWithRetry` to the shared,
 * `graphql()`/`withRetry`-based transport.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockFetchSteps } from './linear-api-test-helpers'

async function importModule() {
  return await import('../audit-linear-drift.mjs')
}

function doneIssuesPage(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
) {
  return { data: { issues: { nodes, pageInfo } } }
}

describe('fetchDoneIssues transport (SMI-5860)', () => {
  const SINCE = '2026-01-01'

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

  it('exits 0 with the exact "Skipping" message when LINEAR_API_KEY is unset — no fetch attempted', async () => {
    delete process.env.LINEAR_API_KEY
    const fetchMock = mockFetchSteps([])
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)

    const { fetchDoneIssues } = await importModule()
    await expect(fetchDoneIssues(SINCE)).rejects.toThrow('process.exit(0)')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('LINEAR_API_KEY not set. Skipping drift audit.')
  })

  it('retries a simulated 5xx response, then succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = mockFetchSteps([
      { kind: 'httpError', status: 503 },
      { kind: 'ok', body: doneIssuesPage([], { hasNextPage: false, endCursor: null }) },
    ])

    const { fetchDoneIssues } = await importModule()
    const promise = fetchDoneIssues(SINCE)
    await vi.advanceTimersByTimeAsync(1000)
    const issues = await promise

    expect(issues).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a simulated transport failure (fetch() itself rejects), then succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = mockFetchSteps([
      { kind: 'transportError', error: new Error('ECONNRESET') },
      {
        kind: 'ok',
        body: doneIssuesPage([{ identifier: 'SMI-1' }], { hasNextPage: false, endCursor: null }),
      },
    ])

    const { fetchDoneIssues } = await importModule()
    const promise = fetchDoneIssues(SINCE)
    await vi.advanceTimersByTimeAsync(1000)
    const issues = (await promise) as Array<{ identifier: string }>

    expect(issues.map((i) => i.identifier)).toEqual(['SMI-1'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('makes exactly one fetch attempt then exits 2 on a GraphQL body-error response, printing the exact stderr text', async () => {
    const errorsArray = [{ message: 'boom' }]
    const fetchMock = mockFetchSteps([{ kind: 'ok', body: { errors: errorsArray } }])
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)

    const { fetchDoneIssues } = await importModule()
    await expect(fetchDoneIssues(SINCE)).rejects.toThrow('process.exit(2)')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Drift audit: Linear query failed:',
      JSON.stringify(errorsArray)
    )
  })

  it('rethrows (does not exit) a non-GraphQL error once retries are exhausted', async () => {
    vi.useFakeTimers()
    const fetchMock = mockFetchSteps([
      { kind: 'httpError', status: 500 },
      { kind: 'httpError', status: 500 },
      { kind: 'httpError', status: 500 },
      { kind: 'httpError', status: 500 },
    ])

    const { fetchDoneIssues } = await importModule()
    const promise = fetchDoneIssues(SINCE)
    const assertion = expect(promise).rejects.toThrow('500')
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(4000)
    await assertion

    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('merges nodes across two paginated pages in order, in a single logical call', async () => {
    const fetchMock = mockFetchSteps([
      {
        kind: 'ok',
        body: doneIssuesPage([{ identifier: 'SMI-1' }], {
          hasNextPage: true,
          endCursor: 'cursor-1',
        }),
      },
      {
        kind: 'ok',
        body: doneIssuesPage([{ identifier: 'SMI-2' }], {
          hasNextPage: false,
          endCursor: null,
        }),
      },
    ])

    const { fetchDoneIssues } = await importModule()
    const issues = (await fetchDoneIssues(SINCE)) as Array<{ identifier: string }>

    expect(issues.map((i) => i.identifier)).toEqual(['SMI-1', 'SMI-2'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('DESIGN QUESTION 1 named micro-delta: retries the full attempt count on a malformed-2xx-JSON body before rethrowing (today this fails unretried, outside the pre-migration fetchWithRetry) — deliberate, not accidental', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input')
        },
        text: async () => 'not json',
      } as unknown as Response
    })
    // @ts-expect-error -- patch global fetch
    global.fetch = fetchMock

    const { fetchDoneIssues } = await importModule()
    const promise = fetchDoneIssues(SINCE)
    const assertion = expect(promise).rejects.toThrow('Unexpected end of JSON input')
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(4000)
    await assertion

    // 1 initial + 3 retries = 4 total — retried because a raw SyntaxError has
    // no .status/.graphqlError, so the Q1 predicate (!err?.graphqlError)
    // treats it as retryable, unlike today's pre-migration behavior where
    // res.json() runs outside the retry helper and fails on the first attempt.
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
