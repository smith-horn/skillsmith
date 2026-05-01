/**
 * SMI-4577: HNSW vs. brute-force microbench.
 *
 * Reports `bench()` timings for both backends. **Does NOT fail CI on
 * regression** — vitest's bench mode is reporting-only. The hard CI gate
 * lives in `hnsw-bench-gate.test.ts` which mirrors the same workload inside
 * a `test()` and asserts the 5x p99 + recall@10 + rss-delta thresholds.
 *
 * Memory tracked via `process.memoryUsage().rss` (NOT `heapUsed` — hnswlib's
 * graph lives in C++ memory and would undercount).
 *
 * Run: `docker exec skillsmith-dev-1 npm run bench:hnsw --workspace=@skillsmith/core`
 */

import { describe, bench, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { EmbeddingService } from '../../src/embeddings/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = resolve(__dirname, 'fixtures', '14k-bench.db')

// Forced to mock embeddings throughout — the bench exercises the search
// backend, not the model.
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

  // 50 random queries — enough samples for stable p99 without dominating
  // bench warmup. Pulled from the same vector space so neighbourhoods exist.
  const allEmbeddings = service.getAllEmbeddings()
  const embeddings = Array.from(allEmbeddings.values())
  for (let i = 0; i < 50; i++) {
    queryVectors.push(embeddings[(i * 271) % embeddings.length])
  }

  // Warm up the HNSW index so the bench measures steady-state search, not
  // first-call build cost.
  await service.findSimilar(queryVectors[0], 10)
})

afterAll(() => {
  service?.close()
})

describe('findSimilar @ 14k vectors', () => {
  bench(
    'brute-force findSimilar topK=10',
    () => {
      service.findSimilarBruteForce(
        queryVectors[Math.floor(Math.random() * queryVectors.length)],
        10
      )
    },
    { iterations: 100, warmupIterations: 10 }
  )

  bench(
    'hnsw findSimilar topK=10',
    async () => {
      await service.findSimilar(queryVectors[Math.floor(Math.random() * queryVectors.length)], 10)
    },
    { iterations: 100, warmupIterations: 10 }
  )
})
