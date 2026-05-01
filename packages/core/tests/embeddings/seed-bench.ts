/**
 * SMI-4577: Seed a synthetic 14k-skill embedding fixture for the HNSW bench.
 *
 * Generates deterministic mock embeddings via `EmbeddingService` (with
 * `SKILLSMITH_USE_MOCK_EMBEDDINGS=true` for speed) and writes them to a
 * SQLite cache that the bench reads back without network/model load.
 *
 * Run via: `npm run bench:hnsw:seed --workspace=@skillsmith/core`
 *
 * The fixture is gitignored (see top-level `.gitignore`) so each environment
 * regenerates it on first bench run. CI invokes this as a `pretest` hook so
 * the bench can boot from a clean checkout.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EmbeddingService } from '../../src/embeddings/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = resolve(__dirname, 'fixtures', '14k-bench.db')
const TARGET_COUNT = 14_000

async function main(): Promise<void> {
  // Force mock-embedding mode so the seed runs in <1s instead of pulling
  // the all-MiniLM-L6-v2 model. The bench reads vectors back as raw
  // Float32Array — semantic correctness is checked separately in the
  // integration test.
  process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS = 'true'

  mkdirSync(dirname(FIXTURE_PATH), { recursive: true })
  if (existsSync(FIXTURE_PATH)) {
    rmSync(FIXTURE_PATH)
  }

  const service = await EmbeddingService.create({ dbPath: FIXTURE_PATH, useFallback: true })

  // Generate 14k synthetic skills. We oversample 100 base templates with
  // numeric suffixes so vectors form natural clusters (a few "neighbours"
  // per query) rather than uniform random — gives the bench a realistic
  // recall workload.
  const templates = Array.from({ length: 100 }, (_, i) => ({
    id: `template-${i}`,
    text: `Skill template ${i}: testing automation framework category ${i % 12} ${i % 7}`,
  }))

  const skills: Array<{ id: string; text: string }> = []
  for (let i = 0; i < TARGET_COUNT; i++) {
    const t = templates[i % templates.length]
    skills.push({
      id: `${t.id}-variant-${Math.floor(i / templates.length)}`,
      text: `${t.text} variant ${i}`,
    })
  }

  const start = Date.now()
  const batch = await service.embedBatch(skills.map(({ id, text }) => ({ id, text })))
  for (const { skillId, embedding, text } of batch) {
    service.storeEmbedding(skillId, embedding, text)
  }
  const elapsedMs = Date.now() - start

  service.close()

  console.log(`[seed-bench] wrote ${batch.length} embeddings to ${FIXTURE_PATH} in ${elapsedMs}ms`)
}

main().catch((err) => {
  console.error('[seed-bench] failed:', err)
  process.exit(1)
})
