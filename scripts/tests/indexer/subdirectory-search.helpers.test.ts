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
 *
 * SMI-5964: the intra-page/intra-leaf budget tests (Cases 4-9) and the
 * no-progress-escalation tests (Cases 10, 15-17) split out to
 * `subdirectory-search.budget.test.ts` / `subdirectory-search.escalation.test.ts`
 * when this file grew past the 500-line convention. Pure fixture factories now
 * live in `scripts/tests/_lib/subdirectory-search-fixtures.ts`, shared by all three.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'
import {
  LADDER_SIZE,
  resetRepoCounter,
  fullPage,
  shortPage,
  makePlan,
} from '../_lib/subdirectory-search-fixtures.js'

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
import { runSubdirectorySearch } from '../../indexer/subdirectory-search.ts'

const noTelemetry: RateLimitTelemetry = {} as RateLimitTelemetry

beforeEach(() => {
  // F-3: fake timers make Date.now() deterministic. Established at a fixed epoch
  // so `startedAt = Date.now()` and later advances are relative to a known base.
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-01T00:00:00Z'))

  resetRepoCounter()
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
    // advances the fake clock past the budget as page 1 is FETCHED (before
    // `processSearchResults` for that page is ever called), so by the time
    // page 1's per-repo processing begins the budget is already exceeded.
    //
    // SMI-5964: `processSearchResults` now checks the deadline at the TOP of
    // its own per-repo loop (§1b), which is reached BEFORE the pre-existing
    // SMI-5448 mid-range check (positioned after `state.lastPage = page`). So
    // this scenario is now caught by the FINER-grained intra-page check,
    // before page 1 processes a single repo -- catching the crossing sooner
    // than the pre-5964 per-page granularity did (the whole point of §1b).
    // `state.lastPage` therefore holds at its PRIOR value (0, page 1 never
    // completed) rather than 1. Every call advances 1000ms so the budget is
    // already crossed on the very first check.
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
    // SMI-5964: cursor holds at page 0 (no page fully processed) -- the
    // intra-page check caught the already-crossed budget before page 1's
    // per-repo processing started. Resume re-enters at page 1 -- no gap, no
    // lost work (page 1 was never partially admitted either).
    expect(backfill.cursor.last_page).toBe(0)
    // The bisection frontier is untouched (range was not bisected).
    expect(backfill.cursor.pending_subranges).toEqual([])
  })

  it('Case 2: range-boundary trip across multiple small ranges -> clean advanced cursor', async () => {
    const budgetMs = 100
    // Every facet exhausts in ONE short page (clean advance). The clock advances
    // per page so the cumulative elapsed crosses the budget while FETCHING the
    // next range's page 1.
    //
    // SMI-5964: because the crossing happens inside the code-search mock (i.e.
    // before that range's `processSearchResults` call), the intra-page check
    // (§1b) now intercepts it at the START of that range -- before it can
    // reach the pre-existing range-boundary check (which sits even later,
    // after that range's own post-page branch). So the range this trips on
    // does NOT get a chance to advance; only the ranges BEFORE it do. This is
    // the same "caught sooner" property as Case 1 -- the range-boundary check
    // remains reachable in production for a genuine cumulative-but-no-single-
    // page-slow crossing (real wall-clock time, not an atomic fake-timer jump
    // inside one mock call).
    mockSearchCode.mockImplementation(async () => {
      vi.advanceTimersByTime(60) // 60ms/range -> budget (100ms) crossed fetching range 2
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
    // SMI-5964: the LAST range attempted is the one whose page-1 fetch crossed
    // the budget -- it is intercepted intra-page (§1b) and does NOT advance.
    // Every range BEFORE it completed cleanly and did advance, so facet_index
    // is one less than ranges_crawled (the attempted-but-stopped range still
    // counts toward ranges_crawled). last_page reset to 0 for that stopped range.
    expect(backfill.cursor.facet_index).toBe(backfill.ranges_crawled - 1)
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
    resetRepoCounter()
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
