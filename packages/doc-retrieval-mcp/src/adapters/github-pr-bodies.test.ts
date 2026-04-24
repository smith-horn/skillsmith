import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createGitHubPrBodiesAdapter,
  parseGraphqlResponse,
  resolveOwnerRepo,
} from './github-pr-bodies.js'
import type { AdapterContext } from '../types.js'
import type { CorpusConfig } from '../config.js'

function makeCtx(
  repoRoot: string,
  mode: 'full' | 'incremental',
  adapterCfg?: Record<string, unknown>
): AdapterContext {
  const cfg: CorpusConfig = {
    storagePath: '.ruvector/store',
    metadataPath: '.ruvector/metadata.json',
    stateFile: '.ruvector/state.json',
    embeddingDim: 384,
    chunk: { targetTokens: 240, overlapTokens: 48, minTokens: 32 },
    globs: ['**/*.md'],
  }
  return {
    repoRoot,
    cfg,
    mode,
    lastSha: null,
    lastRunAt: null,
    adapterCfg: adapterCfg as never,
  }
}

let scratch: string
let origToken: string | undefined
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'pr-bodies-adapter-'))
  mkdirSync(join(scratch, '.ruvector'), { recursive: true })
  origToken = process.env.GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  if (origToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = origToken
  warnSpy.mockRestore()
  rmSync(scratch, { recursive: true, force: true })
})

describe('resolveOwnerRepo', () => {
  it('defaults to smith-horn/skillsmith', () => {
    expect(resolveOwnerRepo(makeCtx(scratch, 'full'))).toEqual({
      owner: 'smith-horn',
      repo: 'skillsmith',
    })
  })

  it('honours adapterCfg.github_owner / github_repo overrides', () => {
    const ctx = makeCtx(scratch, 'full', {
      kind: 'github-pr-bodies',
      github_owner: 'custom-org',
      github_repo: 'custom-repo',
    })
    expect(resolveOwnerRepo(ctx)).toEqual({ owner: 'custom-org', repo: 'custom-repo' })
  })
})

describe('parseGraphqlResponse', () => {
  it('parses a valid search result', () => {
    const raw = JSON.stringify({
      data: {
        search: {
          nodes: [
            {
              number: 748,
              title: 'fix(SMI-4443): callback guard',
              body: 'Fixes the overlay session-blindness regression.',
              mergedAt: '2026-04-24T00:00:00Z',
              mergeCommit: { oid: 'abc123' },
              author: { login: 'ryan' },
              isDraft: false,
              url: 'https://github.com/smith-horn/skillsmith/pull/748',
            },
          ],
        },
      },
    })
    const out = parseGraphqlResponse(raw)
    expect(out?.length).toBe(1)
    expect(out?.[0]).toMatchObject({
      number: 748,
      title: 'fix(SMI-4443): callback guard',
      mergeCommit: 'abc123',
      author: 'ryan',
      isDraft: false,
    })
  })

  it('returns null for malformed JSON', () => {
    expect(parseGraphqlResponse('not json')).toBe(null)
  })

  it('returns [] when nodes is empty or missing', () => {
    expect(parseGraphqlResponse(JSON.stringify({ data: { search: { nodes: [] } } }))).toEqual([])
    expect(parseGraphqlResponse(JSON.stringify({}))).toEqual([])
  })

  it('drops nodes without a number', () => {
    const raw = JSON.stringify({ data: { search: { nodes: [{ title: 'no number' }] } } })
    expect(parseGraphqlResponse(raw)).toEqual([])
  })
})

describe('github-pr-bodies adapter — listFiles', () => {
  it('warns and returns [] when GITHUB_TOKEN is unset', async () => {
    const adapter = createGitHubPrBodiesAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('github-pr-bodies: GITHUB_TOKEN unset')
    )
  })

  it('falls back to cache when fetch returns null and emits cached PRs', async () => {
    process.env.GITHUB_TOKEN = 'fake-token'
    const cache = {
      '748': {
        number: 748,
        title: 'fix(SMI-4443): callback guard',
        body:
          'Fixes the overlay session-blindness regression by adding a ' +
          'callback H1 guard that survives the overlay mount/unmount race.',
        mergedAt: '2026-04-24T00:00:00Z',
        mergeCommit: 'abc123',
        author: 'ryan',
        isDraft: false,
        url: 'https://github.com/smith-horn/skillsmith/pull/748',
      },
    }
    writeFileSync(join(scratch, '.ruvector', 'pr-bodies-cache.json'), JSON.stringify(cache))

    // `gh` CLI call will fail here (no gh auth / maybe no gh at all);
    // adapter must fall back to cache.
    const adapter = createGitHubPrBodiesAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files.length).toBe(1)
    expect(files[0].logicalPath).toBe('github://smith-horn/skillsmith/pr/748')
    expect(files[0].tags?.smi).toBe('SMI-4443')
    expect(files[0].tags?.author).toBe('ryan')
    expect(files[0].absolutePath).toBe(null)
  })

  it('skips draft PRs and short bodies in the cache', async () => {
    process.env.GITHUB_TOKEN = 'fake-token'
    const cache = {
      '100': {
        number: 100,
        title: 'wip',
        body: 'short',
        mergedAt: '',
        mergeCommit: null,
        author: 'ryan',
        isDraft: true,
        url: '',
      },
      '101': {
        number: 101,
        title: 'tiny',
        body: 'still short',
        mergedAt: '',
        mergeCommit: null,
        author: 'ryan',
        isDraft: false,
        url: '',
      },
      '102': {
        number: 102,
        title: 'fix(SMI-4400): real one',
        body:
          'Real body explaining what changed and why with enough detail ' +
          'to pass the MIN_BODY_CHARS threshold easily.',
        mergedAt: '2026-04-01T00:00:00Z',
        mergeCommit: 'xyz',
        author: 'ryan',
        isDraft: false,
        url: '',
      },
    }
    writeFileSync(join(scratch, '.ruvector', 'pr-bodies-cache.json'), JSON.stringify(cache))
    const adapter = createGitHubPrBodiesAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files.map((f) => f.tags?.pr)).toEqual([102])
  })

  it('skips dependabot PRs without an SMI reference', async () => {
    process.env.GITHUB_TOKEN = 'fake-token'
    const cache = {
      '200': {
        number: 200,
        title: 'chore(deps): bump lodash',
        body:
          'Bumps lodash from 4.17.20 to 4.17.21. Release notes: ' +
          'patch security advisory. Auto-generated by dependabot.',
        mergedAt: '',
        mergeCommit: null,
        author: 'dependabot[bot]',
        isDraft: false,
        url: '',
      },
      '201': {
        number: 201,
        title: 'chore(deps): SMI-4000 axios bump',
        body:
          'Bumps axios. Closes SMI-4000 — transitive vulnerability ' +
          'fix tracked under the parent issue for bookkeeping.',
        mergedAt: '',
        mergeCommit: null,
        author: 'dependabot[bot]',
        isDraft: false,
        url: '',
      },
    }
    writeFileSync(join(scratch, '.ruvector', 'pr-bodies-cache.json'), JSON.stringify(cache))
    const adapter = createGitHubPrBodiesAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files.map((f) => f.tags?.pr)).toEqual([201])
  })
})

describe('github-pr-bodies adapter — chunk', () => {
  it('produces one long-term `pr` chunk with virtual-key id', async () => {
    process.env.GITHUB_TOKEN = 'fake-token'
    const cache = {
      '748': {
        number: 748,
        title: 'fix(SMI-4443): callback guard',
        body:
          'Fixes the overlay session-blindness regression. Root cause: ' +
          'missing H1 re-check after overlay close. Rationale locked in ' +
          'for future sessions.',
        mergedAt: '',
        mergeCommit: null,
        author: 'ryan',
        isDraft: false,
        url: '',
      },
    }
    writeFileSync(join(scratch, '.ruvector', 'pr-bodies-cache.json'), JSON.stringify(cache))
    const adapter = createGitHubPrBodiesAdapter()
    const ctx = makeCtx(scratch, 'full')
    const files = await adapter.listFiles(ctx)
    const chunks = await adapter.chunk(files[0], ctx)
    expect(chunks.length).toBe(1)
    expect(chunks[0].kind).toBe('pr')
    expect(chunks[0].lifetime).toBe('long-term')
    expect(chunks[0].filePath).toBe('github://smith-horn/skillsmith/pr/748')
    expect(chunks[0].headingChain[0]).toBe('fix(SMI-4443): callback guard')
  })
})

describe('github-pr-bodies adapter — listDeletedPaths', () => {
  it('returns [] (PRs are immutable)', async () => {
    const adapter = createGitHubPrBodiesAdapter()
    const deleted = await adapter.listDeletedPaths(makeCtx(scratch, 'incremental'))
    expect(deleted).toEqual([])
  })
})
