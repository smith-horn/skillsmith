import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Skip when @ruvector/core native binding is absent (runs in Docker only).
const _require = createRequire(import.meta.url)
let nativeAvailable = false
try {
  _require('@ruvector/core')
  nativeAvailable = true
} catch {
  nativeAvailable = false
}

import { runIndexer } from '../../src/indexer.js'
import { search } from '../../src/search.js'
import { resetConfigCache, loadConfig, resolveRepoPath } from '../../src/config.js'
import { resetEmbedderCache, embedBatch } from '../../src/embedding.js'

const FIXTURES: Record<string, string> = {
  'guide-a.md': [
    '# Guide A',
    '',
    '## Section One',
    '',
    'This is the first section of Guide A. It covers important topics about the system.',
    '',
    '## Section Two',
    '',
    'Section two discusses more advanced material for Guide A in detail.',
  ].join('\n'),
  'guide-b.md': [
    '# Guide B',
    '',
    '## Introduction',
    '',
    'Guide B is about a completely different subject matter entirely.',
    '',
    '## Details',
    '',
    'The details section of Guide B provides comprehensive coverage of the topic.',
  ].join('\n'),
}

describe.skipIf(!nativeAvailable)('search integration (requires @ruvector/core native)', () => {
  let tmpRoot: string
  let configPath: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(async () => {
    savedEnv = {
      CI: process.env.CI,
      SKILLSMITH_CI: process.env.SKILLSMITH_CI,
      SKILLSMITH_REPO_ROOT: process.env.SKILLSMITH_REPO_ROOT,
      SKILLSMITH_USE_MOCK_EMBEDDINGS: process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS,
    }
    delete process.env.CI
    delete process.env.SKILLSMITH_CI
    process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS = 'true'

    tmpRoot = await mkdtemp(join(tmpdir(), 'doc-retrieval-search-'))
    process.env.SKILLSMITH_REPO_ROOT = tmpRoot

    const fixturesDir = join(tmpRoot, 'fixtures')
    await mkdir(fixturesDir, { recursive: true })
    for (const [name, content] of Object.entries(FIXTURES)) {
      await writeFile(join(fixturesDir, name), content, 'utf8')
    }

    const cfg = {
      storagePath: '.ruvector/test-docs',
      metadataPath: '.ruvector/metadata.json',
      stateFile: '.ruvector/.index-state.json',
      embeddingDim: 384,
      chunk: { targetTokens: 240, overlapTokens: 48, minTokens: 8 },
      globs: ['fixtures/**/*.md'],
    }
    configPath = join(tmpRoot, 'test.config.json')
    await writeFile(configPath, JSON.stringify(cfg), 'utf8')

    await runIndexer('full', { configPath })
    resetConfigCache()
  })

  afterEach(async () => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key as keyof typeof process.env]
      else process.env[key as keyof typeof process.env] = val
    }
    resetConfigCache()
    resetEmbedderCache()
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true })
  })

  it('returns empty array when vectors file does not exist', async () => {
    const emptyCfg = {
      storagePath: '.ruvector/nonexistent',
      metadataPath: '.ruvector/metadata.json',
      stateFile: '.ruvector/.index-state.json',
      embeddingDim: 384,
      chunk: { targetTokens: 240, overlapTokens: 48, minTokens: 8 },
      globs: ['fixtures/**/*.md'],
    }
    const emptyCfgPath = join(tmpRoot, 'empty.config.json')
    await writeFile(emptyCfgPath, JSON.stringify(emptyCfg), 'utf8')
    resetConfigCache()

    const hits = await search({ query: 'system topics', configPath: emptyCfgPath })
    expect(hits).toEqual([])
  })

  it('returns hits with similarity in [0, 1] after full index', async () => {
    const hits = await search({ query: 'system topics', k: 5, configPath })

    expect(hits.length).toBeGreaterThan(0)
    for (const hit of hits) {
      expect(hit.similarity).toBeGreaterThanOrEqual(0)
      expect(hit.similarity).toBeLessThanOrEqual(1)
      expect(hit.score).toBe(hit.similarity)
      expect(hit.filePath).toMatch(/^fixtures\//)
      expect(hit.text).toBeTruthy()
    }
  })

  it('respects k limit', async () => {
    const hits = await search({ query: 'section details coverage', k: 2, configPath })
    expect(hits.length).toBeLessThanOrEqual(2)
  })

  it('filters by scopeGlobs', async () => {
    const all = await search({ query: 'guide section', k: 10, minScore: 0, configPath })
    expect(all.length).toBeGreaterThan(0)

    const filtered = await search({
      query: 'guide section',
      k: 10,
      minScore: 0,
      scopeGlobs: ['fixtures/guide-a.md'],
      configPath,
    })

    for (const hit of filtered) {
      expect(hit.filePath).toBe('fixtures/guide-a.md')
    }
  })

  it('respects minScore threshold', async () => {
    const hits = await search({ query: 'section topics', k: 10, minScore: 0.99, configPath })
    for (const hit of hits) {
      expect(hit.similarity).toBeGreaterThanOrEqual(0.99)
    }
  })

  // SMI-4703 §1: this is the regression test for the live-path gap the
  // implementing agent flagged — rerank.ts's hard-exclusion filter is not on
  // the actual call path (server.ts's skill_docs_search tool and
  // scripts/session-priming-query.ts both call search() directly, never
  // rerank()). The fix moved the identical fail-closed predicate into
  // search() itself. This test proves the LIVE boundary excludes a
  // quarantined chunk, not just rerank()'s own already-covered unit tests.
  it('excludes a provenance_tier=quarantine chunk from search() results, even at a near-perfect similarity match (the live-path exclusion, not just rerank())', async () => {
    const cfg = await loadConfig(configPath)
    const storageAbs = resolveRepoPath(cfg.storagePath)
    const vectorsFile = join(storageAbs, 'vectors')

    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    const { VectorDb } = req('@ruvector/core') as typeof import('@ruvector/core')
    const db = new VectorDb({
      dimensions: cfg.embeddingDim,
      storagePath: vectorsFile,
      distanceMetric: 'Cosine',
    })

    const distinctiveQuery = 'zzz-smi-4703-quarantine-canary-zzz'
    const [vec] = await embedBatch([distinctiveQuery])

    await db.insert({
      id: 'smi-4703-quarantine-canary',
      vector: vec,
      metadata: JSON.stringify({
        file_path: 'memory://test-user/feedback_poisoned.md',
        line_start: 1,
        line_end: 1,
        heading_chain: [],
        text: 'This is a quarantined (poisoned) memory chunk that must never reach a session.',
        provenance_tier: 'quarantine',
      }),
    })

    // Sanity check: without the exclusion, this exact-text-match query would
    // return the canary as the top (near-perfect similarity) hit — proving
    // the test fixture itself is a genuine near-perfect match, not a weak
    // one the minScore filter would have excluded anyway.
    const hits = await search({ query: distinctiveQuery, k: 5, minScore: 0, configPath })
    expect(hits.some((h) => h.id === 'smi-4703-quarantine-canary')).toBe(false)
  })

  // SMI-5708 Item #7: scopeGlobs filtering happens AFTER the vector DB's
  // raw top-k fetch. Before this fix, a scoped consumer could get fewer
  // than k results even when more in-scope matches existed beyond the
  // unscoped top-K boundary -- the DB's raw top-k could be entirely
  // dominated by out-of-scope hits, silently starving the scoped result set.
  it('over-fetches so scoped search still returns k in-scope hits when the unscoped top-K is dominated by out-of-scope hits', async () => {
    const cfg = await loadConfig(configPath)
    const storageAbs = resolveRepoPath(cfg.storagePath)
    const vectorsFile = join(storageAbs, 'vectors')

    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    const { VectorDb } = req('@ruvector/core') as typeof import('@ruvector/core')
    const db = new VectorDb({
      dimensions: cfg.embeddingDim,
      storagePath: vectorsFile,
      distanceMetric: 'Cosine',
    })

    const query = 'zzz-smi-5708-overfetch-canary-zzz'
    const [queryVec] = await embedBatch([query])

    // 15 near-identical-to-query decoys, OUTSIDE the target scope -- these
    // dominate the unscoped top-K so a naive single-fetch(k=3) would return
    // zero in-scope hits.
    for (let i = 0; i < 15; i++) {
      await db.insert({
        id: `overfetch-decoy-${i}`,
        vector: queryVec,
        metadata: JSON.stringify({
          file_path: 'fixtures/decoy-not-in-scope.md',
          line_start: 1,
          line_end: 1,
          heading_chain: [],
          text: 'decoy chunk unrelated to the target scope',
          provenance_tier: 'tier-a',
        }),
      })
    }

    // 3 targets, distinctly different (lower-similarity) text, INSIDE the
    // target scope -- ranked well beyond the unscoped top-3 boundary.
    const [targetVec] = await embedBatch(['completely unrelated low-similarity target text'])
    for (let i = 0; i < 3; i++) {
      await db.insert({
        id: `overfetch-target-${i}`,
        vector: targetVec,
        metadata: JSON.stringify({
          file_path: 'fixtures/target-scope.md',
          line_start: i + 1,
          line_end: i + 1,
          heading_chain: [],
          text: `target chunk ${i} in scope`,
          provenance_tier: 'tier-a',
        }),
      })
    }

    const scoped = await search({
      query,
      k: 3,
      minScore: 0,
      scopeGlobs: ['fixtures/target-scope.md'],
      configPath,
    })

    expect(scoped.length).toBe(3)
    for (const hit of scoped) {
      expect(hit.filePath).toBe('fixtures/target-scope.md')
    }
  })

  it('does not over-fetch beyond k when scopeGlobs is unset (no behavior change to the unscoped path)', async () => {
    const hits = await search({ query: 'section details coverage', k: 2, configPath })
    expect(hits.length).toBeLessThanOrEqual(2)
  })

  // SMI-5708 Item #7 (Opus review finding): a NaN k on the scoped over-fetch
  // path previously made every loop-termination check a NaN comparison
  // (always false), spinning forever. The test completing at all -- within
  // vitest's default per-test timeout -- IS the regression proof; a
  // reintroduced hang would time out this test, not fail an assertion.
  it('malformed k (NaN) on the scoped path falls back to the default instead of looping forever', async () => {
    const hits = await search({
      query: 'guide section',
      k: NaN,
      minScore: 0,
      scopeGlobs: ['fixtures/guide-a.md'],
      configPath,
    })
    expect(hits.length).toBeLessThanOrEqual(5) // falls back to the k=5 default
    for (const hit of hits) {
      expect(hit.filePath).toBe('fixtures/guide-a.md')
    }
  })
})
