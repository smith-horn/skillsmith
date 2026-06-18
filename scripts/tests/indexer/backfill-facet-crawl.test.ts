/**
 * Size-faceted backfill crawl tests (SMI-5286 1c)
 *
 * Drives the public entry `runSubdirectorySearch(..., backfillPlan)` to prove the
 * size-faceted depth-first crawl in `subdirectory-search.helpers.ts`
 * (`runBackfillFacetCrawl`) behaves per the SPARC §#3/§#5 contract:
 *   1. Exhausts the static 9-facet ladder when no range saturates → done, all 9
 *      facets completed, cursor.facet === 'done'.
 *   2. A facet whose page-1 total exceeds the 1000-cap is BISECTED (its page-1
 *      repos are NOT collected); the bisected sub-ranges still crawl to
 *      completion → cap_saturated true, done true.
 *   3. Budget + resume round-trip: maxRangesPerDispatch bounds one dispatch; the
 *      returned cursor resumes losslessly across dispatches until done, with
 *      facets_completed monotonically advancing.
 *   4. The crawl threads a `size:` qualifier as the 5th arg of every code-search
 *      call.
 *
 * Strategy: mirrors `subdirectory-search.perskill.test.ts` exactly — mock every
 * I/O boundary (rate-limit delay, github-auth, code-search, license-filter,
 * skill-processor, trees-enumerate) at the module level, import the SUT AFTER the
 * mocks, and let `buildSkillTreeUrl` (pure) and the facet ladder run real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'

// ---------------------------------------------------------------------------
// Module-level mocks — declared before any import of the SUT
// (identical shape to subdirectory-search.perskill.test.ts)
// ---------------------------------------------------------------------------

// Mock delay so the 6s inter-page sleeps don't actually wait.
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

// Imported AFTER mocks so the SUT binds the stubs.
import { runSubdirectorySearch, type BackfillFacetPlan } from '../../indexer/subdirectory-search.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noTelemetry: RateLimitTelemetry = {} as RateLimitTelemetry

/** Static ladder length — kept literal to assert against the SUT, not derive from it. */
const LADDER_SIZE = 9

/**
 * Build a minimal GitHubRepository-shaped code-search hit. Owner is varied via a
 * counter so per-repo dedup (`enumeratedRepos`) never swallows a later facet's
 * single repo — though every assertion in this file keys on facet COUNTERS, not
 * collected-repo counts, so this is belt-and-suspenders.
 */
let repoCounter = 0
function makeCodeSearchRepo(overrides: Record<string, unknown> = {}) {
  repoCounter += 1
  const owner = `owner${repoCounter}`
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

/**
 * A non-saturating facet: page 1 returns ONE repo (total well under the cap, but
 * repos.length === 1 < perPage → short page → range exhausted in a single page).
 * page>=2 returns an empty short page as a defensive backstop.
 */
function nonSaturatingPage(page: number) {
  if (page === 1) {
    return { repos: [makeCodeSearchRepo()], total: 5, retries: 0, incomplete_results: false }
  }
  return { repos: [], total: 5, retries: 0, incomplete_results: false }
}

/** A saturated facet: page-1 total exceeds the 1000-result code-search cap. */
function saturatedPage1() {
  // repos here MUST NOT be collected (the crawl bisects before processing them).
  return {
    repos: [makeCodeSearchRepo({ skillPath: 'skills/should-not-collect' })],
    total: 5000,
    retries: 0,
    incomplete_results: false,
  }
}

/** A BackfillFacetPlan with broad (no path:) query, overridable per test. */
function makePlan(overrides: Partial<BackfillFacetPlan> = {}): BackfillFacetPlan {
  return {
    startCursor: null,
    pathPrefix: undefined,
    perPage: 100,
    maxPagesPerRange: 20,
    maxRangesPerDispatch: 100,
    ...overrides,
  }
}

beforeEach(() => {
  repoCounter = 0
  mockSearchCode.mockReset()
  mockFetchRepoLicense.mockReset()
  mockCheckSkillMdExists.mockReset()
  mockEnumerateRepoSkillPaths.mockReset()

  // Default I/O behaviour: permissive license, validation passes, one skill per repo.
  mockFetchRepoLicense.mockResolvedValue({ license: 'MIT', fetchFailed: false })
  mockCheckSkillMdExists.mockResolvedValue(true)
  mockEnumerateRepoSkillPaths.mockResolvedValue({
    entries: [{ path: 'skills/x', blobSha: 'sha1' }],
    truncatedByCap: false,
    truncatedByApi: false,
  })
})

// ---------------------------------------------------------------------------

describe('runSubdirectorySearch — size-faceted backfill crawl (SMI-5286 1c)', () => {
  it('Case 1: exhausts the full 9-facet ladder when no range saturates', async () => {
    // Every facet/sub-range is non-saturating and exhausts in a single short page.
    mockSearchCode.mockImplementation(async (_pathPrefix: unknown, page: number) =>
      nonSaturatingPage(page)
    )

    const result = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      // maxPages is ignored on the backfill path (plan.maxPagesPerRange governs).
      1,
      noTelemetry,
      makePlan({ maxRangesPerDispatch: 100 })
    )

    expect(result.backfill).toBeDefined()
    const backfill = result.backfill!
    expect(backfill.done).toBe(true)
    expect(backfill.facets_completed).toBe(LADDER_SIZE)
    expect(backfill.facets_total).toBe(LADDER_SIZE)
    expect(backfill.cap_saturated).toBe(false)
    // With no saturation, every top-level facet is one range → 9 ranges crawled.
    expect(backfill.ranges_crawled).toBe(LADDER_SIZE)
    // Terminal cursor: ladder exhausted → facet sentinel 'done', index at the end.
    expect(backfill.cursor.facet).toBe('done')
    expect(backfill.cursor.facet_index).toBe(LADDER_SIZE)
    expect(backfill.cursor.pending_subranges).toEqual([])
  })

  it('Case 2: a saturated facet bisects (page-1 repos not collected) and still completes', async () => {
    // FIRST top-level facet (size:0..127) saturates on page 1; every later range
    // (including the saturated facet's bisected sub-ranges) is non-saturating.
    let firstCall = true
    mockSearchCode.mockImplementation(async (_pathPrefix: unknown, page: number) => {
      if (firstCall) {
        firstCall = false
        // page 1 of the very first facet → saturated.
        return saturatedPage1()
      }
      return nonSaturatingPage(page)
    })

    const result = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ maxRangesPerDispatch: 100 })
    )

    const backfill = result.backfill!
    expect(backfill.cap_saturated).toBe(true)
    // The crawl still drains the whole ladder because the saturated facet's
    // sub-ranges (which return total:5) get crawled before facet 0 advances.
    expect(backfill.done).toBe(true)
    expect(backfill.facets_completed).toBe(LADDER_SIZE)
    expect(backfill.cursor.facet).toBe('done')

    // No repo was collected from the saturated page-1: that page returned a repo
    // whose skillPath was 'should-not-collect', but the crawl bisected BEFORE
    // calling processSearchResults on it. Every collected row therefore comes from
    // the (bisected) sub-ranges / later facets, never the capped page.
    const collectedPaths = result.repos.map((r) => r.skillPath)
    expect(collectedPaths).not.toContain('skills/should-not-collect')
    // enumerateRepoSkillPaths is only reached via processSearchResults, so the
    // saturated repo was never enumerated.
    const enumeratedOwners = mockEnumerateRepoSkillPaths.mock.calls.map((c) => c[0])
    // The saturated repo is owner1 (first makeCodeSearchRepo call). It must NOT
    // appear among enumerated owners.
    expect(enumeratedOwners).not.toContain('owner1')
  })

  it('Case 3: budget + resume round-trip resumes losslessly across dispatches', async () => {
    // Non-saturating for the whole run: each facet exhausts in one range.
    mockSearchCode.mockImplementation(async (_pathPrefix: unknown, page: number) =>
      nonSaturatingPage(page)
    )

    // --- Dispatch 1: budget of 2 ranges. ---
    const seen = new Set<string>()
    const cache = new Map()
    const first = await runSubdirectorySearch(
      seen,
      cache,
      {},
      1,
      noTelemetry,
      makePlan({ maxRangesPerDispatch: 2 })
    )
    const firstBackfill = first.backfill!

    expect(firstBackfill.done).toBe(false)
    expect(firstBackfill.ranges_crawled).toBe(2)
    // Two non-saturating facets completed; cursor is partway through the ladder.
    expect(firstBackfill.facets_completed).toBe(2)
    expect(firstBackfill.cursor.facet_index).toBe(2)
    expect(firstBackfill.cursor.facet_index).toBeLessThan(LADDER_SIZE)
    expect(firstBackfill.cursor.facet).not.toBe('done')

    // --- Dispatch 2: resume from the returned cursor (fresh seenUrls; the cursor,
    // not the dedup set, carries crawl position — documenting the choice). ---
    const second = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ startCursor: firstBackfill.cursor, maxRangesPerDispatch: 2 })
    )
    const secondBackfill = second.backfill!

    // Resumed: strictly MORE facets done than dispatch 1 (no facets lost / redone).
    expect(secondBackfill.facets_completed).toBeGreaterThan(firstBackfill.facets_completed)
    expect(secondBackfill.facets_completed).toBe(4)
    expect(secondBackfill.cursor.facet_index).toBe(4)

    // --- Drain the rest in a loop until done; assert it reaches the full ladder. ---
    let cursor = secondBackfill.cursor
    let done = secondBackfill.done
    let lastCompleted = secondBackfill.facets_completed
    let guard = 0
    while (!done) {
      if (guard++ > 20) throw new Error('resume loop did not converge')
      const next = await runSubdirectorySearch(
        new Set<string>(),
        new Map(),
        {},
        1,
        noTelemetry,
        makePlan({ startCursor: cursor, maxRangesPerDispatch: 2 })
      )
      const nb = next.backfill!
      // Monotonic non-regression of completed facets across every dispatch.
      expect(nb.facets_completed).toBeGreaterThanOrEqual(lastCompleted)
      lastCompleted = nb.facets_completed
      cursor = nb.cursor
      done = nb.done
    }

    expect(lastCompleted).toBe(LADDER_SIZE)
    expect(cursor.facet).toBe('done')
  })

  it('Case 4: passes a size: qualifier as the 5th arg to the code-search call', async () => {
    mockSearchCode.mockImplementation(async (_pathPrefix: unknown, page: number) =>
      nonSaturatingPage(page)
    )

    await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ maxRangesPerDispatch: 3 })
    )

    expect(mockSearchCode).toHaveBeenCalled()
    // Every call carries a 5th arg that is a `size:` qualifier string.
    const sizeArgs = mockSearchCode.mock.calls.map((c) => c[4])
    expect(sizeArgs.length).toBeGreaterThan(0)
    for (const arg of sizeArgs) {
      expect(typeof arg).toBe('string')
      expect(arg as string).toMatch(/^size:/)
    }
    // The first facet (size:0..127) renders as `size:0..127`.
    expect(sizeArgs).toContain('size:0..127')
  })
})
