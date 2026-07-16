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
    // SMI-4703 §3: CORPUS_VERSION bumped 1 -> 2 for the memory-injection-scanner rollout.
    expect(state.corpusVersion).toBe(2)
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

  // SMI-4703 §3: a version bump alone used to be a no-op — nothing compared
  // the persisted state.corpusVersion against the running CORPUS_VERSION
  // constant. This proves the fix: a stale on-disk corpusVersion forces a
  // full reindex even when the caller explicitly requests 'incremental'.
  it('forces a full reindex when persisted corpusVersion differs from CORPUS_VERSION', async () => {
    await runIndexer('full', { configPath })
    resetConfigCache()

    const stateFile = join(tmpRoot, '.ruvector', '.index-state.json')
    const { readFile: readFileFn, writeFile: writeFileFn } = await import('node:fs/promises')
    const state = JSON.parse(await readFileFn(stateFile, 'utf8')) as Record<string, unknown>
    // Simulate a pre-bump on-disk state (as if indexed under CORPUS_VERSION 1).
    state.corpusVersion = 1
    await writeFileFn(stateFile, JSON.stringify(state), 'utf8')

    const result = await runIndexer('incremental', { configPath })

    expect(result.mode).toBe('full')
    // A forced full reindex wipes the prior chunks before rebuilding, so
    // chunksDeleted reflects the wipe of the prior full run's output.
    expect(result.chunksDeleted).toBeGreaterThan(0)
    expect(result.filesScanned).toBe(3)

    const updated = JSON.parse(await readFileFn(stateFile, 'utf8')) as Record<string, unknown>
    expect(updated.corpusVersion).toBe(2)
  })

  it('does NOT force a full reindex when there is no prior state (fresh install)', async () => {
    // No prior runIndexer call in this test — stateAbs does not exist yet.
    const result = await runIndexer('incremental', { configPath })
    expect(result.mode).toBe('incremental')
  })

  it('does NOT force a full reindex when persisted corpusVersion already matches', async () => {
    await runIndexer('full', { configPath })
    resetConfigCache()

    const result = await runIndexer('incremental', { configPath })
    expect(result.mode).toBe('incremental')
  })
})
