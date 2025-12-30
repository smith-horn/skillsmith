/**
 * @fileoverview Trigger phrase overlap detection for skills
 * @module @skillsmith/core/matching/OverlapDetector
 * @see SMI-604: Trigger phrase overlap detection
 *
 * Detects similarity between skill trigger phrases to prevent
 * recommending skills that overlap too much with installed ones.
 *
 * @example
 * const detector = new OverlapDetector({ useFallback: true });
 * const overlap = await detector.detectOverlap(skill1, skill2);
 * if (overlap.overlapScore > 0.8) {
 *   console.log('Skills are too similar:', overlap.overlappingPhrases);
 * }
 */

import { EmbeddingService, type EmbeddingServiceOptions } from '../embeddings/index.js'

/**
 * Skill with trigger phrases for overlap detection
 */
export interface TriggerPhraseSkill {
  /** Unique skill identifier */
  id: string
  /** Skill display name */
  name: string
  /** Trigger phrases that activate this skill */
  triggerPhrases: string[]
}

/**
 * Result of overlap detection between two skills
 */
export interface OverlapResult {
  /** First skill ID */
  skillId1: string
  /** Second skill ID */
  skillId2: string
  /** Overall overlap score (0-1) */
  overlapScore: number
  /** Specific phrases that overlap */
  overlappingPhrases: Array<{
    phrase1: string
    phrase2: string
    similarity: number
  }>
  /** Whether skills are considered duplicates */
  isDuplicate: boolean
}

/**
 * Result of filtering skills by overlap
 */
export interface FilteredSkillsResult {
  /** Skills that passed the overlap filter */
  accepted: TriggerPhraseSkill[]
  /** Skills that were rejected due to overlap */
  rejected: Array<{
    skill: TriggerPhraseSkill
    overlapsWith: string
    overlapScore: number
  }>
}

/**
 * Options for OverlapDetector
 */
export interface OverlapDetectorOptions extends EmbeddingServiceOptions {
  /** Similarity threshold for phrase matching (0-1, default 0.75) */
  phraseThreshold?: number
  /** Overall overlap threshold for skill rejection (0-1, default 0.6) */
  overlapThreshold?: number
  /** Whether to use exact string matching in addition to semantic (default true) */
  useExactMatch?: boolean
}

/**
 * Detects overlap between skill trigger phrases.
 *
 * Uses semantic similarity to identify skills that respond to
 * similar user inputs, preventing confusing recommendations.
 *
 * @example
 * const detector = new OverlapDetector({ overlapThreshold: 0.7 });
 * const result = await detector.filterByOverlap(candidates, installed);
 * // Use result.accepted for recommendations
 */
export class OverlapDetector {
  private embeddingService: EmbeddingService
  private phraseEmbeddings: Map<string, Float32Array> = new Map()
  private readonly phraseThreshold: number
  private readonly overlapThreshold: number
  private readonly useExactMatch: boolean

  constructor(options: OverlapDetectorOptions = {}) {
    this.embeddingService = new EmbeddingService(options)
    this.phraseThreshold = options.phraseThreshold ?? 0.75
    this.overlapThreshold = options.overlapThreshold ?? 0.6
    this.useExactMatch = options.useExactMatch ?? true
  }

  /**
   * Check if detector is using fallback mode
   */
  isUsingFallback(): boolean {
    return this.embeddingService.isUsingFallback()
  }

  /**
   * Detect overlap between two skills.
   *
   * @param skill1 - First skill
   * @param skill2 - Second skill
   * @returns Detailed overlap analysis
   */
  async detectOverlap(
    skill1: TriggerPhraseSkill,
    skill2: TriggerPhraseSkill
  ): Promise<OverlapResult> {
    const overlappingPhrases: OverlapResult['overlappingPhrases'] = []

    // Get embeddings for all phrases
    for (const phrase1 of skill1.triggerPhrases) {
      for (const phrase2 of skill2.triggerPhrases) {
        // Check exact match first
        if (this.useExactMatch && this.isExactMatch(phrase1, phrase2)) {
          overlappingPhrases.push({
            phrase1,
            phrase2,
            similarity: 1.0,
          })
          continue
        }

        // Check semantic similarity
        const embedding1 = await this.getPhraseEmbedding(phrase1)
        const embedding2 = await this.getPhraseEmbedding(phrase2)
        const similarity = this.embeddingService.cosineSimilarity(embedding1, embedding2)

        if (similarity >= this.phraseThreshold) {
          overlappingPhrases.push({
            phrase1,
            phrase2,
            similarity: Math.round(similarity * 100) / 100,
          })
        }
      }
    }

    // Calculate overall overlap score based on unique phrases that overlap
    // Count unique phrases from skill1 that have at least one match in skill2
    const overlappingFromSkill1 = new Set(overlappingPhrases.map((p) => p.phrase1))
    const overlappingFromSkill2 = new Set(overlappingPhrases.map((p) => p.phrase2))

    // Calculate the overlap ratio for each skill
    const ratio1 =
      skill1.triggerPhrases.length > 0
        ? overlappingFromSkill1.size / skill1.triggerPhrases.length
        : 0
    const ratio2 =
      skill2.triggerPhrases.length > 0
        ? overlappingFromSkill2.size / skill2.triggerPhrases.length
        : 0

    // Use the average of both ratios for a balanced score
    const overlapScore = (ratio1 + ratio2) / 2

    return {
      skillId1: skill1.id,
      skillId2: skill2.id,
      overlapScore: Math.round(overlapScore * 100) / 100,
      overlappingPhrases,
      isDuplicate: overlapScore >= this.overlapThreshold,
    }
  }

  /**
   * Check for exact string match (case-insensitive, normalized)
   */
  private isExactMatch(phrase1: string, phrase2: string): boolean {
    const normalize = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ')
    return normalize(phrase1) === normalize(phrase2)
  }

  /**
   * Get or compute embedding for a phrase
   */
  private async getPhraseEmbedding(phrase: string): Promise<Float32Array> {
    const cacheKey = phrase.toLowerCase().trim()

    if (!this.phraseEmbeddings.has(cacheKey)) {
      const embedding = await this.embeddingService.embed(phrase)
      this.phraseEmbeddings.set(cacheKey, embedding)
    }

    return this.phraseEmbeddings.get(cacheKey)!
  }

  /**
   * Filter candidate skills by overlap with installed skills.
   *
   * Removes candidates that have too much trigger phrase overlap
   * with already installed skills.
   *
   * @param candidates - Skills to consider for recommendation
   * @param installed - Currently installed skills
   * @returns Filtered results with accepted and rejected skills
   *
   * @example
   * const result = await detector.filterByOverlap(candidates, installed);
   * console.log(`Accepted: ${result.accepted.length}`);
   * console.log(`Rejected: ${result.rejected.length}`);
   */
  async filterByOverlap(
    candidates: TriggerPhraseSkill[],
    installed: TriggerPhraseSkill[]
  ): Promise<FilteredSkillsResult> {
    const accepted: TriggerPhraseSkill[] = []
    const rejected: FilteredSkillsResult['rejected'] = []

    for (const candidate of candidates) {
      let highestOverlap = 0
      let overlapsWith = ''

      // Check overlap with each installed skill
      for (const installedSkill of installed) {
        const overlap = await this.detectOverlap(candidate, installedSkill)

        if (overlap.overlapScore > highestOverlap) {
          highestOverlap = overlap.overlapScore
          overlapsWith = installedSkill.id
        }
      }

      // Also check overlap with already accepted candidates
      for (const acceptedSkill of accepted) {
        const overlap = await this.detectOverlap(candidate, acceptedSkill)

        if (overlap.overlapScore > highestOverlap) {
          highestOverlap = overlap.overlapScore
          overlapsWith = acceptedSkill.id
        }
      }

      if (highestOverlap >= this.overlapThreshold) {
        rejected.push({
          skill: candidate,
          overlapsWith,
          overlapScore: highestOverlap,
        })
      } else {
        accepted.push(candidate)
      }
    }

    return { accepted, rejected }
  }

  /**
   * Find all overlapping skill pairs in a set.
   *
   * Useful for auditing a skill library for potential conflicts.
   *
   * @param skills - Skills to check for overlaps
   * @returns List of overlapping pairs
   */
  async findAllOverlaps(skills: TriggerPhraseSkill[]): Promise<OverlapResult[]> {
    const overlaps: OverlapResult[] = []

    for (let i = 0; i < skills.length; i++) {
      for (let j = i + 1; j < skills.length; j++) {
        const result = await this.detectOverlap(skills[i], skills[j])

        if (result.overlappingPhrases.length > 0) {
          overlaps.push(result)
        }
      }
    }

    // Sort by overlap score descending
    overlaps.sort((a, b) => b.overlapScore - a.overlapScore)

    return overlaps
  }

  /**
   * Get overlap threshold
   */
  getOverlapThreshold(): number {
    return this.overlapThreshold
  }

  /**
   * Get phrase similarity threshold
   */
  getPhraseThreshold(): number {
    return this.phraseThreshold
  }

  /**
   * Clear cached embeddings
   */
  clear(): void {
    this.phraseEmbeddings.clear()
  }

  /**
   * Close resources
   */
  close(): void {
    this.embeddingService.close()
    this.clear()
  }
}

export default OverlapDetector
