// SMI-4426 Wave 2 Step 1: distanceToSimilarity helper landed alongside the
// remaining throw-stub. Pure utility, no egress surface — parallel-safe with
// the SMI-4427 Ruflo per-tool denial gate. The search() function stays
// blocked until Wave 2 Step 3 wires the real query path (gated on SMI-4427
// merge per the Specification).

import type { SearchHit } from './types.js'

export interface SearchOpts {
  query: string
  k?: number
  minScore?: number
  scopeGlobs?: string[]
  configPath?: string
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

const RUVECTOR_BLOCKED =
  'doc-retrieval: search() is gated on SMI-4427 (Ruflo per-tool denial). ' +
  'See docs/internal/implementation/smi-4426-ruvector-runtime-fix.md Wave 2 ' +
  'Step 3. Steps 1-2 land parallel-safely; Step 3+ egress work follows the gate.'

export async function search(_opts: SearchOpts): Promise<SearchHit[]> {
  throw new Error(RUVECTOR_BLOCKED)
}
