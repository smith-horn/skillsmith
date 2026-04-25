import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { minimatch } from 'minimatch'
import './ruvector-types.js'
// @ruvector/core is CJS; ESM named imports fail at runtime in Node.js v22.
const { VectorDb } = createRequire(import.meta.url)(
  '@ruvector/core'
) as typeof import('@ruvector/core')
import { loadConfig, resolveRepoPath, DEFAULT_MIN_SIMILARITY } from './config.js'
import { embedBatch } from './embedding.js'
import type { ChunkStoredMetadata, SearchHit } from './types.js'

export interface SearchOpts {
  query: string
  k?: number
  minScore?: number
  scopeGlobs?: string[]
  configPath?: string
  /**
   * Skip the post-distance minScore filter and return the raw top-k pool
   * (SMI-4450 Wave 1 Step 6 — plan-review H3). Caller hands the pool to
   * `rerank()` and applies `minScore` AFTER ranking adjustments. Without
   * this flag, an absorbed-but-still-relevant chunk could be evicted before
   * the demotion-cap path could keep it in the result set.
   */
  preRerank?: boolean
}

/**
 * Map an @ruvector/core SearchResult.score value (cosine DISTANCE in [0, 2],
 * lower is better — the backing crate is `anndists::DistCosine`) to a
 * similarity in [0, 1] where 1 = best match.
 *
 * Slightly-negative inputs (float32 precision artifacts from the native
 * binding) clamp to 1.0 — the best-match end — NOT 0.0. Distances > 2 clamp
 * to 0.0 (orthogonal / opposite).
 *
 * See docs/internal/implementation/smi-4426-ruvector-runtime-fix.md §What
 * Changes §1 for the semantic-inversion rationale. PR #722's `SearchHit.score`
 * held raw distance mislabeled as similarity; this helper restores correctness
 * at the API boundary.
 */
export function distanceToSimilarity(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance / 2))
}

type StoredMetadata = ChunkStoredMetadata

export async function search(opts: SearchOpts): Promise<SearchHit[]> {
  const cfg = await loadConfig(opts.configPath)
  const storageAbs = resolveRepoPath(cfg.storagePath)
  const vectorsFile = join(storageAbs, 'vectors')

  if (!existsSync(vectorsFile)) return []

  const db = new VectorDb({
    dimensions: cfg.embeddingDim,
    storagePath: vectorsFile,
    distanceMetric: 'Cosine',
  })

  const queryVecs = await embedBatch([opts.query])
  const queryVec = new Float32Array(queryVecs[0])

  const k = opts.k ?? 5
  const minScore = opts.minScore ?? DEFAULT_MIN_SIMILARITY

  const raw = await db.search({ vector: queryVec, k })

  const hits: SearchHit[] = []
  for (const result of raw) {
    const similarity = distanceToSimilarity(result.score)
    if (!opts.preRerank && similarity < minScore) continue

    let meta: StoredMetadata
    try {
      meta = JSON.parse(result.metadata ?? '{}') as StoredMetadata
    } catch {
      continue
    }

    if (!meta.file_path) continue

    if (opts.scopeGlobs && opts.scopeGlobs.length > 0) {
      const matches = opts.scopeGlobs.some((g) => minimatch(meta.file_path, g, { dot: true }))
      if (!matches) continue
    }

    const id = String(result.id)
    hits.push({
      id,
      filePath: meta.file_path,
      lineStart: meta.line_start,
      lineEnd: meta.line_end,
      headingChain: meta.heading_chain ?? [],
      text: meta.text,
      similarity,
      score: similarity,
      meta,
    })
  }

  return hits
}
