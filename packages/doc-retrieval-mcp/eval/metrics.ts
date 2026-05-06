/**
 * SMI-4702 — Retrieval eval harness metrics.
 *
 * Pure-TS computation of Recall@K, MRR, and nDCG@K over a set of RunResult
 * structs. No external deps beyond Node built-ins. All functions are exported
 * so tests can exercise each independently.
 *
 * Relevance model: binary single-relevance per query. A hit is relevant if
 * its filePath substring-matches (or exactly matches) any expectedChunk for
 * that query. IDCG = 1/log2(2) = 1 (ideal: first position is relevant).
 *
 * Contract with eval-runner.ts:
 *   1. build RunResult[] from search output
 *   2. call computeMetrics(results) → MetricsReport
 *   3. print or persist MetricsReport
 */

export interface ExpectedChunk {
  filePath: string
  matchType: 'substring' | 'exact'
}

export interface GoldEntry {
  id: string
  category: string
  query: string
  expectedChunks: ExpectedChunk[]
  rationale: string
  difficulty: 'easy' | 'medium' | 'hard'
}

export interface HitResult {
  filePath: string
}

export interface RunResult {
  id: string
  query: string
  category: string
  difficulty: 'easy' | 'medium' | 'hard'
  hits: HitResult[]
  expectedChunks: ExpectedChunk[]
}

export interface MetricSet {
  recallAt5: number
  recallAt10: number
  mrr: number
  ndcgAt10: number
  count: number
}

export interface MetricsReport {
  overall: MetricSet
  byCategory: Record<string, MetricSet>
  byDifficulty: Record<string, MetricSet>
}

/**
 * Return true if `hit` satisfies at least one entry in `expected`.
 * Substring match: hit.filePath.includes(expected.filePath).
 * Exact match: hit.filePath === expected.filePath.
 */
export function isHitRelevant(hit: HitResult, expected: ExpectedChunk[]): boolean {
  return expected.some((e) => {
    if (e.matchType === 'exact') return hit.filePath === e.filePath
    return hit.filePath.includes(e.filePath)
  })
}

/**
 * Mean Recall@K across all results.
 * Per-query: 1 if any hit in top-K is relevant, else 0.
 */
export function recallAtK(results: RunResult[], k: number): number {
  if (results.length === 0) return 0
  let totalRecall = 0
  for (const r of results) {
    const topK = r.hits.slice(0, k)
    const relevant = topK.some((h) => isHitRelevant(h, r.expectedChunks))
    totalRecall += relevant ? 1 : 0
  }
  return totalRecall / results.length
}

/**
 * Mean Reciprocal Rank (MRR) across all results.
 * Per-query: 1/rank of the first relevant hit in top-10, 0 if none.
 */
export function mrr(results: RunResult[]): number {
  if (results.length === 0) return 0
  let totalRR = 0
  for (const r of results) {
    const top10 = r.hits.slice(0, 10)
    const firstRelevantIdx = top10.findIndex((h) => isHitRelevant(h, r.expectedChunks))
    if (firstRelevantIdx !== -1) {
      totalRR += 1 / (firstRelevantIdx + 1)
    }
  }
  return totalRR / results.length
}

/**
 * Mean nDCG@K across all results.
 *
 * Binary single-relevance model:
 *   DCG@K = Σ_i (gain_i / log2(rank_i + 1))
 *   gain_i = 1 if hit at rank i (1-indexed) is the first relevant hit, else 0.
 *   IDCG   = 1 / log2(2) = 1 (ideal: first position is relevant).
 *
 * Only the first relevant hit contributes gain (binary single-relevance).
 * nDCG = DCG / IDCG = DCG (since IDCG = 1).
 */
export function ndcgAtK(results: RunResult[], k: number): number {
  if (results.length === 0) return 0
  const IDCG = 1 / Math.log2(2) // = 1.0
  let totalNdcg = 0
  for (const r of results) {
    const topK = r.hits.slice(0, k)
    const firstRelevantIdx = topK.findIndex((h) => isHitRelevant(h, r.expectedChunks))
    let dcg = 0
    if (firstRelevantIdx !== -1) {
      const rank = firstRelevantIdx + 1 // 1-indexed
      dcg = 1 / Math.log2(rank + 1)
    }
    totalNdcg += dcg / IDCG
  }
  return totalNdcg / results.length
}

function computeMetricSet(results: RunResult[]): MetricSet {
  return {
    recallAt5: recallAtK(results, 5),
    recallAt10: recallAtK(results, 10),
    mrr: mrr(results),
    ndcgAt10: ndcgAtK(results, 10),
    count: results.length,
  }
}

/**
 * Compute overall, per-category, and per-difficulty metrics from RunResult[].
 */
export function computeMetrics(results: RunResult[]): MetricsReport {
  const overall = computeMetricSet(results)

  const categoryMap = new Map<string, RunResult[]>()
  const difficultyMap = new Map<string, RunResult[]>()

  for (const r of results) {
    const catBucket = categoryMap.get(r.category) ?? []
    catBucket.push(r)
    categoryMap.set(r.category, catBucket)

    const diffBucket = difficultyMap.get(r.difficulty) ?? []
    diffBucket.push(r)
    difficultyMap.set(r.difficulty, diffBucket)
  }

  const byCategory: Record<string, MetricSet> = {}
  for (const [cat, bucket] of categoryMap) {
    byCategory[cat] = computeMetricSet(bucket)
  }

  const byDifficulty: Record<string, MetricSet> = {}
  for (const [diff, bucket] of difficultyMap) {
    byDifficulty[diff] = computeMetricSet(bucket)
  }

  return { overall, byCategory, byDifficulty }
}
