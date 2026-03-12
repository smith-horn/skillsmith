/**
 * @fileoverview SkillVariantGenerator — produce improved skill variants
 * @module @skillsmith/core/evaluation/SkillVariantGenerator
 * @see SMI-3296: 4 generation strategies (decompose, augment, specialize, LLM rewrite)
 *
 * Strategies ordered by cost:
 *  1. Decompose (0 tokens) — split large skills via SkillDecomposer
 *  2. Augment (0 tokens) — append failure fixes to skill content
 *  3. Specialize (0 tokens) — remove irrelevant sections for benchmark domain
 *  4. LLM Rewrite (~5K tokens) — Claude rewrites skill based on failure patterns
 */

import { createHash, randomUUID } from 'crypto'
import type { FailurePattern, GenerationMethod, SkillVariant } from './types.js'

/** LLM client for rewrite strategy — injected to avoid SDK dependency */
export interface RewriteClient {
  rewrite(params: {
    model: string
    skillContent: string
    failurePatterns: FailurePattern[]
    benchmarkDomain: string
  }): Promise<string>
}

/** Configuration for SkillVariantGenerator */
export interface VariantGeneratorConfig {
  strategies: GenerationMethod[]
  rewriteModelId: string
  rewriteClient?: RewriteClient
  benchmarkDomain: string
}

const DEFAULT_CONFIG: VariantGeneratorConfig = {
  strategies: ['augment', 'decompose'],
  rewriteModelId: 'claude-sonnet-4-6',
  benchmarkDomain: 'general',
}

/** Compute SHA-256 content hash */
function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

/** Count non-empty lines in content */
function lineCount(content: string): number {
  return content.split('\n').length
}

export class SkillVariantGenerator {
  private readonly config: VariantGeneratorConfig
  private readonly seenHashes: Set<string>

  constructor(config?: Partial<VariantGeneratorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.seenHashes = new Set()
  }

  /**
   * Generate variants from a skill using all configured strategies.
   * Deduplicates by content hash — identical outputs from different
   * strategies or frontier members are returned only once.
   */
  async generate(params: {
    skillId: string
    content: string
    parentId: string | null
    iteration: number
    failurePatterns: FailurePattern[]
  }): Promise<SkillVariant[]> {
    const variants: SkillVariant[] = []

    for (const strategy of this.config.strategies) {
      const result = await this.applyStrategy(strategy, params)
      if (result === null) continue

      const hash = contentHash(result)
      if (this.seenHashes.has(hash)) continue

      this.seenHashes.add(hash)
      variants.push({
        id: randomUUID(),
        contentHash: hash,
        content: result,
        parentId: params.parentId,
        skillId: params.skillId,
        iteration: params.iteration,
        generationMethod: strategy,
        contentLines: lineCount(result),
        costTokens: strategy === 'llm_rewrite' ? result.length : 0,
      })
    }

    return variants
  }

  /** Reset seen hashes between runs */
  resetDedup(): void {
    this.seenHashes.clear()
  }

  private async applyStrategy(
    strategy: GenerationMethod,
    params: {
      content: string
      failurePatterns: FailurePattern[]
    }
  ): Promise<string | null> {
    switch (strategy) {
      case 'decompose':
        return this.decompose(params.content)
      case 'augment':
        return this.augment(params.content, params.failurePatterns)
      case 'specialize':
        return this.specialize(params.content)
      case 'llm_rewrite':
        return this.llmRewrite(params.content, params.failurePatterns)
      case 'baseline':
        return null
    }
  }

  /**
   * Strategy 1: Decompose — split large skills via structural analysis.
   * Only applicable if source skill >200 lines.
   * Returns simplified main skill content (sub-skills not tracked individually).
   */
  private decompose(content: string): string | null {
    const sourceLines = lineCount(content)
    if (sourceLines <= 200) return null

    // Extract first major section as a focused variant
    const lines = content.split('\n')
    const sectionStarts: number[] = []
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) {
        sectionStarts.push(i)
      }
    }

    if (sectionStarts.length < 2) return null

    // Keep header + first 2 sections as a focused sub-skill
    const cutoff = sectionStarts.length >= 3 ? sectionStarts[2] : lines.length
    const focused = lines.slice(0, cutoff).join('\n').trim()

    // Only return if meaningfully shorter
    if (lineCount(focused) >= sourceLines * 0.8) return null

    return focused
  }

  /**
   * Strategy 2: Augment — append top-3 failure fixes to skill content.
   * If `## Skill Improvement Notes` already exists, replace it.
   */
  private augment(content: string, failurePatterns: FailurePattern[]): string | null {
    if (failurePatterns.length === 0) return null

    const top3 = failurePatterns
      .slice(0, 3)
      .map((p) => `- **${p.category}** (${p.frequency} occurrences): ${p.suggestedFix}`)
      .join('\n')

    const section = `\n\n## Skill Improvement Notes\n\n${top3}\n`

    // Replace existing section if present
    const sectionRegex = /\n## Skill Improvement Notes\n[\s\S]*?(?=\n## |\n*$)/
    if (sectionRegex.test(content)) {
      return content.replace(sectionRegex, section).trim()
    }

    return (content.trimEnd() + section).trim()
  }

  /**
   * Strategy 3: Specialize — remove generic sections irrelevant to benchmark.
   * Strips sections that don't mention the benchmark domain keywords.
   */
  private specialize(content: string): string | null {
    const domain = this.config.benchmarkDomain.toLowerCase()
    if (domain === 'general') return null

    const lines = content.split('\n')
    const result: string[] = []
    let inSection = false
    let sectionLines: string[] = []
    let sectionRelevant = false

    const domainKeywords = domain.split(/[\s,]+/)

    for (const line of lines) {
      if (line.startsWith('## ')) {
        // Flush previous section
        if (inSection && sectionRelevant) {
          result.push(...sectionLines)
        }
        inSection = true
        sectionLines = [line]
        sectionRelevant = false
      } else if (inSection) {
        sectionLines.push(line)
        const lower = line.toLowerCase()
        if (domainKeywords.some((kw) => lower.includes(kw))) {
          sectionRelevant = true
        }
      } else {
        // Header content before first ##
        result.push(line)
      }
    }

    // Flush last section
    if (inSection && sectionRelevant) {
      result.push(...sectionLines)
    }

    const specialized = result.join('\n').trim()

    // Only return if meaningfully shorter (>10% reduction)
    if (specialized.length >= content.length * 0.9) return null
    // Must retain at least some content
    if (specialized.length < 50) return null

    return specialized
  }

  /**
   * Strategy 4: LLM Rewrite — send skill + failures to Claude for creative rewrite.
   * Requires injected RewriteClient.
   */
  private async llmRewrite(
    content: string,
    failurePatterns: FailurePattern[]
  ): Promise<string | null> {
    if (!this.config.rewriteClient) return null
    if (failurePatterns.length === 0) return null

    const result = await this.config.rewriteClient.rewrite({
      model: this.config.rewriteModelId,
      skillContent: content,
      failurePatterns,
      benchmarkDomain: this.config.benchmarkDomain,
    })

    // Ensure result is different from input
    if (contentHash(result) === contentHash(content)) return null

    return result
  }
}
