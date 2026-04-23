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
import { resetConfigCache } from '../../src/config.js'
import { resetEmbedderCache } from '../../src/embedding.js'

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
})
