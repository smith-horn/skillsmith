/**
 * SMI-5964 §1e: no-progress escalation termination bound.
 *
 * Split out of `subdirectory-search.helpers.test.ts` (Cases 10, 15-17) when
 * that file grew past the 500-line convention. Shares the same mock/fake-timer
 * strategy documented there and in `scripts/tests/_lib/subdirectory-search-fixtures.ts`.
 *
 * Proves the termination bound at all three stop sites the escalation covers
 * (the `acceptTruncation` leaf's cap-suppression limb, its forced-progress
 * limb, and the §1b page-loop twin), plus counter-hygiene edge cases (a
 * legacy resume cursor with the field absent, cross-position immunity per the
 * still-open SMI-5333 unfiltered-read gap, and a net-progress reset). Every
 * multi-dispatch case self-checks that all dispatches share byte-identical
 * plan knobs except `startCursor` -- round-2 plan review found the original
 * Case 10 masked the livelock defect by quietly widening a later dispatch's
 * budget; these tests cannot pass that way.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'
import type { BackfillFacetPlan } from '../../indexer/subdirectory-search.ts'
import type { BackfillCursor } from '../../indexer/backfill-checkpoint.ts'
import {
  PER_PAGE,
  resetRepoCounter,
  makeCodeSearchRepo,
  shortPage,
  saturatedPage,
  makePlan,
  omitStartCursor,
  leafCursor,
  pageCursor,
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
// SMI-5964: NO_PROGRESS_ESCALATION_THRESHOLD is not re-exported through
// subdirectory-search.ts's re-export chain -- imported directly.
import { NO_PROGRESS_ESCALATION_THRESHOLD } from '../../indexer/subdirectory-search.helpers.ts'

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

describe('runSubdirectorySearch -- SMI-5964 no-progress escalation termination bound (§1e)', () => {
  it('NO_PROGRESS_ESCALATION_THRESHOLD is 2 -- the smallest value that never escalates a recoverable single-dispatch stall while still bounding the termination cost at N+1=3 dispatches per position', () => {
    expect(NO_PROGRESS_ESCALATION_THRESHOLD).toBe(2)
  })

  it('Case 10: same-cap acceptTruncation livelock terminates by escalation at dispatch N+1 (cap-suppression limb)', async () => {
    const sharedPlan: Omit<BackfillFacetPlan, 'startCursor'> = {
      pathPrefix: undefined,
      perPage: PER_PAGE,
      maxPagesPerRange: 20,
      maxRangesPerDispatch: 100,
      maxSkillsPerDispatch: 5,
      maxElapsedMs: 0,
      acceptTruncation: true,
    }

    // Every page-1 query for the leaf ('size:5..5') saturates with MORE admits
    // (10 repos, 1 skill each) than the shared cap (5). Any OTHER qualifier
    // (reached only once the leaf retires) gets a normal, non-saturated
    // short page.
    mockSearchCode.mockImplementation(
      async (
        _prefix: unknown,
        _page: unknown,
        _perPage: unknown,
        _telemetry: unknown,
        qualifier: unknown
      ) => (qualifier === 'size:5..5' ? saturatedPage(10) : shortPage())
    )

    const warnSpy = vi.spyOn(console, 'warn')

    const plan1: BackfillFacetPlan = { ...sharedPlan, startCursor: leafCursor() }
    const d1 = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry, plan1)
    const b1 = d1.backfill!

    const plan2: BackfillFacetPlan = { ...sharedPlan, startCursor: b1.cursor }
    const d2 = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry, plan2)
    const b2 = d2.backfill!

    const plan3: BackfillFacetPlan = { ...sharedPlan, startCursor: b2.cursor }
    const d3 = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry, plan3)
    const b3 = d3.backfill!

    const plan4: BackfillFacetPlan = { ...sharedPlan, startCursor: b3.cursor }
    const d4 = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry, plan4)
    const b4 = d4.backfill!

    // (a) Self-check: every knob except startCursor is byte-identical across
    // all four dispatches -- the test cannot pass by quietly widening a later
    // dispatch's budget.
    expect(omitStartCursor(plan2)).toEqual(omitStartCursor(plan1))
    expect(omitStartCursor(plan3)).toEqual(omitStartCursor(plan1))
    expect(omitStartCursor(plan4)).toEqual(omitStartCursor(plan1))

    // (b) D1 stops in the leaf, holding the cursor.
    expect(b1.cursor.facet_index).toBe(0)
    expect(b1.cursor.pending_subranges).toEqual([[5, 5]])
    expect(b1.cursor.last_page).toBe(0)
    expect(b1.cursor.no_progress_stalls).toBe(1)

    // (c) D2, the SAME shared cap: still does NOT advance -- the livelock is
    // real, so this fails loudly if the escalation is ever removed.
    expect(b2.cursor.pending_subranges).toEqual([[5, 5]])
    expect(b2.cursor.no_progress_stalls).toBe(2)

    // (d) D3: escalation fires on the CAP-SUPPRESSION limb -- the cap is
    // provably suppressed (admits exceed it), the leaf retires (cursor
    // strictly past it), and the counter resets to 0.
    expect(d3.admitted).toBeGreaterThan(sharedPlan.maxSkillsPerDispatch!)
    expect(b3.cursor.pending_subranges).not.toEqual([[5, 5]])
    expect(b3.cursor.facet).not.toBe('5-5')
    expect(b3.cursor.no_progress_stalls).toBe(0)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/ESCALATED past no-progress position/)
    )

    // (e) D4 (from D3's cursor) does NOT re-enter the retired leaf.
    expect(b4.cursor.facet).not.toBe('5-5')
    expect(b4.cursor.pending_subranges).not.toEqual([[5, 5]])

    warnSpy.mockRestore()
  })

  it('Case 15: deadline-caused acceptTruncation livelock terminates by FORCED-PROGRESS escalation (not cap suppression)', async () => {
    const sharedPlan: Omit<BackfillFacetPlan, 'startCursor'> = {
      pathPrefix: undefined,
      perPage: PER_PAGE,
      maxPagesPerRange: 20,
      maxRangesPerDispatch: 100,
      maxSkillsPerDispatch: 0, // disabled -- ONLY the deadline governs
      maxElapsedMs: 100,
      acceptTruncation: true,
    }

    mockSearchCode.mockImplementation(
      async (
        _prefix: unknown,
        _page: unknown,
        _perPage: unknown,
        _telemetry: unknown,
        qualifier: unknown
      ) => (qualifier === 'size:5..5' ? saturatedPage(3) : shortPage())
    )
    // Every checkSkillMdExists call advances the clock well past the 100ms
    // budget -- so admitting even ONE skill always crosses the deadline
    // before the NEXT repo's top-of-loop check, on EVERY dispatch (cap
    // suppression cannot rescue this one -- there never was a cap).
    mockCheckSkillMdExists.mockImplementation(async () => {
      vi.advanceTimersByTime(1000)
      return true
    })

    const warnSpy = vi.spyOn(console, 'warn')

    const plan1: BackfillFacetPlan = { ...sharedPlan, startCursor: leafCursor() }
    const d1 = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry, plan1)
    const b1 = d1.backfill!

    const plan2: BackfillFacetPlan = { ...sharedPlan, startCursor: b1.cursor }
    const d2 = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry, plan2)
    const b2 = d2.backfill!

    const plan3: BackfillFacetPlan = { ...sharedPlan, startCursor: b2.cursor }
    const d3 = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry, plan3)
    const b3 = d3.backfill!

    expect(omitStartCursor(plan2)).toEqual(omitStartCursor(plan1))
    expect(omitStartCursor(plan3)).toEqual(omitStartCursor(plan1))

    // D1/D2 hold the leaf -- the deadline stops every attempt.
    expect(b1.cursor.pending_subranges).toEqual([[5, 5]])
    expect(b1.cursor.no_progress_stalls).toBe(1)
    expect(b2.cursor.pending_subranges).toEqual([[5, 5]])
    expect(b2.cursor.no_progress_stalls).toBe(2)

    // D3 escalates on the FORCED-PROGRESS limb: cap suppression is irrelevant
    // here (there was never a cap) -- the deadline STILL trips, so the leaf is
    // forced forward instead, recorded truncated, and the counter resets to 0.
    expect(b3.cursor.pending_subranges).not.toEqual([[5, 5]])
    expect(b3.cursor.no_progress_stalls).toBe(0)
    expect(b3.truncated_repo_count).toBeGreaterThanOrEqual(1)
    expect(d3.errors.some((e) => /escalated past a no-progress/.test(e))).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/ESCALATED past no-progress position/)
    )

    warnSpy.mockRestore()
  })

  it('Case 16: §1b page-loop twin -- same-cap livelock off the truncation path terminates by FORCED-PROGRESS escalation', async () => {
    const sharedPlan: Omit<BackfillFacetPlan, 'startCursor'> = {
      pathPrefix: undefined,
      perPage: PER_PAGE,
      maxPagesPerRange: 20,
      maxRangesPerDispatch: 100,
      maxSkillsPerDispatch: 5,
      maxElapsedMs: 100,
      acceptTruncation: false,
    }
    const P = 2 // resuming at page 2 (startCursor.last_page = 1 = P-1)

    // A normal (non-saturated) page carrying MORE admits (8) than the shared
    // cap (5) -- the same livelock shape as Case 10, one call site over.
    mockSearchCode.mockImplementation(async () => ({
      repos: Array.from({ length: 8 }, () => makeCodeSearchRepo()),
      total: 500,
      retries: 0,
      incomplete_results: false,
    }))

    const warnSpy = vi.spyOn(console, 'warn')

    const plan1: BackfillFacetPlan = { ...sharedPlan, startCursor: pageCursor(P - 1) }
    const d1 = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry, plan1)
    const b1 = d1.backfill!

    const plan2: BackfillFacetPlan = { ...sharedPlan, startCursor: b1.cursor }
    const d2 = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry, plan2)
    const b2 = d2.backfill!

    // D3's escalated (cap-suppressed) attempt STILL stops -- this time on the
    // deadline -- exercising the ONE guarded `state.lastPage = page`
    // assignment §1b's "forbidden variant" clause permits.
    mockCheckSkillMdExists.mockImplementation(async () => {
      vi.advanceTimersByTime(1000)
      return true
    })
    const plan3: BackfillFacetPlan = { ...sharedPlan, startCursor: b2.cursor }
    const d3 = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry, plan3)
    const b3 = d3.backfill!

    expect(omitStartCursor(plan2)).toEqual(omitStartCursor(plan1))
    expect(omitStartCursor(plan3)).toEqual(omitStartCursor(plan1))

    // D1/D2 hold at page P-1 -- state.lastPage is NEVER touched by these two
    // dispatches (the "forbidden variant" stays unreachable by default).
    expect(b1.cursor.last_page).toBe(P - 1)
    expect(b1.cursor.no_progress_stalls).toBe(1)
    expect(b2.cursor.last_page).toBe(P - 1)
    expect(b2.cursor.no_progress_stalls).toBe(2)

    // D3: state.lastPage moves to P via the ONE guarded, escalation-only
    // assignment; the counter resets to 0.
    expect(b3.cursor.last_page).toBe(P)
    expect(b3.cursor.no_progress_stalls).toBe(0)
    expect(b3.truncated_repo_count).toBeGreaterThanOrEqual(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/ESCALATED past no-progress position/)
    )

    warnSpy.mockRestore()
  })

  it('Case 17a: a legacy resume cursor (no_progress_stalls absent) reads as 0 -- never escalates early, never throws', async () => {
    mockSearchCode.mockImplementation(async () => saturatedPage(10))
    const legacyCursor: BackfillCursor = {
      path: '',
      facet: '5-5',
      last_page: 0,
      facet_index: 0,
      pending_subranges: [[5, 5]],
      // no_progress_stalls intentionally OMITTED -- simulates a pre-SMI-5964 row.
    }

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
        startCursor: legacyCursor,
      })
    )
    const backfill = result.backfill!

    // Reads as 0 -- holds the leaf exactly like a fresh first attempt (no
    // throw on the missing field, no premature escalation).
    expect(backfill.cursor.pending_subranges).toEqual([[5, 5]])
    expect(backfill.cursor.no_progress_stalls).toBe(1)
  })

  it('Case 17b: an inherited no_progress_stalls at a DIFFERENT position (SMI-5333 cross-path immunity) is not inherited', async () => {
    mockSearchCode.mockImplementation(async () => saturatedPage(10))
    // The incoming cursor claims 2 prior stalls, but under a DIFFERENT `path`
    // -- e.g. a checkpoint written under a different BACKFILL_PATH_PREFIX,
    // reachable via the still-open SMI-5333 unfiltered-read gap.
    const foreignPathCursor: BackfillCursor = {
      path: '.some-other-prefix/skills',
      facet: '5-5',
      last_page: 0,
      facet_index: 0,
      pending_subranges: [[5, 5]],
      no_progress_stalls: 2,
    }

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
        pathPrefix: undefined, // crawling the BROAD query (path '') this time
        startCursor: foreignPathCursor,
      })
    )
    const backfill = result.backfill!

    // Treated as a first attempt AT THIS position (path '' !== the foreign
    // cursor's path) -- holds rather than escalating.
    expect(backfill.cursor.no_progress_stalls).toBe(1)
  })

  it('Case 17c: a dispatch that makes net progress writes no_progress_stalls=0', async () => {
    mockSearchCode.mockImplementation(async () => shortPage())
    const result = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ maxRangesPerDispatch: 3 })
    )
    expect(result.backfill!.cursor.no_progress_stalls).toBe(0)
  })
})
