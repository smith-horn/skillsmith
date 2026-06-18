/**
 * Per-skill extraction headline AC tests (SMI-5286 Wave 1a §#1, C-1)
 *
 * Drives `runSubdirectorySearch` to prove:
 *   1. One repo with THREE valid SKILL.md files yields THREE distinct repo.url rows.
 *   2. Each row carries the correct skillPath, treeHash, and installable===true.
 *   3. A denylisted-ancestor path (e.g. examples/x) is excluded from the emitted rows.
 *   4. A repo surfaced twice across code-search pages is enumerated only once
 *      (no duplicate rows from re-enumeration).
 *
 * Strategy: mock every I/O boundary (code-search, license-fetch, skill-processor,
 * trees-enumerate) at the module level; let buildSkillTreeUrl run real (pure).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'

// ---------------------------------------------------------------------------
// Module-level mocks — declared before any import of the SUT
// ---------------------------------------------------------------------------

// Mock delay so tests don't actually wait.
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
import { runSubdirectorySearch } from '../../indexer/subdirectory-search.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noTelemetry: RateLimitTelemetry = {} as RateLimitTelemetry

/**
 * Build a minimal GitHubRepository-shaped code-search result for a single repo.
 * The `url` here is the BARE repo html_url (code-search mapper may transform it;
 * subdirectory-search calls buildSkillTreeUrl internally using this as root).
 */
function makeCodeSearchRepo(overrides: Record<string, unknown> = {}) {
  return {
    owner: 'acme',
    name: 'skills-repo',
    fullName: 'acme/skills-repo',
    description: 'test',
    // Reflects production: searchCodeForSkillMdInSubdirectory already emits a
    // per-skill tree URL here, so the consumer must rebuild from the bare
    // html_url (owner/repoName), not re-wrap this value (governance #1).
    url: 'https://github.com/acme/skills-repo/tree/main/.agents/skills/a',
    stars: 5,
    forks: 0,
    topics: ['claude-code-skill'],
    updatedAt: new Date().toISOString(),
    defaultBranch: 'main',
    installable: false,
    repoName: 'skills-repo',
    skillPath: '.agents/skills/a',
    discoveryPath: 'subdirectory_search:broad',
    ...overrides,
  }
}

/** Make a one-page code-search result that returns without errors. */
function makeSearchResult(repos: ReturnType<typeof makeCodeSearchRepo>[]) {
  return {
    repos,
    total: repos.length,
    retries: 0,
    incomplete_results: false,
  }
}

beforeEach(() => {
  mockSearchCode.mockReset()
  mockFetchRepoLicense.mockReset()
  mockCheckSkillMdExists.mockReset()
  mockEnumerateRepoSkillPaths.mockReset()

  // Default: permissive license, validation always passes
  mockFetchRepoLicense.mockResolvedValue({ license: 'MIT', fetchFailed: false })
  mockCheckSkillMdExists.mockResolvedValue(true)
})

// ---------------------------------------------------------------------------
// Headline AC: THREE distinct repo.url rows for ONE repo with THREE skills
// ---------------------------------------------------------------------------

describe('runSubdirectorySearch — per-skill extraction (SMI-5286 Wave 1a §#1)', () => {
  it('emits THREE distinct url rows for one repo with three valid SKILL.md entries', async () => {
    // Code-search returns ONE repo hit (the broad page).
    mockSearchCode.mockResolvedValueOnce(makeSearchResult([makeCodeSearchRepo()]))
    // Second call (would paginate) returns empty → stops.
    mockSearchCode.mockResolvedValue(makeSearchResult([]))

    // Trees enumeration returns three paths for this repo.
    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: [
        { path: '.agents/skills/a', blobSha: 'sha-a' },
        { path: '.agents/skills/b', blobSha: 'sha-b' },
        { path: '.agents/skills/c', blobSha: 'sha-c' },
      ],
      truncatedByCap: false,
      truncatedByApi: false,
    })

    const seenUrls = new Set<string>()
    const validationCache = new Map()

    const result = await runSubdirectorySearch(seenUrls, validationCache, {}, 1, noTelemetry)

    // Three distinct repo rows
    expect(result.repos).toHaveLength(3)

    const urls = result.repos.map((r) => r.url)
    // All three URLs must be distinct
    expect(new Set(urls).size).toBe(3)

    // Each URL must be a per-skill tree URL (not the bare html_url)
    for (const url of urls) {
      expect(url).toMatch(/\/tree\/main\//)
    }

    // Verify specific per-skill URLs
    expect(urls).toContain('https://github.com/acme/skills-repo/tree/main/.agents/skills/a')
    expect(urls).toContain('https://github.com/acme/skills-repo/tree/main/.agents/skills/b')
    expect(urls).toContain('https://github.com/acme/skills-repo/tree/main/.agents/skills/c')

    // Regression (governance #1): the consumer rebuilds from the bare html_url,
    // so even though the input repo.url is already a tree URL, the emitted URLs
    // must NOT contain a doubled `/tree/<branch>` segment.
    for (const url of urls) {
      expect(url).not.toMatch(/\/tree\/[^/]+\/.*\/tree\//)
    }
  })

  it('each emitted row has the correct skillPath, treeHash, and installable===true', async () => {
    mockSearchCode.mockResolvedValueOnce(makeSearchResult([makeCodeSearchRepo()]))
    mockSearchCode.mockResolvedValue(makeSearchResult([]))

    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: [
        { path: '.agents/skills/a', blobSha: 'sha-a' },
        { path: '.agents/skills/b', blobSha: 'sha-b' },
        { path: '.agents/skills/c', blobSha: 'sha-c' },
      ],
      truncatedByCap: false,
      truncatedByApi: false,
    })

    const result = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry)

    expect(result.repos).toHaveLength(3)

    const byPath = Object.fromEntries(result.repos.map((r) => [r.skillPath, r]))

    expect(byPath['.agents/skills/a'].treeHash).toBe('sha-a')
    expect(byPath['.agents/skills/a'].installable).toBe(true)

    expect(byPath['.agents/skills/b'].treeHash).toBe('sha-b')
    expect(byPath['.agents/skills/b'].installable).toBe(true)

    expect(byPath['.agents/skills/c'].treeHash).toBe('sha-c')
    expect(byPath['.agents/skills/c'].installable).toBe(true)
  })

  it('excludes the denylisted-ancestor path from the emitted rows', async () => {
    // Repo has 3 paths; enumerateRepoSkillPaths already applies the denylist,
    // but subdirectory-search must consume whatever enumerateRepoSkillPaths returns.
    // Here we simulate that enumerateRepoSkillPaths correctly filtered down to 2.
    mockSearchCode.mockResolvedValueOnce(makeSearchResult([makeCodeSearchRepo()]))
    mockSearchCode.mockResolvedValue(makeSearchResult([]))

    // enumerateRepoSkillPaths returns only the non-denylisted paths
    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: [
        { path: '.agents/skills/a', blobSha: 'sha-a' },
        { path: '.agents/skills/b', blobSha: 'sha-b' },
        // examples/x was filtered by enumerateRepoSkillPaths (denylist)
      ],
      truncatedByCap: false,
      truncatedByApi: false,
    })

    const result = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry)

    expect(result.repos).toHaveLength(2)

    const skillPaths = result.repos.map((r) => r.skillPath)
    expect(skillPaths).not.toContain('examples/x')
    expect(skillPaths).toContain('.agents/skills/a')
    expect(skillPaths).toContain('.agents/skills/b')
  })

  it('enumerates a repo only ONCE even when it appears across multiple code-search pages', async () => {
    const repo = makeCodeSearchRepo()

    // Page 1 and page 2 both surface the same repo (simulating multi-page hit)
    mockSearchCode
      .mockResolvedValueOnce({ ...makeSearchResult([repo]), repos: [repo] })
      .mockResolvedValueOnce({ ...makeSearchResult([repo]), repos: [repo] })
      .mockResolvedValue(makeSearchResult([]))

    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: [
        { path: '.agents/skills/a', blobSha: 'sha-a' },
        { path: '.agents/skills/b', blobSha: 'sha-b' },
      ],
      truncatedByCap: false,
      truncatedByApi: false,
    })

    const result = await runSubdirectorySearch(
      new Set(),
      new Map(),
      {},
      3, // allow up to 3 pages
      noTelemetry
    )

    // enumerateRepoSkillPaths called only once (second page hit is deduped)
    expect(mockEnumerateRepoSkillPaths).toHaveBeenCalledTimes(1)
    // Rows are emitted only once
    expect(result.repos).toHaveLength(2)
  })

  it('emits NO rows when enumerateRepoSkillPaths signals API truncation', async () => {
    mockSearchCode.mockResolvedValueOnce(makeSearchResult([makeCodeSearchRepo()]))
    mockSearchCode.mockResolvedValue(makeSearchResult([]))

    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: [],
      truncatedByCap: false,
      truncatedByApi: true, // policy (b): emit nothing
    })

    const result = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry)

    expect(result.repos).toHaveLength(0)
  })

  it('marks a skill as installable=false when checkSkillMdExists returns false', async () => {
    mockSearchCode.mockResolvedValueOnce(makeSearchResult([makeCodeSearchRepo()]))
    mockSearchCode.mockResolvedValue(makeSearchResult([]))

    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: [{ path: '.agents/skills/broken', blobSha: 'sha-x' }],
      truncatedByCap: false,
      truncatedByApi: false,
    })

    // Validation fails for this skill
    mockCheckSkillMdExists.mockResolvedValue(false)

    const result = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry)

    expect(result.repos).toHaveLength(1)
    expect(result.repos[0].installable).toBe(false)
  })

  it('skips a repo whose license fetch failed (not counted as license-filtered)', async () => {
    mockSearchCode.mockResolvedValueOnce(makeSearchResult([makeCodeSearchRepo()]))
    mockSearchCode.mockResolvedValue(makeSearchResult([]))

    mockFetchRepoLicense.mockResolvedValue({ license: null, fetchFailed: true })

    const result = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry)

    expect(result.repos).toHaveLength(0)
    expect(result.licenseFiltered).toBe(0)
    expect(result.licenseFetchFailed).toBe(1)
    // Trees enumeration must NOT have been called for this repo
    expect(mockEnumerateRepoSkillPaths).not.toHaveBeenCalled()
  })

  it('excludes repos with a non-permissive license and increments licenseFiltered', async () => {
    mockSearchCode.mockResolvedValueOnce(makeSearchResult([makeCodeSearchRepo()]))
    mockSearchCode.mockResolvedValue(makeSearchResult([]))

    mockFetchRepoLicense.mockResolvedValue({ license: 'GPL-3.0', fetchFailed: false })

    const result = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry)

    expect(result.repos).toHaveLength(0)
    expect(result.licenseFiltered).toBe(1)
    expect(mockEnumerateRepoSkillPaths).not.toHaveBeenCalled()
  })
})
