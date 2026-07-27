/**
 * SMI-5858: Unit tests for the shared low-level Linear GraphQL client
 * (`scripts/lib/linear-client.mjs`).
 *
 * This module is the single source of truth for the transport (`graphql`),
 * the retry primitives (`isRetryable`/`withRetry`/`retryQuery`), and the
 * team/issue/label lookups now shared by `scripts/linear-api.mjs`,
 * `scripts/linear-upsert-drift-issue.mjs`, `scripts/lint-linear-issues.mjs`,
 * and `scripts/e2e/create-linear-issues.linear-client.ts`.
 *
 * The most important invariant this file guards: `getTeamId`/`getIssueId`
 * are SINGLE-ATTEMPT — no retry inside either function (see the module
 * header comment in `scripts/lib/linear-client.mjs` for why). If someone
 * later "helpfully" adds retry back into either function, the
 * single-fetch-call assertions below fail immediately. `resolveLabelIds`
 * is the deliberate exception — it retries internally — and is tested here
 * as a contrast case.
 *
 * Reuses the mock-fetch fixtures/helpers from
 * `scripts/tests/linear-api-test-helpers.ts` (originally split out for
 * `linear-api.test.ts` / `linear-api-uuid-resolution.test.ts`) rather than
 * duplicating them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  API_URL,
  TEAM_KEY,
  RETRY_DELAYS_MS,
  UUID_RE,
  LABEL_PAGE_SIZE,
  graphql,
  isRetryable,
  withRetry,
  retryQuery,
  getTeamId,
  getIssueId,
  normalizeLabelEntries,
  resolveLabelIds,
} from '../lib/linear-client.mjs'
import {
  mockFetchSequence,
  mockFetchSteps,
  labelResponse,
  issueLookupResponse,
  TEAM_RESPONSE,
} from './linear-api-test-helpers'

/** A status-flagged error, mirroring what graphql() attaches on a non-OK HTTP response. */
function statusError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  const err = new Error(message) as Error & { status: number }
  err.status = status
  return err
}

/** A graphqlError-flagged error, mirroring what graphql() throws on a GraphQL `errors` body. */
function graphqlFlaggedError(
  graphqlErrors: unknown = [{ message: 'boom' }]
): Error & { graphqlError: true; graphqlErrors: unknown } {
  const err = new Error('GraphQL errors') as Error & {
    graphqlError: true
    graphqlErrors: unknown
  }
  err.graphqlError = true
  err.graphqlErrors = graphqlErrors
  return err
}

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

describe('constants (SMI-5858)', () => {
  it('exposes the expected values', () => {
    expect(API_URL).toBe('https://api.linear.app/graphql')
    expect(TEAM_KEY).toBe('SMI')
    expect(RETRY_DELAYS_MS).toEqual([1000, 2000, 4000])
    expect(LABEL_PAGE_SIZE).toBe(50)
    expect(UUID_RE.test('11111111-1111-1111-1111-111111111111')).toBe(true)
    expect(UUID_RE.test('SMI-123')).toBe(false)
  })
})

describe('graphql (SMI-5858)', () => {
  it('throws when LINEAR_API_KEY is not set', async () => {
    delete process.env.LINEAR_API_KEY
    await expect(graphql('query {}')).rejects.toThrow(
      'LINEAR_API_KEY environment variable is not set'
    )
  })

  it('sets .status on a non-OK HTTP response', async () => {
    mockFetchSteps([{ kind: 'httpError', status: 500, text: 'server error' }])
    const err = (await graphql('query {}').catch((e) => e)) as Error & { status?: number }
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(500)
  })

  it('sets .graphqlError AND the raw .graphqlErrors array on a GraphQL body error (SMI-5858 additive property)', async () => {
    const errorsArray = [{ message: 'boom' }]
    mockFetchSteps([{ kind: 'ok', body: { errors: errorsArray } }])
    const err = (await graphql('query {}').catch((e) => e)) as Error & {
      graphqlError?: boolean
      graphqlErrors?: unknown
    }
    expect(err.graphqlError).toBe(true)
    expect(err.graphqlErrors).toEqual(errorsArray)
  })

  it('returns json.data on success', async () => {
    mockFetchSteps([{ kind: 'ok', body: { data: { hello: 'world' } } }])
    const data = await graphql('query {}')
    expect(data).toEqual({ hello: 'world' })
  })
})

describe('isRetryable (SMI-5858) - classification table', () => {
  it('treats a status-less error (pure transport failure) as retryable', () => {
    expect(isRetryable(new Error('ECONNRESET'))).toBe(true)
  })

  it('treats HTTP 429 as retryable', () => {
    expect(isRetryable(statusError(429))).toBe(true)
  })

  it('treats HTTP 5xx (500 and 599) as retryable', () => {
    expect(isRetryable(statusError(500))).toBe(true)
    expect(isRetryable(statusError(599))).toBe(true)
  })

  it('treats an ordinary 4xx (404) as NOT retryable', () => {
    expect(isRetryable(statusError(404))).toBe(false)
  })

  it('never retries a graphqlError, regardless of status', () => {
    expect(isRetryable(graphqlFlaggedError())).toBe(false)
  })
})

describe('withRetry (SMI-5858)', () => {
  it('returns on first success without ever consulting the predicate', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const predicate = vi.fn(() => true)
    const result = await withRetry(fn, RETRY_DELAYS_MS, predicate)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(predicate).not.toHaveBeenCalled()
  })

  it('retries per a custom predicate, waiting exactly RETRY_DELAYS_MS between attempts', async () => {
    vi.useFakeTimers()
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockResolvedValueOnce('ok')
    const predicate = vi.fn(() => true)

    const promise = withRetry(fn, RETRY_DELAYS_MS, predicate)
    // Nothing resolves before the first backoff (1000ms) elapses.
    await vi.advanceTimersByTimeAsync(999)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fn).toHaveBeenCalledTimes(3)

    const result = await promise
    expect(result).toBe('ok')
    expect(predicate).toHaveBeenCalledTimes(2)
  })

  it('stops immediately (no further attempts, no delay) when the predicate returns false', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('nope'))
    const predicate = vi.fn(() => false)

    await expect(withRetry(fn, RETRY_DELAYS_MS, predicate)).rejects.toThrow('nope')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(predicate).toHaveBeenCalledTimes(1)
  })

  it('throws the last error once all delays are exhausted, even with an always-retryable predicate', async () => {
    vi.useFakeTimers()
    const fn = vi.fn().mockRejectedValue(new Error('always fails'))

    const promise = withRetry(fn, RETRY_DELAYS_MS, () => true)
    const assertion = expect(promise).rejects.toThrow('always fails')
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(4000)
    await assertion

    // delays.length + 1 = 4 total attempts.
    expect(fn).toHaveBeenCalledTimes(4)
  })

  it('defaults delays to RETRY_DELAYS_MS and the predicate to always-retry when omitted', async () => {
    vi.useFakeTimers()
    const fn = vi.fn().mockRejectedValueOnce(new Error('e1')).mockResolvedValueOnce('ok')

    const promise = withRetry(fn)
    await vi.advanceTimersByTimeAsync(1000)
    const result = await promise

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('retryQuery (SMI-5858) - the classified convention (withRetry + isRetryable)', () => {
  it('retries a retryable (status-less/transport) failure then succeeds', async () => {
    vi.useFakeTimers()
    const fn = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce('ok')
    const promise = retryQuery(fn)
    await vi.advanceTimersByTimeAsync(1000)
    const result = await promise
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries a 429/5xx failure then succeeds', async () => {
    vi.useFakeTimers()
    const fn = vi.fn().mockRejectedValueOnce(statusError(503)).mockResolvedValueOnce('ok')
    const promise = retryQuery(fn)
    await vi.advanceTimersByTimeAsync(1000)
    const result = await promise
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a graphqlError-flagged failure', async () => {
    const fn = vi.fn().mockRejectedValue(graphqlFlaggedError())
    await expect(retryQuery(fn)).rejects.toThrow('GraphQL errors')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a non-retryable 4xx status', async () => {
    const fn = vi.fn().mockRejectedValue(statusError(404))
    await expect(retryQuery(fn)).rejects.toThrow('HTTP 404')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('normalizeLabelEntries (SMI-5858)', () => {
  it('trims whitespace, drops blanks, and dedupes preserving first-seen order', () => {
    expect(normalizeLabelEntries([' ci ', 'ci', '', '   ', 'Security'])).toEqual(['ci', 'Security'])
  })
})

describe('getTeamId (SMI-5858) - single-attempt invariant', () => {
  it('resolves the team id from a single fetch call', async () => {
    const fetchMock = mockFetchSequence([TEAM_RESPONSE])
    const id = await getTeamId('SMI')
    expect(id).toBe('team-uuid')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('REGRESSION GUARD: rethrows a retryable-class failure (500) after exactly ONE fetch call — no retry inside getTeamId itself', async () => {
    const fetchMock = mockFetchSteps([{ kind: 'httpError', status: 500 }])
    await expect(getTeamId('SMI')).rejects.toThrow('500')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('REGRESSION GUARD: rethrows a pure transport failure after exactly ONE fetch call — no retry inside getTeamId itself', async () => {
    const fetchMock = mockFetchSteps([{ kind: 'transportError', error: new Error('ECONNRESET') }])
    await expect(getTeamId('SMI')).rejects.toThrow('ECONNRESET')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws a not-found error when no team node is returned, after one fetch call', async () => {
    const fetchMock = mockFetchSequence([{ data: { teams: { nodes: [] } } }])
    await expect(getTeamId('NOPE')).rejects.toThrow('Team with key "NOPE" not found')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('getIssueId (SMI-5858) - single-attempt invariant', () => {
  it('passes a UUID-shaped identifier through with ZERO fetch calls', async () => {
    const fetchMock = mockFetchSequence([])
    const uuid = '11111111-1111-1111-1111-111111111111'
    const id = await getIssueId(uuid)
    expect(id).toBe(uuid)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves a non-UUID identifier from a single fetch call', async () => {
    const fetchMock = mockFetchSequence([issueLookupResponse('issue-uuid')])
    const id = await getIssueId('SMI-123')
    expect(id).toBe('issue-uuid')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns null (not a throw) when the API answers with no matching issue, after one fetch call', async () => {
    const fetchMock = mockFetchSequence([issueLookupResponse(null)])
    const id = await getIssueId('SMI-999')
    expect(id).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('REGRESSION GUARD: rethrows a retryable-class (transport) failure after exactly ONE fetch call — no retry inside getIssueId itself', async () => {
    const fetchMock = mockFetchSteps([{ kind: 'transportError', error: new Error('ECONNRESET') }])
    await expect(getIssueId('SMI-123')).rejects.toThrow('ECONNRESET')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('resolveLabelIds (SMI-5858) - contrast: DOES retry internally (unlike getTeamId/getIssueId)', () => {
  it('retries a transient failure on the team lookup, then succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = mockFetchSteps([
      { kind: 'httpError', status: 503 },
      { kind: 'ok', body: TEAM_RESPONSE },
      {
        kind: 'ok',
        body: labelResponse([{ id: 'label-uuid', name: 'ci', team: { id: 'team-uuid' } }]),
      },
    ])
    const promise = resolveLabelIds(['ci'], 'SMI')
    await vi.advanceTimersByTimeAsync(1000)
    const result = await promise
    expect(result.labelIds).toEqual(['label-uuid'])
    expect(result.omitted).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries a transient failure on the label-eq lookup itself, then succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = mockFetchSteps([
      { kind: 'ok', body: TEAM_RESPONSE },
      { kind: 'httpError', status: 500 },
      {
        kind: 'ok',
        body: labelResponse([{ id: 'label-uuid', name: 'ci', team: { id: 'team-uuid' } }]),
      },
    ])
    const promise = resolveLabelIds(['ci'], 'SMI')
    await vi.advanceTimersByTimeAsync(1000)
    const result = await promise
    expect(result.labelIds).toEqual(['label-uuid'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('returns empty labelIds/omitted with zero fetch calls when given no label entries', async () => {
    const fetchMock = mockFetchSequence([])
    const result = await resolveLabelIds([], 'SMI')
    expect(result).toEqual({ labelIds: [], omitted: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("REGRESSION GUARD (SMI-5858): an injected resolveTeamId is used instead of this module's own getTeamId, avoiding a redundant fetch when the caller already has a cached team id", async () => {
    // Mirrors linear-api.mjs's own call site: it resolves teamId once via
    // its own CACHED local getTeamId wrapper, then passes that same
    // wrapper into resolveLabelIds so the internal lookup here is a cache
    // hit, not a second live fetch. Without the `resolveTeamId` DI
    // parameter, this function would call the shared (uncached) getTeamId
    // internally regardless of what the caller already resolved.
    const fetchMock = mockFetchSequence([
      labelResponse([{ id: 'label-uuid', name: 'ci', team: { id: 'cached-team-uuid' } }]),
    ])
    const cachedResolveTeamId = vi.fn(async () => 'cached-team-uuid')

    const result = await resolveLabelIds(['ci'], 'SMI', cachedResolveTeamId)

    expect(result.labelIds).toEqual(['label-uuid'])
    expect(cachedResolveTeamId).toHaveBeenCalledTimes(1)
    expect(cachedResolveTeamId).toHaveBeenCalledWith('SMI')
    // Only the label-eq lookup hits fetch; the team id came from the
    // injected function, not from this module's own graphql()/getTeamId.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
