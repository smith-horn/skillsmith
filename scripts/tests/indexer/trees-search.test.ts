/**
 * Unit tests for trees-search.ts — fetchSkillPathsFromTree (SMI-5286 1c §C-4)
 *
 * Asserts the root-level SKILL.md handling: a blob at repo-root `SKILL.md`
 * must enumerate to a TreeSkillEntry with path:'' (buildSkillTreeUrl maps '' →
 * …/tree/<branch>), NOT be silently dropped. A nested `tools/foo/SKILL.md`
 * yields its parent dir, and a `use-skill.md` blob must NOT match (suffix gate).
 *
 * Mocks the network layer at globalThis.fetch so the production HTTP plumbing
 * is exercised but no real requests are made. Matches the mock pattern used in
 * community-url-fork.test.ts (vi.mock rate-limit passthrough + vi.spyOn fetch).
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

// Imported AFTER mocks so the SUT binds the stub.
import { fetchSkillPathsFromTree } from '../../indexer/trees-search.ts'

afterEach(() => vi.restoreAllMocks())

const noTelemetry: RateLimitTelemetry = {} as RateLimitTelemetry

// ---------------------------------------------------------------------------
// Helpers to build minimal GitHub Trees API response payloads
// ---------------------------------------------------------------------------

function makeBlob(path: string, sha: string) {
  return {
    path,
    mode: '100644',
    type: 'blob',
    sha,
    size: 123,
    url: `https://api.github.com/repos/acme/my-skills/git/blobs/${sha}`,
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
// Root-level SKILL.md handling (SMI-5286 1c §C-4)
// ---------------------------------------------------------------------------

describe('fetchSkillPathsFromTree — root-level SKILL.md (SMI-5286 1c §C-4)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('emits path:"" for a root SKILL.md and the parent dir for a nested one; ignores use-skill.md', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchOk({
        sha: 'treesha',
        url: 'https://api.github.com/repos/acme/my-skills/git/trees/main',
        tree: [
          makeBlob('SKILL.md', 'rootsha'), // root SKILL.md → path ''
          makeBlob('tools/foo/SKILL.md', 'nestedsha'), // nested → parent dir
          makeBlob('docs/use-skill.md', 'usesha'), // suffix gate: must NOT match
        ],
        truncated: false,
      })
    )

    const result = await fetchSkillPathsFromTree('acme', 'my-skills', 'main', noTelemetry)

    expect(result.entries).toEqual([
      { path: '', blobSha: 'rootsha' },
      { path: 'tools/foo', blobSha: 'nestedsha' },
    ])
    expect(result.truncated).toBe(false)
    expect(result.errors).toHaveLength(0)
  })

  it('does NOT match use-skill.md even when it is the only blob (suffix gate)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchOk({
        sha: 'treesha',
        url: 'https://api.github.com/repos/acme/my-skills/git/trees/main',
        tree: [makeBlob('use-skill.md', 'usesha')],
        truncated: false,
      })
    )

    const result = await fetchSkillPathsFromTree('acme', 'my-skills', 'main', noTelemetry)

    expect(result.entries).toHaveLength(0)
  })
})
