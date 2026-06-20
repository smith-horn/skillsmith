/**
 * SMI-5319 W4: min_size_bytes fresh-start facet skip tests
 *
 * Verifies that `minSizeBytes` in `BackfillFacetPlan` skips low-byte noise-band
 * facets on a FRESH START and is IGNORED on a RESUME (the cursor's own
 * `facet_index` takes precedence). The 9-facet ladder is unchanged -- min_size
 * only adjusts the initial `facetIndex` on the cold-start path.
 *
 * Mock strategy mirrors `backfill-facet-crawl.test.ts` exactly.
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

// Imported AFTER mocks so the SUT binds the stubs.
import { runSubdirectorySearch, type BackfillFacetPlan } from '../../indexer/subdirectory-search.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noTelemetry: RateLimitTelemetry = {} as RateLimitTelemetry

/** Static ladder length -- kept literal to assert against the SUT, not derive from it. */
const LADDER_SIZE = 9

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

  // SMI-5319: fetchRepoLicense now also returns `defaultBranch` (the code-search
  // API omits it) — a repo with a null `defaultBranch` is skipped, so a real
  // branch must be present for repos to emit.
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

describe('SMI-5319 W4: runSubdirectorySearch -- minSizeBytes fresh-start facet skip', () => {
  it('W4-A: fresh start with minSizeBytes=1024 starts at facet 4 (size:1024..2047), skipping facets 0-3', async () => {
    // Collect the size qualifiers passed to every code-search call.
    const observedQualifiers: string[] = []
    mockSearchCode.mockImplementation(
      async (
        _pathPrefix: unknown,
        page: number,
        _perPage: unknown,
        _tel: unknown,
        sizeQualifier: string
      ) => {
        observedQualifiers.push(sizeQualifier)
        return nonSaturatingPage(page)
      }
    )

    const result = await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      // minSizeBytes=1024 on a fresh start (startCursor=null) must skip facets 0-3.
      makePlan({ minSizeBytes: 1024, maxRangesPerDispatch: 100 })
    )

    const backfill = result.backfill!
    // Done: the crawl ran facets 4-8 and exhausted the full ladder.
    expect(backfill.done).toBe(true)
    // Only facets 4-8 were crawled (min_size skipped 0-3); facets_completed is a
    // ladder-position counter that reads LADDER_SIZE once the ladder is exhausted.
    expect(backfill.facets_completed).toBe(LADDER_SIZE)
    expect(backfill.cursor.facet_index).toBe(LADDER_SIZE)

    // The first code-search call must have used 'size:1024..2047' (facet 4).
    expect(observedQualifiers.length).toBeGreaterThan(0)
    expect(observedQualifiers[0]).toBe('size:1024..2047')

    // Facets 0-3 were never crawled: their qualifiers must be absent.
    const noiseBandQualifiers = ['size:0..127', 'size:128..255', 'size:256..511', 'size:512..1023']
    for (const q of noiseBandQualifiers) {
      expect(observedQualifiers).not.toContain(q)
    }
  })

  it('W4-B: fresh start with minSizeBytes=0 starts at facet 0 (size:0..127, no skip)', async () => {
    const observedQualifiers: string[] = []
    mockSearchCode.mockImplementation(
      async (
        _pathPrefix: unknown,
        page: number,
        _perPage: unknown,
        _tel: unknown,
        sizeQualifier: string
      ) => {
        observedQualifiers.push(sizeQualifier)
        return nonSaturatingPage(page)
      }
    )

    await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({ minSizeBytes: 0, maxRangesPerDispatch: 1 })
    )

    // First call must be the first facet (size:0..127) -- no skip applied.
    expect(observedQualifiers.length).toBeGreaterThan(0)
    expect(observedQualifiers[0]).toBe('size:0..127')
  })

  it('W4-C: a RESUME from a checkpoint cursor at facet_index=6 ignores minSizeBytes and resumes at facet 6', async () => {
    // Simulate: the crawl already completed facets 0-5 (facet_index=6 in cursor).
    // Even with minSizeBytes=1024 (which would normally skip to facet 4 on a fresh
    // start), the resume must honor the cursor's own facet_index=6.
    //
    // This is the load-bearing resume-invariant: cursorToFacetState() restores
    // facetIndex from the checkpoint cursor BEFORE the min_size code runs; the
    // min_size branch is guarded by `plan.startCursor == null` so it is NEVER
    // executed on a resume path.
    const observedQualifiers: string[] = []
    mockSearchCode.mockImplementation(
      async (
        _pathPrefix: unknown,
        page: number,
        _perPage: unknown,
        _tel: unknown,
        sizeQualifier: string
      ) => {
        observedQualifiers.push(sizeQualifier)
        return nonSaturatingPage(page)
      }
    )

    // Build a checkpoint cursor placing the crawl at facet_index=6.
    // facets[6] = { lo: 4096, hi: 8191 } -> qualifier 'size:4096..8191'.
    const resumeCursor = {
      path: '',
      facet: '4096-8191',
      last_page: 0,
      facet_index: 6,
      pending_subranges: [],
    }

    await runSubdirectorySearch(
      new Set<string>(),
      new Map(),
      {},
      1,
      noTelemetry,
      makePlan({
        startCursor: resumeCursor,
        minSizeBytes: 1024, // would skip to facet 4 on fresh start -- MUST be ignored here
        maxRangesPerDispatch: 1,
      })
    )

    // The first call must be at facet 6 (size:4096..8191), NOT at facet 4
    // (size:1024..2047). This proves the resume path ignores minSizeBytes.
    expect(observedQualifiers.length).toBeGreaterThan(0)
    expect(observedQualifiers[0]).toBe('size:4096..8191')

    // Facets below index 6 must not appear (they were already completed in the
    // prior dispatch that wrote the checkpoint cursor).
    expect(observedQualifiers).not.toContain('size:0..127')
    expect(observedQualifiers).not.toContain('size:1024..2047')
    expect(observedQualifiers).not.toContain('size:2048..4095')
  })
})
