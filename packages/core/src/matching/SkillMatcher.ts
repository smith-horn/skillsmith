/**
 * @fileoverview Semantic skill matching using embeddings
 * @module @skillsmith/core/matching/SkillMatcher
 * @see SMI-602: Implement recommend_skills MCP tool
 *
 * Provides semantic similarity matching between skills using
 * the EmbeddingService for vector-based comparisons.
 *
 * @example
 * const matcher = new SkillMatcher({ useFallback: true });
 * const matches = await matcher.findSimilarSkills('react testing', skills, 5);
 */

import { EmbeddingService, type EmbeddingServiceOptions } from '../embeddings/index.js'

/**
 * Skill data for matching
 */
export interface MatchableSkill {
  /** Unique skill identifier */
  id: string
  /** Skill display name */
  name: string
  /** Skill description */
  description: string
  /** Optional trigger phrases for overlap detection */
  triggerPhrases?: string[]
  /** Optional keywords for keyword-based fallback */
  keywords?: string[]
  /** Optional quality score (0-100) */
  qualityScore?: number
}

/**
 * Result of a skill match
 */
export interface SkillMatchResult {
  /** Matched skill */
  skill: MatchableSkill
  /** Semantic similarity score (0-1) */
  similarityScore: number
  /** Why this skill matched */
  matchReason: string
}

/**
 * Options for SkillMatcher
 */
export interface SkillMatcherOptions extends EmbeddingServiceOptions {
  /** Minimum similarity threshold (0-1, default 0.3) */
  minSimilarity?: number
  /** Quality score weight (0-1, default 0.3) */
  qualityWeight?: number
}

/**
 * Semantic skill matcher using embeddings.
 *
 * Finds skills similar to a query using vector similarity,
 * with optional quality score boosting.
 *
 * @example
 * const matcher = new SkillMatcher({ useFallback: true });
 * await matcher.initialize(skills);
 * const results = await matcher.findSimilarSkills('react testing', skills);
 */
export class SkillMatcher {
  private embeddingService: EmbeddingService
  private skillEmbeddings: Map<string, Float32Array> = new Map()
  private initialized = false
  private readonly minSimilarity: number
  private readonly qualityWeight: number

  constructor(options: SkillMatcherOptions = {}) {
    this.embeddingService = new EmbeddingService(options)
    this.minSimilarity = options.minSimilarity ?? 0.3
    this.qualityWeight = options.qualityWeight ?? 0.3
  }

  /**
   * Check if matcher is using fallback mode
   */
  isUsingFallback(): boolean {
    return this.embeddingService.isUsingFallback()
  }

  /**
   * Initialize skill embeddings for a set of skills.
   * Call this before matching for best performance.
   */
  async initialize(skills: MatchableSkill[]): Promise<void> {
    const texts = skills.map((skill) => ({
      id: skill.id,
      text: this.skillToText(skill),
    }))

    const results = await this.embeddingService.embedBatch(texts)

    for (const result of results) {
      this.skillEmbeddings.set(result.skillId, result.embedding)
    }

    this.initialized = true
  }

  /**
   * Convert skill to text for embedding
   */
  private skillToText(skill: MatchableSkill): string {
    const parts = [skill.name, skill.description]

    if (skill.triggerPhrases && skill.triggerPhrases.length > 0) {
      parts.push(skill.triggerPhrases.join(' '))
    }

    if (skill.keywords && skill.keywords.length > 0) {
      parts.push(skill.keywords.join(' '))
    }

    return parts.join(' ').slice(0, 1000)
  }

  /**
   * Find skills similar to a query string.
   *
   * @param query - Search query or context description
   * @param skills - Pool of skills to search
   * @param limit - Maximum results to return
   * @returns Ranked list of matching skills
   *
   * @example
   * const matches = await matcher.findSimilarSkills(
   *   'React TypeScript frontend testing',
   *   availableSkills,
   *   5
   * );
   */
  async findSimilarSkills(
    query: string,
    skills: MatchableSkill[],
    limit: number = 10
  ): Promise<SkillMatchResult[]> {
    // Ensure skills are initialized
    if (!this.initialized) {
      await this.initialize(skills)
    }

    // Get query embedding
    const queryEmbedding = await this.embeddingService.embed(query)

    // Score all skills
    const scored: SkillMatchResult[] = []

    for (const skill of skills) {
      const skillEmbedding = this.skillEmbeddings.get(skill.id)

      if (!skillEmbedding) {
        // Skill not in cache, compute on-the-fly
        const text = this.skillToText(skill)
        const embedding = await this.embeddingService.embed(text)
        this.skillEmbeddings.set(skill.id, embedding)
      }

      const embedding = this.skillEmbeddings.get(skill.id)!
      const semanticScore = this.embeddingService.cosineSimilarity(queryEmbedding, embedding)

      // Apply quality boost
      const qualityBoost = skill.qualityScore ? (skill.qualityScore / 100) * this.qualityWeight : 0

      const finalScore = semanticScore * (1 - this.qualityWeight) + qualityBoost

      if (finalScore >= this.minSimilarity) {
        scored.push({
          skill,
          similarityScore: Math.round(finalScore * 100) / 100,
          matchReason: this.generateMatchReason(skill, query, semanticScore),
        })
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.similarityScore - a.similarityScore)

    return scored.slice(0, limit)
  }

  /**
   * Find skills similar to a set of installed skills.
   *
   * @param installedSkills - Currently installed skills
   * @param candidateSkills - Pool of skills to recommend from
   * @param limit - Maximum results
   * @returns Ranked list of recommended skills
   */
  async findComplementarySkills(
    installedSkills: MatchableSkill[],
    candidateSkills: MatchableSkill[],
    limit: number = 10
  ): Promise<SkillMatchResult[]> {
    if (installedSkills.length === 0) {
      // No installed skills, return top quality candidates
      return candidateSkills
        .map((skill) => ({
          skill,
          similarityScore: skill.qualityScore ? skill.qualityScore / 100 : 0.5,
          matchReason: 'High-quality skill for your toolkit',
        }))
        .sort((a, b) => b.similarityScore - a.similarityScore)
        .slice(0, limit)
    }

    // Build combined query from installed skills
    const installedTexts = installedSkills.map((s) => this.skillToText(s))
    const combinedQuery = installedTexts.join(' ')

    // Filter out already installed
    const installedIds = new Set(installedSkills.map((s) => s.id.toLowerCase()))
    const candidates = candidateSkills.filter((s) => !installedIds.has(s.id.toLowerCase()))

    return this.findSimilarSkills(combinedQuery, candidates, limit)
  }

  /**
   * Generate a human-readable match reason
   */
  private generateMatchReason(skill: MatchableSkill, query: string, semanticScore: number): string {
    const queryLower = query.toLowerCase()
    const skillNameLower = skill.name.toLowerCase()

    // Check for direct keyword matches
    if (skill.keywords) {
      const matchingKeywords = skill.keywords.filter((k) => queryLower.includes(k.toLowerCase()))
      if (matchingKeywords.length > 0) {
        return `Matches your ${matchingKeywords.slice(0, 2).join(' and ')} needs`
      }
    }

    // Check category from description
    const descLower = skill.description.toLowerCase()

    if (queryLower.includes('test') && descLower.includes('test')) {
      return 'Supports your testing workflow'
    }
    if (queryLower.includes('react') && descLower.includes('react')) {
      return 'Enhances your React development'
    }
    if (queryLower.includes('docker') && descLower.includes('docker')) {
      return 'Helps with containerization'
    }
    if (queryLower.includes('api') && descLower.includes('api')) {
      return 'Useful for API development'
    }

    // High semantic match
    if (semanticScore > 0.7) {
      return `Highly relevant to "${skillNameLower}"`
    }

    // Default based on quality
    if (skill.qualityScore && skill.qualityScore >= 90) {
      return 'Top-rated skill in this category'
    }

    return 'Complements your existing skills'
  }

  /**
   * Get embedding dimension
   */
  getEmbeddingDimension(): number {
    return 384
  }

  /**
   * Clear cached embeddings
   */
  clear(): void {
    this.skillEmbeddings.clear()
    this.initialized = false
  }

  /**
   * Close resources
   */
  close(): void {
    this.embeddingService.close()
    this.clear()
  }
}

export default SkillMatcher
