/**
 * License-as-metadata + Trees default-branch AC tests (SMI-5319)
 *
 * Split out of `subdirectory-search.perskill.test.ts` to keep both files under
 * the 500-line CI gate. Drives `runSubdirectorySearch` to prove the SMI-5319
 * behavior:
 *   1. The license ADMISSION gate is gone — ALL licenses
 *      (null/CC0/MIT/Apache-2.0/GPL-3.0) ADMIT with the surfaced SPDX.
 *   2. Repo metadata (license + default branch) resolution is once-per-repo
 *      (N-skill repo → ONE fetchRepoLicense), cached across pages of the same repo.
 *   3. `repoCacheKey` is the single shared key derivation (equality / round-trip).
 *   4. The SKILLSMITH_INDEXER_LICENSE_GATE kill-switch restores legacy exclusion.
 *
 * SMI-5319 (Trees default-branch fix): the code-search API does NOT return
 * default_branch, so the real branch is fetched alongside the license (one
 * `GET /repos` call) BEFORE enumeration. These tests also prove:
 *   5. A repo with a valid FETCHED branch EMITS skills — enumeration + skillUrl
 *      use the FETCHED branch, not the null `repo.defaultBranch`.
 *   6. A repo whose metadata resolves a null default branch is SKIPPED (not
 *      enumerated with a null branch, not a crash), and retried next run.
 *
 * Strategy: mock every I/O boundary (code-search, license-fetch, skill-processor,
 * trees-enumerate) at the module level; let buildSkillTreeUrl run real (pure).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
// repoCacheKey is a pure helper (no I/O) — imported real for the key-shape test.
import { repoCacheKey } from '../../indexer/subdirectory-search.helpers.ts'

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

  // Default: permissive license + resolvable default branch, validation passes.
  // SMI-5319: fetchRepoLicense now returns `defaultBranch` alongside the license
  // (the code-search API omits `default_branch`) — a repo whose `defaultBranch`
  // is null is SKIPPED (not enumerated with a null branch), so the default mock
  // must carry a real branch for repos to emit.
  mockFetchRepoLicense.mockResolvedValue({
    license: 'MIT',
    defaultBranch: 'main',
    fetchFailed: false,
  })
  mockCheckSkillMdExists.mockResolvedValue(true)
})

// ---------------------------------------------------------------------------

describe('runSubdirectorySearch — license-as-metadata + Trees default branch (SMI-5319)', () => {
  // SMI-5319 (Trees default-branch fix): a failed metadata fetch yields a null
  // default branch, so the repo CANNOT be enumerated (`GET /git/trees/null` would
  // 404). It is SKIPPED (not emitted with a null branch) and retried next run —
  // it is NOT a license-admission filter (`licenseFiltered` stays 0).
  it('skips a repo whose metadata fetch failed (null default branch) — not a crash, not emitted', async () => {
    mockSearchCode.mockResolvedValueOnce(makeSearchResult([makeCodeSearchRepo()]))
    mockSearchCode.mockResolvedValue(makeSearchResult([]))

    // A real-looking tree exists, but the metadata fetch failing means we never
    // reach enumeration (branch resolves to null first).
    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: [{ path: '.agents/skills/a', blobSha: 'sha-a' }],
      truncatedByCap: false,
      truncatedByApi: false,
    })
    mockFetchRepoLicense.mockResolvedValue({
      license: null,
      defaultBranch: null,
      fetchFailed: true,
    })

    const result = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry)

    // Skipped: no row emitted, no crash.
    expect(result.repos).toHaveLength(0)
    // A null branch with no skill is never an admission filter.
    expect(result.licenseFiltered).toBe(0)
    expect(result.licenseFetchFailed).toBe(1)
    expect(result.noDefaultBranch).toBe(1)
    // Enumeration is NOT reached without a resolvable branch.
    expect(mockEnumerateRepoSkillPaths).not.toHaveBeenCalled()
  })

  // SMI-5319 (Trees default-branch fix): a SUCCESSFUL metadata fetch that returns
  // a genuinely-absent default branch (e.g. a permissions-stripped response) also
  // skips the repo — null branch is unenumerable regardless of why.
  it('skips a repo whose metadata fetch succeeded but returned a null default branch', async () => {
    mockSearchCode.mockResolvedValueOnce(makeSearchResult([makeCodeSearchRepo()]))
    mockSearchCode.mockResolvedValue(makeSearchResult([]))

    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: [{ path: '.agents/skills/a', blobSha: 'sha-a' }],
      truncatedByCap: false,
      truncatedByApi: false,
    })
    // Fetch succeeded (not a failure) but no branch in the response.
    mockFetchRepoLicense.mockResolvedValue({
      license: 'MIT',
      defaultBranch: null,
      fetchFailed: false,
    })

    const result = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry)

    expect(result.repos).toHaveLength(0)
    expect(result.noDefaultBranch).toBe(1)
    // Not a fetch failure → licenseFetchFailed stays 0.
    expect(result.licenseFetchFailed).toBe(0)
    expect(mockEnumerateRepoSkillPaths).not.toHaveBeenCalled()
  })

  // SMI-5319 (Trees default-branch fix): the HEADLINE case. A repo with a valid
  // FETCHED default branch + tree entries now EMITS skills — enumeration is called
  // with the FETCHED branch (NOT `repo.defaultBranch`), and the emitted skillUrl
  // uses the fetched branch. This is the behavior the bug masked (every repo 404'd
  // on `GET /git/trees/null` because `repo.defaultBranch` was null from code search).
  it('emits skills using the FETCHED default branch, not repo.defaultBranch', async () => {
    // The code-search hit carries a null defaultBranch (matches production: the
    // /search/code API does not return default_branch).
    mockSearchCode.mockResolvedValueOnce(
      makeSearchResult([makeCodeSearchRepo({ defaultBranch: null })])
    )
    mockSearchCode.mockResolvedValue(makeSearchResult([]))

    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: [{ path: '.agents/skills/a', blobSha: 'sha-a' }],
      truncatedByCap: false,
      truncatedByApi: false,
    })
    // The metadata call resolves the REAL branch ('trunk', deliberately not 'main'
    // so the assertion can't accidentally pass off repo.defaultBranch).
    mockFetchRepoLicense.mockResolvedValue({
      license: 'MIT',
      defaultBranch: 'trunk',
      fetchFailed: false,
    })

    const result = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry)

    expect(result.repos).toHaveLength(1)
    expect(result.repos[0].installable).toBe(true)
    expect(result.noDefaultBranch).toBe(0)

    // enumerateRepoSkillPaths was called with the FETCHED branch ('trunk'), the
    // 3rd positional arg — NOT the null repo.defaultBranch.
    expect(mockEnumerateRepoSkillPaths).toHaveBeenCalledTimes(1)
    const enumerateBranchArg = mockEnumerateRepoSkillPaths.mock.calls[0][2]
    expect(enumerateBranchArg).toBe('trunk')

    // The emitted skillUrl uses the fetched branch ('trunk'), never 'null'.
    expect(result.repos[0].url).toBe(
      'https://github.com/acme/skills-repo/tree/trunk/.agents/skills/a'
    )
    expect(result.repos[0].url).not.toContain('/tree/null/')

    // checkSkillMdExists was also called with the fetched branch (3rd positional arg).
    const checkBranchArg = mockCheckSkillMdExists.mock.calls[0][2]
    expect(checkBranchArg).toBe('trunk')
  })

  // SMI-5319: INVERTED. A non-permissive license is no longer an admission filter
  // — the skill ADMITS and the SPDX is surfaced; licenseFiltered stays 0.
  it('admits a repo with a non-permissive license and surfaces its SPDX', async () => {
    mockSearchCode.mockResolvedValueOnce(makeSearchResult([makeCodeSearchRepo()]))
    mockSearchCode.mockResolvedValue(makeSearchResult([]))

    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: [{ path: '.agents/skills/a', blobSha: 'sha-a' }],
      truncatedByCap: false,
      truncatedByApi: false,
    })
    mockFetchRepoLicense.mockResolvedValue({
      license: 'GPL-3.0',
      defaultBranch: 'main',
      fetchFailed: false,
    })

    const result = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry)

    expect(result.repos).toHaveLength(1)
    expect(result.repos[0].license).toBe('GPL-3.0')
    expect(result.licenseFiltered).toBe(0)
    expect(mockEnumerateRepoSkillPaths).toHaveBeenCalledTimes(1)
  })

  // SMI-5319: every license value ADMITS with the correct surfaced SPDX.
  it.each([
    ['null (no detected license)', null],
    ['CC0-1.0 (public-domain dedication)', 'CC0-1.0'],
    ['MIT (permissive)', 'MIT'],
    ['Apache-2.0 (permissive)', 'Apache-2.0'],
    ['GPL-3.0 (copyleft)', 'GPL-3.0'],
  ])('admits and surfaces license for %s', async (_label, spdx) => {
    mockSearchCode.mockResolvedValueOnce(makeSearchResult([makeCodeSearchRepo()]))
    mockSearchCode.mockResolvedValue(makeSearchResult([]))

    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: [{ path: '.agents/skills/a', blobSha: 'sha-a' }],
      truncatedByCap: false,
      truncatedByApi: false,
    })
    mockFetchRepoLicense.mockResolvedValue({
      license: spdx,
      defaultBranch: 'main',
      fetchFailed: false,
    })

    const result = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry)

    expect(result.repos).toHaveLength(1)
    expect(result.repos[0].license).toBe(spdx)
    expect(result.licenseFiltered).toBe(0)
    // SMI-5319 retro: pin the two NEW observability counters (admit volume +
    // null-license rate) so a regression that stops/double-counts them can't
    // silently corrupt the dispatch-summary monitoring.
    expect(result.admitted).toBe(1)
    expect(result.licenseNull).toBe(spdx === null ? 1 : 0)
  })

  // SMI-5319: license resolution is ONCE-per-repo (after the validity gate).
  it('fetches the license exactly ONCE for an N-skill repo', async () => {
    mockSearchCode.mockResolvedValueOnce(makeSearchResult([makeCodeSearchRepo()]))
    mockSearchCode.mockResolvedValue(makeSearchResult([]))

    // One repo, three valid SKILL.md paths.
    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: [
        { path: '.agents/skills/a', blobSha: 'sha-a' },
        { path: '.agents/skills/b', blobSha: 'sha-b' },
        { path: '.agents/skills/c', blobSha: 'sha-c' },
      ],
      truncatedByCap: false,
      truncatedByApi: false,
    })
    mockFetchRepoLicense.mockResolvedValue({
      license: 'MIT',
      defaultBranch: 'main',
      fetchFailed: false,
    })

    const result = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry)

    // Three emitted skills, all sharing the one resolved license.
    expect(result.repos).toHaveLength(3)
    for (const r of result.repos) expect(r.license).toBe('MIT')
    // Exactly ONE license fetch for the whole repo.
    expect(mockFetchRepoLicense).toHaveBeenCalledTimes(1)
    // SMI-5319 retro: all three skills admit; none is null-license (MIT resolved once).
    expect(result.admitted).toBe(3)
    expect(result.licenseNull).toBe(0)
  })

  // SMI-5319: the repoMetaCache is reused across two code-search pages of the same
  // repo — still exactly ONE fetch total (write-key === read-key via repoCacheKey).
  it('reuses the cached license across two pages of the same repo (one fetch total)', async () => {
    const repo = makeCodeSearchRepo()

    mockSearchCode
      .mockResolvedValueOnce({ ...makeSearchResult([repo]), repos: [repo] })
      .mockResolvedValueOnce({ ...makeSearchResult([repo]), repos: [repo] })
      .mockResolvedValue(makeSearchResult([]))

    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: [{ path: '.agents/skills/a', blobSha: 'sha-a' }],
      truncatedByCap: false,
      truncatedByApi: false,
    })
    mockFetchRepoLicense.mockResolvedValue({
      license: 'Apache-2.0',
      defaultBranch: 'main',
      fetchFailed: false,
    })

    const result = await runSubdirectorySearch(new Set(), new Map(), {}, 3, noTelemetry)

    // The repo is enumerated once (once-guard) and the license fetched once.
    expect(mockEnumerateRepoSkillPaths).toHaveBeenCalledTimes(1)
    expect(mockFetchRepoLicense).toHaveBeenCalledTimes(1)
    expect(result.repos).toHaveLength(1)
    expect(result.repos[0].license).toBe('Apache-2.0')
  })

  // SMI-5319 (Pattern-3 invariant): repoCacheKey is the single key derivation, so
  // the once-guard write-key and the repoMetaCache read-key are provably identical.
  it('repoCacheKey is a stable, deterministic owner/repo derivation', () => {
    expect(repoCacheKey('acme', 'skills-repo')).toBe('acme/skills-repo')
    // Deterministic / idempotent.
    expect(repoCacheKey('acme', 'skills-repo')).toBe(repoCacheKey('acme', 'skills-repo'))
    // Distinct owners or repos do not collide.
    expect(repoCacheKey('acme', 'a')).not.toBe(repoCacheKey('acme', 'b'))
    expect(repoCacheKey('a', 'repo')).not.toBe(repoCacheKey('b', 'repo'))
  })

  // SMI-5319 kill-switch: SKILLSMITH_INDEXER_LICENSE_GATE=true restores the legacy
  // pre-validity exclusion (drop non-permissive, count as license-filtered).
  describe('SKILLSMITH_INDEXER_LICENSE_GATE kill-switch (legacy behavior)', () => {
    afterEach(() => {
      delete process.env.SKILLSMITH_INDEXER_LICENSE_GATE
    })

    it('restores legacy exclusion of non-permissive licenses when =true', async () => {
      process.env.SKILLSMITH_INDEXER_LICENSE_GATE = 'true'

      mockSearchCode.mockResolvedValueOnce(makeSearchResult([makeCodeSearchRepo()]))
      mockSearchCode.mockResolvedValue(makeSearchResult([]))
      mockFetchRepoLicense.mockResolvedValue({
        license: 'GPL-3.0',
        defaultBranch: 'main',
        fetchFailed: false,
      })

      const result = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry)

      // Legacy: dropped before the validity gate, counted as license-filtered.
      expect(result.repos).toHaveLength(0)
      expect(result.licenseFiltered).toBe(1)
      expect(mockEnumerateRepoSkillPaths).not.toHaveBeenCalled()
    })

    it('admits permissive licenses under the legacy gate', async () => {
      process.env.SKILLSMITH_INDEXER_LICENSE_GATE = 'true'

      mockSearchCode.mockResolvedValueOnce(makeSearchResult([makeCodeSearchRepo()]))
      mockSearchCode.mockResolvedValue(makeSearchResult([]))
      mockEnumerateRepoSkillPaths.mockResolvedValue({
        entries: [{ path: '.agents/skills/a', blobSha: 'sha-a' }],
        truncatedByCap: false,
        truncatedByApi: false,
      })
      mockFetchRepoLicense.mockResolvedValue({
        license: 'MIT',
        defaultBranch: 'main',
        fetchFailed: false,
      })

      const result = await runSubdirectorySearch(new Set(), new Map(), {}, 1, noTelemetry)

      expect(result.repos).toHaveLength(1)
      expect(result.repos[0].license).toBe('MIT')
      expect(result.licenseFiltered).toBe(0)
    })
  })
})
