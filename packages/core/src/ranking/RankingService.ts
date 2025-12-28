/**
 * SMI-629: Skill Ranking Algorithm
 *
 * Multi-factor ranking that combines:
 * - Semantic relevance from search (BM25/vector similarity)
 * - GitHub popularity (stars, forks)
 * - Recency scoring (last updated)
 * - Trust tier multipliers
 * - Quality score integration
 */

import type { TrustTier, Skill, SearchResult } from '../types/skill.js'

/**
 * Extended skill data with GitHub metrics for ranking
 */
export interface RankableSkill extends Skill {
  stars?: number
  forks?: number
  lastUpdatedAt?: string
}

/**
 * Ranking weights configuration
 */
export interface RankingWeights {
  relevance: number // BM25/semantic score weight
  popularity: number // Stars/forks weight
  recency: number // Last updated weight
  quality: number // Quality score weight
  trustTier: number // Trust tier multiplier weight
}

/**
 * Default ranking weights
 */
export const DEFAULT_WEIGHTS: RankingWeights = {
  relevance: 0.4, // 40% from search relevance
  popularity: 0.2, // 20% from GitHub popularity
  recency: 0.15, // 15% from recency
  quality: 0.15, // 15% from quality score
  trustTier: 0.1, // 10% from trust tier
}

/**
 * Trust tier multipliers for scoring
 */
export const TRUST_TIER_MULTIPLIERS: Record<TrustTier, number> = {
  verified: 1.0, // Full weight for verified skills
  community: 0.85, // 85% for community-reviewed
  experimental: 0.6, // 60% for experimental
  unknown: 0.4, // 40% for unknown/unverified
}

/**
 * Score breakdown for debugging/transparency
 */
export interface ScoreBreakdown {
  relevance: number
  popularity: number
  recency: number
  quality: number
  trustTier: number
  final: number
}

/**
 * Ranked search result with score breakdown
 */
export interface RankedResult {
  skill: Skill
  score: number
  breakdown: ScoreBreakdown
  highlights: SearchResult['highlights']
}

/**
 * Options for ranking configuration
 */
export interface RankingOptions {
  weights?: Partial<RankingWeights>
  maxStars?: number // Cap for star normalization (default 10000)
  maxForks?: number // Cap for fork normalization (default 2000)
  recencyDays?: number // Days to consider for recency (default 365)
}

/**
 * RankingService implements multi-factor ranking for skill search results
 */
export class RankingService {
  private readonly weights: RankingWeights
  private readonly maxStars: number
  private readonly maxForks: number
  private readonly recencyDays: number

  constructor(options?: RankingOptions) {
    this.weights = { ...DEFAULT_WEIGHTS, ...options?.weights }
    this.maxStars = options?.maxStars ?? 10000
    this.maxForks = options?.maxForks ?? 2000
    this.recencyDays = options?.recencyDays ?? 365

    // Validate weights sum to ~1.0
    const sum = Object.values(this.weights).reduce((a, b) => a + b, 0)
    if (Math.abs(sum - 1.0) > 0.01) {
      console.warn(`RankingService: weights sum to ${sum}, expected 1.0`)
    }
  }

  /**
   * Rank a list of search results
   */
  rank(results: SearchResult[], skillData?: Map<string, RankableSkill>): RankedResult[] {
    const ranked = results.map((result) => {
      const extendedData = skillData?.get(result.skill.id)
      return this.scoreResult(result, extendedData)
    })

    // Sort by final score descending
    return ranked.sort((a, b) => b.score - a.score)
  }

  /**
   * Re-rank results with additional data (e.g., after fetching GitHub metrics)
   */
  rerank(results: RankedResult[], updatedData: Map<string, RankableSkill>): RankedResult[] {
    const searchResults: SearchResult[] = results.map((r) => ({
      skill: r.skill,
      rank: r.breakdown.relevance,
      highlights: r.highlights,
    }))

    return this.rank(searchResults, updatedData)
  }

  /**
   * Score a single search result
   */
  private scoreResult(result: SearchResult, extendedData?: RankableSkill): RankedResult {
    const skill = extendedData ?? result.skill

    const breakdown: ScoreBreakdown = {
      relevance: this.normalizeRelevance(result.rank),
      popularity: this.calculatePopularityScore(extendedData),
      recency: this.calculateRecencyScore(skill.updatedAt),
      quality: this.normalizeQualityScore(skill.qualityScore),
      trustTier: this.getTrustTierScore(skill.trustTier),
      final: 0,
    }

    // Calculate weighted final score
    breakdown.final =
      breakdown.relevance * this.weights.relevance +
      breakdown.popularity * this.weights.popularity +
      breakdown.recency * this.weights.recency +
      breakdown.quality * this.weights.quality +
      breakdown.trustTier * this.weights.trustTier

    return {
      skill: result.skill,
      score: breakdown.final,
      breakdown,
      highlights: result.highlights,
    }
  }

  /**
   * Normalize BM25/relevance score to 0-1 range
   * BM25 scores typically range from 0 to ~25
   */
  private normalizeRelevance(rank: number): number {
    // Handle missing or invalid rank
    if (rank <= 0 || !isFinite(rank)) return 0

    // Normalize with sigmoid-like function to cap at 1
    // log1p handles large scores gracefully
    const normalized = Math.log1p(rank) / Math.log1p(25)
    return Math.min(1, normalized)
  }

  /**
   * Calculate popularity score from stars and forks
   */
  private calculatePopularityScore(data?: RankableSkill): number {
    if (!data) return 0

    const stars = data.stars ?? 0
    const forks = data.forks ?? 0

    // Stars weighted 2x forks
    const starScore = Math.min(stars / this.maxStars, 1) * 0.7
    const forkScore = Math.min(forks / this.maxForks, 1) * 0.3

    return starScore + forkScore
  }

  /**
   * Calculate recency score based on last update
   */
  private calculateRecencyScore(updatedAt?: string | null): number {
    if (!updatedAt) return 0.3 // Default for missing data

    const updated = new Date(updatedAt)
    const now = new Date()
    const daysDiff = (now.getTime() - updated.getTime()) / (1000 * 60 * 60 * 24)

    if (daysDiff < 0) return 1 // Future date (shouldn't happen)
    if (daysDiff <= 30) return 1 // Updated within last month
    if (daysDiff >= this.recencyDays) return 0.1 // Very stale

    // Linear decay from 1.0 to 0.1 over recencyDays
    const decay = 1 - (daysDiff / this.recencyDays) * 0.9
    return Math.max(0.1, decay)
  }

  /**
   * Normalize quality score to 0-1 range
   */
  private normalizeQualityScore(qualityScore?: number | null): number {
    if (qualityScore === null || qualityScore === undefined) return 0.5 // Default

    // Quality scores are typically 0-100
    if (qualityScore <= 0) return 0
    if (qualityScore >= 100) return 1

    return qualityScore / 100
  }

  /**
   * Get trust tier score (already 0-1 from multipliers)
   */
  private getTrustTierScore(trustTier: TrustTier): number {
    return TRUST_TIER_MULTIPLIERS[trustTier] ?? TRUST_TIER_MULTIPLIERS.unknown
  }

  /**
   * Get the current weight configuration
   */
  getWeights(): RankingWeights {
    return { ...this.weights }
  }

  /**
   * Calculate a boost factor for specific conditions
   * (e.g., exact name match, official skill)
   */
  calculateBoost(skill: Skill, query: string): number {
    let boost = 1.0

    // Exact name match boost
    if (skill.name.toLowerCase() === query.toLowerCase()) {
      boost *= 1.5
    }

    // Partial name match boost
    if (skill.name.toLowerCase().includes(query.toLowerCase())) {
      boost *= 1.2
    }

    // Verified tier boost
    if (skill.trustTier === 'verified') {
      boost *= 1.1
    }

    return boost
  }

  /**
   * Apply boost to ranked results
   */
  applyBoost(results: RankedResult[], query: string): RankedResult[] {
    return results
      .map((result) => {
        const boost = this.calculateBoost(result.skill, query)
        return {
          ...result,
          score: result.score * boost,
          breakdown: {
            ...result.breakdown,
            final: result.breakdown.final * boost,
          },
        }
      })
      .sort((a, b) => b.score - a.score)
  }
}
