/**
 * Per-dispatch skill cap tests (SMI-5319)
 *
 * Verifies the `maxSkillsPerDispatch` field added to `BackfillFacetPlan`:
 *   1. A crawl with a cap stops EARLY (before exhausting maxRangesPerDispatch),
 *      returns done=false, and produces a resumable cursor (range boundary).
 *   2. cap=0 (or unset) is a no-op -- the full ladder completes.
 *   3. Resuming from the capped cursor (with no cap) eventually reaches done=true.
 *
 * Mock strategy: identical to backfill-facet-crawl.test.ts -- module-level mocks
 * declared before the SUT import, all I/O boundaries stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'

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

// SUT imported AFTER mocks.
import { runSubdirectorySearch, type BackfillFacetPlan } from '../../indexer/subdirectory-search.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noTelemetry: RateLimitTelemetry = {} as RateLimitTelemetry
const LADDER_SIZE = 9

let repoCounter = 0
function makeCodeSearchRepo(overrides: Record<string, unknown> = {}) {
  repoCounter += 1
  const owner = `cap-owner${repoCounter}`
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

function nonSaturatingPage(page: number) {
  if (page === 1) {
    return { repos: [makeCodeSearchRepo()], total: 5, retries: 0, incomplete_results: false }
  }
  return { repos: [], total: 5, retries: 0, incomplete_results: false }
}

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

describe('runSubdirectorySearch -- maxSkillsPerDispatch skill cap (SMI-5319)', () => {
  it('stops early at a range boundary and returns done=false with a resumable cursor', async () => {
    // Each range yields 1 skill. With a cap of 2 the loop stops after 2 ranges.
    mockSearchCode.mockImplementation(async (_pathPrefix: unknown, page: number) =>
      nonSaturatingPage(page)
    )

    const result = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ maxRangesPerDispatch: 100, maxSkillsPerDispatch: 2 })
    )
    const backfill = result.backfill!
    // Crawl stopped early -- fewer than all 9 ranges.
    expect(backfill.ranges_crawled).toBeLessThan(LADDER_SIZE)
    // done must be false (more ranges remain after the cap).
    expect(backfill.done).toBe(false)
    // Cursor must be resumable (not 'done').
    expect(backfill.cursor.facet).not.toBe('done')
    // At least 2 skills admitted (cap was reached or slightly exceeded).
    expect(result.repos.length).toBeGreaterThanOrEqual(2)
  })

  it('cap=0 is a no-op -- the full 9-facet ladder completes', async () => {
    mockSearchCode.mockImplementation(async (_pathPrefix: unknown, page: number) =>
      nonSaturatingPage(page)
    )

    const result = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ maxRangesPerDispatch: 100, maxSkillsPerDispatch: 0 })
    )
    const backfill = result.backfill!
    expect(backfill.done).toBe(true)
    expect(backfill.facets_completed).toBe(LADDER_SIZE)
    expect(backfill.cursor.facet).toBe('done')
  })

  it('resuming from the capped cursor (without cap) eventually reaches done=true', async () => {
    mockSearchCode.mockImplementation(async (_pathPrefix: unknown, page: number) =>
      nonSaturatingPage(page)
    )

    // Dispatch 1: cap at 2 skills.
    const first = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ maxRangesPerDispatch: 100, maxSkillsPerDispatch: 2 })
    )
    expect(first.backfill!.done).toBe(false)

    // Drain to completion from the returned cursor with no cap.
    let cursor = first.backfill!.cursor
    let done = first.backfill!.done
    let guard = 0
    while (!done) {
      if (guard++ > 20) throw new Error('resume loop did not converge')
      const next = await runSubdirectorySearch(
        new Set<string>(),
        new Map(),
        {},
        1,
        noTelemetry,
        makePlan({ startCursor: cursor, maxRangesPerDispatch: 100 })
      )
      cursor = next.backfill!.cursor
      done = next.backfill!.done
    }
    expect(cursor.facet).toBe('done')
  })
})
