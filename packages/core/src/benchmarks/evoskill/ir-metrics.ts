// IR metrics for EvoSkill benchmark evaluation
// Implements nDCG, MRR, MAP, Precision@k, and Recall@k

/**
 * Discounted Cumulative Gain at position k.
 * Uses the standard log2(i+1) discount factor.
 */
function dcgAtK(ranked: string[], relevance: Map<string, number>, k: number): number {
  let dcg = 0
  const limit = Math.min(k, ranked.length)
  for (let i = 0; i < limit; i++) {
    const rel = relevance.get(ranked[i]) ?? 0
    dcg += rel / Math.log2(i + 2) // i+2 because log2(1) = 0
  }
  return dcg
}

/**
 * Normalized Discounted Cumulative Gain at position k.
 * Measures ranking quality with graded relevance.
 * Returns 0 if no relevant items exist.
 */
export function ndcg(ranked: string[], relevance: Map<string, number>, k: number): number {
  if (ranked.length === 0 || relevance.size === 0) return 0

  const actual = dcgAtK(ranked, relevance, k)

  // Ideal ranking: sort all items by relevance descending
  const idealRanked = [...relevance.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)

  const ideal = dcgAtK(idealRanked, relevance, k)
  if (ideal === 0) return 0

  return actual / ideal
}

/**
 * Mean Reciprocal Rank.
 * Returns 1/rank of the first relevant result, or 0 if none found.
 */
export function mrr(ranked: string[], relevant: Set<string>): number {
  if (ranked.length === 0 || relevant.size === 0) return 0

  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i])) {
      return 1 / (i + 1)
    }
  }
  return 0
}

/**
 * Mean Average Precision at k.
 * Computes average precision over positions up to k.
 */
export function mapAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (ranked.length === 0 || relevant.size === 0) return 0

  let hits = 0
  let sumPrecision = 0
  const limit = Math.min(k, ranked.length)

  for (let i = 0; i < limit; i++) {
    if (relevant.has(ranked[i])) {
      hits++
      sumPrecision += hits / (i + 1)
    }
  }

  // Normalize by total relevant items (not k)
  return hits > 0 ? sumPrecision / relevant.size : 0
}

/**
 * Precision at k.
 * Fraction of top-k results that are relevant.
 */
export function precisionAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (ranked.length === 0 || relevant.size === 0) return 0

  const limit = Math.min(k, ranked.length)
  let hits = 0

  for (let i = 0; i < limit; i++) {
    if (relevant.has(ranked[i])) {
      hits++
    }
  }

  return hits / limit
}

/**
 * Recall at k.
 * Fraction of relevant items found in top-k results.
 */
export function recallAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (ranked.length === 0 || relevant.size === 0) return 0

  const limit = Math.min(k, ranked.length)
  let hits = 0

  for (let i = 0; i < limit; i++) {
    if (relevant.has(ranked[i])) {
      hits++
    }
  }

  return hits / relevant.size
}
