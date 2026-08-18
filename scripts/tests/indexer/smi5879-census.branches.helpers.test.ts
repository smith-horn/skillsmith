/**
 * SMI-6015: fixture-level (no live Postgres) tests for the worker-pool,
 * batched-write, circuit-breaker, and rate-limit-split machinery in
 * `smi5879-census.branches.helpers.ts` — the fix for Wave 3's first
 * production-scale dry run, where a headers object built ONCE ~8h before the
 * pass finished went stale after GitHub's 1h App-token expiry and 25,014 of
 * 28,601 repos were silently misclassified `transient`.
 * @module scripts/tests/indexer/smi5879-census.branches.helpers
 *
 * `smi5879-census.branches.ts`'s own `resolveDefaultBranches`/
 * `sweepTransientRepos` orchestration is exercised end-to-end against a live
 * Postgres in `smi5879-census.test.ts` (I-5/I-6). This file covers the
 * per-repo/pool/SQL-builder logic in isolation via a mocked `global.fetch` —
 * no DB involved, matching the task's "fixture-level test, not live DB"
 * instruction for the batched-write correctness check.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  resolveOne,
  waitOutRateLimit,
  runResolutionPool,
  checkCircuitBreaker,
  BranchResolutionAuthError,
  BranchResolutionCircuitBreakerError,
  MAX_RETRIES,
  SECONDARY_RATE_LIMIT_BACKOFF_MS,
  PRIMARY_RATE_LIMIT_RESET_BUFFER_MS,
  CIRCUIT_BREAKER_WARMUP_COUNT,
  CIRCUIT_BREAKER_TRANSIENT_RATE_THRESHOLD,
} from '../../indexer/smi5879-census.branches.helpers.ts'
import { createTokenBucket, newRateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'
import type { DistinctRepo, ResolutionOutcome } from '../../indexer/smi5879-census.types.ts'

const REPO: DistinctRepo = { owner: 'acme', repo: 'widget' }

let originalFetch: typeof global.fetch

beforeEach(() => {
  originalFetch = global.fetch
})

afterEach(() => {
  global.fetch = originalFetch
  vi.useRealTimers()
})

/** Queue fixed Responses for successive `global.fetch` calls (order-sensitive, one per call). */
function queueFetch(responses: Response[]): ReturnType<typeof vi.fn> {
  const queue = [...responses]
  const mock = vi.fn(async () => {
    const next = queue.shift()
    if (next === undefined)
      throw new Error('fetch mock queue exhausted — test registered too few responses')
    return next
  })
  global.fetch = mock as unknown as typeof global.fetch
  return mock
}

/** Effectively-unthrottled token bucket for tests — real rate limiting is exercised via waitOutRateLimit directly. */
function fastBucket(): ReturnType<typeof createTokenBucket> {
  return createTokenBucket(1000, 1000)
}

function repoResponse(defaultBranch: string): Response {
  return new Response(JSON.stringify({ default_branch: defaultBranch }), { status: 200 })
}

// ---------------------------------------------------------------------------
// resolveOne — frozen-header fix (getHeaders per attempt) + 401-fatal
// ---------------------------------------------------------------------------

describe('resolveOne', () => {
  it('resolved: 200 with a usable default_branch, one attempt', async () => {
    const fetchMock = queueFetch([repoResponse('develop')])
    const outcome = await resolveOne(REPO, async () => ({}), newRateLimitTelemetry(), fastBucket())
    expect(outcome).toEqual({
      repo: REPO,
      resolution: 'resolved',
      defaultBranch: 'develop',
      httpStatus: 200,
      attempts: 1,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('not-found: 404 returns immediately, no retry', async () => {
    const fetchMock = queueFetch([new Response('', { status: 404 })])
    const outcome = await resolveOne(REPO, async () => ({}), newRateLimitTelemetry(), fastBucket())
    expect(outcome.resolution).toBe('not-found')
    expect(outcome.defaultBranch).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('200 with no default_branch is transient, never fabricated as resolved', async () => {
    queueFetch([new Response(JSON.stringify({}), { status: 200 })])
    const outcome = await resolveOne(REPO, async () => ({}), newRateLimitTelemetry(), fastBucket())
    expect(outcome.resolution).toBe('transient')
    expect(outcome.defaultBranch).toBeNull()
  })

  it('exhausts retries on repeated 5xx and returns transient (never throws for a 5xx)', async () => {
    queueFetch(Array.from({ length: MAX_RETRIES }, () => new Response('', { status: 503 })))
    const outcome = await resolveOne(REPO, async () => ({}), newRateLimitTelemetry(), fastBucket())
    expect(outcome.resolution).toBe('transient')
    expect(outcome.attempts).toBe(MAX_RETRIES)
  })

  it('SMI-6015 follow-up: 401 gets exactly one cache-busted retry before throwing — a second 401 is fatal, never transient', async () => {
    const fetchMock = queueFetch([
      new Response('', { status: 401 }),
      new Response('', { status: 401 }),
    ])
    await expect(
      resolveOne(REPO, async () => ({}), newRateLimitTelemetry(), fastBucket())
    ).rejects.toThrow(BranchResolutionAuthError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('401 error names the offending repo', async () => {
    queueFetch([new Response('', { status: 401 }), new Response('', { status: 401 })])
    await expect(
      resolveOne(REPO, async () => ({}), newRateLimitTelemetry(), fastBucket())
    ).rejects.toThrow(/acme\/widget/)
  })

  it('SMI-6015 follow-up: a 401 followed by a successful retry recovers — does not throw, does not lose the pass', async () => {
    const fetchMock = queueFetch([new Response('', { status: 401 }), repoResponse('develop')])
    const outcome = await resolveOne(REPO, async () => ({}), newRateLimitTelemetry(), fastBucket())
    expect(outcome.resolution).toBe('resolved')
    expect(outcome.defaultBranch).toBe('develop')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('GPT-5.6-Sol Medium finding (post-merge retro): the dedicated 401 retry counts its own HTTP request in `attempts` -- previously undercounted, and `attempts` is persisted/accumulated downstream', async () => {
    queueFetch([new Response('', { status: 401 }), repoResponse('develop')])
    const outcome = await resolveOne(REPO, async () => ({}), newRateLimitTelemetry(), fastBucket())
    // Two real HTTP requests were made (the 401, then the retry) -- attempts
    // must reflect that, not the outer loop's own attempts=1.
    expect(outcome.attempts).toBe(2)
  })

  it("GPT-5.6-Sol round-2 finding: a 401-then-recovered-to-a-retryable-status sequence still gets the FULL outer retry budget -- the reporting counter must not consume the outer loop's own attempts", async () => {
    // Reviewer's exact walkthrough: 401 -> 403 -> 5xx should still permit a
    // 4th request (the outer loop's own 3rd attempt) -- if the 401 retry's
    // HTTP request were still (incorrectly) shared with the outer `attempts`
    // budget, the loop would exhaust after only 3 fetch calls and this 4th
    // response would never even be consumed, returning 'transient' instead.
    const fetchMock = queueFetch([
      new Response('', { status: 401 }),
      new Response('', { status: 403 }), // the 401's dedicated retry recovers to a DIFFERENT retryable status
      new Response('', { status: 500 }), // outer attempt 2
      repoResponse('develop'), // outer attempt 3 -- only reachable if the outer budget is truly untouched
    ])
    const outcome = await resolveOne(REPO, async () => ({}), newRateLimitTelemetry(), fastBucket())
    expect(outcome.resolution).toBe('resolved')
    expect(outcome.defaultBranch).toBe('develop')
    expect(outcome.attempts).toBe(4)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it("GPT-5.6-Sol Low finding (post-merge retro): clearTokenCache() fires BEFORE the retry's getHeaders() call, and the retry's fetch actually carries whatever getHeaders returns next -- proves real remint wiring, not just that clearTokenCache was called", async () => {
    const authModule = await import('../../indexer/_shared/github-auth.ts')
    const callOrder: string[] = []
    const clearSpy = vi.spyOn(authModule, 'clearTokenCache').mockImplementation(() => {
      callOrder.push('clearTokenCache')
    })
    queueFetch([new Response('', { status: 401 }), repoResponse('main')])
    let headerCalls = 0
    const seenAuthHeaders: (string | undefined)[] = []
    const originalMock = global.fetch as unknown as ReturnType<typeof vi.fn>
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      seenAuthHeaders.push(headers?.['Authorization'])
      return originalMock()
    }) as unknown as typeof global.fetch
    const getHeaders = async () => {
      headerCalls++
      callOrder.push(`getHeaders-${headerCalls}`)
      return { Authorization: `token-${headerCalls}` }
    }
    await resolveOne(REPO, getHeaders, newRateLimitTelemetry(), fastBucket())
    expect(clearSpy).toHaveBeenCalledTimes(1)
    // clearTokenCache must fire BEFORE the retry's getHeaders call -- firing
    // after would let the retry read a stale cached token.
    expect(callOrder).toEqual(['getHeaders-1', 'clearTokenCache', 'getHeaders-2'])
    // The retry's fetch actually carried the SECOND token -- proves the
    // fresh value from getHeaders flowed all the way to the real request,
    // not just that the exported function was invoked.
    expect(seenAuthHeaders).toEqual(['token-1', 'token-2'])
    clearSpy.mockRestore()
  })

  it("SMI-6015 follow-up EDGE CASE: a 401 on the outer loop's own FINAL attempt still gets its dedicated retry and recovers — never silently falls through to transient", async () => {
    // MAX_RETRIES-1 5xx responses burn every attempt except the last, so the
    // 401 below lands exactly on attempts===MAX_RETRIES (the while loop's
    // own final iteration) — the case that would silently fall through to
    // "unclassified -> transient" if the 401 retry were implemented as a
    // `continue` back through the outer loop instead of an inline retry.
    queueFetch([
      ...Array.from({ length: MAX_RETRIES - 1 }, () => new Response('', { status: 500 })),
      new Response('', { status: 401 }),
      repoResponse('develop'),
    ])
    const outcome = await resolveOne(REPO, async () => ({}), newRateLimitTelemetry(), fastBucket())
    expect(outcome.resolution).toBe('resolved')
    expect(outcome.defaultBranch).toBe('develop')
  })

  it('SMI-6015 follow-up EDGE CASE: a 401 on the final attempt whose retry ALSO 401s still throws — never silently returns transient', async () => {
    queueFetch([
      ...Array.from({ length: MAX_RETRIES - 1 }, () => new Response('', { status: 500 })),
      new Response('', { status: 401 }),
      new Response('', { status: 401 }),
    ])
    await expect(
      resolveOne(REPO, async () => ({}), newRateLimitTelemetry(), fastBucket())
    ).rejects.toThrow(BranchResolutionAuthError)
  })

  it('getHeaders is invoked fresh on every retry attempt — the SMI-6015 fix — not once for the whole call', async () => {
    queueFetch([
      new Response('', { status: 500 }),
      new Response('', { status: 500 }),
      repoResponse('main'),
    ])
    let calls = 0
    const getHeaders = async () => {
      calls++
      return { Authorization: `token-${calls}` }
    }
    const outcome = await resolveOne(REPO, getHeaders, newRateLimitTelemetry(), fastBucket())
    expect(outcome.resolution).toBe('resolved')
    // MAX_RETRIES=3 attempts total for a repo that fails twice then succeeds.
    expect(calls).toBe(3)
  })

  it('a getHeaders call returning a DIFFERENT token per attempt is what actually reaches fetch (proves refresh, not just call count)', async () => {
    queueFetch([new Response('', { status: 500 }), repoResponse('main')])
    const seenAuthHeaders: (string | undefined)[] = []
    let calls = 0
    const originalMock = global.fetch as unknown as ReturnType<typeof vi.fn>
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      seenAuthHeaders.push(headers?.['Authorization'])
      return originalMock()
    }) as unknown as typeof global.fetch
    const getHeaders = async () => {
      calls++
      return { Authorization: `token-${calls}` }
    }
    await resolveOne(REPO, getHeaders, newRateLimitTelemetry(), fastBucket())
    expect(seenAuthHeaders).toEqual(['token-1', 'token-2'])
  })
})

// ---------------------------------------------------------------------------
// waitOutRateLimit — primary (bucket exhaustion) vs secondary (abuse) split
// ---------------------------------------------------------------------------

describe('waitOutRateLimit', () => {
  beforeEach(() => vi.useFakeTimers())

  it('secondary (x-ratelimit-remaining absent): honors retry-after when present', async () => {
    const response = new Response('', { status: 403, headers: { 'retry-after': '5' } })
    let resolved = false
    const p = waitOutRateLimit(response).then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(4999)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toBe(true)
    await p
  })

  it('secondary (no retry-after): falls back to SECONDARY_RATE_LIMIT_BACKOFF_MS', async () => {
    const response = new Response('', { status: 429 })
    let resolved = false
    const p = waitOutRateLimit(response).then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(SECONDARY_RATE_LIMIT_BACKOFF_MS - 1)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toBe(true)
    await p
  })

  it('primary (x-ratelimit-remaining="0"): waits until x-ratelimit-reset + buffer, ignoring retry-after entirely', async () => {
    // x-ratelimit-reset is Unix epoch SECONDS (GitHub's real format) —
    // Math.floor(Date.now()/1000) truncates up to ~999ms of sub-second
    // precision, so the margins below are generous (multi-second), not tight
    // to the millisecond, to stay robust against that truncation.
    const nowSec = Math.floor(Date.now() / 1000)
    const resetInSec = 30
    const response = new Response('', {
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(nowSec + resetInSec),
        'retry-after': '1', // must be ignored — a 1s wait would make this test fail below
      },
    })
    let resolved = false
    const p = waitOutRateLimit(response).then(() => {
      resolved = true
    })
    const expectedWaitMs = resetInSec * 1000 + PRIMARY_RATE_LIMIT_RESET_BUFFER_MS
    // Well short of reset+buffer (proves the 1s retry-after was NOT used —
    // that alone would have already resolved by now).
    await vi.advanceTimersByTimeAsync(expectedWaitMs - 5000)
    expect(resolved).toBe(false)
    // Well past reset+buffer, clear of the truncation slop in the other direction.
    await vi.advanceTimersByTimeAsync(6000)
    expect(resolved).toBe(true)
    await p
  })

  it('primary with a malformed/absent x-ratelimit-reset falls back to a bounded wait rather than hanging forever', async () => {
    const response = new Response('', {
      status: 429,
      headers: { 'x-ratelimit-remaining': '0' },
    })
    let resolved = false
    const p = waitOutRateLimit(response).then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(70_000)
    expect(resolved).toBe(true)
    await p
  })
})

// ---------------------------------------------------------------------------
// runResolutionPool — bounded-concurrency worker pool, cooperative cancellation
// ---------------------------------------------------------------------------

describe('runResolutionPool', () => {
  it('processes every repo and reports zero abort when nothing goes wrong', async () => {
    const repos: DistinctRepo[] = Array.from({ length: 12 }, (_, i) => ({
      owner: 'acme',
      repo: `r${i}`,
    }))
    queueFetch(repos.map(() => repoResponse('main')))
    const seen: ResolutionOutcome[] = []
    const { abortedBy } = await runResolutionPool(
      repos,
      async () => ({}),
      newRateLimitTelemetry(),
      4,
      (outcome) => {
        seen.push(outcome)
      }
    )
    expect(abortedBy).toBeNull()
    expect(seen).toHaveLength(12)
  })

  it('stops pulling NEW work once onOutcome signals abort — does not silently process the rest of the list', async () => {
    const repos: DistinctRepo[] = Array.from({ length: 50 }, (_, i) => ({
      owner: 'acme',
      repo: `r${i}`,
    }))
    const fetchMock = queueFetch(repos.map(() => repoResponse('main')))
    let completed = 0
    const { abortedBy } = await runResolutionPool(
      repos,
      async () => ({}),
      newRateLimitTelemetry(),
      3,
      () => {
        completed++
        if (completed === 5) return { reason: new Error('stop-for-test') }
      }
    )
    expect(abortedBy).not.toBeNull()
    expect(abortedBy?.message).toBe('stop-for-test')
    // Bounded leak: with concurrency=3, at most ~2 extra in-flight calls can
    // complete after the 5th signals abort — nowhere near the full list of 50.
    // This is the exact property a raw pMapBounded worker loop does NOT have
    // (see this module's own doc comment on runResolutionPool).
    expect(fetchMock.mock.calls.length).toBeLessThan(50)
    expect(completed).toBeLessThan(50)
  })

  it('a 401 mid-pool sets abortedBy to the BranchResolutionAuthError and stops before the end of the list', async () => {
    const repos: DistinctRepo[] = Array.from({ length: 20 }, (_, i) => ({
      owner: 'acme',
      repo: `r${i}`,
    }))
    // SMI-6015 follow-up: index 3 now needs TWO queued 401s — resolveOne's
    // dedicated retry consumes one extra fetch call before it gives up and
    // aborts the pool, same as a genuinely dead credential would.
    queueFetch([
      ...Array.from({ length: 3 }, () => repoResponse('main')),
      new Response('', { status: 401 }),
      new Response('', { status: 401 }),
    ])
    const outcomes: ResolutionOutcome[] = []
    const { abortedBy } = await runResolutionPool(
      repos,
      async () => ({}),
      newRateLimitTelemetry(),
      1, // concurrency 1 — deterministic index order so the 401 lands exactly at index 3
      (outcome) => {
        outcomes.push(outcome)
      }
    )
    expect(abortedBy).toBeInstanceOf(BranchResolutionAuthError)
    // Indices 0,1,2 resolved before index 3's 401 aborted the pool.
    expect(outcomes).toHaveLength(3)
  })

  it('a sibling worker already in flight when abort fires does NOT get its outcome written — post-await race (GPT-5.6-Sol review, 2026-08-14)', async () => {
    // Deterministic reproduction of the exact race the review flagged: the
    // ORIGINAL pool only checked `abortedBy` BEFORE dispatching a new item,
    // never AFTER an in-flight `resolveOne` resolved — so a worker already
    // mid-flight when a sibling's onOutcome set abortedBy would still call
    // onOutcome for its own (late) result. r0's fetch resolves immediately
    // and its onOutcome triggers the abort; r1's fetch is held open via a
    // manually-controlled promise and only released AFTER r0's abort has
    // already landed, simulating "this call was already in flight when the
    // abort happened, and only finishes after."
    const repos: DistinctRepo[] = [
      { owner: 'acme', repo: 'r0' },
      { owner: 'acme', repo: 'r1' },
    ]
    let releaseR1: (() => void) | null = null
    const r1Gate = new Promise<void>((resolve) => {
      releaseR1 = resolve
    })
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/r1')) {
        await r1Gate // held open until the test explicitly releases it below
      }
      return repoResponse('main')
    }) as unknown as typeof global.fetch

    let abortSignaled = false
    const outcomes: ResolutionOutcome[] = []
    const poolPromise = runResolutionPool(
      repos,
      async () => ({}),
      newRateLimitTelemetry(),
      2, // both dispatch immediately, in parallel
      (outcome) => {
        outcomes.push(outcome)
        if (outcome.repo.repo === 'r0') {
          abortSignaled = true
          return { reason: new Error('abort-after-r0') }
        }
      }
    )

    // Poll (real timers — no fake-timer/microtask assumptions about the
    // pool's internal scheduling) until r0's onOutcome has actually fired
    // and set the abort, THEN release r1 — guarantees r1's fetch resolves
    // strictly after the abort was already signaled, not racily before it.
    while (!abortSignaled) {
      await new Promise((r) => setTimeout(r, 1))
    }
    releaseR1?.()

    const { abortedBy } = await poolPromise
    expect(abortedBy?.message).toBe('abort-after-r0')
    // The actual property under test: r1's outcome must never reach
    // onOutcome, even though its fetch DID eventually resolve successfully.
    expect(outcomes.map((o) => o.repo.repo)).toEqual(['r0'])
    expect(outcomes).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// checkCircuitBreaker
// ---------------------------------------------------------------------------

describe('checkCircuitBreaker', () => {
  it('never trips below the warm-up count, even at a 100% transient rate', () => {
    const result = checkCircuitBreaker(
      CIRCUIT_BREAKER_WARMUP_COUNT - 1,
      CIRCUIT_BREAKER_WARMUP_COUNT - 1
    )
    expect(result).toBeUndefined()
  })

  it('does not trip AT exactly the threshold (strictly greater-than, not >=)', () => {
    const completed = CIRCUIT_BREAKER_WARMUP_COUNT
    const transient = Math.floor(completed * CIRCUIT_BREAKER_TRANSIENT_RATE_THRESHOLD)
    expect(checkCircuitBreaker(completed, transient)).toBeUndefined()
  })

  it('trips once the transient rate exceeds the threshold past warm-up', () => {
    const completed = CIRCUIT_BREAKER_WARMUP_COUNT
    const transient = Math.ceil(completed * CIRCUIT_BREAKER_TRANSIENT_RATE_THRESHOLD) + 1
    const result = checkCircuitBreaker(completed, transient)
    expect(result?.reason).toBeInstanceOf(BranchResolutionCircuitBreakerError)
    expect(result?.reason.message).toMatch(/circuit breaker tripped/)
  })
})

// buildBatchInsertSql / buildBatchUpdateSql tests moved to
// smi5879-census.branches.writes.test.ts (SMI-6015 post-merge retro,
// 2026-08-18) alongside the source split — see that file's own header.
