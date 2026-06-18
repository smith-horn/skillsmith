/**
 * Community URL and fork-guard tests for code-search.ts and topic-search.ts
 * (SMI-5286 Wave 1a §#1, §#6)
 *
 * Asserts:
 *   (a) Result mappers emit the per-skill tree-URL (not the bare html_url).
 *   (b) Forked repositories are filtered out before being returned.
 *
 * Mocks the network layer at globalThis.fetch so the production HTTP plumbing
 * is exercised but no real requests are made. Matches the mock pattern used in
 * skill-md-fetch.test.ts (vi.spyOn + afterEach restoreAllMocks).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { RateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'

// ---------------------------------------------------------------------------
// Keep rate-limit helpers fast: mock delay + withRateLimitTracking to forward
// the fetch call directly so we can spy on globalThis.fetch.
// ---------------------------------------------------------------------------

vi.mock('../../indexer/_shared/rate-limit.ts', () => ({
  GITHUB_API_DELAY: 0,
  delay: vi.fn(async () => undefined),
  withBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  // Let withRateLimitTracking call globalThis.fetch directly (transparent).
  withRateLimitTracking: vi.fn(async (_telemetry: unknown, url: string, opts?: RequestInit) => {
    const init = opts ? { headers: opts.headers } : {}
    return globalThis.fetch(url, init)
  }),
}))

vi.mock('../../indexer/_shared/github-auth.ts', () => ({
  buildGitHubHeaders: vi.fn(async () => ({ Authorization: 'Bearer test-token' })),
}))

// Imported AFTER mocks.
import {
  searchCodeForSkillMd,
  searchCodeForSkillMdInSubdirectory,
} from '../../indexer/code-search.ts'
import { searchRepositories } from '../../indexer/topic-search.ts'

afterEach(() => vi.restoreAllMocks())

const noTelemetry: RateLimitTelemetry = {} as RateLimitTelemetry

// ---------------------------------------------------------------------------
// Helpers to build minimal GitHub API response payloads
// ---------------------------------------------------------------------------

function makeCodeSearchItem(
  overrides: {
    path?: string
    full_name?: string
    owner?: string
    repoName?: string
    html_url?: string
    default_branch?: string
    fork?: boolean
  } = {}
) {
  const owner = overrides.owner ?? 'acme'
  const repoName = overrides.repoName ?? 'my-skills'
  return {
    name: 'SKILL.md',
    path: overrides.path ?? '.agents/skills/foo/SKILL.md',
    repository: {
      id: 1,
      full_name: overrides.full_name ?? `${owner}/${repoName}`,
      name: repoName,
      owner: { login: owner },
      description: 'A skill repo',
      html_url: overrides.html_url ?? `https://github.com/${owner}/${repoName}`,
      stargazers_count: 10,
      forks_count: 2,
      fork: overrides.fork ?? false,
      topics: ['claude-code-skill'],
      default_branch: overrides.default_branch ?? 'main',
    },
  }
}

function makeTopicSearchItem(
  overrides: {
    owner?: string
    name?: string
    html_url?: string
    default_branch?: string
    fork?: boolean
  } = {}
) {
  const owner = overrides.owner ?? 'acme'
  const name = overrides.name ?? 'my-skills'
  return {
    id: 42,
    full_name: `${owner}/${name}`,
    name,
    owner: { login: owner },
    description: 'A skill repo',
    html_url: overrides.html_url ?? `https://github.com/${owner}/${name}`,
    stargazers_count: 5,
    forks_count: 1,
    fork: overrides.fork ?? false,
    topics: ['claude-code-skill'],
    updated_at: '2026-01-01T00:00:00Z',
    default_branch: overrides.default_branch ?? 'main',
    license: { spdx_id: 'MIT' },
  }
}

function makeFetchOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// code-search.ts — searchCodeForSkillMd (root SKILL.md)
// ---------------------------------------------------------------------------

describe('searchCodeForSkillMd — tree-URL and fork guard (SMI-5286 Wave 1a §#1/§#6)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('emits the per-skill tree-URL (not the bare html_url) for a root SKILL.md hit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchOk({
        total_count: 1,
        incomplete_results: false,
        items: [makeCodeSearchItem({ path: 'SKILL.md' })],
      })
    )

    const { repos } = await searchCodeForSkillMd(1, 30, undefined, noTelemetry)

    expect(repos).toHaveLength(1)
    // Root SKILL.md → skillPath '' → tree URL ends with /tree/main
    expect(repos[0].url).toBe('https://github.com/acme/my-skills/tree/main')
    // Must NOT be bare html_url (no /tree/)
    expect(repos[0].url).not.toBe('https://github.com/acme/my-skills')
    expect(repos[0].skillPath).toBe('')
  })

  it('filters out forked repositories (fork===true)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchOk({
        total_count: 2,
        incomplete_results: false,
        items: [
          makeCodeSearchItem({ path: 'SKILL.md', fork: true, repoName: 'forked' }),
          makeCodeSearchItem({ path: 'SKILL.md', fork: false, repoName: 'original' }),
        ],
      })
    )

    const { repos } = await searchCodeForSkillMd(1, 30, undefined, noTelemetry)

    expect(repos).toHaveLength(1)
    expect(repos[0].repoName).toBe('original')
  })

  it('returns an empty repos array when ALL items are forks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchOk({
        total_count: 2,
        incomplete_results: false,
        items: [
          makeCodeSearchItem({ path: 'SKILL.md', fork: true, repoName: 'fork1' }),
          makeCodeSearchItem({ path: 'SKILL.md', fork: true, repoName: 'fork2' }),
        ],
      })
    )

    const { repos, total } = await searchCodeForSkillMd(1, 30, undefined, noTelemetry)

    expect(repos).toHaveLength(0)
    expect(total).toBe(2) // total_count from API is still returned
  })
})

// ---------------------------------------------------------------------------
// code-search.ts — searchCodeForSkillMdInSubdirectory (subdirectory SKILL.md)
// ---------------------------------------------------------------------------

describe('searchCodeForSkillMdInSubdirectory — tree-URL and fork guard (SMI-5286 Wave 1a §#1/§#6)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('emits the per-skill tree-URL for a .agents/skills/foo/SKILL.md hit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchOk({
        total_count: 1,
        incomplete_results: false,
        items: [makeCodeSearchItem({ path: '.agents/skills/foo/SKILL.md' })],
      })
    )

    const result = await searchCodeForSkillMdInSubdirectory(
      '.agents/skills',
      1,
      30,
      undefined,
      noTelemetry
    )

    expect(result.repos).toHaveLength(1)
    const repo = result.repos[0]
    // URL must be the tree-URL for the skill's parent dir
    expect(repo.url).toBe('https://github.com/acme/my-skills/tree/main/.agents/skills/foo')
    // Not the bare html_url
    expect(repo.url).not.toBe('https://github.com/acme/my-skills')
    expect(repo.skillPath).toBe('.agents/skills/foo')
  })

  it('filters out forked repositories from subdirectory code search', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchOk({
        total_count: 2,
        incomplete_results: false,
        items: [
          makeCodeSearchItem({
            path: '.agents/skills/foo/SKILL.md',
            fork: true,
            repoName: 'a-fork',
          }),
          makeCodeSearchItem({
            path: '.agents/skills/bar/SKILL.md',
            fork: false,
            repoName: 'original',
          }),
        ],
      })
    )

    const result = await searchCodeForSkillMdInSubdirectory(
      '.agents/skills',
      1,
      30,
      undefined,
      noTelemetry
    )

    expect(result.repos).toHaveLength(1)
    expect(result.repos[0].repoName).toBe('original')
    expect(result.repos[0].skillPath).toBe('.agents/skills/bar')
  })

  it('broad query (no pathPrefix) emits tree-URL for each distinct skill path', async () => {
    // Two distinct SKILL.md files in the same repo — they get distinct URLs
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchOk({
        total_count: 2,
        incomplete_results: false,
        items: [
          makeCodeSearchItem({ path: '.agents/skills/a/SKILL.md' }),
          makeCodeSearchItem({ path: '.agents/skills/b/SKILL.md' }),
        ],
      })
    )

    const result = await searchCodeForSkillMdInSubdirectory(
      undefined, // broad
      1,
      30,
      undefined,
      noTelemetry
    )

    expect(result.repos).toHaveLength(2)
    const urls = result.repos.map((r) => r.url)
    expect(new Set(urls).size).toBe(2) // distinct
    expect(urls[0]).toMatch(/\/tree\/main\/\.agents\/skills\/a/)
    expect(urls[1]).toMatch(/\/tree\/main\/\.agents\/skills\/b/)
  })
})

// ---------------------------------------------------------------------------
// topic-search.ts — searchRepositories
// ---------------------------------------------------------------------------

describe('searchRepositories — tree-URL and fork guard (SMI-5286 Wave 1a §#1/§#6)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('emits the per-skill tree-URL for a topic-search hit (root skill)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchOk({
        total_count: 1,
        incomplete_results: false,
        items: [makeTopicSearchItem()],
      })
    )

    const { repos } = await searchRepositories('claude-code-skill', 1, 30, undefined, noTelemetry)

    expect(repos).toHaveLength(1)
    const repo = repos[0]
    // Topic search always emits a root-level tree URL (skillPath='')
    expect(repo.url).toBe('https://github.com/acme/my-skills/tree/main')
    // Not bare html_url
    expect(repo.url).not.toBe('https://github.com/acme/my-skills')
    expect(repo.skillPath).toBe('')
  })

  it('filters out forked repositories from topic search results', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchOk({
        total_count: 3,
        incomplete_results: false,
        items: [
          makeTopicSearchItem({ name: 'fork1', fork: true }),
          makeTopicSearchItem({ name: 'original', fork: false }),
          makeTopicSearchItem({ name: 'fork2', fork: true }),
        ],
      })
    )

    const { repos } = await searchRepositories('claude-code-skill', 1, 30, undefined, noTelemetry)

    expect(repos).toHaveLength(1)
    expect(repos[0].name).toBe('original')
  })

  it('returns empty repos array when all topic-search items are forks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchOk({
        total_count: 2,
        incomplete_results: false,
        items: [
          makeTopicSearchItem({ name: 'fork1', fork: true }),
          makeTopicSearchItem({ name: 'fork2', fork: true }),
        ],
      })
    )

    const { repos, total } = await searchRepositories(
      'claude-code-skill',
      1,
      30,
      undefined,
      noTelemetry
    )

    expect(repos).toHaveLength(0)
    expect(total).toBe(2)
  })

  it('emits distinct tree-URLs for non-fork repos and preserves SPDX license from response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchOk({
        total_count: 2,
        incomplete_results: false,
        items: [
          { ...makeTopicSearchItem({ name: 'repo-a' }), license: { spdx_id: 'Apache-2.0' } },
          { ...makeTopicSearchItem({ name: 'repo-b' }), license: null },
        ],
      })
    )

    const { repos } = await searchRepositories('claude-code-skill', 1, 30, undefined, noTelemetry)

    expect(repos).toHaveLength(2)

    const repoA = repos.find((r) => r.name === 'repo-a')!
    expect(repoA.url).toBe('https://github.com/acme/repo-a/tree/main')
    expect(repoA.license).toBe('Apache-2.0')

    const repoB = repos.find((r) => r.name === 'repo-b')!
    expect(repoB.url).toBe('https://github.com/acme/repo-b/tree/main')
    expect(repoB.license).toBeNull()
  })
})
