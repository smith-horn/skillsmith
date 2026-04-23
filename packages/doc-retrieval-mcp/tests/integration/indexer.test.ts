import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'

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
  'guide-c.md': [
    '# Guide C',
    '',
    '## Overview',
    '',
    'Guide C provides a high-level overview of the system architecture.',
    'This file is shorter than the others to test varied chunk counts.',
  ].join('\n'),
}

describe.skipIf(!nativeAvailable)('indexer integration (requires @ruvector/core native)', () => {
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
    // Disable CI guard and use fast mock embeddings for integration tests
    delete process.env.CI
    delete process.env.SKILLSMITH_CI
    process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS = 'true'

    tmpRoot = await mkdtemp(join(tmpdir(), 'doc-retrieval-int-'))
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

  it('full reindex indexes all 3 fixture files and produces chunks', async () => {
    const result = await runIndexer('full', { configPath })

    expect(result.mode).toBe('full')
    expect(result.filesScanned).toBe(3)
    expect(result.chunksUpserted).toBeGreaterThan(0)
    expect(result.chunksDeleted).toBe(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('second full reindex replaces all chunks (idempotent chunk count)', async () => {
    const first = await runIndexer('full', { configPath })
    resetConfigCache()
    const second = await runIndexer('full', { configPath })

    expect(second.filesScanned).toBe(first.filesScanned)
    expect(second.chunksUpserted).toBe(first.chunksUpserted)
  })

  it('writes state file with lastRunAt and chunksUpserted recorded', async () => {
    await runIndexer('full', { configPath })

    const stateFile = join(tmpRoot, '.ruvector', '.index-state.json')
    expect(existsSync(stateFile)).toBe(true)
    const state = JSON.parse(await (await import('node:fs/promises')).readFile(stateFile, 'utf8'))
    expect(state.lastRunAt).toBeTruthy()
    expect(state.corpusVersion).toBe(1)
    expect(Object.keys(state.chunkCountByFile).length).toBe(3)
  })

  it('incremental reindex with no prior state indexes all files', async () => {
    const result = await runIndexer('incremental', { configPath })

    expect(result.mode).toBe('incremental')
    expect(result.filesScanned).toBe(3)
    expect(result.chunksUpserted).toBeGreaterThan(0)
  })

  it('incremental after full only reindexes deleted file chunks', async () => {
    await runIndexer('full', { configPath })
    resetConfigCache()

    // Delete one fixture file
    const fixtureToDelete = join(tmpRoot, 'fixtures', 'guide-c.md')
    await unlink(fixtureToDelete)

    const result = await runIndexer('incremental', { configPath })
    // guide-c.md was deleted: its chunks are removed, no new ones for it
    expect(result.filesScanned).toBe(2) // guide-a and guide-b still present
  })

  it('refuses to run when CI=true', async () => {
    process.env.CI = 'true'
    await expect(runIndexer('full', { configPath })).rejects.toThrow(/refusing to run in CI/)
  })
})
