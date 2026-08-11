/**
 * SMI-5964 §1a/§1b/§1c: intra-page and intra-leaf budget tests.
 *
 * Split out of `subdirectory-search.helpers.test.ts` (Cases 4-9) when that
 * file grew past the 500-line convention. Shares the same mock/fake-timer
 * strategy documented there and in `scripts/tests/_lib/subdirectory-search-fixtures.ts`.
 * Covers: a deadline crossing mid-page (via entry-processing, not code-search
 * itself) holds the cursor at the previous page; a skill-cap trip mid-page is
 * bounded to at most one repo's entries; the `acceptTruncation` leaf's own
 * intra-leaf budget trip does NOT advance the facet (round-2 plan-review
 * blocker 2, fixed in §1c).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'
import {
  LADDER_SIZE,
  PER_PAGE,
  resetRepoCounter,
  fullPage,
  shortPage,
  saturatedPage,
  makePlan,
  leafCursor,
} from '../_lib/subdirectory-search-fixtures.js'

// ---------------------------------------------------------------------------
// Module-level mocks -- declared before any import of the SUT
// ---------------------------------------------------------------------------

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
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------

describe('runSubdirectorySearch -- SMI-5964 intra-page/intra-leaf budget (§1a/§1b/§1c)', () => {
  it('Case 4: deadline crosses mid-page (via entry-processing mock, not code-search) -- cursor holds at the PREVIOUS page', async () => {
    const budgetMs = 100
    // No clock advance from the code-search mock -- page 1 fetches cleanly.
    mockSearchCode.mockImplementation(async () => fullPage())
    let skillCheckCount = 0
    mockCheckSkillMdExists.mockImplementation(async () => {
      skillCheckCount++
      // Page 1 has PER_PAGE (100) repos, each with 1 skill -- call 101 is the
      // FIRST skill of page 2. Page 1 completes cleanly before the budget crosses.
      if (skillCheckCount === PER_PAGE + 1) {
        vi.advanceTimersByTime(1000)
      }
      return true
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

    expect(backfill.done).toBe(false)
    expect(backfill.cursor.facet_index).toBe(0)
    expect(backfill.cursor.facet).not.toBe('done')
    // Page 1 fully processed (100 admits) before the intra-page check on page 2
    // caught the already-crossed budget -- cursor holds at the PREVIOUS page (1).
    expect(backfill.cursor.last_page).toBe(1)
    expect(backfill.cursor.pending_subranges).toEqual([])
  })

  it('Case 5: deadline crosses mid-page on a cold-start PAGE 1 (via entry-processing mock) -- cursor holds at page 0', async () => {
    const budgetMs = 100
    mockSearchCode.mockImplementation(async () => fullPage())
    let skillCheckCount = 0
    mockCheckSkillMdExists.mockImplementation(async () => {
      skillCheckCount++
      if (skillCheckCount === 1) {
        vi.advanceTimersByTime(1000)
      }
      return true
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

    expect(backfill.done).toBe(false)
    expect(backfill.cursor.facet_index).toBe(0)
    // Cold start -- page 1 never completed, so last_page holds at 0 (its prior
    // value). Resume re-enters at page 1 -- no gap, no lost work.
    expect(backfill.cursor.last_page).toBe(0)
    expect(backfill.cursor.pending_subranges).toEqual([])
  })

  it("Case 6: intra-page skill cap trips mid-page -- overshoot bounded to at most one repo's entries, cursor holds", async () => {
    const cap = 5
    const entriesPerRepo = 3
    mockSearchCode.mockImplementation(async () => fullPage()) // no clock advance -- pure skill-cap test
    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: Array.from({ length: entriesPerRepo }, (_v, i) => ({
        path: `skills/${i}`,
        blobSha: `sha-${i}`,
      })),
      truncatedByCap: false,
      truncatedByApi: false,
    })

    const result = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ maxRangesPerDispatch: 100, maxSkillsPerDispatch: cap })
    )
    const backfill = result.backfill!

    expect(backfill.done).toBe(false)
    expect(backfill.cursor.facet_index).toBe(0)
    expect(backfill.cursor.last_page).toBe(0)
    expect(backfill.cursor.pending_subranges).toEqual([])
    // Stopped well short of the full page's potential admits (100 repos * 3
    // skills each), and the overshoot past the cap is bounded to at most one
    // repo's entries -- the loop-top check in process.ts fires before the
    // FULL page (or even a full repo beyond the boundary) can be consumed.
    expect(result.admitted).toBeGreaterThanOrEqual(cap)
    expect(result.admitted).toBeLessThan(PER_PAGE * entriesPerRepo)
    expect(result.admitted - cap).toBeLessThanOrEqual(entriesPerRepo)
  })

  it('Case 7: maxElapsedMs=0 AND maxSkillsPerDispatch=0 together stay fully disabled (compound regression guard)', async () => {
    mockSearchCode.mockImplementation(async () => shortPage())
    const result = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ maxRangesPerDispatch: 100, maxElapsedMs: 0, maxSkillsPerDispatch: 0 })
    )
    const backfill = result.backfill!
    expect(backfill.done).toBe(true)
    expect(backfill.facets_completed).toBe(LADDER_SIZE)
    expect(backfill.cursor.facet).toBe('done')
  })

  it('Case 9: acceptTruncation leaf -- an intra-leaf budget trip does NOT advance the facet (review blocker 2)', async () => {
    mockSearchCode.mockImplementation(async () => saturatedPage(10))

    const result = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({
        maxRangesPerDispatch: 100,
        maxSkillsPerDispatch: 5,
        acceptTruncation: true,
        startCursor: leafCursor(),
      })
    )
    const backfill = result.backfill!

    // advanceFacet NOT taken: facet_index/pending_subranges unchanged from the
    // seeded cursor, last_page stays 0, done=false.
    expect(backfill.cursor.facet_index).toBe(0)
    expect(backfill.cursor.pending_subranges).toEqual([[5, 5]])
    expect(backfill.cursor.last_page).toBe(0)
    expect(backfill.done).toBe(false)
    // Observability preserved: the leaf is still recorded truncated even
    // though the budget (not the saturation cap) is what stopped it this time.
    expect(backfill.truncated_repo_count).toBeGreaterThanOrEqual(1)
  })
})
