/**
 * SMI-6073: degraded-response detection + bounded retry tests for
 * `searchCodeForSkillMdInSubdirectory` (scripts/indexer/code-search.ts).
 *
 * GitHub's code-search endpoint can return HTTP 200 with a nonzero
 * `total_count` but empty `items` (see the SMI-6073 plan's Context section —
 * the documented query-timeout-degrades-to-partial-results behavior). Prior
 * to this change that was indistinguishable from a genuine "zero results"
 * page. These tests exercise the new detection + bounded retry + error-return
 * logic added to `searchCodeForSkillMdInSubdirectory`.
 *
 * Mocking approach mirrors `rate-limit-tracking.test.ts` (the existing test
 * for this module's shared 403/429 retry wrapper): `global.fetch` is mocked
 * directly and the REAL `withRateLimitTracking` implementation is left in
 * place (only `delay` is stubbed to a no-op via a partial `importOriginal`
 * override, matching the pattern already used in
 * `subdirectory-search.helpers.test.ts` for the same module), so these tests
 * exercise the actual header-parsing + retry control flow, not a stand-in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  searchCodeForSkillMdInSubdirectory,
  CODE_SEARCH_RESULT_CAP,
  DEGRADED_RESPONSE_RETRY_DELAY_MS,
} from '../../indexer/code-search.ts'
import { newRateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'

// `delay` stubbed to a no-op so the 6s degraded-retry delay (and the
// pre-existing 403/429 RETRY_DELAYS ladder) cost no real wall-clock time.
// Everything else (withRateLimitTracking, RateLimitError, etc.) stays real.
vi.mock('../../indexer/_shared/rate-limit.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../indexer/_shared/rate-limit.ts')>()
  return {
    ...actual,
    delay: vi.fn(async () => undefined),
  }
})

vi.mock('../../indexer/_shared/github-auth.ts', () => ({
  buildGitHubHeaders: vi.fn(async () => ({})),
}))

/** A minimal, realistic code-search item (matches `CodeSearchResponse['items'][number]`). */
function makeItem(overrides: { fork?: boolean; owner?: string; name?: string } = {}) {
  const owner = overrides.owner ?? 'owner1'
  const name = overrides.name ?? 'repo1'
  return {
    name: 'SKILL.md',
    path: 'skills/x/SKILL.md',
    repository: {
      id: 1,
      full_name: `${owner}/${name}`,
      name,
      owner: { login: owner },
      description: null,
      html_url: `https://github.com/${owner}/${name}`,
      stargazers_count: 1,
      forks_count: 0,
      fork: overrides.fork ?? false,
      topics: [],
      default_branch: 'main',
    },
  }
}

function jsonResponse(
  body: unknown,
  opts: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: opts.status ?? 200,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  })
}

/** A 403/429 rate-limit response (no JSON body -- code-search.ts never parses one on this path). */
function rateLimitResponse(status: 403 | 429, headers: Record<string, string> = {}): Response {
  return new Response('rate limited', { status, headers })
}

describe('searchCodeForSkillMdInSubdirectory — SMI-6073 degraded-response handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
    fetchMock = vi.fn()
    // @ts-expect-error overriding global for test
    global.fetch = fetchMock
  })
  afterEach(() => {
    global.fetch = originalFetch
    vi.clearAllMocks()
  })

  it('retries once on a degraded response (raw items empty, total_count > 0, page in range), then returns error if still degraded', async () => {
    const telemetry = newRateLimitTelemetry()
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { total_count: 50, incomplete_results: false, items: [] },
          { headers: { 'x-github-request-id': 'req-1' } }
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { total_count: 50, incomplete_results: false, items: [] },
          { headers: { 'x-github-request-id': 'req-2' } }
        )
      )

    const result = await searchCodeForSkillMdInSubdirectory(undefined, 1, 100, telemetry)

    // Initial fetch + exactly ONE degraded retry -- not the full RETRY_DELAYS ladder.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.repos).toEqual([])
    expect(result.error).toBeDefined()
    expect(result.error).toContain('degraded response')
    // The error names the LAST response's request id (retried once, still degraded).
    expect(result.error).toContain('req-2')
  })

  it('does NOT treat an all-filtered-out page (forks) as degraded -- raw items non-empty, no retry, repos: []', async () => {
    const telemetry = newRateLimitTelemetry()
    // GitHub returned 3 real items (total_count matches), but every single one
    // is a fork -- a legitimate empty `repos` result, not degradation.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        total_count: 3,
        incomplete_results: false,
        items: [makeItem({ fork: true }), makeItem({ fork: true }), makeItem({ fork: true })],
      })
    )

    const result = await searchCodeForSkillMdInSubdirectory(undefined, 1, 100, telemetry)

    expect(fetchMock).toHaveBeenCalledTimes(1) // no retry
    expect(result.error).toBeUndefined()
    expect(result.repos).toEqual([])
    expect(result.total).toBe(3)
  })

  it('does NOT treat a page requested past min(total_count, CODE_SEARCH_RESULT_CAP) as degraded (legitimate empty page)', async () => {
    const telemetry = newRateLimitTelemetry()
    const perPage = 100
    // total_count (5000) exceeds the cap, so the retrievable ceiling is
    // CODE_SEARCH_RESULT_CAP (1000), not total_count. Request the page
    // immediately past that ceiling (page 11 * 100 = 1000..1100, entirely
    // beyond the retrievable range).
    const pageJustPastCap = CODE_SEARCH_RESULT_CAP / perPage + 1
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ total_count: 5000, incomplete_results: false, items: [] })
    )

    const result = await searchCodeForSkillMdInSubdirectory(
      undefined,
      pageJustPastCap,
      perPage,
      telemetry
    )

    expect(fetchMock).toHaveBeenCalledTimes(1) // no retry -- legitimate empty page
    expect(result.error).toBeUndefined()
    expect(result.repos).toEqual([])
    expect(result.total).toBe(5000)
  })

  it('skips the retry when the elapsed-budget deadline is imminent -- returns error immediately, single fetch', async () => {
    const telemetry = newRateLimitTelemetry()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { total_count: 10, incomplete_results: false, items: [] },
        { headers: { 'x-github-request-id': 'req-deadline' } }
      )
    )

    // Deadline is closer than the degraded-retry delay -- retry must be skipped
    // rather than wasting a retry this close to a hard timeout.
    const deadlineAtMs = Date.now() + DEGRADED_RESPONSE_RETRY_DELAY_MS - 1000

    const result = await searchCodeForSkillMdInSubdirectory(
      undefined,
      1,
      100,
      telemetry,
      undefined,
      deadlineAtMs
    )

    expect(fetchMock).toHaveBeenCalledTimes(1) // no retry attempted
    expect(result.error).toBeDefined()
    expect(result.error).toContain('deadline imminent')
    expect(result.error).toContain('req-deadline')
  })

  it('a successful (non-degraded) response is unaffected -- real items returned normally, single fetch', async () => {
    const telemetry = newRateLimitTelemetry()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        total_count: 1,
        incomplete_results: false,
        items: [makeItem()],
      })
    )

    const result = await searchCodeForSkillMdInSubdirectory(undefined, 1, 100, telemetry)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.error).toBeUndefined()
    expect(result.repos).toHaveLength(1)
    expect(result.repos[0].fullName).toBe('owner1/repo1')
  })

  it('SMI-6073: degraded-then-rate-limited -- the degraded retry and the FULL 403/429 ladder are independently budgeted', async () => {
    // Response sequence: 1 degraded (consumes the degraded retry's ONE
    // allowance) -> 4 rate-limited responses (3 real retries + a 4th that
    // finds the ladder exhausted). Regression guard for the BLOCKING bug
    // (GPT-5.6-Sol review, 2026-08-17): an earlier version shared a single
    // loop-iteration counter between the degraded retry and the 403/429
    // ladder, so the degraded retry silently stole one of the ladder's 3
    // retries -- only 4 total fetches would occur (not 5) and the "after 3
    // retries" message would be inaccurate (only 2 real 403/429 retries
    // would have actually happened).
    const telemetry = newRateLimitTelemetry()
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ total_count: 50, incomplete_results: false, items: [] })
      )
      .mockResolvedValueOnce(rateLimitResponse(429))
      .mockResolvedValueOnce(rateLimitResponse(429))
      .mockResolvedValueOnce(rateLimitResponse(429))
      .mockResolvedValueOnce(rateLimitResponse(429, { 'x-github-request-id': 'req-exhausted' }))

    const result = await searchCodeForSkillMdInSubdirectory(undefined, 1, 100, telemetry)

    // 1 (degraded) + 4 (rate-limited: 3 retried + 1 exhausted) = 5 fetches.
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('rate limit exhausted')
    // The FULL 3-retry ladder was honored -- not reduced by the degraded retry.
    expect(result.error).toContain('after 3 retries')
    expect(result.error).toContain('req-exhausted')
    // Combined retry count: 1 degraded retry + 3 rate-limit retries.
    expect(result.retries).toBe(4)
  })

  it('SMI-6073: rate-limited-then-degraded -- a degraded response interleaved MID-ladder does not shrink the 403/429 budget', async () => {
    // Response sequence: 2 rate-limited (2 real retries) -> 1 degraded
    // (consumes the degraded retry's ONE allowance, interleaved BETWEEN
    // rate-limit retries) -> 2 more rate-limited (the 3rd retry, then a 4th
    // that finds the ladder exhausted). Proves independence in the OPPOSITE
    // ordering from the test above -- the ladder must still get its full 3
    // retries even though a degraded response occupied a fetch slot in the
    // middle of it.
    const telemetry = newRateLimitTelemetry()
    fetchMock
      .mockResolvedValueOnce(rateLimitResponse(429))
      .mockResolvedValueOnce(rateLimitResponse(429))
      .mockResolvedValueOnce(
        jsonResponse({ total_count: 50, incomplete_results: false, items: [] })
      )
      .mockResolvedValueOnce(rateLimitResponse(429))
      .mockResolvedValueOnce(rateLimitResponse(429, { 'x-github-request-id': 'req-exhausted-2' }))

    const result = await searchCodeForSkillMdInSubdirectory(undefined, 1, 100, telemetry)

    // 4 rate-limited (3 retried + 1 exhausted) + 1 degraded (retried) = 5 fetches.
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('rate limit exhausted')
    expect(result.error).toContain('after 3 retries')
    expect(result.error).toContain('req-exhausted-2')
    expect(result.retries).toBe(4)
  })
})
