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

// SMI-5708 Item #7 -- when scopeGlobs narrows results, the vector DB's raw
// top-k can be dominated by out-of-scope hits, silently returning fewer than
// k in-scope results even when more exist beyond the unscoped top-K
// boundary. @ruvector/core's SearchQuery has an undocumented `filter` field
// (see ruvector-types.ts's module augmentation) that MIGHT support pushing
// the scope predicate into the DB query itself, but it ships with no
// documentation and an `unknown` type in the installed version -- verifying
// its real behavior would mean probing an unversioned native surface
// against a live index, which this pass doesn't do (same YAGNI stance
// ruvector-types.ts already takes on other unaugmented native surfaces).
// Adaptive over-fetch is the documented fallback and needs no assumptions
// about undocumented native-binding behavior: request progressively larger
// k until enough in-scope hits are found, the DB is exhausted (returns
// fewer than requested), or the ceiling is hit.
const SCOPE_OVERFETCH_MULTIPLIER = 4
const SCOPE_OVERFETCH_CEILING = 500

function buildHits(
  raw: Array<{ id: string; score: number; metadata?: string }>,
  opts: SearchOpts,
  minScore: number
): SearchHit[] {
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

    // SMI-4703 §1: hard-exclude any chunk that isn't provenance-tagged
    // 'tier-a' — a retrieval-set EXCLUSION, not a ranking penalty. This is
    // the SAME predicate rerank.ts applies, but rerank() is not on the live
    // call path (server.ts's skill_docs_search tool and
    // scripts/session-priming-query.ts — the actual session-priming
    // injection path this whole feature defends — both call search()
    // directly). Without this check here, a quarantined chunk would still
    // reach a real session even though rerank() would correctly exclude it
    // if anything called it. Fail-closed on omission: a missing/undefined
    // provenance_tier (a chunk that predates the field, or a corrupt/
    // truncated metadata blob) is excluded exactly like an explicit
    // 'quarantine' value, never defaulted to 'tier-a' by omission.
    if (meta.provenance_tier !== 'tier-a') continue

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

  const rawK = opts.k ?? 5
  // SMI-5708 Item #7 (Opus review finding): a malformed k (NaN, negative,
  // fractional) previously passed straight to a single db.search() call and
  // whatever came back, came back -- degraded output, but no hang. Once the
  // scoped path can loop, an unvalidated NaN k makes every break condition a
  // NaN comparison (all false) and `fetchK * MULTIPLIER` stays NaN forever,
  // turning malformed input into an infinite loop of real DB queries.
  // Mirrors rerank()'s topK guard from this same wave's Task #6.
  const k = Number.isFinite(rawK) && rawK >= 1 ? Math.floor(rawK) : 5
  const minScore = opts.minScore ?? DEFAULT_MIN_SIMILARITY
  const scoped = (opts.scopeGlobs?.length ?? 0) > 0

  let fetchK = k
  let hits: SearchHit[] = []
  for (;;) {
    const raw = await db.search({ vector: queryVec, k: fetchK })
    hits = buildHits(raw, opts, minScore)

    if (!scoped) break
    if (hits.length >= k) break
    if (raw.length < fetchK) break // DB exhausted -- more k won't yield more candidates
    if (fetchK >= SCOPE_OVERFETCH_CEILING) break

    fetchK = Math.min(fetchK * SCOPE_OVERFETCH_MULTIPLIER, SCOPE_OVERFETCH_CEILING)
  }

  return scoped ? hits.slice(0, k) : hits
}
