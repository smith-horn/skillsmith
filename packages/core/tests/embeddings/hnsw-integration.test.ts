/**
 * SMI-4577: HNSW + EmbeddingService integration test.
 *
 * Asserts:
 *  - `findSimilar` returns the same top-1 as the brute-force fallback
 *  - recall@10 ≥ 0.95 across 50 query iterations
 *  - the on-disk cache (`~/.skillsmith/cache/hnsw-{model}.bin`) is created
 *    after first call
 *  - deleting the cache forces a rebuild on the next call (no crash)
 *
 * Uses a temp `HOME` to keep the cache out of the user's real `~/.skillsmith/`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EmbeddingService } from '../../src/embeddings/index.js'

const MODEL_NAME_SAFE = 'Xenova__all-MiniLM-L6-v2'

// SMI-4691: hnswlib-node is an optionalDependency. When the native binding is
// unavailable (e.g. macOS host without the postinstall step), EmbeddingService
// silently falls through to brute-force and never persists a cache file. The
// cache-write assertion is only meaningful when HNSW is actually loaded.
const HNSW_AVAILABLE = (() => {
  try {
    createRequire(import.meta.url)('hnswlib-node')
    return true
  } catch {
    return false
  }
})()

describe('HNSW + EmbeddingService integration (SMI-4577)', () => {
  let tmpHome: string
  let originalHome: string | undefined
  let originalCacheOverride: string | undefined
  let service: EmbeddingService
  let dbPath: string

  beforeEach(async () => {
    tmpHome = join(
      tmpdir(),
      `skillsmith-hnsw-int-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    mkdirSync(tmpHome, { recursive: true })
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
    // SMI-4691: HOME stub is ignored by os.homedir() on macOS (getpwuid path).
    // Pin getCacheDir() to the temp tree explicitly via the override env.
    originalCacheOverride = process.env.SKILLSMITH_CACHE_DIR_OVERRIDE
    process.env.SKILLSMITH_CACHE_DIR_OVERRIDE = join(tmpHome, '.skillsmith', 'cache')
    process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS = 'true'
    delete process.env.SKILLSMITH_USE_HNSW

    dbPath = join(tmpHome, 'skills.db')
    service = await EmbeddingService.create({ dbPath, useFallback: true })

    // Seed 100 deterministic embeddings.
    const skills = Array.from({ length: 100 }, (_, i) => ({
      id: `skill-${i}`,
      text: `Skill ${i} category ${i % 7} description ${i % 13}`,
    }))
    const batch = await service.embedBatch(skills)
    for (const { skillId, embedding, text } of batch) {
      service.storeEmbedding(skillId, embedding, text)
    }
  })

  afterEach(() => {
    service?.close()
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
    if (originalCacheOverride !== undefined) {
      process.env.SKILLSMITH_CACHE_DIR_OVERRIDE = originalCacheOverride
    } else {
      delete process.env.SKILLSMITH_CACHE_DIR_OVERRIDE
    }
    if (existsSync(tmpHome)) {
      try {
        rmSync(tmpHome, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
  })

  it('findSimilar produces deterministic top-1 matching brute-force', async () => {
    const all = service.getAllEmbeddings()
    const someVector = Array.from(all.values())[0]
    const hnsw = await service.findSimilar(someVector, 10)
    const brute = service.findSimilarBruteForce(someVector, 10)
    expect(hnsw.length).toBe(brute.length)
    expect(hnsw[0]?.skillId).toBe(brute[0]?.skillId)
  })

  it('recall@10 ≥ 0.95 across 50 query iterations (score-tolerant)', async () => {
    // Mock embeddings produce many tied cosine scores in the top-10 band
    // (variants of the same template share most of their text). Treat
    // HNSW hits within `1e-6` of any brute-force top-10 score as
    // semantically equivalent to capture the intent of the gate.
    const all = service.getAllEmbeddings()
    const vectors = Array.from(all.values())
    let sum = 0
    let count = 0
    const SCORE_TIE_EPSILON = 1e-6
    for (let i = 0; i < 50; i++) {
      const q = vectors[(i * 31) % vectors.length]
      const brute = service.findSimilarBruteForce(q, 10)
      const hnsw = await service.findSimilar(q, 10)
      const bruteIds = new Set(brute.map((r) => r.skillId))
      const bruteScores = brute.map((r) => r.score)
      let hits = 0
      for (const r of hnsw) {
        if (bruteIds.has(r.skillId)) {
          hits++
        } else if (bruteScores.some((s) => Math.abs(s - r.score) < SCORE_TIE_EPSILON)) {
          hits++
        }
      }
      sum += hits / 10
      count++
    }
    expect(sum / count).toBeGreaterThanOrEqual(0.95)
  })

  it.skipIf(!HNSW_AVAILABLE)(
    'writes ~/.skillsmith/cache/hnsw-{model}.bin after first call',
    async () => {
      const all = service.getAllEmbeddings()
      const someVector = Array.from(all.values())[0]
      await service.findSimilar(someVector, 10)
      // Force the debounced persist.
      service.close()
      const cacheBin = join(tmpHome, '.skillsmith', 'cache', `hnsw-${MODEL_NAME_SAFE}.bin`)
      expect(existsSync(cacheBin)).toBe(true)
    }
  )

  it('rebuilds index when cache is deleted (no crash)', async () => {
    const all = service.getAllEmbeddings()
    const someVector = Array.from(all.values())[0]
    await service.findSimilar(someVector, 10)
    service.close()

    const cacheBin = join(tmpHome, '.skillsmith', 'cache', `hnsw-${MODEL_NAME_SAFE}.bin`)
    if (existsSync(cacheBin)) {
      unlinkSync(cacheBin)
    }

    // New service should rebuild from SQLite without erroring.
    const service2 = await EmbeddingService.create({ dbPath, useFallback: true })
    const result = await service2.findSimilar(someVector, 10)
    expect(result.length).toBeGreaterThan(0)
    service2.close()
  })

  it('honours SKILLSMITH_USE_HNSW=false (brute-force only path)', async () => {
    process.env.SKILLSMITH_USE_HNSW = 'false'
    try {
      const all = service.getAllEmbeddings()
      const someVector = Array.from(all.values())[0]
      const result = await service.findSimilar(someVector, 5)
      expect(result.length).toBe(5)
    } finally {
      delete process.env.SKILLSMITH_USE_HNSW
    }
  })
})
