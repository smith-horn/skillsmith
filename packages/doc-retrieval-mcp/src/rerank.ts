/**
 * SMI-4450 Wave 1 Step 6 — local deterministic re-ranker.
 *
 * Two responsibilities:
 *   1. **Absorption + supersession penalties (always applied).** Reads
 *      `hit.meta?.absorbed_by` / `hit.meta?.supersedes` populated by the retro
 *      frontmatter (SMI-4451 Step 5) and demotes superseded lessons.
 *   2. **Phase 2 fallback (env-gated).** When
 *      `SKILLSMITH_DOC_RETRIEVAL_RERANK=bm25`, layers BM25 keyword rescore +
 *      min-max normalize + 0.6/0.4 combine + MMR (λ=0.5) iterative top-5 over
 *      the input pool. Wave 1 production stays on Phase 1 (pure embedding +
 *      penalties) unless Step 8 6-pair regression fails ≥5/6.
 *
 * Caller contract: invoke `search({ query, k: 20, preRerank: true })` to get
 * the raw top-20 pool, hand to `rerank(hits, query)`, then apply minScore=0.35
 * and truncate to k=5. Per SPARC §S6 plan-review H3, the minScore filter runs
 * AFTER rerank (not before) so absorbed-but-still-relevant hits clear the
 * 0.35 floor via the demotion-cap path rather than being evicted pre-score.
 *
 * Deliberate design tradeoffs:
 *   - BM25 IDF is computed from the input pool (not the global corpus). With
 *     N=20 the rare-term IDF signal is muted but BM25's TF + length-norm still
 *     produces meaningful relative ordering. Global IDF would require
 *     metadata-store I/O on every rerank call; the per-batch approximation
 *     keeps `rerank.ts` self-contained and ships Phase 2 today. Upgrade path:
 *     precompute global IDF in indexer, write to `<storagePath>/idf.json`,
 *     load lazily here behind the same env flag.
 *   - Phase 2 is env-gated, not opts-gated — this matches §S6's "fallback
 *     triggered by regression test failure only". An ops switch (env) is
 *     correct; a per-call flag would invite drift.
 */

import type { SearchHit } from './types.js'

// Absorption demotion cap (SMI-4450 plan-review M3): replace hard ×0.3 multiply
// with `min(similarity * 0.5, 0.5)` so a high-similarity absorbed chunk still
// clears the 0.35 minScore and renders below the canonical artifact rather
// than being evicted entirely.
const ABSORPTION_HALVE_FACTOR = 0.5
const ABSORPTION_CEILING = 0.5

// Supersession penalty (no floor cap): supersession implies the replacement
// IS in the index and will rank above the superseded entry, so a clean halve
// is sufficient.
const SUPERSESSION_HALVE_FACTOR = 0.5

// Phase 2 BM25 constants per SPARC §S6.
const BM25_K1 = 1.5
const BM25_B = 0.75

// Phase 2 combination weights per SPARC §S6 ("combined = 0.6 * normalize(emb) + 0.4 * normalize(bm25)").
const EMB_WEIGHT = 0.6
const BM25_WEIGHT = 0.4

// Phase 2 MMR diversity coefficient per SPARC §S6 (λ=0.5).
const MMR_LAMBDA = 0.5

// Phase 2 selection cap (rerank pool → top-5 before caller applies minScore).
const MMR_TOP_K = 5

/**
 * Apply Wave 1 ranking adjustments to a pool of hits.
 *
 * Always applies absorption + supersession penalties. Adds Phase 2 BM25+MMR
 * when `SKILLSMITH_DOC_RETRIEVAL_RERANK === 'bm25'`. Returns hits sorted by
 * adjusted score descending; caller is responsible for the post-rerank
 * minScore filter and final truncate.
 */
export function rerank(hits: SearchHit[], query: string): SearchHit[] {
  if (hits.length === 0) return []

  const adjusted = hits.map(applyPenalties)

  if (process.env.SKILLSMITH_DOC_RETRIEVAL_RERANK === 'bm25') {
    return phase2BM25MMR(adjusted, query)
  }

  return [...adjusted].sort((a, b) => b.score - a.score)
}

/**
 * Apply absorption + supersession penalties to a single hit.
 *
 * Returns a NEW hit with `score` rewritten and `similarity` preserved (so
 * downstream consumers can still see the raw embedding signal). When neither
 * penalty applies, returns a structurally-equal copy with `score === similarity`
 * (already true by construction in `search.ts`).
 */
function applyPenalties(hit: SearchHit): SearchHit {
  const absorbed = hit.meta?.absorbed_by
  const supersedes = hit.meta?.supersedes

  let score = hit.similarity
  if (typeof absorbed === 'string' && absorbed.length > 0) {
    score = Math.min(hit.similarity * ABSORPTION_HALVE_FACTOR, ABSORPTION_CEILING)
  } else if (typeof supersedes === 'string' && supersedes.length > 0) {
    score = hit.similarity * SUPERSESSION_HALVE_FACTOR
  }

  return { ...hit, score }
}

/**
 * Phase 2 BM25 + MMR fallback. Operates over the already-penalty-adjusted pool.
 */
function phase2BM25MMR(hits: SearchHit[], query: string): SearchHit[] {
  const queryTokens = tokenize(query)
  const docs = hits.map((h) => tokenize(h.text))
  const idf = buildIdf(docs)
  const avgDocLen = docs.reduce((s, d) => s + d.length, 0) / Math.max(docs.length, 1)

  const bm25Scores = docs.map((d) => bm25Score(queryTokens, d, idf, avgDocLen))
  const embScores = hits.map((h) => h.score)

  const normEmb = minMaxNormalize(embScores)
  const normBM25 = minMaxNormalize(bm25Scores)

  const combined = hits.map((_, i) => EMB_WEIGHT * normEmb[i] + BM25_WEIGHT * normBM25[i])

  return mmrSelect(hits, docs, combined, MMR_LAMBDA, MMR_TOP_K)
}

/** Lowercase + whitespace + strip non-alphanumerics (apostrophes drop). */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

/** Document-frequency IDF over a per-batch corpus (Robertson/Spärck-Jones form). */
export function buildIdf(docs: string[][]): Map<string, number> {
  const N = docs.length
  const df = new Map<string, number>()
  for (const doc of docs) {
    const seen = new Set(doc)
    for (const term of seen) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }
  const idf = new Map<string, number>()
  for (const [term, freq] of df) {
    // log((N - df + 0.5) / (df + 0.5) + 1) — non-negative variant
    idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1))
  }
  return idf
}

export function bm25Score(
  queryTokens: string[],
  docTokens: string[],
  idf: Map<string, number>,
  avgDocLen: number
): number {
  if (docTokens.length === 0) return 0
  const tf = new Map<string, number>()
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1)

  let score = 0
  const lenNorm = 1 - BM25_B + BM25_B * (docTokens.length / Math.max(avgDocLen, 1))
  for (const q of queryTokens) {
    const f = tf.get(q) ?? 0
    if (f === 0) continue
    const qIdf = idf.get(q) ?? 0
    score += qIdf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * lenNorm))
  }
  return score
}

export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  if (span === 0) return values.map(() => 0)
  return values.map((v) => (v - min) / span)
}

/**
 * MMR selection: iteratively pick the candidate maximizing
 * `λ * combined[i] - (1-λ) * max(sim(i, picked))` until top-k filled. `sim`
 * is Jaccard over token sets — bag-of-words proxy that avoids re-embedding.
 */
function mmrSelect(
  hits: SearchHit[],
  docs: string[][],
  combined: number[],
  lambda: number,
  k: number
): SearchHit[] {
  const n = hits.length
  const target = Math.min(k, n)
  const picked: number[] = []
  const remaining = new Set<number>(hits.map((_, i) => i))

  while (picked.length < target && remaining.size > 0) {
    let bestIdx = -1
    let bestScore = -Infinity
    for (const i of remaining) {
      const diversity =
        picked.length === 0 ? 0 : Math.max(...picked.map((p) => jaccard(docs[i], docs[p])))
      const mmr = lambda * combined[i] - (1 - lambda) * diversity
      if (mmr > bestScore) {
        bestScore = mmr
        bestIdx = i
      }
    }
    if (bestIdx === -1) break
    picked.push(bestIdx)
    remaining.delete(bestIdx)
  }
  return picked.map((i) => ({ ...hits[i], score: combined[i] }))
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a)
  const B = new Set(b)
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  const union = A.size + B.size - inter
  return union === 0 ? 0 : inter / union
}
