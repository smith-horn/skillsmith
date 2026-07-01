/**
 * Elapsed-time budget guard tests (SMI-5448)
 *
 * Verifies the `maxElapsedMs` field added to `BackfillFacetPlan` and consumed by
 * `runBackfillFacetCrawl` (in `subdirectory-search.helpers.ts`). The guard turns a
 * GHA-timeout whole-dispatch rollback into forward progress by checkpoint-and-
 * exiting at a clean boundary once the per-dispatch wall clock crosses the budget.
 * Two exit paths, both losslessly resumable via the returned cursor:
 *   1. MID-RANGE: the budget trips between pages of a NON-exhausted range. The
 *      range is NOT advanced/bisected -- the cursor holds at `state.lastPage`,
 *      `facet_index` is unchanged, `done=false`. Resume re-enters at lastPage+1.
 *   2. RANGE-BOUNDARY: several individually-fine ranges cumulatively cross the
 *      budget. The last range fully completed (advanced), so the cursor is clean
 *      and advanced past the crawled ranges.
 *   3. DISABLED (`maxElapsedMs=0`): behavior byte-identical to omitting the field
 *      (regression guard) -- the full 9-facet ladder completes to done=true.
 *
 * Fake-timer strategy (per the plan's review, F-3/F-4): `vi.useFakeTimers()` in
 * `beforeEach` fakes `Date.now()` so the crawl's `Date.now() - startedAt` budget
 * check can be driven deterministically without real waits; `vi.useRealTimers()`
 * in `afterEach` prevents fake-timer state leaking into sibling test files. The
 * `delay(6000)` inter-page sleep is a no-op mock (no `setTimeout`), so no timer
 * advancement is needed to un-block the page loop -- only `Date.now()` is
 * advanced (from inside the code-search mock, which runs once per page).
 *
 * Mock strategy: mirrors backfill-facet-crawl.test.ts / backfill-skill-cap.test.ts
 * -- every I/O boundary stubbed at the module level, SUT imported after the mocks,
 * driven through the public entry `runSubdirectorySearch(..., backfillPlan)`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'

// ---------------------------------------------------------------------------
// Module-level mocks -- declared before any import of the SUT
// ---------------------------------------------------------------------------

// `delay` is a no-op (no setTimeout), so fake timers only need to govern Date.now().
vi.mock('../../indexer/_shared/rate-limit.ts', () => ({
  GITHUB_API_DELAY: 0,
  delay: vi.fn(async () => undefined),
  withRateLimitTracking: vi.fn(),
  withBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  newRateLimitTelemetry: vi.fn(() => ({})),
}))

vi.mock('../../indexer/_shared/github-auth.ts', () => ({
  buildGitHubHeaders: vi.fn(async () => ({})),
}))

const mockSearchCode = vi.fn()
vi.mock('../../indexer/code-search.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../indexer/code-search.ts')>()
  return {
    ...actual,
    searchCodeForSkillMdInSubdirectory: (...args: unknown[]) => mockSearchCode(...args),
  }
})

const mockFetchRepoLicense = vi.fn()
vi.mock('../../indexer/license-filter.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../indexer/license-filter.ts')>()
  return {
    ...actual,
    fetchRepoLicense: (...args: unknown[]) => mockFetchRepoLicense(...args),
  }
})

const mockCheckSkillMdExists = vi.fn()
vi.mock('../../indexer/skill-processor.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../indexer/skill-processor.ts')>()
  return {
    ...actual,
    checkSkillMdExists: (...args: unknown[]) => mockCheckSkillMdExists(...args),
  }
})

const mockEnumerateRepoSkillPaths = vi.fn()
vi.mock('../../indexer/trees-enumerate.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../indexer/trees-enumerate.ts')>()
  return {
    ...actual,
    enumerateRepoSkillPaths: (...args: unknown[]) => mockEnumerateRepoSkillPaths(...args),
  }
})

// SUT imported AFTER mocks so it binds the stubs.
import { runSubdirectorySearch, type BackfillFacetPlan } from '../../indexer/subdirectory-search.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noTelemetry: RateLimitTelemetry = {} as RateLimitTelemetry
const LADDER_SIZE = 9
const PER_PAGE = 100

let repoCounter = 0
function makeCodeSearchRepo(overrides: Record<string, unknown> = {}) {
  repoCounter += 1
  const owner = `elapsed-owner${repoCounter}`
  return {
    owner,
    name: 'skills-repo',
    fullName: `${owner}/skills-repo`,
    description: 'test',
    url: `https://github.com/${owner}/skills-repo/tree/main/skills/x`,
    stars: 5,
    forks: 0,
    topics: ['claude-code-skill'],
    updatedAt: new Date().toISOString(),
    defaultBranch: 'main',
    installable: false,
    repoName: 'skills-repo',
    skillPath: 'skills/x',
    discoveryPath: 'subdirectory_search:broad',
    ...overrides,
  }
}

/** A FULL page (repos.length === perPage): total <= cap so no saturation/bisect,
 *  but the page is NOT short, so the range does NOT exhaust and keeps paginating. */
function fullPage() {
  const repos = Array.from({ length: PER_PAGE }, () => makeCodeSearchRepo())
  return { repos, total: 500, retries: 0, incomplete_results: false }
}

/** A single-repo short page: total under the cap, repos.length < perPage, so the
 *  range exhausts in one page (clean advance). */
function shortPage() {
  return { repos: [makeCodeSearchRepo()], total: 5, retries: 0, incomplete_results: false }
}

function makePlan(overrides: Partial<BackfillFacetPlan> = {}): BackfillFacetPlan {
  return {
    startCursor: null,
    pathPrefix: undefined,
    perPage: PER_PAGE,
    maxPagesPerRange: 20,
    maxRangesPerDispatch: 100,
    ...overrides,
  }
}

beforeEach(() => {
  // F-3: fake timers make Date.now() deterministic. Established at a fixed epoch
  // so `startedAt = Date.now()` and later advances are relative to a known base.
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-01T00:00:00Z'))

  repoCounter = 0
  mockSearchCode.mockReset()
  mockFetchRepoLicense.mockReset()
  mockCheckSkillMdExists.mockReset()
  mockEnumerateRepoSkillPaths.mockReset()

  mockFetchRepoLicense.mockResolvedValue({
    license: 'MIT',
    defaultBranch: 'main',
    fetchFailed: false,
  })
  mockCheckSkillMdExists.mockResolvedValue(true)
  mockEnumerateRepoSkillPaths.mockResolvedValue({
    entries: [{ path: 'skills/x', blobSha: 'sha1' }],
    truncatedByCap: false,
    truncatedByApi: false,
  })
})

afterEach(() => {
  // F-3: restore real timers so fake-timer state never leaks into sibling files.
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------

describe('runSubdirectorySearch -- SMI-5448 elapsed-time budget guard', () => {
  it('Case 1: mid-range trip -- cursor holds at lastPage, facet not advanced, done=false', async () => {
    const budgetMs = 100
    // Facet 0 returns FULL pages (never short-exhausts). The code-search mock
    // advances the fake clock past the budget as page 1 is fetched, so after
    // page 1 is processed (state.lastPage = 1) the mid-range elapsed check trips:
    // timedOut = true, break, NO advanceFacet. Every call advances 1000ms so the
    // budget is already crossed on the first inter-page check.
    mockSearchCode.mockImplementation(async () => {
      vi.advanceTimersByTime(1000) // push Date.now() well past the 100ms budget
      return fullPage()
    })

    const result = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ maxRangesPerDispatch: 100, maxElapsedMs: budgetMs })
    )
    const backfill = result.backfill!

    // The crawl stopped mid-range on facet 0: exactly one range was entered and
    // it did NOT complete (no advance), so ranges_crawled is 1 but facet_index 0.
    expect(backfill.ranges_crawled).toBe(1)
    // Not done -- the same facet must be resumed next dispatch.
    expect(backfill.done).toBe(false)
    // Cursor NOT advanced: still on the first facet (index 0, sentinel not 'done').
    expect(backfill.cursor.facet_index).toBe(0)
    expect(backfill.cursor.facet).not.toBe('done')
    // Cursor holds at the last fully-processed page (page 1), so resume re-enters
    // at lastPage+1 = page 2 -- no gap, no lost work.
    expect(backfill.cursor.last_page).toBe(1)
    // The bisection frontier is untouched (range was not bisected).
    expect(backfill.cursor.pending_subranges).toEqual([])
  })

  it('Case 2: range-boundary trip across multiple small ranges -> clean advanced cursor', async () => {
    const budgetMs = 100
    // Every facet exhausts in ONE short page (clean advance). The clock advances
    // per page so the cumulative elapsed crosses the budget at a RANGE BOUNDARY
    // (after advanceFacet), taking the range-boundary break, not the mid-range one.
    mockSearchCode.mockImplementation(async () => {
      vi.advanceTimersByTime(60) // 60ms/range -> budget (100ms) crossed after range 2
      return shortPage()
    })

    const result = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ maxRangesPerDispatch: 100, maxElapsedMs: budgetMs })
    )
    const backfill = result.backfill!

    // Stopped early (before the full 9-facet ladder) but at a clean boundary.
    expect(backfill.ranges_crawled).toBeLessThan(LADDER_SIZE)
    expect(backfill.ranges_crawled).toBeGreaterThanOrEqual(2)
    expect(backfill.done).toBe(false)
    // Cursor is ADVANCED (clean boundary): facet_index equals the number of fully
    // completed ranges, and last_page reset to 0 for the next (un-entered) facet.
    expect(backfill.cursor.facet_index).toBe(backfill.ranges_crawled)
    expect(backfill.cursor.facet).not.toBe('done')
    expect(backfill.cursor.last_page).toBe(0)
    expect(backfill.cursor.pending_subranges).toEqual([])
  })

  it('Case 3: maxElapsedMs=0 is disabled -- byte-identical to omitting it (full ladder completes)', async () => {
    // Even with the clock advancing aggressively per page, a 0 budget disables the
    // guard entirely (0 is falsy), so the crawl runs the full 9-facet ladder to
    // done -- identical to a plan with no maxElapsedMs field at all.
    mockSearchCode.mockImplementation(async () => {
      vi.advanceTimersByTime(10_000) // would trip any positive budget; ignored at 0
      return shortPage()
    })

    const withZero = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ maxRangesPerDispatch: 100, maxElapsedMs: 0 })
    )
    const zeroBackfill = withZero.backfill!
    expect(zeroBackfill.done).toBe(true)
    expect(zeroBackfill.facets_completed).toBe(LADDER_SIZE)
    expect(zeroBackfill.cursor.facet).toBe('done')

    // Regression parity: a plan with the field OMITTED reaches the same terminal.
    repoCounter = 0
    mockSearchCode.mockImplementation(async () => {
      vi.advanceTimersByTime(10_000)
      return shortPage()
    })
    const withoutField = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ maxRangesPerDispatch: 100 }) // no maxElapsedMs at all
    )
    const omittedBackfill = withoutField.backfill!
    expect(omittedBackfill.done).toBe(zeroBackfill.done)
    expect(omittedBackfill.facets_completed).toBe(zeroBackfill.facets_completed)
    expect(omittedBackfill.cursor.facet).toBe(zeroBackfill.cursor.facet)
    expect(omittedBackfill.cursor.facet_index).toBe(zeroBackfill.cursor.facet_index)
  })
})
