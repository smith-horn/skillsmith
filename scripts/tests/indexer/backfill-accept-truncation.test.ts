/**
 * SMI-5321: BACKFILL_ACCEPT_TRUNCATION floor tests
 *
 * Verifies the opt-in fetch-with-truncation behavior for a saturated,
 * unbisectable size-facet leaf (a single-byte finite range, or an open-ended
 * range past the bisection ceiling, where `bisectFacet` returns null):
 *
 *   - Flag ON  + saturated + unbisectable leaf → page-1 repos already in memory
 *     from saturation detection are admitted (NO second code-search fetch), leaf
 *     recorded truncated=true (NOT skipped).
 *   - Flag OFF (default) + same leaf → current skip behavior preserved
 *     (no fetch, recorded truncated, 0 repos collected from that leaf).
 *
 * Mock strategy mirrors `backfill-facet-crawl.test.ts` exactly: module-level
 * vi.mock for every I/O boundary, SUT imported after mocks are declared.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'

// ---------------------------------------------------------------------------
// Module-level mocks — declared before any import of the SUT
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

// Static import of the mocked `delay` — binds to the vi.fn() stub above
// (module-scope vi.mock runs before this import, so the mock is in place).
// Matches the pattern in backfill-facet-crawl.test.ts.
import { delay as mockedDelay } from '../../indexer/_shared/rate-limit.ts'

// Imported AFTER mocks so the SUT binds the stubs.
import { runSubdirectorySearch, type BackfillFacetPlan } from '../../indexer/subdirectory-search.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noTelemetry: RateLimitTelemetry = {} as RateLimitTelemetry

let repoCounter = 0
function makeCodeSearchRepo(skillPath = 'skills/x') {
  repoCounter += 1
  const owner = `owner${repoCounter}`
  return {
    owner,
    name: 'skills-repo',
    fullName: `${owner}/skills-repo`,
    description: 'test',
    url: `https://github.com/${owner}/skills-repo/tree/main/${skillPath}`,
    stars: 5,
    forks: 0,
    topics: ['claude-code-skill'],
    updatedAt: new Date().toISOString(),
    defaultBranch: 'main',
    installable: false,
    repoName: 'skills-repo',
    skillPath,
    discoveryPath: 'subdirectory_search:broad',
  }
}

/**
 * Build a plan whose FIRST facet (size:0..127) is a single-byte unbisectable
 * leaf. We achieve this by restricting maxRangesPerDispatch to 1 so only the
 * first top-level facet is visited per dispatch. That facet saturates on page 1
 * AND its bisect yields {0..63} and {64..127} (both finite, non-single-byte),
 * so we need to drive ALL the way down to single-byte ranges. Instead, the
 * simplest approach is: facet size:0..0 is a single-byte range (lo === hi) so
 * bisectFacet returns null immediately. We construct that via a startCursor
 * pointing at a pending subrange with lo===hi===0.
 *
 * More direct: the `facet0AlwaysSaturates` mock used in `backfill-facet-crawl.test.ts`
 * drives facet 0's bisection to exhaustion naturally. We replicate that setup
 * but with a budget of 1000 ranges to observe the truncated count, then add the
 * acceptTruncation variant.
 */

/**
 * A mock where facet 0 (size:0..127) AND every bisected finite descendant with
 * hi <= 127 ALWAYS saturates. All other facets (lo >= 128) are non-saturating.
 * Identical to the helper in backfill-facet-crawl.test.ts — copied here to
 * keep tests self-contained.
 */
function facet0AlwaysSaturatesImpl(reposOnSaturatedPage: ReturnType<typeof makeCodeSearchRepo>[]) {
  return async (
    _pathPrefix: unknown,
    page: number,
    _perPage: unknown,
    _telemetry: unknown,
    sizeQualifier: string
  ) => {
    const m = /^size:(\d+)\.\.(\d+)$/.exec(sizeQualifier)
    const withinFacet0 = m !== null && Number(m[2]) <= 127
    if (withinFacet0 && page === 1) {
      return {
        repos: reposOnSaturatedPage,
        total: 5000,
        retries: 0,
        incomplete_results: false,
      }
    }
    if (withinFacet0 && page > 1) {
      // Should never be reached when the crawl correctly bisects/truncates on
      // page 1; return empty as a defensive backstop.
      return { repos: [], total: 5000, retries: 0, incomplete_results: false }
    }
    // Non-facet-0 ranges: short non-saturating page.
    return { repos: [makeCodeSearchRepo()], total: 5, retries: 0, incomplete_results: false }
  }
}

/** Base plan that drives facet 0 to exhaustion (all sub-ranges bisected). */
function makePlan(overrides: Partial<BackfillFacetPlan> = {}): BackfillFacetPlan {
  return {
    startCursor: null,
    pathPrefix: undefined,
    perPage: 100,
    maxPagesPerRange: 20,
    maxRangesPerDispatch: 1000,
    ...overrides,
  }
}

beforeEach(() => {
  repoCounter = 0
  mockSearchCode.mockReset()
  mockFetchRepoLicense.mockReset()
  mockCheckSkillMdExists.mockReset()
  mockEnumerateRepoSkillPaths.mockReset()

  // Default I/O behaviour: permissive license + resolvable default branch.
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

// ---------------------------------------------------------------------------

describe('runSubdirectorySearch — SMI-5321 acceptTruncation floor', () => {
  it('flag OFF (default): saturated unbisectable leaf is skipped, no repos collected from it', async () => {
    // Repos that would appear on the saturated page — none should be collected
    // when acceptTruncation is false (the default skip path).
    const saturatedRepos = [
      makeCodeSearchRepo('skills/should-not-collect-1'),
      makeCodeSearchRepo('skills/should-not-collect-2'),
    ]
    mockSearchCode.mockImplementation(facet0AlwaysSaturatesImpl(saturatedRepos))

    const result = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ acceptTruncation: false })
    )

    const backfill = result.backfill!
    // Crawl terminates (facet 0 retires on truncation, rest of ladder completes).
    expect(backfill.done).toBe(true)
    // At least one range was recorded truncated.
    expect(backfill.truncated_repo_count).toBeGreaterThan(0)
    // None of the saturated repos were admitted.
    const collectedPaths = result.repos.map((r) => r.skillPath)
    expect(collectedPaths).not.toContain('skills/should-not-collect-1')
    expect(collectedPaths).not.toContain('skills/should-not-collect-2')
    // processSearchResults (and thus enumerateRepoSkillPaths) was never called
    // for those repos: the saturated page results were discarded.
    const enumeratedOwners = mockEnumerateRepoSkillPaths.mock.calls.map((c) => c[0])
    for (const repo of saturatedRepos) {
      expect(enumeratedOwners).not.toContain(repo.owner)
    }
  })

  it('flag OFF absent (undefined): same skip behavior as explicit false', async () => {
    const saturatedRepos = [makeCodeSearchRepo('skills/no-collect-absent')]
    mockSearchCode.mockImplementation(facet0AlwaysSaturatesImpl(saturatedRepos))

    // acceptTruncation omitted entirely (undefined) — default behavior.
    const result = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan() // no acceptTruncation key
    )

    expect(result.backfill!.done).toBe(true)
    expect(result.backfill!.truncated_repo_count).toBeGreaterThan(0)
    const paths = result.repos.map((r) => r.skillPath)
    expect(paths).not.toContain('skills/no-collect-absent')
  })

  it('flag ON: saturated unbisectable leaf is fetched (page 1), repos admitted, leaf still recorded truncated', async () => {
    // These repos appear on the saturated page-1 responses for every single-byte
    // sub-range of facet 0. With acceptTruncation=true they should be admitted.
    const saturatedRepos = [
      makeCodeSearchRepo('skills/floor-collect-1'),
      makeCodeSearchRepo('skills/floor-collect-2'),
    ]
    mockSearchCode.mockImplementation(facet0AlwaysSaturatesImpl(saturatedRepos))

    const result = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ acceptTruncation: true })
    )

    const backfill = result.backfill!
    // Crawl still terminates (truncation retires the leaf, rest completes).
    expect(backfill.done).toBe(true)
    // Leaf is still recorded truncated (observability preserved).
    expect(backfill.truncated_repo_count).toBeGreaterThan(0)
    // At least the floor-fetch repos were enumerated (processSearchResults ran).
    const enumeratedOwners = mockEnumerateRepoSkillPaths.mock.calls.map((c) => c[0])
    // At least one of the saturated repos' owners should appear in enumeration.
    const anyFloorEnumerated = saturatedRepos.some((r) => enumeratedOwners.includes(r.owner))
    expect(anyFloorEnumerated).toBe(true)
  })

  it('flag ON: floor reuses in-memory page-1 repos — mockSearchCode called exactly ONCE per saturated leaf (no second fetch)', async () => {
    // The saturation detection path fetches page 1 and breaks. The floor MUST
    // reuse those repos from memory; no second searchCodeForSkillMdInSubdirectory
    // call is issued for that leaf. We verify this by counting calls to
    // mockSearchCode per saturated sub-range: each single-byte leaf should
    // produce exactly one call (the detection fetch), never two.
    const saturatedRepos = [makeCodeSearchRepo('skills/floor-no-refetch')]
    mockSearchCode.mockImplementation(facet0AlwaysSaturatesImpl(saturatedRepos))

    // Capture which (sizeQualifier, page) pairs are requested.
    const calls: Array<{ qualifier: string; page: number }> = []
    const originalImpl = mockSearchCode.getMockImplementation()!
    mockSearchCode.mockImplementation(async (...args: Parameters<typeof originalImpl>) => {
      calls.push({ qualifier: args[4] as string, page: args[1] as number })
      return originalImpl(...args)
    })

    await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ acceptTruncation: true })
    )

    // For every saturated (facet-0, hi<=127) qualifier, there must be exactly
    // ONE call at page=1 — the saturation detection call. A second call with
    // the same qualifier at page=1 would indicate a redundant re-fetch.
    const facet0Calls = calls.filter((c) => {
      const m = /^size:(\d+)\.\.(\d+)$/.exec(c.qualifier)
      return m !== null && Number(m[2]) <= 127
    })
    const qualifierCounts = new Map<string, number>()
    for (const c of facet0Calls) {
      qualifierCounts.set(c.qualifier, (qualifierCounts.get(c.qualifier) ?? 0) + 1)
    }
    // Every facet-0 qualifier must appear exactly once (one detection fetch only).
    for (const [qualifier, count] of qualifierCounts) {
      expect(count, `qualifier ${qualifier} was fetched ${count} times, expected 1`).toBe(1)
    }
  })

  it('flag ON + saturated leaf with empty page-1 repos: crawl still advances cleanly, no errors', async () => {
    // Defensive path: saturatedPageRepos is captured as [] (empty repos list on
    // the saturated page). With acceptTruncation=true the crawl should still
    // advance and complete without errors, admitting zero repos from the leaf.
    mockSearchCode.mockImplementation(
      async (
        _pathPrefix: unknown,
        _page: unknown,
        _perPage: unknown,
        _telemetry: unknown,
        sizeQualifier: string
      ) => {
        const m = /^size:(\d+)\.\.(\d+)$/.exec(sizeQualifier)
        const withinFacet0 = m !== null && Number(m[2]) <= 127
        if (withinFacet0) {
          // Saturated with an empty repos list (unusual but possible if the API
          // returns results=0 despite total_count>1000 — a defensive scenario).
          return { repos: [], total: 5000, retries: 0, incomplete_results: false }
        }
        return { repos: [makeCodeSearchRepo()], total: 5, retries: 0, incomplete_results: false }
      }
    )

    const result = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ acceptTruncation: true })
    )

    const backfill = result.backfill!
    expect(backfill.done).toBe(true)
    expect(backfill.truncated_repo_count).toBeGreaterThan(0)
    // No errors surfaced (empty repos is valid, not an error).
    expect(result.errors).toHaveLength(0)
  })

  it('delay is called during the crawl (pacing active for multi-page non-saturated ranges)', async () => {
    // Verify the delay mock is wired correctly (not bypassed by the floor path).
    // We construct a mock where facet-0 saturates (as usual) but at least one
    // non-facet-0 range returns a FULL first page (length === perPage), triggering
    // the inter-page 6s delay before the second (short) page.
    const perPage = 3 // small to keep the test fast
    const saturatedRepos = [makeCodeSearchRepo('skills/floor-delay-check')]
    let nonFacet0PageCalls = 0
    mockSearchCode.mockImplementation(
      async (
        _pathPrefix: unknown,
        page: number,
        _perPage: unknown,
        _telemetry: unknown,
        sizeQualifier: string
      ) => {
        const m = /^size:(\d+)\.\.(\d+)$/.exec(sizeQualifier)
        const withinFacet0 = m !== null && Number(m[2]) <= 127
        if (withinFacet0 && page === 1) {
          return { repos: saturatedRepos, total: 5000, retries: 0, incomplete_results: false }
        }
        if (withinFacet0 && page > 1) {
          return { repos: [], total: 5000, retries: 0, incomplete_results: false }
        }
        // Non-facet-0: first call returns a full page (triggers delay); second short.
        nonFacet0PageCalls++
        if (nonFacet0PageCalls === 1) {
          return {
            repos: Array.from({ length: perPage }, () => makeCodeSearchRepo()),
            total: perPage + 1,
            retries: 0,
            incomplete_results: false,
          }
        }
        return {
          repos: [makeCodeSearchRepo()],
          total: perPage + 1,
          retries: 0,
          incomplete_results: false,
        }
      }
    )

    const delayCallsBefore = (mockedDelay as ReturnType<typeof vi.fn>).mock.calls.length

    await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ acceptTruncation: true, perPage })
    )

    // delay must have fired at least once (the inter-page gap after the full
    // first page of the first non-facet-0 range).
    const delayCallsAfter = (mockedDelay as ReturnType<typeof vi.fn>).mock.calls.length
    expect(delayCallsAfter).toBeGreaterThan(delayCallsBefore)
  })
})
