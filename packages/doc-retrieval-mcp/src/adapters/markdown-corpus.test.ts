import { describe, it, expect, afterEach } from 'vitest'
import { writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { createMarkdownCorpusAdapter } from './markdown-corpus.js'
import type { AdapterContext, AdapterFile } from '../types.js'
import type { CorpusConfig } from '../config.js'
import { makeFixtureEnv, makeFixtureTempDir } from '../_lib/git-fixture-env.js'

/**
 * Focused unit test for the `markdown-corpus` adapter's `chunk()` provenance
 * tagging (SMI-4703 §1). This adapter previously had no dedicated test file
 * — the only existing coverage was indirect, via
 * `tests/integration/indexer.test.ts` (which asserts on chunk COUNTS, not
 * on individual `ChunkMetadata` fields). Added here because SMI-4703 is the
 * first change to touch this file's `chunk()` output shape.
 */
function makeCtx(): AdapterContext {
  const cfg: CorpusConfig = {
    storagePath: '.ruvector/store',
    metadataPath: '.ruvector/metadata.json',
    stateFile: '.ruvector/state.json',
    embeddingDim: 384,
    chunk: { targetTokens: 240, overlapTokens: 48, minTokens: 8 },
    globs: ['**/*.md'],
  }
  return {
    repoRoot: '/fake/repo',
    cfg,
    mode: 'full',
    lastSha: null,
    lastRunAt: null,
  }
}

describe('markdown-corpus adapter — chunk provenance tagging (SMI-4703 §1)', () => {
  it('tags every chunk provenanceTier: "tier-a" (reaches the corpus via a human-reviewed PR merge)', async () => {
    const adapter = createMarkdownCorpusAdapter()
    const file: AdapterFile = {
      logicalPath: 'docs/internal/example.md',
      rawContent: '# Example\n\nSome documentation content that forms a single chunk.\n',
      absolutePath: null,
    }
    const chunks = await adapter.chunk(file, makeCtx())
    expect(chunks.length).toBeGreaterThan(0)
    for (const c of chunks) {
      expect(c.provenanceTier).toBe('tier-a')
      expect(c.kind).toBe('markdown-doc')
      expect(c.lifetime).toBe('long-term')
    }
  })

  it('returns [] (no chunks to tag) when the file cannot be read', async () => {
    const adapter = createMarkdownCorpusAdapter()
    const file: AdapterFile = {
      logicalPath: 'docs/internal/missing.md',
      rawContent: '',
      absolutePath: '/fake/repo/docs/internal/missing.md',
    }
    const chunks = await adapter.chunk(file, makeCtx())
    expect(chunks).toEqual([])
  })
})

/**
 * Regression coverage for the 2026-07-21 incident: a real content edit
 * inside docs/internal (a git submodule) produced a 0-file incremental
 * run — `git diff --name-only` in the outer repo reports a changed
 * submodule as one opaque gitlink path, never the files changed inside
 * it, so every submodule file silently dropped out of every incremental
 * run. Builds a REAL git repo with a REAL submodule (the prior
 * integration test's `mkdtemp`-only fixtures never called `git init`, so
 * `gitChangedFiles()` was never actually exercised against real history).
 */
describe('markdown-corpus adapter — incremental listFiles across a submodule boundary (2026-07-21 regression)', () => {
  let outerRoot: string
  let innerRoot: string

  afterEach(async () => {
    if (outerRoot) await rm(outerRoot, { recursive: true, force: true })
    if (innerRoot) await rm(innerRoot, { recursive: true, force: true })
  })

  // SMI-4693: sanitized env (strips GIT_DISCOVERY_VARS, pins test author/
  // committer identity) so these spawned `git` calls can't resolve against
  // an ambient parent .git via inherited env hints.
  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: makeFixtureEnv() })
  }

  function commit(cwd: string, message: string): string {
    git(cwd, ['commit', '-q', '-m', message])
    return git(cwd, ['rev-parse', 'HEAD']).trim()
  }

  function makeCtxFor(repoRoot: string, lastSha: string | null): AdapterContext {
    const cfg: CorpusConfig = {
      storagePath: '.ruvector/store',
      metadataPath: '.ruvector/metadata.json',
      stateFile: '.ruvector/state.json',
      embeddingDim: 384,
      chunk: { targetTokens: 240, overlapTokens: 48, minTokens: 8 },
      globs: ['docs/internal/**/*.md'],
    }
    return { repoRoot, cfg, mode: 'incremental', lastSha, lastRunAt: null }
  }

  it('resolves files changed inside a submodule, not just the opaque gitlink path', async () => {
    innerRoot = makeFixtureTempDir('doc-retrieval-submodule')
    git(innerRoot, ['init', '-q'])
    await writeFile(join(innerRoot, 'first.md'), '# First\n')
    git(innerRoot, ['add', '.'])
    commit(innerRoot, 'inner: initial')

    outerRoot = makeFixtureTempDir('doc-retrieval-outer')
    git(outerRoot, ['init', '-q'])
    git(outerRoot, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      innerRoot,
      'docs/internal',
    ])
    git(outerRoot, ['add', '.'])
    const baseSha = commit(outerRoot, 'outer: add docs/internal submodule')

    // Edit inside the submodule and advance its own history.
    const innerCheckout = join(outerRoot, 'docs/internal')
    await writeFile(join(innerCheckout, 'second.md'), '# Second\n')
    git(innerCheckout, ['add', '.'])
    commit(innerCheckout, 'inner: add second.md')

    // Bump the outer repo's gitlink pointer — this is the only thing a
    // plain `git diff --name-only` in the outer repo will ever show.
    git(outerRoot, ['add', 'docs/internal'])
    commit(outerRoot, 'outer: bump docs/internal pointer')

    const adapter = createMarkdownCorpusAdapter()
    const files = await adapter.listFiles(makeCtxFor(outerRoot, baseSha))
    const paths = files.map((f) => f.logicalPath).sort()

    // Before the fix this returned [] — the submodule's gitlink path
    // never matches a glob-expanded file, so the new file inside it was
    // silently dropped from the incremental run.
    expect(paths).toContain('docs/internal/second.md')
  })

  it('treats a newly-initialized submodule as fully changed when lastSha predates it', async () => {
    innerRoot = makeFixtureTempDir('doc-retrieval-submodule-new')
    git(innerRoot, ['init', '-q'])
    await writeFile(join(innerRoot, 'a.md'), '# A\n')
    await writeFile(join(innerRoot, 'b.md'), '# B\n')
    git(innerRoot, ['add', '.'])
    commit(innerRoot, 'inner: initial')

    outerRoot = makeFixtureTempDir('doc-retrieval-outer-new')
    git(outerRoot, ['init', '-q'])
    await writeFile(join(outerRoot, 'placeholder.md'), '# Placeholder\n')
    git(outerRoot, ['add', '.'])
    const baseSha = commit(outerRoot, 'outer: initial, before submodule exists')

    git(outerRoot, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      innerRoot,
      'docs/internal',
    ])
    git(outerRoot, ['add', '.'])
    commit(outerRoot, 'outer: add docs/internal submodule')

    const adapter = createMarkdownCorpusAdapter()
    const files = await adapter.listFiles(makeCtxFor(outerRoot, baseSha))
    const paths = files.map((f) => f.logicalPath).sort()

    expect(paths).toEqual(['docs/internal/a.md', 'docs/internal/b.md'])
  })
})
