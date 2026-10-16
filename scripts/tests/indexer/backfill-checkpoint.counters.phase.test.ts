/**
 * SMI-7121 Wave 1 (pre-merge gate PR-16): Phase 3b's real wrapper feeds the checkpoint
 * @module scripts/tests/indexer/backfill-checkpoint.counters.phase
 *
 * Drives the real `runSubdirectorySearchPhase` (network layer mocked, same shape as
 * backfill-facet-crawl.test.ts) and asserts the counters that reach
 * `buildCheckpointPayload` match the fixture, so a change anywhere between the crawl
 * and the checkpoint (the mapping, or a later write to `result.subdirectory_search`)
 * fails here rather than shipping a wrong halt input.
 *
 * Fixture, chosen so every expected value follows from it by hand and all four are
 * pairwise distinct and non-zero (so a swapped or mis-sourced mapping fails, including
 * one sourced from the always-0 license_fetch_failed / license_null). The legacy license
 * gate is switched on for this test so license_filtered can be non-zero. The first range
 * returns one short page of six repos, each with one skill; every later range returns an
 * empty short page. Budget: 4 ranges.
 *   - owner1, owner3, owner4: MIT, branch main      -> admitted 3
 *   - owner2, owner5: MIT, no resolvable branch     -> no_default_branch 2
 *   - owner6: GPL-3.0 (gate on)                     -> license_filtered 1
 *   - 4 ranges, each exhausted by one short page    -> ranges_crawled 4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'

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
import {
  runSubdirectorySearchPhase,
  type BackfillFacetPlan,
} from '../../indexer/subdirectory-search.ts'
import { buildCheckpointPayload } from '../../indexer/backfill-checkpoint.counters.ts'
import type { IndexerResult } from '../../indexer/indexer-types.ts'
import type { BackfillDispatchInputs } from '../../indexer/backfill-dispatch-inputs.ts'

function repo(owner: string) {
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
  }
}

const plan: BackfillFacetPlan = {
  startCursor: null,
  pathPrefix: undefined,
  perPage: 100,
  maxPagesPerRange: 20,
  maxRangesPerDispatch: 4,
}

let savedGate: string | undefined

afterEach(() => {
  if (savedGate === undefined) delete process.env.SKILLSMITH_INDEXER_LICENSE_GATE
  else process.env.SKILLSMITH_INDEXER_LICENSE_GATE = savedGate
})

beforeEach(() => {
  mockSearchCode.mockReset()
  mockFetchRepoLicense.mockReset()
  mockCheckSkillMdExists.mockReset()
  mockEnumerateRepoSkillPaths.mockReset()

  savedGate = process.env.SKILLSMITH_INDEXER_LICENSE_GATE
  process.env.SKILLSMITH_INDEXER_LICENSE_GATE = 'true'

  // The first search call (range 1, page 1) returns six repos in one short page; every
  // later call is an empty short page, so each later range is exhausted after one page.
  let calls = 0
  mockSearchCode.mockImplementation(async () => {
    calls += 1
    const repos =
      calls === 1 ? ['owner1', 'owner2', 'owner3', 'owner4', 'owner5', 'owner6'].map(repo) : []
    return { repos, total: repos.length, retries: 0, incomplete_results: false }
  })
  mockFetchRepoLicense.mockImplementation(async (owner: string) => ({
    license: owner === 'owner6' ? 'GPL-3.0' : 'MIT',
    defaultBranch: owner === 'owner2' || owner === 'owner5' ? null : 'main',
    fetchFailed: false,
  }))
  mockCheckSkillMdExists.mockResolvedValue(true)
  mockEnumerateRepoSkillPaths.mockResolvedValue({
    entries: [{ path: 'skills/x', blobSha: 'sha1' }],
    truncatedByCap: false,
    truncatedByApi: false,
  })
})

describe('runSubdirectorySearchPhase -> buildCheckpointPayload', () => {
  it('carries this dispatch’s real counters into the checkpoint payload', async () => {
    const result = { errors: [] } as unknown as IndexerResult
    await runSubdirectorySearchPhase({
      seenUrls: new Set<string>(),
      validationCache: new Map(),
      validationOptions: {},
      codeSearchMaxPages: 1,
      telemetry: {} as RateLimitTelemetry,
      repositories: [],
      result,
      backfillFacetPlan: plan,
    })

    expect(result.backfill_crawl).toBeDefined()
    const payload = buildCheckpointPayload({
      runId: 'run-phase',
      crawl: result.backfill_crawl!,
      subdirectorySearch: result.subdirectory_search,
      dryRun: false,
      dispatchInputs: {} as BackfillDispatchInputs,
      loaded: null,
    })
    expect(payload.dispatch_counters).toEqual({
      admitted: 3,
      no_default_branch: 2,
      license_filtered: 1,
      ranges_crawled: 4,
    })
  })
})
