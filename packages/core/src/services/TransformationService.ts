/**
 * SMI-1788: TransformationService - Orchestrate skill optimization pipeline
 *
 * The central service for transforming community skills into optimized versions.
 * Coordinates the full pipeline:
 * 1. SkillAnalyzer - Analyze skill for optimization patterns
 * 2. SkillDecomposer - Decompose large skills into sub-skills
 * 3. SubagentGenerator - Generate companion subagent definitions
 * 4. Caching - Cache transformed skills for reuse
 *
 * Implements the hybrid approach:
 * - Hot skills (>100 installs): Pre-transformed, cached
 * - Warm skills (10-100 installs): JIT on first install, cached
 * - Cold skills (<10 installs): JIT on demand, short TTL
 *
 * Part of the Skillsmith Optimization Layer.
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import { createHash } from 'crypto'
import { CacheRepository } from '../repositories/CacheRepository.js'
import { analyzeSkill, quickTransformCheck, type SkillAnalysis } from './SkillAnalyzer.js'
import {
  decomposeSkill,
  parallelizeTaskCalls,
  type DecompositionResult,
} from './SkillDecomposer.js'
import {
  generateSubagent,
  type SubagentGenerationResult,
  type SubagentDefinition,
} from './SubagentGenerator.js'

/**
 * Full transformation result for a skill
 */
export interface TransformationResult {
  /** Whether transformation was applied */
  transformed: boolean

  /** The optimized main SKILL.md content */
  mainSkillContent: string

  /** Sub-skills (if decomposed) */
  subSkills: Array<{
    filename: string
    content: string
  }>

  /** Companion subagent (if generated) */
  subagent?: SubagentDefinition

  /** CLAUDE.md integration snippet */
  claudeMdSnippet?: string

  /** Transformation statistics */
  stats: TransformationStats

  /** Analysis that informed the transformation */
  analysis: SkillAnalysis

  /** Attribution footer added to content */
  attribution: string
}

/**
 * Statistics about the transformation
 */
export interface TransformationStats {
  /** Original content line count */
  originalLines: number

  /** Optimized main skill line count */
  optimizedLines: number

  /** Number of sub-skills extracted */
  subSkillCount: number

  /** Whether Task() calls were parallelized */
  tasksParallelized: boolean

  /** Whether subagent was generated */
  subagentGenerated: boolean

  /** Estimated token reduction percentage */
  tokenReductionPercent: number

  /** Transformation duration in ms */
  transformDurationMs: number
}

/**
 * Cached transformation entry
 */
interface CachedTransformation {
  result: TransformationResult
  skillHash: string
  cachedAt: string
  version: string
}

/**
 * Configuration for TransformationService
 */
export interface TransformationServiceOptions {
  /** Cache TTL in seconds (default: 3600 = 1 hour) */
  cacheTtl?: number

  /** Enable caching (default: true) */
  enableCache?: boolean

  /** Force re-transformation even if cached (default: false) */
  forceTransform?: boolean

  /** Transformation version for cache invalidation */
  version?: string
}

const DEFAULT_OPTIONS: Required<TransformationServiceOptions> = {
  cacheTtl: 3600, // 1 hour
  enableCache: true,
  forceTransform: false,
  version: '1.0.0',
}

/**
 * SMI-1791: Maximum content length to process (2MB)
 * Prevents DoS from extremely large inputs
 */
const MAX_CONTENT_LENGTH = 2 * 1024 * 1024

/** Cache key prefix for transformed skills */
const CACHE_KEY_PREFIX = 'transform:'

/** Attribution text added to optimized skills */
const ATTRIBUTION =
  '\n\n---\n\n*Optimized by Skillsmith - Token usage reduced through intelligent decomposition*'

/**
 * TransformationService orchestrates the skill optimization pipeline
 */
export class TransformationService {
  private cache: CacheRepository | null
  private options: Required<TransformationServiceOptions>

  /**
   * Create a new TransformationService
   *
   * @param db - Database connection (optional, for caching)
   * @param options - Service configuration
   */
  constructor(db?: DatabaseType, options?: TransformationServiceOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.cache = db && this.options.enableCache ? new CacheRepository(db) : null
  }

  /**
   * Transform a skill through the full optimization pipeline
   *
   * @param skillId - Unique identifier for the skill (for caching)
   * @param skillName - Human-readable skill name
   * @param description - Skill description
   * @param content - The full SKILL.md content
   * @returns Transformation result
   */
  async transform(
    skillId: string,
    skillName: string,
    description: string,
    content: string
  ): Promise<TransformationResult> {
    const startTime = Date.now()

    // SMI-1791: Validate content length to prevent DoS
    if (content.length > MAX_CONTENT_LENGTH) {
      throw new Error(
        `Content exceeds maximum length of ${MAX_CONTENT_LENGTH} bytes (got ${content.length})`
      )
    }

    // Check cache first (unless force transform)
    if (!this.options.forceTransform && this.cache) {
      const cached = this.getCachedTransformation(skillId, content)
      if (cached) {
        return cached
      }
    }

    // Quick check if transformation is needed
    if (!quickTransformCheck(content)) {
      // Still add attribution but skip full transformation
      const result = this.createMinimalResult(content, startTime)

      // Cache the result
      if (this.cache) {
        this.cacheTransformation(skillId, content, result)
      }

      return result
    }

    // Full analysis
    const analysis = analyzeSkill(content)

    // Apply transformations
    let transformedContent = content

    // 1. Parallelize Task() calls
    let tasksParallelized = false
    if (analysis.taskPatterns.canBatch) {
      transformedContent = parallelizeTaskCalls(transformedContent)
      tasksParallelized = true
    }

    // 2. Decompose if needed
    const decomposition = decomposeSkill(transformedContent, analysis)

    // 3. Generate subagent if beneficial
    const subagentResult = generateSubagent(skillName, description, content, analysis)

    // Build result
    const result = this.buildResult(
      decomposition,
      subagentResult,
      analysis,
      tasksParallelized,
      startTime
    )

    // Cache the result
    if (this.cache) {
      this.cacheTransformation(skillId, content, result)
    }

    return result
  }

  /**
   * Quick transform without caching (for testing or one-off transforms)
   *
   * @param skillName - Human-readable skill name
   * @param description - Skill description
   * @param content - The full SKILL.md content
   * @returns Transformation result
   */
  /**
   * SMI-1798: Transform without caching (for testing or one-off transforms)
   * Note: This is NOT a synchronous I/O operation - the name indicates
   * it runs without async cache operations.
   */
  transformWithoutCache(
    skillName: string,
    description: string,
    content: string
  ): TransformationResult {
    const startTime = Date.now()

    // SMI-1791: Validate content length to prevent DoS
    if (content.length > MAX_CONTENT_LENGTH) {
      throw new Error(
        `Content exceeds maximum length of ${MAX_CONTENT_LENGTH} bytes (got ${content.length})`
      )
    }

    // Quick check if transformation is needed
    if (!quickTransformCheck(content)) {
      return this.createMinimalResult(content, startTime)
    }

    // Full analysis
    const analysis = analyzeSkill(content)

    // Apply transformations
    let transformedContent = content

    // 1. Parallelize Task() calls
    let tasksParallelized = false
    if (analysis.taskPatterns.canBatch) {
      transformedContent = parallelizeTaskCalls(transformedContent)
      tasksParallelized = true
    }

    // 2. Decompose if needed
    const decomposition = decomposeSkill(transformedContent, analysis)

    // 3. Generate subagent if beneficial
    const subagentResult = generateSubagent(skillName, description, content, analysis)

    return this.buildResult(decomposition, subagentResult, analysis, tasksParallelized, startTime)
  }

  /**
   * Check if a skill would benefit from transformation without fully transforming
   *
   * @param content - The SKILL.md content
   * @returns Analysis with transformation recommendations
   */
  analyze(content: string): SkillAnalysis {
    return analyzeSkill(content)
  }

  /**
   * Get cached transformation if available and valid
   */
  private getCachedTransformation(skillId: string, content: string): TransformationResult | null {
    if (!this.cache) return null

    const cacheKey = this.buildCacheKey(skillId)
    const cached = this.cache.get<CachedTransformation>(cacheKey)

    if (!cached) return null

    // Validate cache entry
    const contentHash = this.hashContent(content)
    if (cached.skillHash !== contentHash) {
      // Content changed, invalidate cache
      return null
    }

    if (cached.version !== this.options.version) {
      // Version mismatch, invalidate cache
      return null
    }

    return cached.result
  }

  /**
   * Cache a transformation result
   */
  private cacheTransformation(
    skillId: string,
    content: string,
    result: TransformationResult
  ): void {
    if (!this.cache) return

    const cacheKey = this.buildCacheKey(skillId)
    const contentHash = this.hashContent(content)

    const cacheEntry: CachedTransformation = {
      result,
      skillHash: contentHash,
      cachedAt: new Date().toISOString(),
      version: this.options.version,
    }

    this.cache.set(cacheKey, cacheEntry, this.options.cacheTtl)
  }

  /**
   * Build cache key for a skill
   */
  private buildCacheKey(skillId: string): string {
    return `${CACHE_KEY_PREFIX}${skillId}`
  }

  /**
   * SMI-1790: Compute SHA-256 hash for content comparison
   * Uses cryptographic hash for reliable cache invalidation
   */
  private hashContent(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex')
  }

  /**
   * Create minimal result for skills that don't need transformation
   */
  private createMinimalResult(content: string, startTime: number): TransformationResult {
    const lineCount = content.split('\n').length

    // Add attribution if not present
    let mainSkillContent = content
    if (!content.includes('Optimized by Skillsmith')) {
      mainSkillContent = content.trimEnd() + ATTRIBUTION
    }

    return {
      transformed: false,
      mainSkillContent,
      subSkills: [],
      stats: {
        originalLines: lineCount,
        optimizedLines: mainSkillContent.split('\n').length,
        subSkillCount: 0,
        tasksParallelized: false,
        subagentGenerated: false,
        tokenReductionPercent: 0,
        transformDurationMs: Date.now() - startTime,
      },
      analysis: analyzeSkill(content),
      attribution: ATTRIBUTION,
    }
  }

  /**
   * Build full transformation result
   */
  private buildResult(
    decomposition: DecompositionResult,
    subagentResult: SubagentGenerationResult,
    analysis: SkillAnalysis,
    tasksParallelized: boolean,
    startTime: number
  ): TransformationResult {
    // Calculate token reduction
    let tokenReductionPercent = decomposition.stats.tokenReductionPercent

    // Add savings from subagent context isolation
    if (subagentResult.generated) {
      tokenReductionPercent += 20 // Subagent provides ~20% additional savings
    }

    // Add savings from task parallelization
    if (tasksParallelized) {
      tokenReductionPercent += analysis.taskPatterns.batchSavingsPercent / 2
    }

    // Cap at 80% (realistic maximum)
    tokenReductionPercent = Math.min(80, Math.round(tokenReductionPercent))

    return {
      transformed: decomposition.wasDecomposed || subagentResult.generated || tasksParallelized,
      mainSkillContent: decomposition.mainSkill.content,
      subSkills: decomposition.subSkills.map((s) => ({
        filename: s.filename,
        content: s.content,
      })),
      subagent: subagentResult.subagent,
      claudeMdSnippet: subagentResult.claudeMdSnippet,
      stats: {
        originalLines: decomposition.stats.originalLines,
        optimizedLines: decomposition.mainSkill.lineCount,
        subSkillCount: decomposition.subSkills.length,
        tasksParallelized,
        subagentGenerated: subagentResult.generated,
        tokenReductionPercent,
        transformDurationMs: Date.now() - startTime,
      },
      analysis,
      attribution: ATTRIBUTION,
    }
  }

  /**
   * Clear transformation cache
   */
  clearCache(): number {
    if (!this.cache) return 0
    return this.cache.clear()
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { enabled: boolean; ttl: number; version: string } {
    return {
      enabled: this.cache !== null,
      ttl: this.options.cacheTtl,
      version: this.options.version,
    }
  }
}

/**
 * Create a standalone transformation (no caching)
 *
 * @param skillName - Human-readable skill name
 * @param description - Skill description
 * @param content - The full SKILL.md content
 * @returns Transformation result
 */
export function transformSkill(
  skillName: string,
  description: string,
  content: string
): TransformationResult {
  const service = new TransformationService()
  return service.transformWithoutCache(skillName, description, content)
}

export default TransformationService
