/**
 * @fileoverview VariantSelector — Pareto frontier selection for skill variants
 * @module @skillsmith/core/evaluation/VariantSelector
 * @see SMI-3297: Select non-dominated variants by accuracy vs cost
 *
 * Pareto dominance: A dominates B if A.accuracy >= B.accuracy AND A.cost <= B.cost
 * with at least one strict inequality.
 * Tiebreaker: prefer smaller skillSize (fewer tokens in context).
 */

import type { ScoredVariant } from './types.js'

export class VariantSelector {
  /**
   * Select top non-dominated variants from candidates.
   * Returns at most `frontierSize` variants from the Pareto frontier.
   *
   * @param candidates - Scored variants to select from
   * @param frontierSize - Maximum number of variants to retain
   * @returns Non-dominated variants, sorted by accuracy descending
   */
  select(candidates: ScoredVariant[], frontierSize: number): ScoredVariant[] {
    if (candidates.length === 0) return []
    if (candidates.length <= frontierSize) {
      return this.filterDominated(candidates)
    }

    const frontier = this.filterDominated(candidates)

    if (frontier.length <= frontierSize) return frontier

    // More non-dominated than we need — pick by accuracy + tiebreak on skillSize
    return frontier
      .sort((a, b) => {
        const accDiff = b.accuracy - a.accuracy
        if (Math.abs(accDiff) > 1e-9) return accDiff
        return a.skillSize - b.skillSize
      })
      .slice(0, frontierSize)
  }

  /**
   * Remove dominated variants from the set.
   * A variant is dominated if any other variant has >= accuracy AND <= cost
   * with at least one strict inequality.
   */
  private filterDominated(candidates: ScoredVariant[]): ScoredVariant[] {
    return candidates.filter((candidate, _i) => {
      return !candidates.some(
        (other) =>
          other !== candidate &&
          other.accuracy >= candidate.accuracy &&
          other.cost <= candidate.cost &&
          (other.accuracy > candidate.accuracy || other.cost < candidate.cost)
      )
    })
  }
}
