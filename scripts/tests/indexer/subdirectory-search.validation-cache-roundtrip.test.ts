/**
 * SMI-5930: validationCache round-trip regression test.
 * @module scripts/tests/indexer/subdirectory-search.validation-cache-roundtrip
 *
 * `subdirectory-search.perskill.test.ts` and `.license-branch.test.ts` both mock
 * `checkSkillMdExists` entirely (`mockCheckSkillMdExists.mockResolvedValue(true)`),
 * so neither exercises the real cache write (`checkSkillMdExists` ->
 * `validationCache.set`) or the real cache read (`getCachedValidation` ->
 * `repositoryToSkill`) — the exact round-trip SMI-5930 investigated after
 * discovering 91%+ of `subdirectory_search`-path skills persist with
 * `name`/`description` falling back to the repository's own name/description
 * instead of the SKILL.md frontmatter's. This test closes that coverage gap:
 * it drives the REAL `checkSkillMdExists` + `getCachedValidation` +
 * `repositoryToSkill` (only `global.fetch`, `fetchRepoLicense`, and
 * `enumerateRepoSkillPaths` are mocked) through `processSearchResults`, proving
 * the write-key/read-key pairing SMI-5849 fixed still holds for both a
 * single multi-skill repo and two DIFFERENT repos processed consecutively
 * (the exact prod shape of GeoloeG-IsT/pitch + GeoloeG-IsT/agents-reverse-engineer,
 * two unrelated repos sharing an identical `.claude/skills/are-*` path set).
 *
 * RCA status: this test PASSES on current `main` — the cache-key-mismatch
 * hypothesis in docs/internal/implementation/smi-5898-wave5-design-proposal.md
 * (Open Question 2) is empirically ruled out for this code path. See
 * docs/internal/implementation/smi-5930-rca-progress.md for the full
 * investigation and the production-diagnostic log this PR adds instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'

vi.mock('../../indexer/_shared/rate-limit.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../indexer/_shared/rate-limit.ts')>()
  return { ...actual, delay: vi.fn(async () => undefined), GITHUB_API_DELAY: 0 }
})
vi.mock('../../indexer/_shared/github-auth.ts', () => ({
  buildGitHubHeaders: vi.fn(async () => ({})),
}))

const mockFetchRepoLicense = vi.fn()
vi.mock('../../indexer/license-filter.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../indexer/license-filter.ts')>()
  return { ...actual, fetchRepoLicense: (...args: unknown[]) => mockFetchRepoLicense(...args) }
})

const mockEnumerateRepoSkillPaths = vi.fn()
vi.mock('../../indexer/trees-enumerate.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../indexer/trees-enumerate.ts')>()
  return {
    ...actual,
    enumerateRepoSkillPaths: (...args: unknown[]) => mockEnumerateRepoSkillPaths(...args),
  }
})

import { processSearchResults } from '../../indexer/subdirectory-search.process.ts'
import {
  getCachedValidation,
  repositoryToSkill,
  type SkillMdValidation,
} from '../../indexer/skill-processor.ts'
import type { GitHubRepository } from '../../indexer/topic-search.ts'

function skillMdContent(name: string, repoLabel: string) {
  return [
    '---',
    `name: ${name}`,
    `description: Skill ${name} belonging to ${repoLabel}, long enough to clear the gate.`,
    '---',
    '',
    `# ${name}`,
    '',
    'Body content long enough to clear the minimum length gate comfortably here.',
  ].join('\n')
}

describe('SMI-5930: validationCache round-trip through processSearchResults (real checkSkillMdExists)', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
    mockFetchRepoLicense.mockReset()
    mockFetchRepoLicense.mockResolvedValue({
      license: 'MIT',
      defaultBranch: 'main',
      fetchFailed: false,
    })
    mockEnumerateRepoSkillPaths.mockReset()
  })
  afterEach(() => {
    global.fetch = originalFetch
  })

  function makeResultRepo(
    owner: string,
    repoName: string,
    description: string | null
  ): GitHubRepository {
    return {
      owner,
      name: repoName,
      fullName: `${owner}/${repoName}`,
      description,
      // Code search omits default_branch, so this is the (undefined) code-search
      // shaped value — mirrors prod (SMI-5849).
      url: `https://github.com/${owner}/${repoName}/tree/undefined/.claude/skills/are-clean`,
      stars: 1,
      forks: 0,
      topics: [],
      updatedAt: new Date().toISOString(),
      defaultBranch: undefined as unknown as string,
      installable: false,
      repoName,
      skillPath: '.claude/skills/are-clean',
      discoveryPath: 'subdirectory_search:broad',
    }
  }

  it('a single repo with two skills resolves distinct, correct names from the cache', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('are-clean'))
        return new Response(skillMdContent('are-clean', 'pitch'), { status: 200 })
      if (url.includes('are-help'))
        return new Response(skillMdContent('are-help', 'pitch'), { status: 200 })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof global.fetch

    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: [
        { path: '.claude/skills/are-clean', blobSha: 'sha-clean' },
        { path: '.claude/skills/are-help', blobSha: 'sha-help' },
      ],
      truncatedByCap: false,
      truncatedByApi: false,
    })

    const validationCache = new Map<string, SkillMdValidation>()
    const repos: GitHubRepository[] = []
    // SMI-5964 Case 8: `budget` omitted entirely -- the exact shape the two
    // cron call sites (subdirectory-search.ts:238, :292) use. Must return
    // { stopped: false } and consume every input repo, proving the cron path
    // is byte-identical to pre-5964 behavior.
    const outcome = await processSearchResults(
      [makeResultRepo('GeoloeG-IsT', 'pitch', null)],
      new Set(),
      validationCache,
      { strictValidation: true },
      repos,
      {
        licenseFiltered: 0,
        licenseFetchFailed: 0,
        admitted: 0,
        licenseNull: 0,
        noDefaultBranch: 0,
      },
      {} as RateLimitTelemetry,
      {},
      new Set(),
      new Map()
    )

    expect(outcome).toEqual({ stopped: false })
    expect(repos).toHaveLength(2)
    const names = repos.map((repo) => {
      const validation = getCachedValidation(
        repo.owner,
        repo.repoName,
        repo.defaultBranch,
        validationCache,
        repo.skillPath
      )
      return repositoryToSkill(repo, undefined, validation, false).name
    })
    expect(new Set(names)).toEqual(new Set(['are-clean', 'are-help']))
  })

  it('two DIFFERENT repos sharing an identical skill_path set (prod shape: GeoloeG-IsT/pitch + GeoloeG-IsT/agents-reverse-engineer) do not cross-contaminate', async () => {
    global.fetch = vi.fn(async (url: string) => {
      const m = url.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/main\/(.+)\/SKILL\.md/)
      if (!m) return new Response('not found', { status: 404 })
      const [, , repo, path] = m
      const skillName = path.endsWith('are-clean') ? 'are-clean' : 'are-help'
      return new Response(skillMdContent(skillName, repo), { status: 200 })
    }) as unknown as typeof global.fetch

    mockEnumerateRepoSkillPaths.mockResolvedValue({
      entries: [
        { path: '.claude/skills/are-clean', blobSha: 'sha-clean' },
        { path: '.claude/skills/are-help', blobSha: 'sha-help' },
      ],
      truncatedByCap: false,
      truncatedByApi: false,
    })

    const validationCache = new Map<string, SkillMdValidation>()
    const repos: GitHubRepository[] = []
    await processSearchResults(
      [
        makeResultRepo('GeoloeG-IsT', 'pitch', null),
        makeResultRepo(
          'GeoloeG-IsT',
          'agents-reverse-engineer',
          'Reverse engineer your codebase to let your agents work efficiently'
        ),
      ],
      new Set(),
      validationCache,
      { strictValidation: true },
      repos,
      {
        licenseFiltered: 0,
        licenseFetchFailed: 0,
        admitted: 0,
        licenseNull: 0,
        noDefaultBranch: 0,
      },
      {} as RateLimitTelemetry,
      {},
      new Set(),
      new Map()
    )

    expect(repos).toHaveLength(4)
    for (const repo of repos) {
      const validation = getCachedValidation(
        repo.owner,
        repo.repoName,
        repo.defaultBranch,
        validationCache,
        repo.skillPath
      )
      const expectedName = repo.skillPath?.endsWith('are-clean') ? 'are-clean' : 'are-help'
      expect(validation?.metadata?.name, `${repo.fullName}:${repo.skillPath}`).toBe(expectedName)
      const skill = repositoryToSkill(repo, undefined, validation, false)
      expect(skill.name, `${repo.fullName}:${repo.skillPath}`).toBe(expectedName)
      // Neither repo's name should ever fall back to the OTHER repo's name or
      // to its own repository name (the SMI-5930 symptom).
      expect(skill.name).not.toBe(repo.repoName)
    }
  })
})
