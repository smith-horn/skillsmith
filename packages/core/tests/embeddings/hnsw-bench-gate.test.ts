/**
 * SMI-4577: HNSW vs. brute-force CI gate.
 *
 * vitest's `bench()` blocks (in `hnsw-vs-brute-force.bench.ts`) report
 * timings but do NOT fail CI on regression. This test mirrors that bench
 * structure inside a `test()` so we get a hard gate:
 *
 *  - p99 HNSW × 5 < p99 brute-force
 *  - recall@10 ≥ 0.95
 *  - rss delta < 100MB after build
 *
 * Without this companion file the bench is decorative — see plan §"Bench gate".
 */

import { test, expect, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { EmbeddingService } from '../../src/embeddings/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = resolve(__dirname, 'fixtures', '14k-bench.db')

process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS = 'true'

let service: EmbeddingService
const queryVectors: Float32Array[] = []

async function ensureFixture(): Promise<void> {
  if (existsSync(FIXTURE_PATH)) return
  const seedScript = resolve(__dirname, 'seed-bench.ts')
  const result = spawnSync('npx', ['tsx', seedScript], {
    stdio: 'inherit',
    cwd: resolve(__dirname, '..', '..'),
  })
  if (result.status !== 0) {
    throw new Error(`seed-bench failed with exit code ${result.status}`)
  }
}

beforeAll(async () => {
  await ensureFixture()
  service = await EmbeddingService.create({ dbPath: FIXTURE_PATH, useFallback: true })
  const all = service.getAllEmbeddings()
  const embeddings = Array.from(all.values())
  for (let i = 0; i < 50; i++) {
    queryVectors.push(embeddings[(i * 271) % embeddings.length])
  }
  // Warm up so the gate measures steady-state, not first-call build cost.
  await service.findSimilar(queryVectors[0], 10)
}, 60_000)

afterAll(() => {
  service?.close()
})

test('HNSW must be ≥ 5x faster (p99) than brute-force AND recall@10 ≥ 0.95', async () => {
  const ITERATIONS = 100
  const TOP_K = 10

  // brute-force p99
  const bruteTimes: number[] = []
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint()
    service.findSimilarBruteForce(queryVectors[i % queryVectors.length], TOP_K)
    bruteTimes.push(Number(process.hrtime.bigint() - start) / 1_000_000)
  }

  // HNSW p99 (with rss delta)
  const rssBefore = process.memoryUsage().rss
  const hnswTimes: number[] = []
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint()
    await service.findSimilar(queryVectors[i % queryVectors.length], TOP_K)
    hnswTimes.push(Number(process.hrtime.bigint() - start) / 1_000_000)
  }
  const rssAfter = process.memoryUsage().rss

  bruteTimes.sort((a, b) => a - b)
  hnswTimes.sort((a, b) => a - b)
  const p99 = (arr: number[]): number => arr[Math.floor(arr.length * 0.99)] ?? arr.at(-1)!
  const p99Brute = p99(bruteTimes)
  const p99Hnsw = p99(hnswTimes)

  // recall@10 — score-tolerant. Mock embeddings produce many ties in the
  // top-10 cosine band (variants of the same template share most of their
  // text), so strict id matching undercounts. Treat an HNSW result as a
  // "hit" when its score is within 1e-6 of *any* score in the brute-force
  // top-10, which captures the semantic-equivalence intent of the gate.
  let recallSum = 0
  let recallCount = 0
  const SCORE_TIE_EPSILON = 1e-6
  for (let i = 0; i < Math.min(50, queryVectors.length); i++) {
    const brute = service.findSimilarBruteForce(queryVectors[i], TOP_K)
    const hnsw = await service.findSimilar(queryVectors[i], TOP_K)
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
    recallSum += hits / TOP_K
    recallCount++
  }
  const meanRecall = recallSum / Math.max(recallCount, 1)
  const rssDeltaMb = (rssAfter - rssBefore) / 1024 / 1024

  console.log(
    `[hnsw-bench-gate] p99 brute=${p99Brute.toFixed(3)}ms, ` +
      `p99 hnsw=${p99Hnsw.toFixed(3)}ms, ` +
      `speedup=${(p99Brute / Math.max(p99Hnsw, 0.001)).toFixed(2)}x, ` +
      `recall@10=${meanRecall.toFixed(3)}, ` +
      `rss delta=${rssDeltaMb.toFixed(1)}MB`
  )

  expect(p99Hnsw * 5).toBeLessThan(p99Brute)
  expect(meanRecall).toBeGreaterThanOrEqual(0.95)
  // rss can be negative under GC; clamp to assert "no runaway growth".
  expect(rssDeltaMb).toBeLessThan(100)
}, 120_000)
